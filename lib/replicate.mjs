import Replicate from "replicate";

export const IMAGE_MODEL = "google/nano-banana-2";
export const REWRITE_MODEL = "google/gemini-2.5-flash";
export const REMOVE_BG_MODEL = "bria/remove-background";
export const INTERPOLATION_MODEL = "google-research/frame-interpolation";

export const IMAGE_RESOLUTION = "4K";

const NUM_WORDS = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };

export function createClient(token) {
  return new Replicate({ auth: token });
}

export async function resolveLatestVersion(client, modelId) {
  const [owner, name] = modelId.split("/");
  const model = await client.models.get(owner, name);
  const version = model.latest_version?.id;
  if (!version) throw new Error(`No latest version for ${modelId}`);
  return version;
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function extractOutputUrl(output) {
  if (typeof output === "string") {
    return validateHttpUrl(output) ? output : "";
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const str = typeof item === "string" ? item : (item?.toString?.() || "");
      if (validateHttpUrl(str)) return str;
    }
    return "";
  }
  const str = output?.toString?.() || "";
  if (validateHttpUrl(str)) return str;
  if (output && typeof output === "object" && typeof output.url === "string") {
    if (validateHttpUrl(output.url)) return output.url;
  }
  return "";
}

function cleanPromptText(text) {
  return text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/g, "").trim();
}

export function extractOutputText(output) {
  if (typeof output === "string") return cleanPromptText(output);
  if (Array.isArray(output)) {
    const joined = output.filter(part => typeof part === "string").join("");
    return cleanPromptText(joined);
  }
  return "";
}

export function pickErrorMessage(data, fallback) {
  if (typeof data?.error === "string" && data.error.trim()) return data.error.trim();
  if (typeof data?.detail === "string" && data.detail.trim()) return data.detail.trim();
  if (Array.isArray(data?.detail) && data.detail.length > 0) {
    const msg = data.detail.map(e => typeof e === "string" ? e : e?.msg || "").filter(Boolean).join(" | ");
    if (msg) return msg;
  }
  if (typeof data?.title === "string" && data.title.trim()) return data.title.trim();
  if (typeof data?.raw === "string" && data.raw.trim()) return data.raw.trim();
  return fallback;
}

export function buildSpritePrompt(basePrompt, gridSize = 4, options = {}) {
  const w = NUM_WORDS[gridSize] || "four";
  const referenceRules = options.hasReference ? [
    "",
    "REFERENCE IMAGE RULES:",
    "A reference image is provided. The reference image is the source of truth for the character design.",
    "Preserve the same character identity, gender presentation, face covering, hairstyle, outfit, armor,",
    "materials, color palette, glowing accents, weapons, props, and silhouette from the reference.",
    "Do not redesign the character. Do not change skin or clothing materials. Do not add a visor, helmet,",
    "new colors, new limbs, or unrelated sci-fi details unless they already appear in the reference.",
    "Only change the pose from cell to cell to create the requested animation."
  ] : [];

  return [
    "STRICT TECHNICAL REQUIREMENTS FOR THIS IMAGE:",
    "",
    `FORMAT: A single image containing a ${w}-by-${w} grid of equally sized cells.`,
    "Every cell must be the exact same dimensions, perfectly aligned, with no gaps or overlap.",
    "",
    "FORBIDDEN: Absolutely no text, no numbers, no letters, no digits, no labels,",
    "no watermarks, no signatures, no UI elements anywhere in the image. The image must",
    "contain ONLY the character illustrations in the grid cells and nothing else.",
    "",
    "CONSISTENCY: The exact same single character must appear in every cell.",
    "Same proportions, same art style, same level of detail, same camera angle throughout.",
    "Isometric three-quarter view. Full body visible head to toe in every cell.",
    "Strong clean silhouette against a plain solid flat-color background.",
    "",
    "ANIMATION FLOW: The cells read left-to-right, top-to-bottom, like reading a page.",
    "This is one continuous motion sequence. Each cell shows the next moment in the movement.",
    "The transition between the last cell of one row and the first cell of the next row",
    `must be just as smooth as transitions within a row — no jumps, no resets.`,
    `Each row contains ${w} phases of the motion. The very last cell loops back seamlessly`,
    "to the very first cell.",
    "",
    "MOTION QUALITY: Show real weight and physics. Bodies shift weight between feet.",
    "Arms counterbalance legs. Torsos rotate into actions. Follow-through on every movement.",
    "No stiff poses — every cell must feel like a freeze-frame of fluid motion.",
    "For locomotion (walk/run): strictly alternate left and right legs — one leg extends forward",
    "while the other pushes behind. Each frame must show a clearly different leg position.",
    "Never repeat the same pose twice in a row.",
    ...referenceRules,
    "",
    "CHARACTER AND ANIMATION DIRECTION:",
    basePrompt
  ].join("\n");
}

export function buildRewriteSystemPrompt(gridSize) {
  const w = NUM_WORDS[gridSize] || "four";
  return [
    "You are an animation director and character designer for a sprite sheet pipeline.",
    "Given a character concept, you MUST return exactly two sections, nothing else:",
    "",
    "CHARACTER: A vivid description of the character's appearance — body type, armor, weapons, colors, silhouette, art style. Be extremely specific and visual.",
    "",
    `CHOREOGRAPHY: A ${w}-beat continuous animation loop that showcases this specific character's personality and abilities. Each beat is one row of the sheet. The last beat must transition seamlessly back into the first.`,
    "For each beat, describe the body position, weight distribution, limb placement, and motion arc in one sentence.",
    "The choreography must feel natural and unique to THIS character — a mage animates differently than a knight, a dancer differently than a berserker.",
    "",
    "RULES:",
    "- Never use numbers or digits anywhere.",
    "- Never mention grids, pixels, frames, cells, or image generation.",
    "- Never mention sprite sheets or technical terms.",
    "- Write as if directing a real actor through a motion capture session.",
    `- The ${w} beats must form one fluid, looping performance.`,
    "- For locomotion (walk/run): strictly alternate left and right legs in each beat.",
    "  Describe exact limb positions — which leg is forward, which is pushing off,",
    "  which arm is swinging forward. Every beat must show a distinctly different leg configuration."
  ].join("\n");
}

export function makeDefaultPrompt() {
  const subjects = ["baby dragon", "crystal fox", "tiny samurai cat", "sparkle unicorn", "bamboo panda warrior"];
  const styles = ["painterly fantasy", "vibrant anime", "cel-shaded cartoon", "cozy storybook", "Studio Ghibli inspired"];
  const subject = subjects[Math.floor(Math.random() * subjects.length)];
  const style = styles[Math.floor(Math.random() * styles.length)];
  return `${subject}, ${style}, isometric action RPG`;
}
