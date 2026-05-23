/**
 * Unit tests for src/main.ts.
 *
 * Pure helpers (parsePatterns, parseAlwaysRunFor, filterChangedFiles,
 * resolveRefs) are tested directly against their imports. The orchestrator
 * `run()` is tested through mocks of @actions/core and @actions/github
 * declared via jest.unstable_mockModule (the ESM-friendly mocking pattern
 * the typescript-action template uses).
 *
 * Following that pattern: mocks are registered BEFORE the module under test
 * is imported, and the module under test is imported dynamically so it picks
 * up the mocks.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import * as githubFixture from '../__fixtures__/github.js'

// Register mocks before importing main. The unstable_ prefix is misleading;
// this is the supported way to mock ESM modules in Jest.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => githubFixture)

// Dynamic import so the mocks above are in place when main.ts evaluates.
const {
  parsePatterns,
  parseAlwaysRunFor,
  filterChangedFiles,
  resolveRefs,
  fetchChangedFiles,
  run
} = await import('../src/main.js')

// ---------------------------------------------------------------------------
// parsePatterns
// ---------------------------------------------------------------------------
describe('parsePatterns', () => {
  it('returns an empty array for an empty string', () => {
    expect(parsePatterns('')).toEqual([])
  })

  it('returns an empty array for whitespace-only input', () => {
    expect(parsePatterns('   \n\n  \t  \n')).toEqual([])
  })

  it('splits a multiline string into trimmed patterns', () => {
    expect(parsePatterns('src/**\n**/*.md')).toEqual(['src/**', '**/*.md'])
  })

  it('trims surrounding whitespace from each line', () => {
    expect(parsePatterns('  src/**  \n\t**/*.md\t')).toEqual([
      'src/**',
      '**/*.md'
    ])
  })

  it('drops blank lines mixed in with patterns', () => {
    expect(parsePatterns('src/**\n\n\n**/*.md\n')).toEqual([
      'src/**',
      '**/*.md'
    ])
  })
})

// ---------------------------------------------------------------------------
// parseAlwaysRunFor
// ---------------------------------------------------------------------------
describe('parseAlwaysRunFor', () => {
  it('returns an empty array for an empty string', () => {
    expect(parseAlwaysRunFor('')).toEqual([])
  })

  it('splits a comma-separated list', () => {
    expect(parseAlwaysRunFor('workflow_dispatch,schedule')).toEqual([
      'workflow_dispatch',
      'schedule'
    ])
  })

  it('trims whitespace around entries', () => {
    expect(parseAlwaysRunFor(' workflow_dispatch , schedule ')).toEqual([
      'workflow_dispatch',
      'schedule'
    ])
  })

  it('lowercases entries so input is case-insensitive', () => {
    expect(parseAlwaysRunFor('Workflow_Dispatch,SCHEDULE')).toEqual([
      'workflow_dispatch',
      'schedule'
    ])
  })

  it('drops empty entries from doubled commas', () => {
    expect(parseAlwaysRunFor('workflow_dispatch,,schedule')).toEqual([
      'workflow_dispatch',
      'schedule'
    ])
  })
})

