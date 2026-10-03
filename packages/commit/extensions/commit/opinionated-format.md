# Opinionated format

Use one release-intent type:

- `feat`: new user-facing capability.
- `fix`: corrected user-visible bug.
- `improve`: refinement to an existing user-facing workflow, performance, or reliability.
- `internal`: non-user-facing infrastructure, tooling, refactors, tests, dependencies, or technical fixes. Do not classify technical-only fixes as `fix`.

Commits always use unscoped `type: description`. PR titles use `type: description` in zero/one-package repositories and `type(package): description` in multi-package workspaces. These are release-intent types, not Conventional Commits.

Determine package count from workspace configuration or independently built/published package roots. Exclude a private coordinating root manifest unless it is itself a package. Scope uses one primary package's workspace directory basename (e.g. `renderer`, not `@example/pi-renderer`), determined from PR intent and its full diff against the base. Incidental shared files/lockfiles do not override a clear primary package. Use `monorepo` for root-only, cross-cutting, or unclear multi-package work.

Write concrete descriptions, not vague value propositions. In the PR body:

- `Public summary`: one specific standalone user-facing sentence for feat/fix/improve; exactly `None.` for internal.
- `Context`: useful product/business or implementation context for future releases; may be internal.

Public summaries must work without repository access: no GitHub links, PR numbers, hashes, private URLs, internal implementation details, or forced marketing. Do not copy package scopes into them. GitHub Releases are internal shipping records; public changelog/social text is derived from these summaries.
