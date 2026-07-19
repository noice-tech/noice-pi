# 🔔 @noice-tech/pi-terminal-bell

A tiny [Pi](https://github.com/earendil-works/pi) extension that rings your terminal when Pi is ready.

## Install

```sh
pi install npm:@noice-tech/pi-terminal-bell
```

## How it works

Pi emits one standard BEL character after it fully settles. Short runs under 10 seconds are ignored, and non-interactive output is never touched.

Change the minimum duration in seconds—or use `0` to ring every time:

```sh
PI_TERMINAL_BELL_MIN_DURATION=30 pi
```

## Ghostty 👻

Choose how Ghostty presents the bell:

```ini
bell-features = attention,title,border
```

Add `system` if you also want the system alert. Test your setup with:

```sh
printf '\a'
```

See Ghostty’s [BEL](https://ghostty.org/docs/vt/control/bel) and [`bell-features`](https://ghostty.org/docs/config/reference#bell-features) docs.

## Why BEL?

One byte. No runtime dependencies. Works through interactive SSH and terminal multiplexers. Your terminal keeps control of sound and accessibility, so BEL may be audible, visual-only, suppressed, or require multiplexer configuration.

## Provenance

This package migrated from [`samohovets/pi-terminal-bell`](https://github.com/samohovets/pi-terminal-bell) at source snapshot [`63e5b6d`](https://github.com/samohovets/pi-terminal-bell/commit/63e5b6d68c9689f5609af15620bbbd7f7708e4db). The source repository remains the history and provenance record.

## License

[MIT](./LICENSE)