// ---------------------------------------------------------------------------
// filterChangedFiles
// ---------------------------------------------------------------------------
describe('filterChangedFiles', () => {
  it('returns an empty array when given no files', () => {
    expect(filterChangedFiles([], ['**/*.cs'], [])).toEqual([])
  })

  it('keeps files that match an include pattern', () => {
    expect(
      filterChangedFiles(['src/Foo.cs', 'src/Bar.cs'], ['src/**'], [])
    ).toEqual(['src/Foo.cs', 'src/Bar.cs'])
  })

  it('drops files that match no include pattern', () => {
    expect(filterChangedFiles(['docs/intro.txt'], ['src/**'], [])).toEqual([])
  })

  it('drops files that match both include and ignore', () => {
    expect(
      filterChangedFiles(['src/README.md'], ['src/**'], ['**/*.md'])
    ).toEqual([])
  })

  it('keeps files matching include but not ignore', () => {
    expect(filterChangedFiles(['src/Foo.cs'], ['src/**'], ['**/*.md'])).toEqual(
      ['src/Foo.cs']
    )
  })

  it('treats include patterns as OR (any one is sufficient)', () => {
    expect(
      filterChangedFiles(
        ['src/Foo.cs', 'tests/Bar.cs'],
        ['src/**', 'tests/**'],
        []
      )
    ).toEqual(['src/Foo.cs', 'tests/Bar.cs'])
  })

  it('treats ignore patterns as OR (any one excludes)', () => {
    expect(
      filterChangedFiles(
        ['src/Foo.cs', 'src/README.md', 'src/notes.txt'],
        ['src/**'],
        ['**/*.md', '**/*.txt']
      )
    ).toEqual(['src/Foo.cs'])
  })

  it('matches dotfiles (verifies dot: true is set)', () => {
    expect(
      filterChangedFiles(['.github/workflows/ci.yml'], ['.github/**'], [])
    ).toEqual(['.github/workflows/ci.yml'])
  })

  it('ignores markdown under included directories (Polymorph scenario)', () => {
    const changed = [
      'src/Polymorph/Foo.cs',
      'src/Polymorph/README.md',
      'src/Polymorph.Tests/Bar.cs'
    ]
    const include = ['src/Polymorph/**', 'src/Polymorph.Abstractions/**']
    const ignore = ['**/*.md']
    expect(filterChangedFiles(changed, include, ignore)).toEqual([
      'src/Polymorph/Foo.cs'
    ])
  })
})

