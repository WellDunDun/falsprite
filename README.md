# FalSprite

Game-ready sprite sheet animations from a single text prompt. Built on [Replicate](https://replicate.com) — one API token powers everything.

![FalSprite](https://img.shields.io/badge/powered_by-Replicate-e8607a) ![License](https://img.shields.io/badge/license-MIT-blue)

## What it does

Type a character description, pick a grid size, choose animation actions — FalSprite generates a full 4K sprite sheet with transparent background and animated preview. A post-processing CLI then turns the raw sheet into game-ready output: jitter-free aligned frames, optional AI frame interpolation, and a ready-to-use Godot `SpriteFrames` resource.

**Pipeline (all on Replicate):**
- **google/nano-banana-2** — image generation (4K sprite sheet)
- **google/gemini-2.5-flash** — intelligent prompt rewriting with character design + choreography
- **bria/remove-background** — background removal
- **google-research/frame-interpolation** (FILM) — optional in-between frames for smoother animation

## Features

- **4K generation**: up to 1024px per frame on a 4x4 grid
- **Configurable grid**: 2x2, 3x3, 4x4, 5x5, 6x6
- **Multi-action selection**: pick multiple animation actions per grid row (idle, walk, run, attack, cast, jump, dance, death, dodge, or custom)
- **LLM prompt rewrite**: your simple prompt becomes a detailed character + choreography direction
- **Auto background removal**: BRIA removes the background automatically
- **Live preview**: real-time frame-by-frame animation with FPS control
- **Downloads**: sprite sheet PNG, transparent PNG, animated GIF
- **Reference image**: upload a reference to guide the generation
- **Post-processing CLI**: baseline alignment, per-frame bg removal, FILM interpolation, Godot export

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:8787](http://localhost:8787)

You need a **Replicate API token** — get one at [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens). That single token covers all services. You can paste it in the UI or set `REPLICATE_API_TOKEN` in your environment.

## Post-processing for Godot

The web UI gives you a raw sheet; `process-sprites.mjs` makes it game-ready:

```bash
export REPLICATE_API_TOKEN=r8_...

node process-sprites.mjs --input sprite-sheet-4x4-4k.png --grid 4 \
  --name hero --actions idle,walk,run,attack --fps 10 --interpolate
```

What it does, in order:

1. **Slices** the sheet into frames
2. **Interpolates** (`--interpolate`) — FILM generates an in-between frame for every adjacent pair *and* the loop-closing pair, doubling frames per row (4 → 8)
3. **Removes backgrounds per frame** — cleaner edges than whole-sheet removal (`--bg local` for a free offline chroma-key, `--bg none` if already transparent)
4. **Aligns frames** — re-centers each silhouette and pins feet to a shared baseline, eliminating the frame-to-frame jitter typical of AI grid sheets (`--anchor center|none` for jump/fly rows)
5. **Exports** to `output/<name>/`:
   - `sheet.png` — aligned, transparent sheet
   - `frames/` — individual transparent PNGs per animation frame
   - `<name>.tres` — Godot 4 `SpriteFrames` resource (one looping animation per row)
   - `metadata.json` — frame sizes, animation table, `hframes`/`vframes`

**In Godot:** copy `sheet.png` + `<name>.tres` into your project (default expected path `res://sprites/<name>/`, override with `--res-path`), add an `AnimatedSprite2D`, and set its `sprite_frames` to the `.tres`. Each grid row becomes a named looping animation.

## Dev tools

```bash
node batch-generate.mjs --count 10 --grid 4      # bulk-generate showcase sheets
node process-showcase.mjs                        # bg-remove + GIF showcase entries
```

Both read `REPLICATE_API_TOKEN` or accept `--key`.

## Deploy to Vercel

```bash
npm i -g vercel
vercel
```

The project includes Vercel-ready serverless functions in `api/` and static assets in `public/`. Note: a full 4K generation can approach serverless time limits — local use is the primary workflow.

## Project structure

```
├── public/               Static frontend
│   ├── index.html        Main app
│   ├── app.js            Frontend logic
│   ├── styles.css        Styles
│   ├── showcase/         Example GIFs
│   └── select.html       Showcase curation tool
├── api/                  Vercel serverless functions
│   ├── generate.mjs      Sprite generation endpoint
│   ├── upload.mjs        Image upload endpoint
│   └── media.mjs         Media proxy endpoint
├── lib/replicate.mjs     Shared Replicate API helpers
├── server.mjs            Local dev server
├── process-sprites.mjs   Post-processor: align + interpolate + Godot export
├── batch-generate.mjs    Batch generation tool (dev)
└── process-showcase.mjs  Showcase processor (dev)
```

## Tech stack

- **Frontend**: Vanilla JS, no framework, no build step
- **Backend**: Node.js (native HTTP server for dev, Vercel serverless for prod)
- **AI**: All via Replicate (nano-banana-2, Gemini 2.5 Flash, BRIA, FILM)
- **Imaging**: sharp (slicing, alignment, compositing), gif.js (browser) + gifenc (server-side)

## License

MIT
