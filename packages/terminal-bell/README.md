# 🔔 @noice-tech/pi-terminal-bell

Ring your terminal when Pi finishes a long run.

## Install

```bash
pi install -l npm:@noice-tech/pi-terminal-bell
```

## Use

There are no slash commands. The extension writes one standard BEL character after an interactive Pi run lasting at least 10 seconds.

Set a different minimum duration in seconds, or use `0` for every run:

```bash
PI_TERMINAL_BELL_MIN_DURATION=30 pi
```

It runs only in TUI mode with TTY output. Your terminal decides whether BEL produces sound, a visual indicator, or an attention request.

## Terminal setup

Test BEL handling with:

```bash
printf '\a'
```

For Ghostty, set `bell-features = attention,title,border`; add `system` for a system alert. See the [Ghostty bell documentation](https://ghostty.org/docs/vt/control/bel).
