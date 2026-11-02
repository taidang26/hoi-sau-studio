# A closed-eye frame drawn onto pose A itself, so nothing but the eyes changes: finds the two amber irises inside
# a box (the face), paints each over with the colour of the dark ring around it and draws a closed-lid curve.
# python blink.py in.png out.png x0,y0,x1,y1
#
# Only the top 60% of the box is searched (the eyes, not the hoodie or a lamp below), and the two blobs must look
# like a pair of eyes: similar size, side by side, a sensible distance apart. Anything else exits with code 2 and
# writes nothing, so the clip keeps a still picture instead of paint on a cheek.
import sys
import cv2
import numpy as np

src, dst, box = sys.argv[1], sys.argv[2], sys.argv[3]
x0, y0, x1, y1 = map(int, box.split(","))
im = cv2.imread(src)
H, W = im.shape[:2]
x0, x1 = max(0, x0), min(W, x1)
y0 = max(0, y0)
y1 = min(H, y0 + int((y1 - y0) * 0.6))
fw = max(1, x1 - x0)
roi = im[y0:y1, x0:x1]
hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)


def pair(sat):
    # Amber/orange irises: hue 8-30, saturated and bright enough; dim night scenes need the lower floor.
    m = cv2.inRange(hsv, (8, sat, 110), (28, 255, 255))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, lab, st, cen = cv2.connectedComponentsWithStats(m)
    blobs = [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= 60]
    best = None
    for a in range(len(blobs)):
        for b in range(a + 1, len(blobs)):
            i, j = blobs[a], blobs[b]
            ai, aj = st[i, cv2.CC_STAT_AREA], st[j, cv2.CC_STAT_AREA]
            if max(ai, aj) > 2.5 * min(ai, aj):
                continue
            (cxi, cyi), (cxj, cyj) = cen[i], cen[j]
            r = max(st[i, 2], st[i, 3], st[j, 2], st[j, 3]) * 0.55
            dx, dy = abs(cxi - cxj), abs(cyi - cyj)
            # Real eyes are not specks: a radius under 4% of the face is a fleck of colour, not an iris.
            if dy > max(r, 0.08 * fw) or not (2.2 * r <= dx <= 0.7 * fw) or not (0.04 * fw <= r <= 0.18 * fw):
                continue
            score = ai + aj
            if best is None or score > best[0]:
                best = (score, [i, j], st, int(r))
    return best


found = pair(170) or pair(110)
if not found:
    print("no pair of eyes found")
    sys.exit(2)
_, eyes, st, rr = found
out = im.copy()
for i in eyes:
    x, y, w, h = st[i, :4]
    cx, cy, r = x0 + x + w // 2, y0 + y + h // 2, rr
    ring = np.zeros(im.shape[:2], np.uint8)
    cv2.circle(ring, (cx, cy), int(r * 1.7), 255, -1); cv2.circle(ring, (cx, cy), int(r * 1.05), 0, -1)
    px = im[ring > 0]
    dark = px[px.sum(1) <= np.percentile(px.sum(1), 35)]  # the dark fur ring, not the cream face
    colour = np.median(dark if len(dark) else px, axis=0)
    lid = np.zeros(im.shape[:2], np.uint8)
    cv2.circle(lid, (cx, cy), int(r * 1.25), 255, -1)
    soft = cv2.GaussianBlur(lid, (21, 21), 0).astype(np.float32)[..., None] / 255
    out = (out * (1 - soft) + colour * soft).astype(np.uint8)
    # Closed lid: a gentle downward curve with a dark outline.
    cv2.ellipse(out, (cx, cy), (int(r * 0.85), int(r * 0.35)), 0, 10, 170, (25, 20, 20), max(4, r // 9), cv2.LINE_AA)
    print(f"eye at {cx},{cy} r {r}")
cv2.imwrite(dst, out)
