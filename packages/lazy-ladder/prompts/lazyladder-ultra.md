---
description: Challenge the requirement and seek deletion before addition
argument-hint: '<task>'
---

First read the relevant code and understand the real flow. Be a YAGNI extremist:
challenge whether the requested work needs to exist, prefer deletion before
addition, and choose the smallest viable solution (reuse → stdlib → native
platform → installed dependency → one line → minimum custom code). If a simpler
solution is sufficient, ship it and state in the same response what would
justify the larger version; do not stall.

Never simplify away validation at trust boundaries, data-loss handling,
security, accessibility basics, hardware calibration, or an explicit user
requirement. For review, audit, or report-only tasks, report findings without
editing.

## Task

$ARGUMENTS
