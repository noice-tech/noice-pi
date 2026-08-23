# @noice-tech/pi-lazy-ladder

Opt-in Pi prompt templates for coding tasks that benefit from a deliberately minimal, senior-engineer approach.

## The seven-step ladder

Lazy Ladder asks Pi to understand the affected code and then stop at the first sufficient solution:

1. Skip work that does not need to exist (YAGNI).
2. Reuse what the codebase already provides.
3. Prefer the standard library.
4. Prefer native platform features.
5. Reuse installed dependencies.
6. Use one line when one line is enough.
7. Otherwise, write the minimum custom code that works.

It favors root-cause fixes, small diffs, and lightweight checks without removing required validation, security, accessibility, data-loss protection, or hardware calibration.

## Opt-in by design

Lazy Ladder is a prompt-only package. It registers Markdown prompt templates, not an extension, and uses no lifecycle hooks, persistent state, status UI, or system-prompt injection. Each command affects only the request that invokes it; prompts that do not invoke Lazy Ladder are unaffected.

## Choose an intensity

- **Full** applies every rung and stops at the simplest solution that meets the actual need.
- **Ultra** first challenges whether the work is needed and prefers deletion before addition.

## Review or repository audit

`/lazyladder-review` is a read-only review of over-engineering in the current diff or a supplied scope. `/lazyladder-repo-audit` is a read-only scan of the entire repository. Neither command applies fixes.

## Install

```bash
pi install -l npm:@noice-tech/pi-lazy-ladder
```

## Commands

| Command                      | What it does                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `/lazyladder <task>`         | Applies the complete minimal-solution ladder.                                    |
| `/lazyladder-ultra <task>`   | Challenges the requirement and prefers deletion before addition.                 |
| `/lazyladder-review [scope]` | Reviews the current diff or supplied scope for over-engineering without editing. |
| `/lazyladder-repo-audit`     | Audits the whole repository for over-engineering without editing.                |

## Lazy Ladder and Ponytail

Lazy Ladder is inspired by the official [Ponytail](https://github.com/DietrichGebert/ponytail) extension, but takes a more manual and opinionated approach: invoke it only for tasks where you want its minimal-solution ladder. Ponytail's persistent mode is useful when its behavior should apply throughout a session. These are different workflow tradeoffs; neither approach is universally superior.

Lazy Ladder is neither the official Ponytail plugin nor affiliated with its maintainers. Its prompt design references Ponytail source commit [`2ed6c52c9d7e5e56942508591085fd45dea277d3`](https://github.com/DietrichGebert/ponytail/commit/2ed6c52c9d7e5e56942508591085fd45dea277d3).
