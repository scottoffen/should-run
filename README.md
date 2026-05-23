# should-run

[![Linter](https://github.com/scottoffen/should-run/actions/workflows/linter.yml/badge.svg)](https://github.com/scottoffen/should-run/actions/workflows/linter.yml)
[![CI](https://github.com/scottoffen/should-run/actions/workflows/ci.yml/badge.svg)](https://github.com/scottoffen/should-run/actions/workflows/ci.yml)
[![Check dist/](https://github.com/scottoffen/should-run/actions/workflows/check-dist.yml/badge.svg)](https://github.com/scottoffen/should-run/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/scottoffen/should-run/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/scottoffen/should-run/actions/workflows/codeql-analysis.yml)
![Coverage](./badges/coverage.svg)

A GitHub Action that decides whether a downstream job should run, based on which
files changed against a set of include/ignore glob patterns. It exists so you
can use a single workflow as a required status check on branch protection while
still skipping it for documentation-only changes.

## Why this action exists

GitHub Actions lets you scope a workflow to a set of paths using the `paths:`
filter on the `on:` trigger. That works well, until you set the workflow as a
**required status check** in branch protection.

When a pull request changes only paths that fall outside the filter (for
example, a documentation-only PR), GitHub does not start the workflow at all.
The required check never reports a status, sits in "pending" forever, and the
merge button stays disabled.

The standard workaround is to make the workflow run on every PR, then have its
first step decide whether to actually do the work. When that step reports "no",
the real build job is **skipped**, which GitHub counts as success for branch
protection. That's what this action does.

The action also exposes the list of changed files matching your filter, which
downstream steps can use to make finer-grained decisions.

## Inputs

| Name             | Required | Default                      | Description                                                                                                                                                                       |
| ---------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`        | yes      | -                            | Newline-separated glob patterns. The action returns `should-run=true` if any changed file matches at least one of these patterns.                                                 |
| `ignore`         | no       | `''`                         | Newline-separated glob patterns. A changed file matching both an include and an ignore pattern is treated as if it had not changed.                                               |
| `always-run-for` | no       | `workflow_dispatch,schedule` | Comma-separated list of event names that bypass file filtering and always return `should-run=true`. Pass an empty string to disable.                                              |
| `github-token`   | no       | `${{ github.token }}`        | Token used to call the GitHub Compare API. The default token has the read access needed for same-repository compares. Override only if calling across repositories or with a PAT. |

Globs follow [minimatch](https://github.com/isaacs/minimatch) semantics with
`dot: true`, so patterns like `**/*.md` also match files starting with a `.`
(e.g. `.github/CONTRIBUTING.md`).

## Outputs

| Name            | Description                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `should-run`    | `'true'` if at least one changed file matched `include` and was not excluded by `ignore`. Always `'true'` for events listed in `always-run-for` and for fail-open cases. |
| `changed-files` | Newline-separated list of files that matched `include` and were not excluded by `ignore`. Empty for events that bypass filtering or that fail open.                      |

## Behavior by event type

| Event               | Behavior                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request`      | Compares `base.sha` against `head.sha` and applies the filter.                                                                                           |
| `push`              | Compares `before` against `after` and applies the filter. The first push to a branch (where `before` is the zero SHA) fails open with `should-run=true`. |
| `workflow_dispatch` | Default `always-run-for` includes this event, so `should-run=true` without any API call. Override `always-run-for` to change.                            |
| `schedule`          | Default `always-run-for` includes this event, so `should-run=true` without any API call. Override `always-run-for` to change.                            |
| any other event     | Returns `should-run=true` (fail open).                                                                                                                   |

## Failure mode

The action is designed to **fail open**: any unexpected error - API failure,
malformed payload, unknown event type - results in `should-run=true` and a
warning annotation explaining why filtering could not run. The rationale is that
a broken filter blocking real work is worse than a broken filter letting an
extra workflow run.

If you need strict-fail semantics for your use case, layer an additional check
on the job that consumes this action's output.

## Usage

### Minimum example

```yaml
jobs:
  preflight:
    runs-on: ubuntu-latest
    outputs:
      should-run: ${{ steps.check.outputs.should-run }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: check
        uses: scottoffen/should-run@v0
        with:
          include: |
            src/**

  build:
    needs: preflight
    if: needs.preflight.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Running the real work"
```

### With ignore patterns

Useful when a top-level `include` directory contains files that should not
trigger a run (e.g. Markdown).

```yaml
- id: check
  uses: scottoffen/should-run@v0
  with:
    include: |
      src/**
      build/**
    ignore: |
      **/*.md
```

### Required status check with path filtering

The use case this action was built for. The workflow runs on every PR, so it can
satisfy a required status check. The build job is gated on the preflight result
and skips for PRs that touch only ignored paths.

```yaml
name: PR Build

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  preflight:
    runs-on: ubuntu-latest
    outputs:
      should-run: ${{ steps.check.outputs.should-run }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: check
        uses: scottoffen/should-run@v0
        with:
          include: |
            src/MyProject/**
            src/MyProject.Tests/**
            src/Directory.Build.props
            src/MyProject.sln
          ignore: |
            **/*.md

  build:
    needs: preflight
    if: needs.preflight.outputs.should-run == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: 10.0.x
      - run: dotnet test src/MyProject.sln
```

Set the **build** job (not the preflight job) as the required check in branch
protection. When the preflight reports `should-run=false`, the build job is
skipped, which counts as success - and the merge button unblocks for
documentation-only PRs.

### Using changed-files in downstream steps

```yaml
- id: check
  uses: scottoffen/should-run@v0
  with:
    include: |
      src/**
      tests/**

- name: List what changed
  if: steps.check.outputs.should-run == 'true'
  run: |
    echo "Files that triggered this run:"
    echo "${{ steps.check.outputs.changed-files }}"
```

### Pinning to a specific version

The examples above use the moving major-version tag `@v0`, which receives patch
and minor updates automatically. To pin to an exact version:

```yaml
uses: scottoffen/should-run@v0.1.0
```

## Development

Pull requests are welcome. To work on the action locally:

```bash
npm install
npm run all
```

`npm run all` runs format, lint, tests, coverage, and bundling. The bundled
output goes to `dist/index.js`, which is committed alongside the source - that's
the file GitHub Actions runners actually execute.

Tests are in `__tests__/main.test.ts`. The pure helpers (`parsePatterns`,
`parseAlwaysRunFor`, `filterChangedFiles`, `resolveRefs`) are tested directly;
`run()` is tested through ESM module mocks of `@actions/core` and
`@actions/github`.

## License

[MIT](./LICENSE)
