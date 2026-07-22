# 🔔 @noice-tech/pi-terminal-bell

Switch away from long Pi runs—your terminal alerts you when the agent settles.

## Install

```bash
pi install npm:@noice-tech/pi-terminal-bell
```

## Usage

There are no slash commands. The extension writes one standard BEL character after an interactive Pi run lasting at least 10 seconds.

It only runs in TUI mode with TTY output. Your terminal decides whether BEL produces sound, a visual indicator, or an attention request.

Set a different minimum duration in seconds, or use `0` for every eligible run:

```bash
PI_TERMINAL_BELL_MIN_DURATION=30 pi
```

## Terminal setup

Test the terminal's BEL handling with:

```bash
printf '\a'
```

For Ghostty, configure `bell-features = attention,title,border`; add `system` for a system alert. See the [Ghostty bell documentation](https://ghostty.org/docs/vt/control/bel).
