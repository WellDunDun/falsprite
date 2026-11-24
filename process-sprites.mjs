#!/usr/bin/env node
// ─────────────────────────────────────────────────
// FalSprite post-processor — turns a generated sheet into game-ready sprites.
//
// Pipeline: slice grid → (optional) FILM frame interpolation → per-frame
// background removal → baseline alignment → aligned sheet + individual
// frames + metadata + Godot 4 SpriteFrames (.tres).
//
// Usage:
//   node process-sprites.mjs --input sheet.png [--grid 4] [--name hero] [options]
//
// Options:
//   --input PATH|URL   sprite sheet PNG (required)
//   --grid N           grid size used at generation (default 4)
//   --name NAME        character name for output folder (default: input basename)
//   --out DIR          output root directory (default ./output)
//   --actions LIST     comma-separated action name per row, e.g. "idle,walk,run,attack"
//                      (default row0..rowN; used for frame names + Godot animations)
//   --fps N            playback fps written to metadata + .tres (default 10)
//   --key TOKEN        Replicate token (falls back to REPLICATE_API_TOKEN)
//   --bg MODE          replicate | local | none (default: replicate if token, else local)
//                      "local" = flat-color chroma key, free/offline, needs the solid
//                      background the generator prompts for. "none" = input already transparent.
//   --interpolate      insert FILM in-between frames (doubles frames per row, incl. the
//                      loop-closing frame; requires a Replicate token)
//   --anchor MODE      baseline | center | none (default baseline). Baseline pins feet to a
//                      shared ground line — use "center" or "none" for jump/fly rows.
//   --res-path PATH    res:// folder the sheet will live at in Godot
//                      (default res://sprites/<name>)
//   --concurrency N    parallel Replicate calls (default 4)
// ─────────────────────────────────────────────────

import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  REMOVE_BG_MODEL, INTERPOLATION_MODEL,
  createClient, resolveLatestVersion, extractOutputUrl, validateHttpUrl
} from "./lib/replicate.mjs";

// ── CLI args ──────────────────────────────────

function parseArgs() {
  const raw = process.argv.slice(2);
  const map = {};
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startsWith("--")) {
      const key = raw[i].slice(2);
      if (i + 1 < raw.length && !raw[i + 1].startsWith("--")) {
        map[key] = raw[i + 1];
        i++;
      } else {
        map[key] = "true";
      }
    }
  }
  return map;
}

const args = parseArgs();
const INPUT = args.input || "";
const GRID = Math.max(2, Math.min(6, parseInt(args.grid || "4", 10)));
const TOKEN = args.key || process.env.REPLICATE_API_TOKEN || "";
const NAME = (args.name || path.basename(INPUT, path.extname(INPUT)) || "sprite")
  .replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
const OUT_ROOT = args.out || "output";
const OUT_DIR = path.join(OUT_ROOT, NAME);
const FPS = Math.max(1, Math.min(60, parseInt(args.fps || "10", 10)));
const INTERPOLATE = "interpolate" in args;
const ANCHOR = ["baseline", "center", "none"].includes(args.anchor) ? args.anchor : "baseline";
const BG_MODE = ["replicate", "local", "none"].includes(args.bg) ? args.bg : (TOKEN ? "replicate" : "local");
const RES_PATH = (args["res-path"] || `res://sprites/${NAME}`).replace(/\/$/, "");
const CONCURRENCY = Math.max(1, Math.min(10, parseInt(args.concurrency || "4", 10)));

const ACTIONS = (args.actions || "")
  .split(",").map(s => s.trim().replace(/[^a-z0-9_-]+/gi, "_").toLowerCase()).filter(Boolean);

