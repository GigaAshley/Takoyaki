#!/usr/bin/env python3
# Regenerate every bundled brand asset — public/ icons and the
# docker/branding-defaults/ set — from the source files in
# scripts/brand-source/. Run any time the brand mark changes so all favicon /
# apple-touch-icon / PWA icon variants stay in sync from a single source.
#
# Sources: logo.svg (vector mark), logo.png (1024x1024 render of it,
# transparent), wordmark.png (transparent, light letters — dark UI only).
#
# Requirements: Pillow (`pip install pillow`).
# Usage: run from repo root — `python3 scripts/regen-brand-icons.py`.
from PIL import Image
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "scripts" / "brand-source"
LOGO = Image.open(SRC / "logo.png").convert("RGBA")
WORDMARK = Image.open(SRC / "wordmark.png").convert("RGBA")
SVG_SRC = SRC / "logo.svg"

PUBLIC = REPO / "public"
DEFAULTS = REPO / "docker" / "branding-defaults"

# App base color (theme_color, --color-pv-base-end).
DARK = (0x0a, 0x0b, 0x12, 255)


def resize_transparent(size):
    return LOGO.resize((size, size), Image.LANCZOS)


def resize_on_dark(size, pad_frac=0.08):
    # Composite the logo (scaled to (1 - 2*pad_frac) of size) onto solid dark
    # bg. Padding keeps the mark away from the iOS mask's rounded-corner clip.
    bg = Image.new("RGBA", (size, size), DARK)
    inner = max(1, int(size * (1 - 2 * pad_frac)))
    bg.alpha_composite(LOGO.resize((inner, inner), Image.LANCZOS),
                       dest=((size - inner) // 2, (size - inner) // 2))
    return bg


def save(img, path):
    img.save(path, "PNG", optimize=True)
    print(f"wrote {path.relative_to(REPO)} ({img.size[0]}x{img.size[1]})")


# Transparent variants: favicon (browser paints bg), PWA manifest icons
# (Android uses manifest.background_color).
for name, size in {
    "favicon-16.png": 16,
    "favicon-32.png": 32,
    "apple-touch-icon-192.png": 192,
    "apple-touch-icon-512.png": 512,
    "full-icon.png": 600,
}.items():
    save(resize_transparent(size), PUBLIC / name)

for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
    save(resize_transparent(size), PUBLIC / "icons" / f"{size}x{size}.png")

# iOS apple-touch-icon variants: iOS paints WHITE behind transparent PNGs
# (and masks to a rounded square), so bake the dark base in.
for name, size in {
    "apple-touch-icon-40.png": 40,
    "apple-touch-icon-60.png": 60,
    "apple-touch-icon-76.png": 76,
    "apple-touch-icon-120.png": 120,
    "apple-touch-icon-152.png": 152,
    "apple-touch-icon-180.png": 180,
}.items():
    save(resize_on_dark(size), PUBLIC / name)

# Multi-size ICO for browser-tab favicon fallback.
ico_sizes = [(16, 16), (32, 32), (48, 48)]
resize_transparent(48).save(PUBLIC / "favicon.ico", format="ICO", sizes=ico_sizes)
print("wrote public/favicon.ico (16 + 32 + 48 transparent)")

(PUBLIC / "icon.svg").write_bytes(SVG_SRC.read_bytes())
print("wrote public/icon.svg")

# Bundled branding defaults (served when an instance sets no override).
save(resize_transparent(600), DEFAULTS / "icon.png")
save(resize_transparent(192), DEFAULTS / "pwa-icon-192.png")
save(resize_transparent(512), DEFAULTS / "pwa-icon-512.png")
save(WORDMARK, DEFAULTS / "wordmark.png")
(DEFAULTS / "favicon.svg").write_bytes(SVG_SRC.read_bytes())
print("wrote docker/branding-defaults/favicon.svg")

print("\nAll brand assets regenerated.")
