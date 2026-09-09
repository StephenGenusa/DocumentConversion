"""Generate the app icon: a document page with two conversion arrows on an indigo tile.

Writes build/icon.ico (Windows, multi-size), build/icon.png and resources/icon.png (512px).
Run:  python build/make-icon.py
"""
from PIL import Image, ImageDraw
from pathlib import Path
import math

S = 1024  # render size; downscaled for output
INDIGO = (99, 102, 241)      # #6366f1, matches the UI primary
INDIGO_DARK = (67, 56, 202)  # #4338ca
WHITE = (255, 255, 255)
PAPER_LINE = (199, 210, 254) # #c7d2fe

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded tile with a subtle vertical gradient
tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
td = ImageDraw.Draw(tile)
for y in range(S):
    t = y / S
    c = tuple(int(INDIGO[i] * (1 - t) + INDIGO_DARK[i] * t) for i in range(3)) + (255,)
    td.line([(0, y), (S, y)], fill=c)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
img.paste(tile, (0, 0), mask)

# Document page (left-leaning) with folded corner
px0, py0, px1, py1 = int(S * 0.26), int(S * 0.18), int(S * 0.62), int(S * 0.70)
fold = int(S * 0.11)
page = [(px0, py0), (px1 - fold, py0), (px1, py0 + fold), (px1, py1), (px0, py1)]
d.polygon(page, fill=WHITE)
d.polygon([(px1 - fold, py0), (px1 - fold, py0 + fold), (px1, py0 + fold)], fill=PAPER_LINE)
# text lines
lw = int(S * 0.022)
for i, frac in enumerate([0.36, 0.44, 0.52, 0.60]):
    y = int(S * frac)
    x1 = px1 - int(S * 0.06) if i != 3 else px0 + int(S * 0.18)
    d.rounded_rectangle([px0 + int(S * 0.06), y, x1, y + lw], radius=lw // 2, fill=PAPER_LINE)

# Two circular conversion arrows (bottom-right), white with a stroke
cx, cy, r = int(S * 0.68), int(S * 0.70), int(S * 0.15)
stroke = int(S * 0.055)
# dark backing disc so arrows read against the page edge
d.ellipse([cx - r - stroke * 1.6, cy - r - stroke * 1.6, cx + r + stroke * 1.6, cy + r + stroke * 1.6], fill=INDIGO_DARK)

def arc_arrow(start, end):
    d.arc([cx - r, cy - r, cx + r, cy + r], start=start, end=end, fill=WHITE, width=stroke)
    # arrow head at `end`
    a = math.radians(end)
    tip = (cx + (r) * math.cos(a), cy + (r) * math.sin(a))
    # tangent direction (clockwise)
    tx, ty = -math.sin(a), math.cos(a)
    nx, ny = math.cos(a), math.sin(a)
    # Base sits just behind the arc end (so it overlaps the stroke), point extends forward.
    back = stroke * 0.35
    length = stroke * 1.9
    half = stroke * 1.05
    bx, by = tip[0] - tx * back, tip[1] - ty * back
    p1 = (bx + tx * length, by + ty * length)
    p2 = (bx + nx * half, by + ny * half)
    p3 = (bx - nx * half, by - ny * half)
    d.polygon([p1, p2, p3], fill=WHITE)

arc_arrow(200, 330)
arc_arrow(20, 150)

out_png = img.resize((512, 512), Image.LANCZOS)
root = Path(__file__).resolve().parents[1]
out_png.save(root / "build" / "icon.png")
out_png.save(root / "resources" / "icon.png")
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.resize((256, 256), Image.LANCZOS).save(root / "build" / "icon.ico", format="ICO", sizes=ico_sizes)
print("wrote build/icon.ico, build/icon.png, resources/icon.png")
