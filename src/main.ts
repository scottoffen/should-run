import * as core from '@actions/core'
import * as github from '@actions/github'
import { minimatch } from 'minimatch'

/**
 * Minimatch options used throughout. `dot: true` means patterns like `**\/*.md`
 * also match files starting with `.` (e.g. `.github/foo.md`), which matches
 * what most users expect in a GitHub Actions context.
 */
const MINIMATCH_OPTIONS = { dot: true } as const

/**
 * A SHA value that GitHub uses for the `before` field on the first push to a
 * branch. There is no parent commit to diff against in that case.
 */
const ZERO_SHA = '0000000000000000000000000000000000000000'

/**
 * Splits a newline-separated input value into a clean array of pattern strings.
 * Empty lines and pure-whitespace lines are dropped; surrounding whitespace is
 * trimmed from each line. The action reads `include` and `ignore` as multiline
 * strings, so both go through this.
 */
export function parsePatterns(input: string): string[] {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Splits a comma-separated input value into a normalized array of event names.
 * Whitespace around each entry is trimmed and entries are lowercased so the
 * input is forgiving of formatting (`"workflow_dispatch, Schedule"` works the
 * same as `"workflow_dispatch,schedule"`).
 */
export function parseAlwaysRunFor(input: string): string[] {
  return input
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
}

/**
 * Returns the subset of `files` that should be considered "changed for the
 * purposes of this workflow". A file qualifies when it matches at least one
 * include pattern AND does not match any ignore pattern. This is the core
 * matching logic; everything else in the file exists to feed inputs to this
 * function or act on its result.
 */
export function filterChangedFiles(
  files: string[],
  include: string[],
  ignore: string[]
): string[] {
  return files.filter((file) => {
    const isIncluded = include.some((pattern) =>
      minimatch(file, pattern, MINIMATCH_OPTIONS)
    )
    if (!isIncluded) return false

    const isIgnored = ignore.some((pattern) =>
      minimatch(file, pattern, MINIMATCH_OPTIONS)
    )
    return !isIgnored
  })
}

/**
 * Result of resolving base/head SHAs from an event payload. `null` means there
 * is no meaningful diff to compute - either because the event type does not
 * carry one (workflow_dispatch, schedule) or because of an edge case like the
 * first push to a branch where the parent SHA is all zeros.
 */
export type ResolvedRefs = { base: string; head: string } | null

/**
 * Narrowing helper: returns true if the value is a non-null object, so
 * TypeScript will let us index into it with bracket notation. Used to walk
 * the loosely-typed event payload safely.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Read a deeply-nested string property from a loosely-typed payload, returning
 * undefined if any intermediate hop is missing or the wrong type. The webhook
 * payload shape varies between event types, so we cannot import a static type
 * that covers all of them; this helper substitutes for that lookup safely.
 */
function getNestedString(
  payload: Record<string, unknown>,
  path: readonly string[]
): string | undefined {
  let current: unknown = payload
  for (const key of path) {
    if (!isObject(current)) return undefined
    current = current[key]
  }
  return typeof current === 'string' ? current : undefined
}

/**
 * Pulls base and head SHAs out of a webhook event payload. Only `pull_request`
 * and `push` events have a natural diff; everything else returns null and the
 * caller decides what to do (typically: fail open).
 *
 * Edge cases handled here:
 *  - First push to a branch: `payload.before` is the zero SHA. There is no
 *    parent commit to diff against, so we return null. The caller treats this
 *    as "cannot filter, fail open" rather than trying to enumerate all files
 *    in the head commit.
 *  - Missing SHAs: defensive null-return rather than throwing, since the
 *    upstream payload shape can vary between event sub-types.
 *
 * The payload is typed as Record<string, unknown> because @actions/github does
 * not expose a stable, importable type for it that we can rely on across
 * package versions. We walk the structure with a small helper that null-checks
 * every hop.
 */
export function resolveRefs(
  eventName: string,
  payload: Record<string, unknown>
): ResolvedRefs {
  if (eventName === 'pull_request') {
    const base = getNestedString(payload, ['pull_request', 'base', 'sha'])
    const head = getNestedString(payload, ['pull_request', 'head', 'sha'])
    if (!base || !head) return null
    return { base, head }
  }

  if (eventName === 'push') {
    const before = getNestedString(payload, ['before'])
    const after = getNestedString(payload, ['after'])
    if (!before || !after) return null
    if (before === ZERO_SHA) return null
    return { base: before, head: after }
  }

  return null
}

/**
 * The Octokit shape we depend on. Defining this narrowly (rather than relying
 * on the full `InstanceType<typeof GitHub>` shape) makes the function trivial
 * to mock in tests: a fake object with one method on the right path satisfies
 * the contract.
 */
export interface CompareCapableOctokit {
  rest: {
    repos: {
      compareCommitsWithBasehead: (params: {
        owner: string
        repo: string
        basehead: string
        per_page?: number
        page?: number
      }) => Promise<{ data: { files?: Array<{ filename: string }> } }>
    }
  }
}

/**
 * Fetches the list of files changed between `base` and `head` from the
 * GitHub Compare API. Pagination is handled manually here rather than via
 * `octokit.paginate` so the function's external surface stays a plain object
 * (easier to mock without pulling in Octokit's iterator types).
 *
 * The Compare API returns a maximum of 300 files per page; we keep paging
 * until a page returns fewer than that. For pathological commits with
 * thousands of files this still terminates correctly.
 */
export async function fetchChangedFiles(
  octokit: CompareCapableOctokit,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<string[]> {
  const PER_PAGE = 100
  const filenames: string[] = []
  let page = 1

  for (;;) {
    const response = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
      per_page: PER_PAGE,
      page
    })

    const files = response.data.files ?? []
    for (const file of files) filenames.push(file.filename)

    if (files.length < PER_PAGE) break
    page += 1
  }

  return filenames
}

