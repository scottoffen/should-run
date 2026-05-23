# Releasing a GitHub Action

Reference doc for tagging, releasing, and (optionally) publishing a TypeScript
GitHub Action to the Marketplace. Written against the
`actions/typescript-action` template's conventions.

## Before tagging

Verify the state of the repository:

1. All CI workflows green (Lint, CI, Check dist/, CodeQL).
1. Working tree clean (`git status` shows nothing to commit).
1. `dist/index.js` is up to date with `src/`. If you're unsure, run
   `npm run bundle` and check `git status` -- anything in `dist/` means the
   committed bundle was stale.
1. Readme accurately describes the current inputs, outputs, and behavior.
1. Decide the version number. SemVer:
   - **Patch** (`v0.1.1`): bugfixes, no behavior change visible to consumers.
   - **Minor** (`v0.2.0`): new inputs/outputs, new optional behavior, no
     breaking change to existing usage.
   - **Major** (`v1.0.0`): any change that could break existing consumers
     (renaming/removing an input, changing default behavior, changing output
     format).
   - Pre-1.0, minor bumps can include breaking changes by convention. Use
     `v0.x.y` until you're ready to commit to a stable API.

## Tag and push

From the repository locally, on the commit you want to release:

```bash
# Create the exact-version tag
git tag v0.1.0
git push origin v0.1.0

# Create or move the major-version tag to point at the new release.
# Consumers using `@v0` will get this version automatically.
git tag -f v0 v0.1.0
git push --force origin v0
```

The `-f` and `--force` are required when moving an existing major tag (i.e. on
every release after the first). They're not destructive -- they just re-point
the tag.

## Create a GitHub Release

A Git tag is enough to make `uses: owner/repo@v0.1.0` work. A _Release_ on top
of the tag adds a human-readable changelog and is required to publish to
Marketplace.

### Using the gh CLI

```bash
gh release create v0.1.0 \
  --title "v0.1.0" \
  --notes "Initial release." \
  --target main
```

For auto-generated release notes based on PRs and commits since the last
release:

```bash
gh release create v0.1.0 \
  --title "v0.1.0" \
  --generate-notes
```

### Using the web UI

1. Repository → Releases → "Draft a new release".
1. "Choose a tag" → pick `v0.1.0` (or create a new tag from this view).
1. Title: `v0.1.0`.
1. Description: write release notes, or click "Generate release notes" to
   auto-populate from PRs and commits.
1. Click "Publish release".

## Publish to Marketplace (optional, one-time setup + per-release)

Marketplace requires the repository's `action.yml` to have `name`,
`description`, and `branding` (icon + color). The readme must clearly describe
the action.

### First-time setup

1. Marketplace name must be unique. Check
   `https://github.com/marketplace?type=actions&query=<name>` before listing.
1. In the Release editor (web UI), check **"Publish this release to the GitHub
   Marketplace"**.
1. Accept the Developer Agreement if prompted (one-time per account).
1. Pick **primary category** (e.g. "Continuous integration") and an optional
   secondary category.
1. Confirm the action's branding renders correctly in the preview.
1. Publish the release.

The action becomes available at `https://github.com/marketplace/actions/<name>`.

### Subsequent releases

Each new release can also be pushed to Marketplace by re-checking the "Publish
to Marketplace" checkbox in the release editor. The category selections from the
first listing carry forward.

## After releasing

1. Verify the major tag (`v0`) points at the new release commit:

   ```bash
   git ls-remote --tags origin | grep -E "(v0|v0\.1\.0)$"
   ```

   Both should show the same commit SHA.

1. Smoke-test from a consumer repository: bump `uses:` to the new version and
   confirm it still works.
1. If anything is broken: fix forward with a new patch release. Do NOT re-tag an
   existing version -- consumers may have already cached the broken version
   against that tag.

## Quick reference

| Step                 | Command / Action                                     |
| -------------------- | ---------------------------------------------------- |
| Verify clean state   | `git status` → empty; CI green                       |
| Create version tag   | `git tag vX.Y.Z && git push origin vX.Y.Z`           |
| Move major tag       | `git tag -f vX vX.Y.Z && git push --force origin vX` |
| Create release       | `gh release create vX.Y.Z --generate-notes`          |
| List to Marketplace  | Web UI: check the Marketplace box in release editor  |
| Verify after release | `git ls-remote --tags origin`                        |
