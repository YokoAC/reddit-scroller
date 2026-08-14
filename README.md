# Reddit Scroller

Auto-scrolls a Reddit feed in your normal Firefox on a second monitor, driven by
global numpad hotkeys — so you can keep reading without leaving a full-screen game.

Two halves:

- A **userscript** that runs inside your real, already-logged-in Firefox. It owns the
  scrolling, decides which post is "current", and draws the on-screen readout.
- A **Python daemon** that owns the global keyboard hook and hands commands to the
  userscript over `127.0.0.1`.

## Setup

**1. The daemon**

```bash
uv sync
uv run python -m reddit_scroller
```

Leave it running. It prints its bindings on start.

**2. The userscript**

1. Install [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/).
2. Build the script: `cd userscript && npm install && npm run build`
3. Open the Violentmonkey dashboard → **+** → **Install from file**, and pick
   `userscript/dist/reddit-scroller.user.js`.
4. Open `https://www.reddit.com`. The HUD appears bottom-right with a green dot
   next to "daemon".

The built file is already committed, so installing it does not require the build
step — but rerun `npm run build` and reinstall the file if you change the source.

## Controls

| Key | In the feed | In a thread |
|---|---|---|
| Numpad `0` | pause / resume scrolling | pause / resume scrolling |
| Numpad `+` / `-` | speed up / down by 15 px/s | speed up / down by 15 px/s |
| Numpad `8` / `2` | select previous / next post | scroll up / down a screen |
| Numpad `Enter` | open the selected post | — |
| Numpad `.` | — | back to the feed |

The selected post is outlined in blue and named in the HUD. While auto-scrolling it
follows whatever sits a quarter of the way down the screen; pressing `8` or `2` pins
your choice until it scrolls off.

Nothing is suppressed — your game still receives every one of these keys.

## Configuration

Copy `config.example.json` to `config.json` and edit. Every field is optional; anything
you leave out keeps its default.

| Field | Default | Meaning |
|---|---|---|
| `port` | `8765` | Loopback port. |
| `default_speed` | `90` | Starting scroll speed, px/s. |
| `speed_step` | `15` | Change per `faster` / `slower` press. |
| `speed_min` / `speed_max` | `15` / `600` | Speed limits. |
| `focus_line` | `0.25` | Where the "current post" line sits, as a fraction of screen height. |
| `bindings` | see above | Command → key name. |

Valid key names: `numpad0`–`numpad9`, `numpad_dot`, `numpad_plus`, `numpad_minus`,
`numpad_star`, `numpad_enter`.

Commands: `toggle`, `open`, `back`, `faster`, `slower`, `prev`, `next`.

`config.json` is gitignored — it's local to your machine. `config.example.json` is
the committed template.

## Troubleshooting

**The HUD says "no daemon".** The daemon is not running, or it is on a different port
than the userscript expects. Check `uv run python -m reddit_scroller` is up and that
`PORT` at the top of `userscript/src/main.js` matches `port` in your `config.json` —
these are two independent values and changing one without the other breaks the
connection. If you change `PORT`, rebuild the userscript (`npm run build`) and
reinstall it before the change takes effect.

**Hotkeys work on the desktop but not in the game.** Windows will not deliver hooked
keys from an elevated window to a non-elevated process. Run the daemon from an
Administrator terminal. Borderless-windowed mode also tends to behave better than
exclusive full-screen.

**The HUD says "no posts detected".** Reddit changed its markup and the
`shreddit-post` selector in `userscript/src/selection.js` needs updating. Scrolling
still works meanwhile.

**Nothing happens on any key.** Check the daemon's console — it logs every hotkey it
sees. If nothing appears there, the problem is the keyboard hook; if lines appear but
the page does not react, the problem is the transport.

## Development

```bash
uv run pytest              # daemon tests (51)
cd userscript && npm test  # userscript tests (86)
```
