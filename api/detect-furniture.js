const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = JSON.parse(req.body || "{}");
  } catch (err) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const { image } = body;
  if (!image) {
    res.status(400).json({ error: "Missing image" });
    return;
  }

  const backendUrl = process.env.RENDER_BACKEND_URL;
  if (!backendUrl) {
    res.status(500).json({ error: "RENDER_BACKEND_URL is not set" });
    return;
  }

  let response;
  try {
    response = await fetch(`${backendUrl}/api/detect-furniture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Request to detection backend failed" });
    return;
  }

  const data = await response.json();
  res.status(200).json(data);
}