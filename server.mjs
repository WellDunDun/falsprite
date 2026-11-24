import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IMAGE_MODEL, REMOVE_BG_MODEL, REWRITE_MODEL, IMAGE_RESOLUTION,
  createClient, extractOutputText, extractOutputUrl,
  buildSpritePrompt, buildRewriteSystemPrompt,
  makeDefaultPrompt, validateHttpUrl
} from "./lib/replicate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const NUM_WORDS = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };

const MIME_BY_EXT = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) { reject(new Error("Payload too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function getApiToken(req, body = {}) {
  return (req.headers["x-replicate-token"] || body?.apiKey || process.env.REPLICATE_API_TOKEN || "").toString().trim();
}

// ── Handlers ────────────────────────────────────

async function handleUpload(req, res) {
  let body;
  try { body = await parseJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }

  const token = getApiToken(req, body);
  if (!token) { sendJson(res, 400, { error: "Missing Replicate API token" }); return; }

  const { data, contentType, filename } = body;
  if (!data || !contentType) { sendJson(res, 400, { error: "Missing data or contentType" }); return; }

  try {
    const buffer = Buffer.from(data, "base64");
    const client = createClient(token);
    const file = await client.files.create(buffer);
    sendJson(res, 200, { url: file.urls.get });
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

async function handleGenerate(req, res) {
  let body;
  try { body = await parseJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }

  const token = getApiToken(req, body);
  if (!token) { sendJson(res, 400, { error: "Missing Replicate API token" }); return; }

  const originalPrompt = (typeof body.prompt === "string" && body.prompt.trim()) ? body.prompt.trim() : makeDefaultPrompt();
  const gridSize = Math.max(2, Math.min(6, parseInt(body.gridSize, 10) || 4));
  const gridWord = NUM_WORDS[gridSize] || "four";
  const referenceImageUrl = typeof body.imageUrl === "string" && validateHttpUrl(body.imageUrl) ? body.imageUrl : "";
  const warnings = [];
  let rewrittenPrompt = originalPrompt;

  const client = createClient(token);

  // LLM rewrite
  if (referenceImageUrl) {
    warnings.push("Prompt rewrite skipped because a reference image was provided.");
  } else {
    try {
    const rewriteOutput = await client.run(REWRITE_MODEL, {
      input: {
        prompt: `Design the character and choreograph a ${gridWord}-beat animation loop for: ${originalPrompt}`,
        system_prompt: buildRewriteSystemPrompt(gridSize),
        max_completion_tokens: 500,
        temperature: 0.65
      }
    });
    const candidate = extractOutputText(rewriteOutput);
    if (candidate) rewrittenPrompt = candidate;
    else warnings.push("Rewrite returned unexpected format. Original prompt kept.");
    } catch (err) {
      warnings.push(`Rewrite skipped: ${err.message}`);
    }
  }

  // Sprite generation
  const spritePrompt = buildSpritePrompt(rewrittenPrompt, gridSize, { hasReference: Boolean(referenceImageUrl) });

  const spriteInput = {
    prompt: spritePrompt,
    aspect_ratio: "1:1",
    resolution: IMAGE_RESOLUTION,
    output_format: "png"
  };
  if (referenceImageUrl) spriteInput.image_input = [referenceImageUrl];

  let spriteUrl;
  try {
    const spriteOutput = await client.run(IMAGE_MODEL, { input: spriteInput });
    spriteUrl = extractOutputUrl(spriteOutput);
    if (!spriteUrl) throw new Error("No image URL in sprite result");
  } catch (err) {
    sendJson(res, 502, { error: `Sprite generation failed: ${err.message}`, warnings });
    return;
  }

  // Background removal
  let transparentSpriteUrl = "";
  try {
    const bgOutput = await client.run(REMOVE_BG_MODEL, { input: { image_url: spriteUrl } });
    transparentSpriteUrl = extractOutputUrl(bgOutput);
    if (!transparentSpriteUrl) warnings.push("BG removal succeeded but no output URL.");
  } catch (err) {
    warnings.push(`BG removal skipped: ${err.message}`);
  }

  sendJson(res, 200, {
    promptOriginal: originalPrompt,
    promptRewritten: rewrittenPrompt,
    spriteUrl,
    transparentSpriteUrl,
    warnings,
    metadata: { grid: `${gridSize}x${gridSize}`, gridSize, resolution: IMAGE_RESOLUTION }
  });
}

async function handleMedia(req, res, urlObject) {
  const mediaUrl = (urlObject.searchParams.get("url") || "").trim();
  if (!validateHttpUrl(mediaUrl)) { sendJson(res, 400, { error: "Invalid media URL" }); return; }

  const token = getApiToken(req);
  try {
    const headers = {};
    // Replicate Files API URLs need auth; replicate.delivery output URLs are public
    if (token && new URL(mediaUrl).hostname === "api.replicate.com") {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(mediaUrl, { headers });
    if (!response.ok) { sendJson(res, response.status, { error: "Unable to fetch media" }); return; }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": response.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Length": buffer.length
    });
    res.end(buffer);
  } catch {
    sendJson(res, 502, { error: "Unable to proxy media" });
  }
}

async function serveStatic(req, res, urlObject) {
  const requestPath = urlObject.pathname === "/" ? "/index.html" : urlObject.pathname;
  const normalized = path.normalize(requestPath).replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR)) { sendText(res, 403, "Forbidden"); return; }

  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(file);
  } catch {
    sendText(res, 404, "Not found");
  }
}

// ── Server ──────────────────────────────────────

const server = createServer(async (req, res) => {
  const urlObject = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-replicate-token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && urlObject.pathname === "/health") { sendJson(res, 200, { ok: true }); return; }
  if (req.method === "POST" && urlObject.pathname === "/api/upload") { await handleUpload(req, res); return; }
  if (req.method === "POST" && urlObject.pathname === "/api/generate") { await handleGenerate(req, res); return; }
  if (req.method === "GET" && urlObject.pathname === "/api/media") { await handleMedia(req, res, urlObject); return; }

  if (req.method === "POST" && urlObject.pathname === "/api/showcase") {
    try {
      const body = await parseJsonBody(req);
      if (!Array.isArray(body)) { sendJson(res, 400, { error: "Body must be a JSON array" }); return; }
      await writeFile(path.join(PUBLIC_DIR, "showcase.json"), JSON.stringify(body, null, 2) + "\n");
      sendJson(res, 200, { ok: true, count: body.length });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
    return;
  }

  await serveStatic(req, res, urlObject);
});

server.listen(PORT, () => {
  console.log(`FalSprite running on http://localhost:${PORT}`);
});