// ---------------------------------------------------------------------------
// resolveRefs
// ---------------------------------------------------------------------------
describe('resolveRefs', () => {
  it('returns base and head for a pull_request event', () => {
    expect(
      resolveRefs('pull_request', {
        pull_request: {
          base: { sha: 'base-sha' },
          head: { sha: 'head-sha' }
        }
      })
    ).toEqual({ base: 'base-sha', head: 'head-sha' })
  })

  it('returns null when pull_request payload lacks SHAs', () => {
    expect(resolveRefs('pull_request', {})).toBeNull()
  })

  it('returns before and after for a push event', () => {
    expect(resolveRefs('push', { before: 'abc123', after: 'def456' })).toEqual({
      base: 'abc123',
      head: 'def456'
    })
  })

  it('returns null when push is the first push to a branch (zero SHA)', () => {
    expect(
      resolveRefs('push', {
        before: '0000000000000000000000000000000000000000',
        after: 'def456'
      })
    ).toBeNull()
  })

  it('returns null when push payload is missing fields', () => {
    expect(resolveRefs('push', {})).toBeNull()
  })

  it('returns null for workflow_dispatch', () => {
    expect(resolveRefs('workflow_dispatch', {})).toBeNull()
  })

  it('returns null for any unrecognized event', () => {
    expect(resolveRefs('release', {})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// fetchChangedFiles
// ---------------------------------------------------------------------------
describe('fetchChangedFiles', () => {
  // Build a fake octokit that returns a fixed response for one page.
  // Per-test specialization handles pagination.
  function fakeOctokit(
    responses: Array<{ files?: Array<{ filename: string }> }>
  ) {
    let call = 0
    return {
      rest: {
        repos: {
          compareCommitsWithBasehead: jest.fn(async () => {
            const data = responses[call] ?? { files: [] }
            call += 1
            return { data }
          })
        }
      }
    }
  }

  it('returns filenames from a single-page response', async () => {
    const octokit = fakeOctokit([
      { files: [{ filename: 'a.cs' }, { filename: 'b.md' }] }
    ])
    const result = await fetchChangedFiles(
      octokit,
      'owner',
      'repo',
      'base',
      'head'
    )
    expect(result).toEqual(['a.cs', 'b.md'])
  })

  it('returns an empty array when files is missing from the response', async () => {
    const octokit = fakeOctokit([{}])
    const result = await fetchChangedFiles(
      octokit,
      'owner',
      'repo',
      'base',
      'head'
    )
    expect(result).toEqual([])
  })

  it('paginates when a full page is returned', async () => {
    // First page is exactly PER_PAGE (100) items, so the loop fetches a
    // second page. Second page is short, so the loop stops.
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.cs`
    }))
    const secondPage = [{ filename: 'last.cs' }]
    const octokit = fakeOctokit([{ files: firstPage }, { files: secondPage }])

    const result = await fetchChangedFiles(
      octokit,
      'owner',
      'repo',
      'base',
      'head'
    )

    expect(result).toHaveLength(101)
    expect(result[0]).toBe('f0.cs')
    expect(result[100]).toBe('last.cs')
    expect(octokit.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledTimes(
      2
    )
  })
})

// ---------------------------------------------------------------------------
// run (orchestrator) - sampled paths
// ---------------------------------------------------------------------------
describe('run', () => {
  beforeEach(() => {
    // Reset all mocks between tests so call counts and return values
    // don't leak across cases.
    jest.clearAllMocks()
    githubFixture.context.eventName = ''
    githubFixture.context.payload = {}
  })

  // Helper: wire up core.getInput to return values keyed by input name.
  function stubInputs(values: Record<string, string>) {
    core.getInput.mockImplementation((name: string) => values[name] ?? '')
  }

  it('happy path: PR with a matching file sets should-run=true', async () => {
    stubInputs({
      include: 'src/**',
      ignore: '**/*.md',
      'always-run-for': 'workflow_dispatch,schedule',
      'github-token': 'fake-token'
    })
    githubFixture.context.eventName = 'pull_request'
    githubFixture.context.payload = {
      pull_request: {
        base: { sha: 'base-sha' },
        head: { sha: 'head-sha' }
      }
    }
    githubFixture.compareCommitsWithBasehead.mockResolvedValueOnce({
      data: {
        files: [{ filename: 'src/Foo.cs' }, { filename: 'src/README.md' }]
      }
    })

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('should-run', 'true')
    expect(core.setOutput).toHaveBeenCalledWith('changed-files', 'src/Foo.cs')
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('workflow_dispatch short-circuits to should-run=true without API call', async () => {
    stubInputs({
      include: 'src/**',
      ignore: '',
      'always-run-for': 'workflow_dispatch,schedule',
      'github-token': 'fake-token'
    })
    githubFixture.context.eventName = 'workflow_dispatch'

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('should-run', 'true')
    expect(core.setOutput).toHaveBeenCalledWith('changed-files', '')
    expect(githubFixture.compareCommitsWithBasehead).not.toHaveBeenCalled()
  })

  it('fails open with should-run=true when refs cannot be resolved', async () => {
    stubInputs({
      include: 'src/**',
      ignore: '',
      'always-run-for': '',
      'github-token': 'fake-token'
    })
    // Push event with the zero SHA (first push to a branch) → resolveRefs
    // returns null → fail open.
    githubFixture.context.eventName = 'push'
    githubFixture.context.payload = {
      before: '0000000000000000000000000000000000000000',
      after: 'def456'
    }

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('should-run', 'true')
    expect(githubFixture.compareCommitsWithBasehead).not.toHaveBeenCalled()
  })

  it('fails open with should-run=true and warns when the API throws', async () => {
    stubInputs({
      include: 'src/**',
      ignore: '',
      'always-run-for': '',
      'github-token': 'fake-token'
    })
    githubFixture.context.eventName = 'pull_request'
    githubFixture.context.payload = {
      pull_request: {
        base: { sha: 'base-sha' },
        head: { sha: 'head-sha' }
      }
    }
    githubFixture.compareCommitsWithBasehead.mockRejectedValueOnce(
      new Error('boom')
    )

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('should-run', 'true')
    expect(core.setOutput).toHaveBeenCalledWith('changed-files', '')
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })
})
