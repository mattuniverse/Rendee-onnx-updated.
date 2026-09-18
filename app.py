import base64
import io
import json
import os

import anthropic
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MODEL_NAME = os.environ.get("MODEL_NAME", "claude-haiku-4-5-20251001")
MAX_IMAGE_SIDE = int(os.environ.get("MAX_IMAGE_SIDE", "1568"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]

VALID_FURNITURE_IDS = [
    "sofa_2", "sofa_3", "chair", "armchair", "table_rect", "table_round",
    "coffee", "desk", "tv", "bed_s", "bed_d", "bed_k", "cabinet", "wall_cab",
    "toilet", "sink", "bathtub", "plant", "shelf", "wardrobe", "door", "window",
    "rug", "wall",
]

SYSTEM_PROMPT = """You are a furniture-detection engine for a floor-plan app. You receive a room photo and must return ONLY a JSON object — no prose, no markdown fences — describing every piece of furniture, fixture, or structural element (doors, windows, walls) visible in the image.

Image dimensions will be given to you as imageWidth and imageHeight. All coordinates you output must be in pixel units on that same scale, using (x, y) as the CENTER of the bounding box, plus width and height — matching a standard object-detection box format, not corner coordinates.

Only use these furnitureId values (case-sensitive, exact match required). If an object doesn't clearly match one, omit furnitureId and instead add its label to "unmappedClasses":
sofa_2, sofa_3, chair, armchair, table_rect, table_round, coffee, desk, tv, bed_s, bed_d, bed_k, cabinet, wall_cab, toilet, sink, bathtub, plant, shelf, wardrobe, door, window, rug, wall

For each detected object return:
- "class": your own descriptive label for what you saw (e.g. "dining chair")
- "furnitureId": one of the allowed values above, or omit if none fit
- "confidence": your estimated confidence from 0 to 1
- "x", "y": center of the bounding box in pixels
- "width", "height": box dimensions in pixels

Rules:
- Only report objects you can actually see and localize — do not guess at objects outside the frame or hallucinate typical room contents.
- Give your best pixel-coordinate estimate; err toward tighter boxes around the visible object rather than the whole wall/floor area.
- Do not include duplicate boxes for the same physical object.
- Return valid JSON only, in this exact shape:

{
  "detections": [
    { "furnitureId": "...", "class": "...", "confidence": 0.0, "x": 0, "y": 0, "width": 0, "height": 0 }
  ],
  "unmappedClasses": ["..."]
}
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

    # Downscale server-side if larger than MAX_IMAGE_SIDE on the longest side —
    # Claude bills/processes by resolution; bigger images cost more tokens for
    # no accuracy gain. Coordinates are rescaled back to orig size below.
    scale = min(1.0, MAX_IMAGE_SIDE / max(orig_w, orig_h))
    scaled_w, scaled_h = int(round(orig_w * scale)), int(round(orig_h * scale))
    scaled_img = img if scale >= 1.0 else img.resize((scaled_w, scaled_h), Image.LANCZOS)

    # Re-encode as JPEG for the API (smaller payload)
    buf = io.BytesIO()
    scaled_img.save(buf, format="JPEG", quality=85)
    jpeg_b64 = base64.b64encode(buf.getvalue()).decode()

    media_type = "image/jpeg"
    if scaled_img.format:
        fmt = scaled_img.format.lower()
        if fmt in ("png",):
            media_type = "image/png"
        elif fmt in ("gif",):
            media_type = "image/gif"
        elif fmt in ("webp",):
            media_type = "image/webp"

    try:
        message = client.messages.create(
            model=MODEL_NAME,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": jpeg_b64,
                        },
                    },
                    {"type": "text", "text": f"imageWidth: {scaled_w}\nimageHeight: {scaled_h}\n\nDetect all furniture, fixtures, and structural elements in this room photo."},
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
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Could not parse detection response.")

    if isinstance(parsed, dict):
        detected = parsed.get("detections", [])
        unmapped = parsed.get("unmappedClasses", [])
    elif isinstance(parsed, list):
        detected = parsed
        unmapped = []
    else:
        detected, unmapped = [], []

    if not isinstance(detected, list):
        detected = []
    unmapped_classes = list(unmapped) if isinstance(unmapped, list) else []

    # Validate furnitureIds and rescale coordinates back to original dimensions
    cleaned = []
    for d in detected:
        if not isinstance(d, dict):
            continue
        furniture_id = d.get("furnitureId", "")
        cls = (d.get("class") or furniture_id or "").strip()
        if furniture_id not in VALID_FURNITURE_IDS:
            if cls and cls not in unmapped_classes:
                unmapped_classes.append(cls)
            continue  # drop furnitureId, move class into unmappedClasses
        rx = float(d.get("x", 0)) * (orig_w / scaled_w)
        ry = float(d.get("y", 0)) * (orig_h / scaled_h)
        rw = float(d.get("width", 0)) * (orig_w / scaled_w)
        rh = float(d.get("height", 0)) * (orig_h / scaled_h)
        cleaned.append({
            "furnitureId": furniture_id,
            "class": cls,
            "confidence": float(d.get("confidence", 0.9)),
            "x": rx,
            "y": ry,
            "width": rw,
            "height": rh,
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
        "unmappedClasses": unmapped_classes,
    }


@app.get("/")
def health():
    return {"status": "ok", "model": MODEL_NAME, "runtime": "claude-api"}


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