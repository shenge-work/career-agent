#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate landing/assets/og-cover.png (1200x630) matching CareerAgent branding."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1200, 630
OUT = os.path.join(os.path.dirname(__file__), "og-cover.png")

FONT_DIR = r"C:/Windows/Fonts"
F_REG = os.path.join(FONT_DIR, "msyh.ttc")      # Microsoft YaHei
F_BOLD = os.path.join(FONT_DIR, "msyhbd.ttc")   # Microsoft YaHei Bold

def font(path, size, idx=0):
    return ImageFont.truetype(path, size, index=idx)

# ---- palette (from css/style.css) ----
NAVY_TOP = (17, 24, 39)      # #111827
NAVY_BOT = (11, 15, 26)      # #0b0f1a
PRIMARY = (79, 70, 229)      # #4f46e5
PRIMARY_SOFT = (199, 210, 254)  # #c7d2fe
INDIGO_LT = (129, 140, 248)  # #818cf8
WHITE = (255, 255, 255)
GRAY = (203, 213, 225)       # #cbd5e1
FOOT = (148, 163, 184)       # #94a3b8

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# ---- base vertical gradient ----
base = Image.new("RGB", (W, H))
grad = Image.new("RGB", (1, H))
px = grad.load()
for y in range(H):
    px[0, y] = lerp(NAVY_TOP, NAVY_BOT, y / (H - 1))
base.paste(grad.resize((W, H)))

# ---- indigo radial glow (soft) ----
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
g = ImageDraw.Draw(glow)
g.ellipse([620, -260, 1200 + 260, 560], fill=PRIMARY + (70,))
glow = glow.filter(ImageFilter.GaussianBlur(140))
base = Image.alpha_composite(base.convert("RGBA"), glow).convert("RGB")

d = ImageDraw.Draw(base)

# ---- brand mark (indigo rounded square + white document icon) ----
MX, MY, MS = 80, 64, 64
d.rounded_rectangle([MX, MY, MX + MS, MY + MS], radius=15, fill=PRIMARY)
# document icon centered in mark
ix, iy, iw, ih = MX + 16, MY + 14, 32, 36
d.rounded_rectangle([ix, iy, ix + iw, iy + ih], radius=5, outline=WHITE, width=3)
for k in range(3):
    ly = iy + 10 + k * 8
    lw = 18 if k < 2 else 11
    d.line([ix + 7, ly, ix + 7 + lw, ly], fill=WHITE, width=3)

# ---- wordmark ----
f_word = font(F_BOLD, 40)
d.text((MX + MS + 22, MY + 6), "CareerAgent", font=f_word, fill=WHITE)

# ---- eyebrow pill ----
f_eyebrow = font(F_REG, 21)
eyebrow = "AI 求职助手"
eb_w = d.textlength(eyebrow, font=f_eyebrow)
pill_x, pill_y, pad_x, pad_y = 80, 168, 16, 9
d.rounded_rectangle([pill_x, pill_y, pill_x + eb_w + pad_x * 2, pill_y + 21 + pad_y * 2],
                    radius=999, fill=(79, 70, 229, 40) if False else (99, 102, 241, 38),
                    outline=(199, 210, 254, 110), width=1)
d.text((pill_x + pad_x, pill_y + pad_y - 1), eyebrow, font=f_eyebrow, fill=PRIMARY_SOFT)

# ---- headline (two lines) ----
f_head = font(F_BOLD, 60)
line1 = "你只管提升专业、练好面试"
d.text((80, 250), line1, font=f_head, fill=WHITE)
# line2 with accent on "AI"
pre = "剩下的交给 "
w_pre = d.textlength(pre, font=f_head)
d.text((80, 330), pre, font=f_head, fill=WHITE)
d.text((80 + w_pre, 330), "AI", font=f_head, fill=INDIGO_LT)

# ---- subtitle ----
f_sub = font(F_REG, 24)
sub = "让 AI 替你搞定求职杂活，你只管专注专业与面试"
d.text((80, 414), sub, font=f_sub, fill=GRAY)

# ---- platform pills (Windows / macOS) ----
f_pill = font(F_REG, 22)
pills = [("Windows", (52, 211, 153)), ("macOS", (96, 165, 250))]
px0, py0, ppad, gap = 80, 500, 18, 14
for txt, dot in pills:
    tw = d.textlength(txt, font=f_pill)
    bw = tw + ppad * 2 + 22
    d.rounded_rectangle([px0, py0, px0 + bw, py0 + 40], radius=20,
                        fill=(255, 255, 255, 20), outline=(255, 255, 255, 35), width=1)
    d.ellipse([px0 + ppad, py0 + 16, px0 + ppad + 9, py0 + 25], fill=dot)
    d.text((px0 + ppad + 18, py0 + 8), txt, font=f_pill, fill=(229, 231, 235))
    px0 += bw + gap

# ---- footer domain ----
f_foot = font(F_REG, 18)
domain = "career-agent.pages.dev"
fw = d.textlength(domain, font=f_foot)
d.text((W - 80 - fw, H - 56), domain, font=f_foot, fill=FOOT)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
base.save(OUT, "PNG")
print("saved", OUT, base.size)