if (!INPUT) {
  console.error("Usage: node process-sprites.mjs --input sheet.png [--grid 4] [--name hero]");
  console.error("       [--actions idle,walk,run,attack] [--fps 10] [--bg replicate|local|none]");
  console.error("       [--interpolate] [--anchor baseline|center|none] [--out output]");
  process.exit(1);
}
if ((BG_MODE === "replicate" || INTERPOLATE) && !TOKEN) {
  console.error("A Replicate token is required for --bg replicate and --interpolate.");
  console.error("Pass --key or set REPLICATE_API_TOKEN, or use --bg local.");
  process.exit(1);
}

// ── Small helpers ─────────────────────────────

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loadInput(input) {
  if (validateHttpUrl(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`Failed to fetch input (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(input);
}

async function downloadBuffer(url) {
  const headers = {};
  if (new URL(url).hostname === "api.replicate.com") headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Replicate steps ───────────────────────────

const _client = createClient(TOKEN);

async function replicateRemoveBackground(pngBuffer, label) {
  const upFile = await _client.files.create(pngBuffer);
  const output = await _client.run(REMOVE_BG_MODEL, { input: { image_url: upFile.urls.get, preserve_alpha: true } });
  const outUrl = extractOutputUrl(output);
  if (!outUrl) throw new Error(`BG removal returned no URL (${label})`);
  const buffer = await downloadBuffer(outUrl);
  return sharp(buffer).ensureAlpha().png().toBuffer();
}

async function interpolatePair(urlA, urlB, label) {
  const version = await resolveLatestVersion(_client, INTERPOLATION_MODEL);
  const output = await _client.run(`${INTERPOLATION_MODEL}:${version}`, {
    input: {
      frame1: urlA,
      frame2: urlB,
      times_to_interpolate: 1
    }
  });
  const outUrl = extractOutputUrl(output);
  if (!outUrl) throw new Error(`Interpolation returned no URL (${label})`);
  const buffer = await downloadBuffer(outUrl);
  return sharp(buffer).ensureAlpha().png().toBuffer();
}

// ── Local chroma-key background removal ───────
// Estimates the flat background color from the frame border, then maps color
// distance to alpha. Works because the generator prompts for a plain solid
// background. Cloud BRIA (--bg replicate) is higher quality for soft edges.

async function localRemoveBackground(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  // Modal border color, quantized to 16-step buckets
  const buckets = new Map();
  const border = 2;
  const sample = (x, y) => {
    const p = (y * w + x) * 4;
    const key = `${data[p] >> 4},${data[p + 1] >> 4},${data[p + 2] >> 4}`;
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += data[p]; b.g += data[p + 1]; b.b += data[p + 2];
    buckets.set(key, b);
  };
  for (let x = 0; x < w; x++) for (let y = 0; y < border; y++) { sample(x, y); sample(x, h - 1 - y); }
  for (let y = 0; y < h; y++) for (let x = 0; x < border; x++) { sample(x, y); sample(w - 1 - x, y); }

  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  const bg = { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };

  const T0 = 28, T1 = 70;
  for (let p = 0; p < data.length; p += 4) {
    const d = Math.sqrt((data[p] - bg.r) ** 2 + (data[p + 1] - bg.g) ** 2 + (data[p + 2] - bg.b) ** 2);
    const a = d <= T0 ? 0 : d >= T1 ? 255 : Math.round(((d - T0) / (T1 - T0)) * 255);
    data[p + 3] = Math.min(data[p + 3], a);
  }

  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

// ── Alignment ─────────────────────────────────

async function alphaBoundingBox(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const threshold = 24;
  let minX = w, minY = h, maxX = -1, maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Re-place each frame's content on a fresh transparent canvas so the silhouette
// is horizontally centered and (for baseline mode) the feet sit on a shared
// ground line. This is what kills the frame-to-frame jitter in-engine.
// targetBottom is shared across ALL rows so animations don't pop when switching.
async function alignFrames(frames, boxes, cellW, cellH, targetBottom) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  return Promise.all(frames.map(async (frame, i) => {
    const box = boxes[i];
    if (!box) return frame;

    const content = await sharp(frame).extract(box).png().toBuffer();
    const left = clamp(Math.round(cellW / 2 - box.width / 2), 0, cellW - box.width);
    let top;
    if (ANCHOR === "baseline") {
      top = clamp(targetBottom - box.height + 1, 0, cellH - box.height);
    } else {
      top = clamp(Math.round(cellH / 2 - box.height / 2), 0, cellH - box.height);
    }

    return sharp({ create: { width: cellW, height: cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: content, left, top }])
      .png()
      .toBuffer();
  }));
}

// ── Godot SpriteFrames (.tres) export ─────────

function buildSpriteFramesTres(rows, cellW, cellH, fps, resPath) {
  const totalFrames = rows.reduce((sum, r) => sum + r.frames.length, 0);
  const lines = [];
  lines.push(`[gd_resource type="SpriteFrames" load_steps=${totalFrames + 2} format=3]`);
  lines.push("");
  lines.push(`[ext_resource type="Texture2D" path="${resPath}/sheet.png" id="1_sheet"]`);
  lines.push("");

  rows.forEach((row, r) => {
    row.frames.forEach((_, i) => {
      lines.push(`[sub_resource type="AtlasTexture" id="Atlas_${r}_${i}"]`);
      lines.push(`atlas = ExtResource("1_sheet")`);
      lines.push(`region = Rect2(${i * cellW}, ${r * cellH}, ${cellW}, ${cellH})`);
      lines.push("");
    });
  });

  const animations = rows.map((row, r) => {
    const frameRefs = row.frames
      .map((_, i) => `{\n"duration": 1.0,\n"texture": SubResource("Atlas_${r}_${i}")\n}`)
      .join(", ");
    return `{\n"frames": [${frameRefs}],\n"loop": true,\n"name": &"${row.name}",\n"speed": ${fps.toFixed(1)}\n}`;
  }).join(", ");

  lines.push("[resource]");
  lines.push(`animations = [${animations}]`);
  lines.push("");
  return lines.join("\n");
}

// ── Main ──────────────────────────────────────

async function main() {
  console.log(`\n  FalSprite post-processor`);
  console.log(`  ────────────────────────`);
  console.log(`  Input: ${INPUT}`);
  console.log(`  Grid: ${GRID}x${GRID} | bg: ${BG_MODE} | anchor: ${ANCHOR} | interpolate: ${INTERPOLATE ? "on" : "off"}\n`);

  const sheetBuffer = await loadInput(INPUT);
  const meta = await sharp(sheetBuffer).metadata();
  const cellW = Math.floor(meta.width / GRID);
  const cellH = Math.floor(meta.height / GRID);
  console.log(`  Sheet ${meta.width}x${meta.height} → ${GRID * GRID} cells of ${cellW}x${cellH}`);

  // 1. Slice
  const rows = [];
  for (let r = 0; r < GRID; r++) {
    const frames = [];
    for (let c = 0; c < GRID; c++) {
      frames.push(await sharp(sheetBuffer)
        .extract({ left: c * cellW, top: r * cellH, width: cellW, height: cellH })
        .png()
        .toBuffer());
    }
    rows.push({ name: ACTIONS[r] || `row${r}`, frames });
  }
  console.log(`  Sliced ${GRID * GRID} frames`);

  // 2. Interpolation (on original frames, before bg removal — FILM wants full RGB)
  if (INTERPOLATE) {
    process.stdout.write(`  Interpolating (${GRID} in-betweens per row, incl. loop frame)... `);
    for (const row of rows) {
      // Upload each source frame once; each is used by two pairs
      const urls = await mapLimit(row.frames, CONCURRENCY, async (f) => {
        const file = await _client.files.create(f);
        return file.urls.get;
      });

      const pairs = row.frames.map((_, i) => [i, (i + 1) % row.frames.length]);
      const mids = await mapLimit(pairs, CONCURRENCY, ([a, b]) =>
        interpolatePair(urls[a], urls[b], `${row.name} ${a}→${b}`));

      const merged = [];
      row.frames.forEach((frame, i) => { merged.push(frame, mids[i]); });
      row.frames = merged;
      process.stdout.write(`${row.name} `);
    }
    console.log("✓");
  }

  // 3. Background removal
  if (BG_MODE !== "none") {
    process.stdout.write(`  Removing backgrounds (${BG_MODE})... `);
    for (const row of rows) {
      row.frames = await mapLimit(row.frames, CONCURRENCY, (frame, i) =>
        BG_MODE === "replicate"
          ? replicateRemoveBackground(frame, `${NAME}-${row.name}-${i}`)
          : localRemoveBackground(frame));
      process.stdout.write(`${row.name} `);
    }
    console.log("✓");
  }

  // 4. Alignment
  if (ANCHOR !== "none") {
    process.stdout.write(`  Aligning frames (${ANCHOR})... `);
    const rowBoxes = [];
    const allBottoms = [];
    for (const row of rows) {
      const boxes = await Promise.all(row.frames.map(f => alphaBoundingBox(f)));
      rowBoxes.push(boxes);
      for (const b of boxes) if (b) allBottoms.push(b.top + b.height - 1);
    }
    const targetBottom = allBottoms.length > 0 ? median(allBottoms) : cellH - 1;
    for (let r = 0; r < rows.length; r++) {
      rows[r].frames = await alignFrames(rows[r].frames, rowBoxes[r], cellW, cellH, targetBottom);
    }
    console.log("✓");
  }

  // 5. Outputs
  const framesDir = path.join(OUT_DIR, "frames");
  await mkdir(framesDir, { recursive: true });

  const framesPerRow = rows[0].frames.length;
  const composites = [];
  for (let r = 0; r < rows.length; r++) {
    for (let i = 0; i < rows[r].frames.length; i++) {
      composites.push({ input: rows[r].frames[i], left: i * cellW, top: r * cellH });
      await writeFile(path.join(framesDir, `${rows[r].name}_${String(i).padStart(2, "0")}.png`), rows[r].frames[i]);
    }
  }

  const sheet = await sharp({
    create: { width: cellW * framesPerRow, height: cellH * rows.length, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).composite(composites).png().toBuffer();
  await writeFile(path.join(OUT_DIR, "sheet.png"), sheet);

  const metadata = {
    name: NAME,
    source: INPUT,
    grid: `${GRID}x${GRID}`,
    frameWidth: cellW,
    frameHeight: cellH,
    framesPerRow,
    interpolated: INTERPOLATE,
    anchor: ANCHOR,
    fps: FPS,
    animations: rows.map(r => ({ name: r.name, frames: r.frames.length })),
    godot: { hframes: framesPerRow, vframes: rows.length, spriteFrames: `${NAME}.tres` },
    generatedAt: new Date().toISOString()
  };
  await writeFile(path.join(OUT_DIR, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  await writeFile(path.join(OUT_DIR, `${NAME}.tres`), buildSpriteFramesTres(rows, cellW, cellH, FPS, RES_PATH));

  console.log(`\n  Done → ${OUT_DIR}/`);
  console.log(`    sheet.png       aligned ${framesPerRow}x${rows.length} sheet (${cellW * framesPerRow}x${cellH * rows.length})`);
  console.log(`    frames/         ${framesPerRow * rows.length} individual transparent PNGs`);
  console.log(`    ${NAME}.tres    Godot SpriteFrames — copy sheet.png + .tres into ${RES_PATH}/`);
  console.log(`    metadata.json   frame sizes + animation table\n`);
  console.log(`  In Godot: add an AnimatedSprite2D, set its sprite_frames to ${NAME}.tres.`);
  console.log(`  Animations: ${rows.map(r => r.name).join(", ")} (loop, ${FPS} fps)\n`);
}

main().catch(err => {
  console.error(`\n  Fatal: ${err.message}\n`);
  process.exit(1);
});
