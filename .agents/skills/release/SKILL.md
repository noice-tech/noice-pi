---
name: release
description: Prepare a stable lockstep release of noice-tech/noice-pi, push its release commit and tag, and create the published GitHub Release with automatically generated notes. Use when asked to cut, prepare, make, or create a release of this repository. Stops before npm publication so the user can run the publish command themselves.
compatibility: Repository-specific to noice-tech/noice-pi. Requires git, gh, Node.js 24.13.0, pnpm 11.3.0, network access, and permission to push and create GitHub Releases.
---

# Release noice-pi

Prepare exactly one stable, lockstep release and create its GitHub Release. Leave npm publication to the user.

## Non-negotiable boundaries

- Work only in the `noice-tech/noice-pi` repository and from its root.
- Follow `CONTRIBUTING.md` as the source of truth for version and release policy.
- Never run `pnpm release:publish`, `npm publish`, or a workspace package's publish command.
- Never publish packages individually.
- Do not manually edit package versions, create the release commit, create the tag, or push them. `pnpm release:prepare` owns those operations and their validation.
- Use only canonical stable versions in `X.Y.Z` form. Do not create prereleases.
- Treat `release:prepare` as irreversible: it atomically pushes `main` and the tag. Obtain the user's confirmation of the exact version before running it unless the user already supplied that exact version in the current request.

## Choose the version

If the user supplied `X.Y.Z`, use it after checking that it is greater than every publishable package's current version.

If no version was supplied:

1. Read the current versions from the publishable `packages/*/package.json` files. They must be aligned.
2. Find the latest stable `vX.Y.Z` release tag.
3. Inspect the commits and diff from that tag through `HEAD`.
4. Apply the policy in `CONTRIBUTING.md`: breaking change = major, new backward-compatible behavior = minor, fixes or maintenance only = patch.
5. Recommend the resulting next version, briefly explain the bump, and ask the user to confirm that exact version.

Do not infer a lower bump merely from commit prefixes when the diff shows a larger change.

## Preflight

Before making changes:

1. Confirm the repository root with `git rev-parse --show-toplevel` and confirm `origin` resolves to `noice-tech/noice-pi`.
2. Confirm `git`, `gh`, `node`, and `pnpm` are available.
3. Confirm GitHub CLI authentication and repository access with `gh auth status` and `gh repo view noice-tech/noice-pi`.
4. Confirm the requested tag and GitHub Release do not conflict with an existing release.

Do not work around a dirty tree, a branch other than `main`, divergence from `origin/main`, a version conflict, failed checks, or failed authentication. Report the blocker instead. The preparation script repeats the critical Git and version checks; let it do so.

## Prepare and create the release

Set `version` to the confirmed version and `tag` to `v${version}`.

### 1. Prepare

Run the repository's workflow unchanged:

```bash
pnpm release:prepare "$version"
```

This runs all checks, updates every publishable package manifest, commits `Release X.Y.Z`, creates the annotated tag, and atomically pushes `main` and the tag. It does not publish to npm.

If it fails, stop and preserve the state for diagnosis. Follow recovery instructions printed by the script. Do not guess whether a failed push reached the remote and do not rerun preparation blindly.

### 2. Create the published GitHub Release

Only after preparation succeeds, run:

```bash
gh release create "$tag" \
  --repo noice-tech/noice-pi \
  --verify-tag \
  --title "$tag" \
  --generate-notes
```

Do not pass `--draft` or `--prerelease`. GitHub's generated notes are the changelog; do not replace them with invented notes.

### 3. Verify

Read the release back:

```bash
gh release view "$tag" \
  --repo noice-tech/noice-pi \
  --json isDraft,isPrerelease,tagName,url
```

Verify that:

- `tagName` equals the requested tag;
- `isDraft` is `false`;
- `isPrerelease` is `false`; and
- the tag points to the current `main` commit locally and on `origin`.

If release creation reports an error after the request may have reached GitHub, inspect it with `gh release view` before retrying. If a release for the tag already exists, do not overwrite or recreate it; accept it only if all verification conditions pass. Otherwise stop and explain the mismatch.

## Finish

Report:

- the released version;
- the GitHub Release URL;
- that release preparation and GitHub Release creation are complete;
- that nothing was published to npm; and
- the only remaining command for the user:

```bash
pnpm release:publish X.Y.Z
```

Do not run that command.
