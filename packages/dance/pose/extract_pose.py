"""Reads body poses from a dance video with Meta's open Keypoint R-CNN.

    python extract_pose.py dance.mp4 poses.json [--device cuda]

Keypoint R-CNN (Mask R-CNN family, Meta AI Research) ships with torchvision,
Meta's PyTorch vision library; its weights download once on first run. Every
person in every frame gets 17 COCO keypoints, and people are followed from
frame to frame by box overlap, so each one becomes a track.

Install once: pip install -r requirements.txt
"""

import argparse
import json
import sys

import cv2
import torch
from torchvision.models.detection import KeypointRCNN_ResNet50_FPN_Weights, keypointrcnn_resnet50_fpn


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--min-score", type=float, default=0.8, help="person detection threshold")
    ap.add_argument("--max-width", type=int, default=720, help="frames are shrunk to this width for speed")
    args = ap.parse_args()

    weights = KeypointRCNN_ResNet50_FPN_Weights.DEFAULT
    model = keypointrcnn_resnet50_fpn(weights=weights).eval().to(args.device)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"Cannot open {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    shrink = min(1.0, args.max_width / width)

    tracks = []  # {"id", "box", "last", "frames": {index: pose}}
    index = 0
    with torch.no_grad():
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            if shrink < 1:
                img = cv2.resize(img, None, fx=shrink, fy=shrink, interpolation=cv2.INTER_AREA)
            t = torch.from_numpy(img).permute(2, 0, 1).float().div(255).to(args.device)
            det = model([t])[0]
            people = []
            for box, score, kps, kscores in zip(det["boxes"], det["scores"], det["keypoints"], det["keypoints_scores"]):
                if score < args.min_score:
                    continue
                b = [float(v) / shrink for v in box]
                # keypoints_scores are logits; squash to 0..1
                pose = [[round(float(k[0]) / shrink, 1), round(float(k[1]) / shrink, 1), round(float(torch.sigmoid(s)), 3)] for k, s in zip(kps, kscores)]
                people.append((b, pose))
            # Follow people by the best box overlap with each track's last box.
            used = set()
            for b, pose in sorted(people, key=lambda p: -(p[0][2] - p[0][0]) * (p[0][3] - p[0][1])):
                best, best_iou = None, 0.2
                for tr in tracks:
                    if tr["id"] in used or index - tr["last"] > 15:
                        continue
                    o = iou(b, tr["box"])
                    if o > best_iou:
                        best, best_iou = tr, o
                if best is None:
                    best = {"id": len(tracks) + 1, "frames": {}}
                    tracks.append(best)
                best.update(box=b, last=index)
                best["frames"][index] = pose
                used.add(best["id"])
            index += 1
            if index % 30 == 0:
                print(f"frame {index}/{total}", file=sys.stderr, flush=True)

    out = {
        "source": args.video,
        "model": "torchvision keypointrcnn_resnet50_fpn (Meta AI Research)",
        "fps": fps,
        "width": width,
        "height": height,
        "frameCount": index,
        "tracks": [{"id": tr["id"], "frames": [tr["frames"].get(i) for i in range(index)]} for tr in tracks if len(tr["frames"]) >= 10],
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"{len(out['tracks'])} people over {index} frames -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
