from math import pi, sin
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
logo = Image.open(ROOT / "assets/champvision-logo-transparent.png").convert("RGBA")
logo.thumbnail((390, 390), Image.Resampling.LANCZOS)

frames = []
width, height = 960, 600
points = [(0, 470), (95, 450), (170, 458), (255, 408), (340, 422), (430, 344),
          (520, 365), (610, 286), (700, 303), (790, 232), (880, 255), (960, 175)]

for frame_index in range(48):
    phase = frame_index / 48
    frame = Image.new("RGB", (width, height), "#03050a")
    draw = ImageDraw.Draw(frame, "RGBA")

    for x in range(0, width, 80):
        draw.line((x, 0, x, height), fill=(36, 104, 220, 20), width=1)
    for y in range(0, height, 80):
        draw.line((0, y, width, y), fill=(36, 104, 220, 18), width=1)

    for index, x in enumerate(range(0, width, 48)):
        tower_height = 70 + ((index * 47) % 210)
        draw.rectangle((x, height - tower_height, x + 33, height), fill=(7, 14, 26, 220))
        for window_y in range(height - tower_height + 12, height - 8, 18):
            glow = 40 + int(35 * sin(phase * 2 * pi + index))
            draw.rectangle((x + 7, window_y, x + 11, window_y + 5), fill=(45, 112, 230, glow))

    shifted = [(x, y + 7 * sin(phase * 2 * pi + x / 100)) for x, y in points]
    reveal = max(2, int(len(shifted) * min(1, phase * 1.7 + .25)))
    draw.line(shifted[:reveal], fill=(38, 116, 255, 210), width=4, joint="curve")
    for x, y in shifted[:reveal]:
        draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=(119, 175, 255, 230))

    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    pulse = 86 + int(24 * sin(phase * 2 * pi))
    glow_draw.ellipse((665 - pulse, 285 - pulse, 665 + pulse, 285 + pulse), fill=(19, 104, 255, 95))
    glow = glow.filter(ImageFilter.GaussianBlur(52))
    frame = Image.alpha_composite(frame.convert("RGBA"), glow)

    logo_frame = ImageEnhance.Brightness(logo).enhance(1 + .08 * sin(phase * 2 * pi))
    logo_x = 665 - logo_frame.width // 2
    logo_y = 285 - logo_frame.height // 2 + int(5 * sin(phase * 2 * pi))
    frame.alpha_composite(logo_frame, (logo_x, logo_y))

    shade = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    shade_draw = ImageDraw.Draw(shade)
    shade_draw.rectangle((0, 0, 500, height), fill=(0, 0, 0, 135))
    frame = Image.alpha_composite(frame, shade).convert("RGB")
    frames.append(frame)

frames[0].save(
    ROOT / "assets/champvision-hero.webp",
    save_all=True,
    append_images=frames[1:],
    duration=85,
    loop=0,
    quality=70,
    method=4,
)
