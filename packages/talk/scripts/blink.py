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


def pair_dark(vmax):
    # Black eyes (Rico, Poppy, Bino, Uni): solid round dark blobs. Ink outlines are dark too, so a blob must be
    # filled (area close to its circle) and roundish; the same pair geometry as the irises then picks the eyes.
    m = cv2.inRange(hsv, (0, 0, 0), (180, 255, vmax))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, st, cen = cv2.connectedComponentsWithStats(m)
    blobs = []
    for i in range(1, n):
        w, h, a = st[i, 2], st[i, 3], st[i, cv2.CC_STAT_AREA]
        if a < 40 or not (0.6 <= w / max(1, h) <= 1.7) or a < 0.55 * w * h:
            continue
        blobs.append(i)
    best = None
    for a in range(len(blobs)):
        for b in range(a + 1, len(blobs)):
            i, j = blobs[a], blobs[b]
            ai, aj = st[i, cv2.CC_STAT_AREA], st[j, cv2.CC_STAT_AREA]
            if max(ai, aj) > 2.0 * min(ai, aj):
                continue
            (cxi, cyi), (cxj, cyj) = cen[i], cen[j]
            r = max(st[i, 2], st[i, 3], st[j, 2], st[j, 3]) * 0.55
            dx, dy = abs(cxi - cxj), abs(cyi - cyj)
            if dy > max(r, 0.06 * fw) or not (2.2 * r <= dx <= 0.7 * fw) or not (0.012 * fw <= r <= 0.15 * fw):
                continue
            score = ai + aj
            if best is None or score > best[0]:
                best = (score, [i, j], st, int(r))
    if best is None:
        return None
    # A small pupil sits inside a drawn eye (white with an ink outline): shut the whole eye, not only the pupil.
    score, eyes, st2, r = best
    rings = [k for k in range(1, n) if st[k, cv2.CC_STAT_AREA] >= 40 and st[k, cv2.CC_STAT_AREA] < 0.5 * st[k, 2] * st[k, 3]]
    big = []
    for e in eyes:
        cx, cy = cen[e]
        hit = [k for k in rings if st[k, 0] <= cx <= st[k, 0] + st[k, 2] and st[k, 1] <= cy <= st[k, 1] + st[k, 3] and 2.2 * r <= max(st[k, 2], st[k, 3]) / 2 <= 0.18 * fw]
        big.append(max(st[k, 2], st[k, 3]) / 2 for k in hit[:1])
    sizes = [next(g, None) for g in big]
    if all(sizes):
        r = int(min(sizes) * 0.85)
    elif r < 0.03 * fw:
        r = int(r * 2.2)
    return (score, eyes, st2, r)


dark = False
found = pair(170) or pair(110)
if not found:
    found = pair_dark(60) or pair_dark(85)
    dark = bool(found)
if not found:
    print("no pair of eyes found")
    sys.exit(2)
