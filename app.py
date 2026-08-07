import base64
import io
import os

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

MODEL_PATH = os.environ.get("MODEL_PATH", "best.onnx")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.35"))
IOU_THRESHOLD = float(os.environ.get("IOU_THRESHOLD", "0.45"))
INPUT_SIZE = int(os.environ.get("INPUT_SIZE", "640"))  # must match the size the model was exported at
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]

# Class names, in the same order YOLO trained them (index = class id).
# Ultralytics embeds these in best.pt but NOT always in the plain ONNX export,
# so we set them here explicitly. Edit this list to match your data.yaml `names:`.
CLASS_NAMES = os.environ.get("CLASS_NAMES", "").split(",") if os.environ.get("CLASS_NAMES") else None

app = FastAPI(title="FloorPlan Studio - furniture detection (ONNX)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST"],
    allow_headers=["*"],
)

# Loaded once at process start. onnxruntime + numpy have a much smaller memory
# footprint than torch/ultralytics, which is the whole point of this version.
session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
input_name = session.get_inputs()[0].name


def letterbox(img: Image.Image, size: int):
    """Resize+pad to a square, preserving aspect ratio (matches YOLO's own preprocessing)."""
    w, h = img.size
    scale = min(size / w, size / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    resized = img.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    pad_x, pad_y = (size - nw) // 2, (size - nh) // 2
    canvas.paste(resized, (pad_x, pad_y))
    return canvas, scale, pad_x, pad_y


def nms(boxes, scores, iou_threshold):
    """Plain-numpy non-max suppression. boxes: [N,4] as x1,y1,x2,y2."""
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


@app.get("/")
def health():
    return {"status": "ok", "model": MODEL_PATH, "runtime": "onnxruntime"}


@app.post("/detect")
async def detect(request: Request):
    body = await request.json()
    image_b64 = body.get("image")
    if not image_b64 or not isinstance(image_b64, str):
        raise HTTPException(status_code=400, detail='Missing "image" (base64 string) in the request body.')

    try:
        image_bytes = base64.b64decode(image_b64)
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode image.")

    orig_w, orig_h = img.size
    canvas, scale, pad_x, pad_y = letterbox(img, INPUT_SIZE)

    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)[None, :, :, :]  # NCHW

    outputs = session.run(None, {input_name: arr})
    pred = outputs[0]  # typical YOLOv8/11 export shape: [1, 4+num_classes, num_boxes]
    if pred.shape[1] < pred.shape[2]:
        pred = pred[0].T  # -> [num_boxes, 4+num_classes]
    else:
        pred = pred[0]

    boxes_xywh = pred[:, :4]
    class_scores = pred[:, 4:]
    class_ids = np.argmax(class_scores, axis=1)
    confidences = class_scores[np.arange(len(class_scores)), class_ids]

    mask = confidences >= CONF_THRESHOLD
    boxes_xywh, class_ids, confidences = boxes_xywh[mask], class_ids[mask], confidences[mask]

    predictions = []
    if len(boxes_xywh) > 0:
        # center-xywh (in the 640x640 letterboxed space) -> x1y1x2y2, for NMS
        cx, cy, w, h = boxes_xywh[:, 0], boxes_xywh[:, 1], boxes_xywh[:, 2], boxes_xywh[:, 3]
        x1, y1, x2, y2 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
        boxes_x1y1x2y2 = np.stack([x1, y1, x2, y2], axis=1)

        keep = nms(boxes_x1y1x2y2, confidences, IOU_THRESHOLD)

        for i in keep:
            # undo letterbox padding/scale -> original image pixel coords
            bcx = (cx[i] - pad_x) / scale
            bcy = (cy[i] - pad_y) / scale
            bw = w[i] / scale
            bh = h[i] / scale
            cls_id = int(class_ids[i])
            cls_name = CLASS_NAMES[cls_id] if CLASS_NAMES and cls_id < len(CLASS_NAMES) else str(cls_id)
            predictions.append({
                "class": cls_name,
                "confidence": float(confidences[i]),
                "x": float(bcx),
                "y": float(bcy),
                "width": float(bw),
                "height": float(bh),
            })

    return {
        "outputs": [
            {
                "predictions": predictions,
                "image": {"width": orig_w, "height": orig_h},
            }
        ]
    }