/**
 * The action entrypoint. Reads inputs, decides whether to filter or short-
 * circuit, calls the appropriate helpers, sets outputs.
 *
 * Failure policy: any unexpected error is caught and logged as a warning, and
 * the action falls open (should-run=true). A broken filter that blocks
 * legitimate builds is worse than a broken filter that lets a no-op build run;
 * the consuming workflow can always layer additional checks if it needs
 * stricter behavior.
 */
export async function run(): Promise<void> {
  try {
    const includeInput = core.getInput('include', { required: true })
    const ignoreInput = core.getInput('ignore')
    const alwaysRunForInput = core.getInput('always-run-for')
    const token = core.getInput('github-token', { required: true })

    const include = parsePatterns(includeInput)
    const ignore = parsePatterns(ignoreInput)
    const alwaysRunFor = parseAlwaysRunFor(alwaysRunForInput)

    if (include.length === 0) {
      throw new Error("Input 'include' must contain at least one pattern.")
    }

    const eventName = github.context.eventName
    core.info(`Event: ${eventName}`)

    // Short-circuit for events the consumer has marked as always-run. The
    // default list ('workflow_dispatch,schedule') covers events that do not
    // have a natural file diff; consumers can extend or shrink it.
    if (alwaysRunFor.includes(eventName)) {
      core.info(`Event '${eventName}' is in always-run-for; skipping filter.`)
      setOutputs(true, [])
      return
    }

    const refs = resolveRefs(
      eventName,
      github.context.payload as Record<string, unknown>
    )
    if (!refs) {
      // Either an unsupported event type, or a recognized event whose payload
      // does not yield a usable base/head (e.g. first push to a branch).
      // We cannot compute a diff, so we fail open.
      core.info(
        `No diff available for event '${eventName}'; failing open with should-run=true.`
      )
      setOutputs(true, [])
      return
    }

    const octokit = github.getOctokit(token)
    const { owner, repo } = github.context.repo

    core.info(`Comparing ${refs.base}...${refs.head}`)
    const allChanged = await fetchChangedFiles(
      octokit,
      owner,
      repo,
      refs.base,
      refs.head
    )
    core.info(`Changed files: ${allChanged.length}`)

    const matched = filterChangedFiles(allChanged, include, ignore)
    core.info(`Matched files: ${matched.length}`)

    // Per-file decisions are noisy; gated behind ACTIONS_STEP_DEBUG so they
    // only show up when someone is actively debugging.
    for (const file of allChanged) {
      const included = matched.includes(file)
      core.debug(`  ${included ? 'INCLUDE' : 'skip   '}  ${file}`)
    }

    setOutputs(matched.length > 0, matched)
  } catch (error) {
    // Fail-open contract: log the problem but do not fail the step. The
    // consuming workflow gets should-run=true and a warning annotation
    // explaining why filtering did not run.
    const message = error instanceof Error ? error.message : String(error)
    core.warning(`should-run encountered an error; failing open: ${message}`)
    setOutputs(true, [])
  }
}

/**
 * Centralizes output writing so the two output names cannot drift from each
 * other across the various exit paths in `run`.
 */
function setOutputs(shouldRun: boolean, changedFiles: string[]): void {
  core.setOutput('should-run', shouldRun ? 'true' : 'false')
  core.setOutput('changed-files', changedFiles.join('\n'))
}
