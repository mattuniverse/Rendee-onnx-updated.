import base64
import io
import json
import os

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

MODEL_PATH = os.environ.get("MODEL_PATH", "best.onnx")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.5"))
IOU_THRESHOLD = float(os.environ.get("IOU_THRESHOLD", "0.45"))
INPUT_SIZE = int(os.environ.get("INPUT_SIZE", "640"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]

# Class names for the [1, 62, 8400] YOLO model (58 classes). Read from the model's
# own metadata ("names"). Override via CLASS_NAMES env var (comma-separated) if the
# production model is retrained.
_DEFAULT_CLASS_NAMES = [
    "0", "Bed", "Cabinet", "Carpet", "Ceramic floor", "Chair", "Clock", "Closet",
    "Computer", "Couch", "Cupboard", "Curtains", "Dining Table", "Door", "Frame",
    "Gypsum Board", "Lamp", "Monitor", "Nightstand", "SOFA", "Shelf", "Sideboard",
    "Sofa", "Swivel_C", "TV stand", "Table", "Transparent Closet", "Wall Futec",
    "Wall Panel", "Window", "Windows", "Wooden floor", "air conditioner", "arm chair",
    "bed", "ceiling fan", "chair", "closet", "cupboard", "dining table",
    "dining-table", "dinning-table", "door", "drawer near bed", "frame",
    "hanging lights", "lamp", "master bed", "nightstand", "photoframe", "shelf",
    "sideboard", "sofa", "table", "transparent closet", "wall", "wardrobe", "windows",
]

CLASS_NAMES = (os.environ.get("CLASS_NAMES", "") or ",".join(_DEFAULT_CLASS_NAMES)).split(",")

_DEFAULT_CLASS_MAP = {
    # Model uses mixed casing (e.g. "Couch", "Dining Table", "TV stand"); maps are case-insensitive.
    "sofa": "sofa_3",
    "sofa 2 seat": "sofa_2",
    "sofa 3 seat": "sofa_3",
    "sofa2": "sofa_2",
    "sofa_2": "sofa_2",
    "sofa3": "sofa_3",
    "sofa_3": "sofa_3",
    "couch": "sofa_3",
    "loveseat": "sofa_2",
    "chair": "chair",
    "dining chair": "chair",
    "armchair": "armchair",
    "arm chair": "armchair",
    "lounge chair": "armchair",
    "swivel_c": "chair",
    "table": "table_rect",
    "dining table": "table_rect",
    "dining-table": "table_rect",
    "dinning-table": "table_rect",
    "round table": "table_round",
    "coffee table": "coffee",
    "desk": "desk",
    "tv stand": "tv",
    "bed": "bed_d",
    "master bed": "bed_d",
    "single bed": "bed_s",
    "double bed": "bed_d",
    "king bed": "bed_k",
    "drawer near bed": "cabinet",
    "nightstand": "cabinet",
    "toilet": "toilet",
    "sink": "sink",
    "bathtub": "bathtub",
    "tub": "bathtub",
    "plant": "plant",
    "houseplant": "plant",
    "potted_plant": "plant",
    "potted plant": "plant",
    "tv": "tv",
    "television": "tv",
    "tvmonitor": "tv",
    "monitor": "tv",
    "computer": "tv",
    "bookshelf": "shelf",
    "bookcase": "shelf",
    "shelf": "shelf",
    "sideboard": "cabinet",
    "cabinet": "cabinet",
    "wall cabinet": "wall_cab",
    "wardrobe": "wardrobe",
    "closet": "wardrobe",
    "transparent closet": "wardrobe",
    "cupboard": "cabinet",
    "door": "door",
    "window": "window",
    "windows": "window",
    "rug": "rug",
    "carpet": "rug",
    "wall": "wall",
    "curtains": "wall_cab",
    "ceiling fan": "wall_cab",
    "air conditioner": "wall_cab",
    "lamp": "tv",
    "frame": "shelf",
    "photoframe": "shelf",
}


def _load_class_map():
    env_map = os.environ.get("CLASS_MAP", "")
    if env_map:
        try:
            return {k.lower(): v for k, v in json.loads(env_map).items()}
        except json.JSONDecodeError:
            pass
    return dict(_DEFAULT_CLASS_MAP)

CLASS_MAP = _load_class_map()

app = FastAPI(title="FloorPlan Studio - furniture detection (ONNX)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
input_name = session.get_inputs()[0].name


def letterbox(img: Image.Image, size: int):
    w, h = img.size
    scale = min(size / w, size / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    resized = img.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    pad_x, pad_y = (size - nw) // 2, (size - nh) // 2
    canvas.paste(resized, (pad_x, pad_y))
    return canvas, scale, pad_x, pad_y


def nms(boxes, scores, iou_threshold):
    if len(boxes) == 0:
        return []
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[1:][iou <= iou_threshold]
    return keep


def _run_detection(image_b64: str):
    try:
        image_bytes = base64.b64decode(image_b64)
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode image.")

    orig_w, orig_h = img.size
    canvas, scale, pad_x, pad_y = letterbox(img, INPUT_SIZE)

    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)[None, :, :, :]

    outputs = session.run(None, {input_name: arr})
    pred = outputs[0]
    if pred.shape[1] < pred.shape[2]:
        pred = pred[0].T
    else:
        pred = pred[0]

    boxes_xywh = pred[:, :4]
    class_scores = pred[:, 4:]
    class_ids = np.argmax(class_scores, axis=1)
    confidences = class_scores[np.arange(len(class_scores)), class_ids]

    mask = confidences >= CONF_THRESHOLD
    boxes_xywh, class_ids, confidences = boxes_xywh[mask], class_ids[mask], confidences[mask]

    predictions = []
    unmapped = set()

    if len(boxes_xywh) > 0:
        cx, cy, w, h = boxes_xywh[:, 0], boxes_xywh[:, 1], boxes_xywh[:, 2], boxes_xywh[:, 3]
        x1, y1, x2, y2 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
        boxes_x1y1x2y2 = np.stack([x1, y1, x2, y2], axis=1)

        keep = nms(boxes_x1y1x2y2, confidences, IOU_THRESHOLD)

        for i in keep:
            bcx = (cx[i] - pad_x) / scale
            bcy = (cy[i] - pad_y) / scale
            bw = w[i] / scale
            bh = h[i] / scale
            cls_id = int(class_ids[i])

            if CLASS_NAMES and cls_id < len(CLASS_NAMES):
                cls_name = CLASS_NAMES[cls_id]
            else:
                cls_name = str(cls_id)

            cls_lower = cls_name.lower().strip()
            furniture_id = CLASS_MAP.get(cls_lower)

            if furniture_id:
                predictions.append({
                    "furnitureId": furniture_id,
                    "class": cls_name,
                    "confidence": float(confidences[i]),
                    "x": float(bcx),
                    "y": float(bcy),
                    "width": float(bw),
                    "height": float(bh),
                })
            else:
                unmapped.add(cls_name)

    return {
        "detections": predictions,
        "predictions": [
            {
                "class": p["class"],
                "confidence": p["confidence"],
                "x": p["x"],
                "y": p["y"],
                "width": p["width"],
                "height": p["height"],
            }
            for p in predictions
        ],
        "imageWidth": orig_w,
        "imageHeight": orig_h,
        "unmappedClasses": sorted(unmapped),
    }


@app.get("/")
def health():
    return {"status": "ok", "model": MODEL_PATH, "runtime": "onnxruntime"}


@app.post("/api/detect-furniture")
async def detect_furniture(request: Request):
    body = await request.json()
    image_b64 = body.get("image")
    if not image_b64 or not isinstance(image_b64, str):
        raise HTTPException(status_code=400, detail='Missing "image" (base64 string) in the request body.')
    return _run_detection(image_b64)


@app.post("/detect")
async def detect(request: Request):
    body = await request.json()
    image_b64 = body.get("image")
    if not image_b64 or not isinstance(image_b64, str):
        raise HTTPException(status_code=400, detail='Missing "image" (base64 string) in the request body.')
    return _run_detection(image_b64)
