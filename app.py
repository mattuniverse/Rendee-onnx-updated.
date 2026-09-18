import base64
import io
import json
import os

import anthropic
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]

VALID_FURNITURE_IDS = [
    "sofa_2", "sofa_3", "chair", "armchair", "table_rect", "table_round",
    "coffee", "desk", "bed_s", "bed_d", "bed_k", "cabinet", "wardrobe",
    "shelf", "tv", "door", "window", "rug", "wall_cab", "plant", "toilet",
    "sink", "bathtub",
]

DETECTION_PROMPT = """You are a furniture detection AI for a floor plan tool.

Analyze this room image and detect ALL visible furniture and fixtures.

For each item detected, return a JSON object with these exact fields:
- "furnitureId": one of these exact values only: sofa_2, sofa_3, chair, armchair, table_rect, table_round, coffee, desk, bed_s, bed_d, bed_k, cabinet, wardrobe, shelf, tv, door, window, rug, wall_cab, plant, toilet, sink, bathtub
- "class": the natural name of the item (e.g. "Sofa", "Dining Chair", "Wardrobe")
- "confidence": a number between 0 and 1 representing how confident you are
- "x": estimated center x position in pixels from left edge
- "y": estimated center y position in pixels from top edge
- "width": estimated width in pixels
- "height": estimated height in pixels

Rules:
- sofa_2 = 2-seat sofa/loveseat, sofa_3 = 3-seat sofa/couch
- bed_s = single/twin, bed_d = double/queen, bed_k = king
- wall_cab = anything wall-mounted (AC unit, curtains, wall shelf, ceiling fan)
- tv = television or monitor
- Use table_rect for rectangular tables, table_round for round tables
- If unsure between two furnitureIds, pick the closest one
- Clamp all coordinates so they stay within the image boundaries
- Detect EVERY visible item, do not skip small items like lamps or plants

Return ONLY a valid JSON array, no explanation, no markdown, no extra text.
Example format:
[
  {"furnitureId": "sofa_3", "class": "Sofa", "confidence": 0.95, "x": 320, "y": 240, "width": 200, "height": 120},
  {"furnitureId": "chair", "class": "Dining Chair", "confidence": 0.90, "x": 100, "y": 300, "width": 60, "height": 80}
]
"""

app = FastAPI(title="FloorPlan Studio - furniture detection (Claude)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def _detect_with_claude(image_b64: str):
    try:
        image_bytes = base64.b64decode(image_b64)
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode image.")

    orig_w, orig_h = img.size

    # Re-encode as JPEG for the API (smaller payload)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    jpeg_b64 = base64.b64encode(buf.getvalue()).decode()

    try:
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2048,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": jpeg_b64,
                        },
                    },
                    {"type": "text", "text": DETECTION_PROMPT},
                ],
            }],
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Claude API error: {str(e)}")

    raw = message.content[0].text.strip()

    # Strip markdown fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip()

    try:
        detections = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail=f"Claude returned invalid JSON: {raw[:200]}")

    # Validate and clamp each detection
    cleaned = []
    for d in detections:
        if not isinstance(d, dict):
            continue
        furniture_id = d.get("furnitureId", "")
        if furniture_id not in VALID_FURNITURE_IDS:
            continue  # drop unknown IDs
        # Clamp coordinates to image bounds
        w = min(float(d.get("width", 50)), orig_w)
        h = min(float(d.get("height", 50)), orig_h)
        x = max(w / 2, min(orig_w - w / 2, float(d.get("x", orig_w / 2))))
        y = max(h / 2, min(orig_h - h / 2, float(d.get("y", orig_h / 2))))
        cleaned.append({
            "furnitureId": furniture_id,
            "class": d.get("class", furniture_id),
            "confidence": float(d.get("confidence", 0.9)),
            "x": x,
            "y": y,
            "width": w,
            "height": h,
        })

    return {
        "detections": cleaned,
        "predictions": [
            {
                "class": d["class"],
                "confidence": d["confidence"],
                "x": d["x"],
                "y": d["y"],
                "width": d["width"],
                "height": d["height"],
            }
            for d in cleaned
        ],
        "imageWidth": orig_w,
        "imageHeight": orig_h,
    }


@app.get("/")
def health():
    return {"status": "ok", "model": "claude-haiku-4-5-20251001", "runtime": "anthropic"}


@app.post("/api/detect-furniture")
async def detect_furniture(request: Request):
    body = await request.json()
    image_b64 = body.get("image")
    if not image_b64 or not isinstance(image_b64, str):
        raise HTTPException(status_code=400, detail='Missing "image" (base64 string) in request body.')
    return _detect_with_claude(image_b64)


@app.post("/detect")
async def detect(request: Request):
    body = await request.json()
    image_b64 = body.get("image")
    if not image_b64 or not isinstance(image_b64, str):
        raise HTTPException(status_code=400, detail='Missing "image" (base64 string) in request body.')
    return _detect_with_claude(image_b64)