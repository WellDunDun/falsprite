import { createClient } from "../lib/replicate.mjs";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const body = req.body || {};
  const token = (req.headers["x-replicate-token"] || body.apiKey || "").trim();
  if (!token) { res.status(400).json({ error: "Missing Replicate API token" }); return; }

  const { data, contentType } = body;
  if (!data || !contentType) { res.status(400).json({ error: "Missing data or contentType" }); return; }

  try {
    const buffer = Buffer.from(data, "base64");
    const client = createClient(token);
    const file = await client.files.create(buffer);
    res.status(200).json({ url: file.urls.get });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}
