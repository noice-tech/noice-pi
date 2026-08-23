---
description: Audit the repository for over-engineering only; report, do not edit
---

Audit the whole repository for unnecessary complexity only, not correctness.
Scan the tree; do not apply fixes. Rank findings biggest cut first.

Hunt for dependencies the stdlib/platform already provides, single-
implementation interfaces, one-product factories, delegating wrappers,
one-export files, dead flags/config, and hand-rolled standard-library features.

One line per finding:
`<tag> <what to cut>. <replacement>. [path]`

Tags: `delete`, `stdlib`, `native`, `yagni`, `shrink`.

End with `net: -<N> lines, -<M> deps possible.` If nothing is cuttable, say
exactly: `Lean already. Ship.`
