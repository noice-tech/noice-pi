---
description: Review changes for over-engineering only; report, do not edit
argument-hint: '[scope]'
---

Review ${@:-the current code changes} for unnecessary complexity only, not
correctness. Do not apply fixes.

One line per finding:
`L<line>: <tag> <what to cut>. <replacement>.`
Use `<file>:L<line>` for multiple files.

Tags:

- `delete:` dead code, unused flexibility, speculative feature; replacement: nothing.
- `stdlib:` hand-rolled standard-library feature; name it.
- `native:` dependency/code duplicated by the platform; name it.
- `yagni:` one-implementation abstraction, unused config, or one-caller layer.
- `shrink:` same logic in fewer lines; show the shorter form.

End with `net: -<N> lines possible.` If there is nothing to cut, say exactly:
`Lean already. Ship.` A smoke test or small assert-based self-check is not bloat.

## Optional scope

$ARGUMENTS
