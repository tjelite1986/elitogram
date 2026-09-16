#!/usr/bin/env python3
"""Generate the PWA icon set in public/.

A host-side developer tool, not part of the runtime: it is run by hand when the
icon design changes, and its output (the PNGs) is what ships. Requires Pillow.

    python3 scripts/make-icons.py

Bump the ?v= query in app/manifest.ts after regenerating. Android bakes the
icon into a generated APK at install time and only re-reads it when it notices
the manifest changed, so an icon swapped behind an unchanged URL never reaches
a home screen that already has the app.
"""

from pathlib import Path

from PIL import Image, ImageDraw

PUBLIC = Path(__file__).resolve().parent.parent / "public"

ACCENT = (168, 85, 247)      # --accent, violet-500
ACCENT_DEEP = (88, 28, 135)  # violet-900, the far end of the maskable gradient
TILE_TOP = (30, 19, 42)      # the violet-tinted dark the background fades from
TILE_BOTTOM = (18, 18, 18)   # --app-bg's base
WHITE = (255, 255, 255)

SUPERSAMPLE = 4


def vertical_gradient(size, top, bottom):
    """A one-pixel-wide gradient stretched to `size` — cheaper than per-pixel."""
    strip = Image.new("RGB", (1, size))
    px = strip.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return strip.resize((size, size), Image.Resampling.BICUBIC)


def stack_icon(size, *, background, back_fill, front_fill, lens, bleed=False):
    """The Elitogram mark: two stacked photo frames, the front one holding a
    lens — a feed of pictures rather than a single picture.

    `bleed` fills the whole square (iOS applies its own rounding, and a maskable
    icon must have paint in every corner); otherwise the tile gets Android's
    rounded-square silhouette.
    """
    s = size * SUPERSAMPLE
    img = background(s).convert("RGBA")

    if not bleed:
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, s - 1, s - 1), radius=s * 0.22, fill=255
        )
        img.putalpha(mask)

    draw = ImageDraw.Draw(img)

    # Two square frames, the back one peeking out up and to the left. Square
    # because that is the shape every tile in the grid is cropped to.
    side = s * (0.50 if bleed else 0.56)
    offset = side * 0.15
    cx = cy = s / 2
    back = (
        cx - side / 2 - offset,
        cy - side / 2 - offset,
        cx + side / 2 - offset,
        cy + side / 2 - offset,
    )
    front = (
        cx - side / 2 + offset,
        cy - side / 2 + offset,
        cx + side / 2 + offset,
        cy + side / 2 + offset,
    )
    draw.rounded_rectangle(back, radius=side * 0.24, fill=back_fill)
    draw.rounded_rectangle(front, radius=side * 0.24, fill=front_fill)

    # The lens: a ring, not a disc. A filled circle at this size reads as a
    # button; the open one reads as something you look through.
    r = side * 0.235
    fx = (front[0] + front[2]) / 2
    fy = (front[1] + front[3]) / 2
    draw.ellipse(
        (fx - r, fy - r, fx + r, fy + r),
        outline=lens,
        width=round(side * 0.085),
    )

    return img.resize((size, size), Image.Resampling.LANCZOS)


def main():
    PUBLIC.mkdir(parents=True, exist_ok=True)

    def tile(s):
        return vertical_gradient(s, TILE_TOP, TILE_BOTTOM)

    def violet(s):
        return vertical_gradient(s, ACCENT, ACCENT_DEEP)

    # "any": the dark tile, so the icon reads as the app on a dark home screen
    # rather than as a violet blob.
    for size in (512, 192):
        stack_icon(
            size,
            background=tile,
            back_fill=(*ACCENT, 110),
            front_fill=ACCENT,
            lens=WHITE,
        ).save(PUBLIC / f"icon-{size}.png")

    # "maskable": paint to every edge. The launcher crops this to whatever
    # shape it likes, so the frames sit well inside the 80% safe zone.
    stack_icon(
        512,
        background=violet,
        back_fill=(*WHITE, 110),
        front_fill=WHITE,
        lens=ACCENT_DEEP,
        bleed=True,
    ).save(PUBLIC / "icon-maskable-512.png")

    # iOS rounds this itself and puts it on the home screen as-is.
    stack_icon(
        180,
        background=tile,
        back_fill=(*ACCENT, 110),
        front_fill=ACCENT,
        lens=WHITE,
        bleed=True,
    ).save(PUBLIC / "apple-touch-icon.png")

    stack_icon(
        32,
        background=tile,
        back_fill=(*ACCENT, 110),
        front_fill=ACCENT,
        lens=WHITE,
    ).save(PUBLIC / "favicon-32.png")

    for f in sorted(PUBLIC.glob("*.png")):
        print(f"{f.name}: {f.stat().st_size} B")


if __name__ == "__main__":
    main()