_, eyes, st, rr = found
out = im.copy()
sizes_seen = []
for i in eyes:
    x, y, w, h = st[i, :4]
    cx, cy, r = x0 + x + w // 2, y0 + y + h // 2, rr
    ring = np.zeros(im.shape[:2], np.uint8)
    cv2.circle(ring, (cx, cy), int(r * 1.7), 255, -1); cv2.circle(ring, (cx, cy), int(r * 1.05), 0, -1)
    px = im[ring > 0]
    if dark:
        # A drawn eye: black pupil inside a white eye with an ink outline. Find the white around the pupil, cover it
        # and its outline with the colour just above the eye (face or fur, not the muzzle or blush below), draw a lid.
        px0, py0, pw, ph = st[i, :4]
        pcx, pcy = x0 + px0 + pw // 2, y0 + py0 + ph // 2
        R = int(max(r, max(pw, ph)) * 4)
        X0, Y0, X1, Y1 = max(0, pcx - R), max(0, pcy - R), min(W, pcx + R), min(H, pcy + R)
        sub = im[Y0:Y1, X0:X1]
        sh = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
        white = cv2.inRange(sh, (0, 0, 185), (180, 60, 255))
        nn, lb, sst, _ = cv2.connectedComponentsWithStats(white)
        ring_pts = [(pcx - X0 + dx, pcy - Y0 + dy) for dx, dy in ((0, -ph), (0, ph), (-pw, 0), (pw, 0), (0, -2 * ph), (-2 * pw, 0), (2 * pw, 0))]
        labs = {lb[y, x] for x, y in ring_pts if 0 <= x < sub.shape[1] and 0 <= y < sub.shape[0] and lb[y, x] > 0}
        eye = np.zeros(sub.shape[:2], np.uint8)
        for L in labs:
            if sst[L, cv2.CC_STAT_AREA] < 0.25 * sub.shape[0] * sub.shape[1]:  # not the whole white face
                eye[lb == L] = 255
        cv2.circle(eye, (pcx - X0, pcy - Y0), max(pw, ph) // 2 + 2, 255, -1)
        ys, xs = np.nonzero(eye)
        ew = max(1, xs.max() - xs.min()); eh = max(1, ys.max() - ys.min())
        # Safety: the white must be one eye, not a muzzle or face it runs into (roundish, inside the search window).
        if not (0.6 <= ew / eh <= 1.7) or xs.min() == 0 or ys.min() == 0 or xs.max() >= sub.shape[1] - 1 or ys.max() >= sub.shape[0] - 1:
            print("eye white runs into the face; no blink")
            sys.exit(2)
        ink = max(5, int(0.12 * max(ew, eh)))
        cover = cv2.dilate(eye, np.ones((2 * ink + 1, 2 * ink + 1), np.uint8))
        band = cv2.dilate(cover, np.ones((2 * ink + 1, 2 * ink + 1), np.uint8)) - cover
        ecx, ecy = X0 + (xs.min() + xs.max()) // 2, Y0 + (ys.min() + ys.max()) // 2
        above = band.copy(); above[(ecy - Y0):, :] = 0  # only the band above the eye's middle
        apx = sub[above > 0]
        apx = apx[apx.sum(1) > np.percentile(apx.sum(1), 20)] if len(apx) else apx
        colour = np.median(apx, axis=0) if len(apx) else np.median(px, axis=0)
        # Safety: the lid colour must match the face at the eye's sides too (white marks above a dark face do not).
        sides = band.copy(); sides[:max(0, ecy - Y0 - eh // 4), :] = 0; sides[(ecy - Y0 + eh // 4):, :] = 0
        spx = sub[sides > 0]
        if len(spx) and np.abs(np.median(spx, axis=0).astype(int) - colour.astype(int)).sum() > 120:
            print("face colour round the eye is uneven; no blink")
            sys.exit(2)
        soft = cv2.GaussianBlur(cover, (7, 7), 0).astype(np.float32)[..., None] / 255
        out[Y0:Y1, X0:X1] = (out[Y0:Y1, X0:X1] * (1 - soft) + colour * soft).astype(np.uint8)
        cv2.ellipse(out, (ecx, ecy), (int(ew * 0.45), int(eh * 0.18)), 0, 10, 170, (25, 20, 20), max(4, ew // 18), cv2.LINE_AA)
        sizes_seen.append(ew)
        print(f"eye at {ecx},{ecy} r {ew // 2}")
        continue
    else:
        ring_dark = px[px.sum(1) <= np.percentile(px.sum(1), 35)]  # the dark fur ring, not the cream face
        colour = np.median(ring_dark if len(ring_dark) else px, axis=0)
    lid = np.zeros(im.shape[:2], np.uint8)
    cv2.circle(lid, (cx, cy), int(r * 1.25), 255, -1)
    soft = cv2.GaussianBlur(lid, (21, 21), 0).astype(np.float32)[..., None] / 255
    out = (out * (1 - soft) + colour * soft).astype(np.uint8)
    # Closed lid: a gentle downward curve with a dark outline.
    cv2.ellipse(out, (cx, cy), (int(r * 0.85), int(r * 0.35)), 0, 10, 170, (25, 20, 20), max(4, r // 9), cv2.LINE_AA)
    print(f"eye at {cx},{cy} r {r}")
if len(sizes_seen) == 2 and max(sizes_seen) > 1.25 * min(sizes_seen):
    print("the two eyes came out different sizes; no blink")
    sys.exit(2)
cv2.imwrite(dst, out)
