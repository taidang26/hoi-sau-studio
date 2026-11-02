# Pose B onto pose A, small regions only: for each region of A (eyes, a hand...), find where that part sits in
# pose B (edge template match within +-SEARCH px), take B's patch from there and paste it into A under a
# feathered ellipse. Everything outside the regions is A, so the room never moves between poses.
# python align_pose.py shots_dir s01:x0,y0,x1,y1[@dx,dy][;...] [...]   (@dx,dy: take B from there, no search; @sift: warp B onto A by features around the region, so unchanged lines stay put)  -> shots_dir/sXX-b2.png
import sys
import cv2
import numpy as np

SEARCH = 120
d = sys.argv[1]
for arg in sys.argv[2:]:
    s, regs = arg.split(":")
    a = cv2.imread(f"{d}/{s}.png")
    b = cv2.resize(cv2.imread(f"{d}/{s}-b.png"), (a.shape[1], a.shape[0]))
    out = a.astype(np.float32)
    notes = []
    for r in regs.split(";"):
        r, _, off = r.partition("@")
        x0, y0, x1, y1 = map(int, r.split(","))
        sx0, sy0 = max(0, x0 - SEARCH), max(0, y0 - SEARCH)
        win = b[sy0:min(b.shape[0], y1 + SEARCH), sx0:min(b.shape[1], x1 + SEARCH)]
        res = cv2.matchTemplate(cv2.Canny(win, 60, 160), cv2.Canny(a[y0:y1, x0:x1], 60, 160), cv2.TM_CCORR_NORMED)
        _, score, _, (mx, my) = cv2.minMaxLoc(res)
        bx, by = sx0 + mx, sy0 + my
        if off == "sift":
            pad = 160
            X0, Y0, X1, Y1 = max(0, x0 - pad), max(0, y0 - pad), min(a.shape[1], x1 + pad), min(a.shape[0], y1 + pad)
            sift = cv2.SIFT_create(4000)
            ka, da = sift.detectAndCompute(cv2.cvtColor(a[Y0:Y1, X0:X1], cv2.COLOR_BGR2GRAY), None)
            kb, db = sift.detectAndCompute(cv2.cvtColor(b[Y0:Y1, X0:X1], cv2.COLOR_BGR2GRAY), None)
            mm = [x for x, y in cv2.BFMatcher().knnMatch(db, da, k=2) if x.distance < 0.75 * y.distance]
            M, inl = cv2.estimateAffinePartial2D(np.float32([kb[x.queryIdx].pt for x in mm]), np.float32([ka[x.trainIdx].pt for x in mm]), method=cv2.RANSAC, ransacReprojThreshold=2)
            wb = cv2.warpAffine(b[Y0:Y1, X0:X1], M, (X1 - X0, Y1 - Y0), borderMode=cv2.BORDER_REPLICATE)
            bfull = b.copy(); bfull[Y0:Y1, X0:X1] = wb
            patch = bfull[y0:y1, x0:x1].astype(np.float32)
            score = float(inl.sum()); bx, by = x0 + M[0, 2], y0 + M[1, 2]
        elif off:
            dx, dy = map(int, off.split(",")); bx, by, score = x0 + dx, y0 + dy, 1.0
        if off != "sift":
            patch = b[by:by + (y1 - y0), bx:bx + (x1 - x0)].astype(np.float32)
        m = np.zeros((y1 - y0, x1 - x0), np.float32)
        cv2.ellipse(m, ((x1 - x0) // 2, (y1 - y0) // 2), (int((x1 - x0) * 0.42), int((y1 - y0) * 0.42)), 0, 0, 360, 1, -1)
        k = max(31, (min(x1 - x0, y1 - y0) // 4) | 1)
        m = cv2.GaussianBlur(m, (k, k), 0)[..., None]
        out[y0:y1, x0:x1] = out[y0:y1, x0:x1] * (1 - m) + patch * m
        notes.append(f"{r} -> moved {bx - x0:.0f},{by - y0:.0f} match {score:.2f}")
    cv2.imwrite(f"{d}/{s}-b2.png", out.astype(np.uint8))
    print(s, "; ".join(notes))
