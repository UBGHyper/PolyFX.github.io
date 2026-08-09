# PolyFX Shaders

Graphics overhaul mod for [PolyTrack](https://www.kodub.com/apps/polytrack). Ambient occlusion,
bloom, tone mapping, god rays, screen-space reflections, a day/night sky, real headlights and brake
lights, underglow. All opt-in graphics presets on top of the stock look, and the default (Off) preset
touches nothing at all.

Unofficial, not affiliated with Kodub. No game assets are shipped in this repo. `app_src/` and
`extracted/` are built locally from your own PolyTrack install and are gitignored.

## Install

Add this as a custom mod URL in [PolyModLoader](https://polymodloader.com):

```
https://cdn.polymodloader.com/gh/UBGHyper/PolyFX.github.io/main/release
```

Settings show up under **Realistic Shading**: Graphics Preset (default Balanced), Time of Day, and
Underglow. In-game, press **`** (backtick) for a live tuning panel with every parameter as a slider.
**F2** is a free-fly photo mode, **F9** saves a screenshot.

## Local dev setup

You need your own extracted copy of the game to build or test against. Nothing here ships one.

1. Find `resources/app.asar` inside your PolyTrack install folder.
2. `npm install`
3. `npm run setup:dev -- --asar "C:\path\to\resources\app.asar"`

This extracts the game into `app_src/` and patches `main.bundle.js` with the same render hook
`src/main.mod.js` installs through PolyModLoader, so you can test the mod without PolyModLoader at
all.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Builds both flavors: `dist/PolyFX` (for PolyModLoader) and `app_src/mod` (direct-patch, for local testing). |
| `npm run build:watch` | Same, rebuilds on save. |
| `npm run dev` | Serves `app_src/` so you can open the direct-patch flavor in a browser tab. |
| `npm run serve:pml` | Serves `dist/PolyFX` locally so PolyModLoader can install it as a custom URL before anything's published. Run it on the machine that's actually running PolyTrack. |
| `npm run shots` | Screenshot bench (Playwright) — captures every preset at a fixed spot in the game and records frame time. Uses your real GPU by default; `--headless` falls back to software rendering. |
| `npm test` | Two checks, see below. Skip cleanly if you haven't run `setup:dev` yet. |
| `npm run release` | Builds and fills in `release/` — the folder PolyModLoader's CDN actually serves. Run before pushing. |

## Publishing an update

`release/` is committed (unlike `dist/`, which is gitignored) — it's what the CDN URL above pulls
straight from this repo.

```
npm run release
git add release/ src/pml/
git commit -m "..."
git push
```

PolyModLoader caches mods pretty aggressively. If a change doesn't seem to show up for people, add a
new version folder (e.g. `1.0.1/`) under `src/pml/` and point `src/pml/manifest.json`'s
`latest["0.6.2"]` at it — that forces a fresh fetch instead of serving a cached copy.

## Tests

```
npm test
```

- `test/mixin-tokens.test.mjs` checks that `src/main.mod.js`'s render hook still matches the game's
  actual code. PolyModLoader patches the game by finding exact text inside one specific method
  (`V.prototype.update`) and splicing in new code — if that text shifts even slightly (extra
  whitespace, wrong method boundary), the patch silently fails and the mod does nothing. This test
  replays PolyModLoader's own patching logic against a real extracted copy of the game so that kind
  of failure gets caught before it ships instead of after.
- `test/stock-safety.test.mjs` checks that with the graphics preset at Off, PolyFX never touches
  anything in the scene at all.

## More detail

[PLAN.md](PLAN.md) covers the current architecture. [ROADMAP.md](ROADMAP.md) covers what's built vs.
still open — weather, TAA, path-traced photo mode, and more.
