import {
  IMAGE_MODEL, REMOVE_BG_MODEL, REWRITE_MODEL, IMAGE_RESOLUTION,
  createClient, extractOutputText, extractOutputUrl,
  buildSpritePrompt, buildRewriteSystemPrompt,
  makeDefaultPrompt, validateHttpUrl
} from "../lib/replicate.mjs";

const NUM_WORDS = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const body = req.body || {};
  const token = (req.headers["x-replicate-token"] || body.apiKey || "").trim();
  if (!token) { res.status(400).json({ error: "Missing Replicate API token" }); return; }

  const client = createClient(token);
  const originalPrompt = (typeof body.prompt === "string" && body.prompt.trim()) ? body.prompt.trim() : makeDefaultPrompt();
  const gridSize = Math.max(2, Math.min(6, parseInt(body.gridSize, 10) || 4));
  const gridWord = NUM_WORDS[gridSize] || "four";
  const referenceImageUrl = typeof body.imageUrl === "string" && validateHttpUrl(body.imageUrl) ? body.imageUrl : "";
  const warnings = [];
  let rewrittenPrompt = originalPrompt;

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
    res.status(502).json({ error: `Sprite generation failed: ${err.message}`, warnings });
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

  res.status(200).json({
    promptOriginal: originalPrompt,
    promptRewritten: rewrittenPrompt,
    spriteUrl,
    transparentSpriteUrl,
    warnings,
    metadata: { grid: `${gridSize}x${gridSize}`, gridSize, resolution: IMAGE_RESOLUTION }
  });
}
