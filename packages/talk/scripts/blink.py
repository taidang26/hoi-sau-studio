# A closed-eye frame drawn onto pose A itself, so nothing but the eyes changes: finds the two amber irises inside
# a box, paints each over with the colour of the dark ring around it and draws a closed-lid curve.
# python blink.py in.png out.png x0,y0,x1,y1
import sys
import cv2
import numpy as np

src, dst, box = sys.argv[1], sys.argv[2], sys.argv[3]
x0, y0, x1, y1 = map(int, box.split(","))
im = cv2.imread(src)
roi = im[y0:y1, x0:x1]
hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
# Amber/orange irises: hue 8-30, strong saturation and brightness.
m = cv2.inRange(hsv, (8, 170, 140), (28, 255, 255))
m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
n, lab, st, cen = cv2.connectedComponentsWithStats(m)
eyes = sorted(range(1, n), key=lambda i: -st[i, cv2.CC_STAT_AREA])[:2]
out = im.copy()
# Both eyes get the larger eye's size: a half-lidded iris shows less amber than the eye really covers.
rr = max(int(max(st[i, 2], st[i, 3]) * 0.55) for i in eyes)
for i in eyes:
    x, y, w, h = st[i, :4]
    cx, cy, r = x0 + x + w // 2, y0 + y + h // 2, rr
    ring = np.zeros(im.shape[:2], np.uint8)
    cv2.circle(ring, (cx, cy), int(r * 1.7), 255, -1); cv2.circle(ring, (cx, cy), int(r * 1.05), 0, -1)
    px = im[ring > 0]
    colour = np.median(px[px.sum(1) < np.percentile(px.sum(1), 35)], axis=0)  # the dark fur ring, not the cream face
    lid = np.zeros(im.shape[:2], np.uint8)
    cv2.circle(lid, (cx, cy), int(r * 1.25), 255, -1)
    soft = cv2.GaussianBlur(lid, (21, 21), 0).astype(np.float32)[..., None] / 255
    out = (out * (1 - soft) + colour * soft).astype(np.uint8)
    # Closed lid: a gentle downward curve with a dark outline.
    cv2.ellipse(out, (cx, cy), (int(r * 0.85), int(r * 0.35)), 0, 10, 170, (25, 20, 20), max(4, r // 9), cv2.LINE_AA)
    print(f"eye at {cx},{cy} r {r}")
cv2.imwrite(dst, out)
