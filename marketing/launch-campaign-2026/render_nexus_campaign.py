from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "final"
OUTPUT.mkdir(parents=True, exist_ok=True)

NAVY = (7, 31, 63)
BLUE = (37, 99, 255)
CYAN = (0, 194, 255)
VIOLET = (124, 58, 237)
WHITE = (247, 251, 255)
MUTED = (193, 214, 234)
GREEN = (16, 185, 129)

FONT_REGULAR = Path(r"C:\Windows\Fonts\segoeui.ttf")
FONT_SEMIBOLD = Path(r"C:\Windows\Fonts\seguisb.ttf")
FONT_BOLD = Path(r"C:\Windows\Fonts\segoeuib.ttf")


def typeface(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont:
    path = FONT_BOLD if weight == "bold" else FONT_SEMIBOLD if weight == "semibold" else FONT_REGULAR
    return ImageFont.truetype(str(path), size=size)


def cover(image: Image.Image, size: tuple[int, int], anchor_y: float = 0.5) -> Image.Image:
    image = image.convert("RGB")
    target_w, target_h = size
    scale = max(target_w / image.width, target_h / image.height)
    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    left = max(0, (resized.width - target_w) // 2)
    max_top = max(0, resized.height - target_h)
    top = round(max_top * max(0, min(1, anchor_y)))
    return resized.crop((left, top, left + target_w, top + target_h))


def rgba_gradient(size: tuple[int, int], *, top_alpha: int, bottom_alpha: int, left_alpha: int = 0) -> Image.Image:
    width, height = size
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    pixels = layer.load()
    for y in range(height):
        vertical = top_alpha + (bottom_alpha - top_alpha) * (y / max(1, height - 1))
        for x in range(width):
            horizontal = left_alpha * (1 - x / max(1, width - 1))
            alpha = int(max(vertical, horizontal))
            pixels[x, y] = (3, 17, 39, max(0, min(255, alpha)))
    return layer


def add_glow(canvas: Image.Image, center: tuple[int, int], radius: int, color: tuple[int, int, int], alpha: int) -> None:
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    x, y = center
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*color, alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(radius // 2))
    canvas.alpha_composite(glow)


def brand(draw: ImageDraw.ImageDraw, x: int, y: int, scale: float = 1.0) -> None:
    box = round(46 * scale)
    radius = round(13 * scale)
    draw.rounded_rectangle((x, y, x + box, y + box), radius=radius, fill=BLUE)
    draw.text((x + box / 2, y + box / 2 - 1), "N", font=typeface(round(25 * scale), "bold"), fill=WHITE, anchor="mm")
    draw.text((x + box + round(13 * scale), y + box / 2 - 1), "NEXUS", font=typeface(round(24 * scale), "bold"), fill=WHITE, anchor="lm")


def pill(draw: ImageDraw.ImageDraw, text: str, x: int, y: int, accent: tuple[int, int, int] = CYAN) -> int:
    font = typeface(24, "bold")
    bbox = draw.textbbox((0, 0), text, font=font)
    width = bbox[2] - bbox[0] + 42
    draw.rounded_rectangle((x, y, x + width, y + 48), radius=24, fill=(*accent, 38), outline=(*accent, 150), width=2)
    draw.text((x + 21, y + 24), text, font=font, fill=WHITE, anchor="lm")
    return width


def multiline(draw: ImageDraw.ImageDraw, text: str, x: int, y: int, font: ImageFont.FreeTypeFont, fill, spacing: int) -> int:
    draw.multiline_text((x, y), text, font=font, fill=fill, spacing=spacing)
    bbox = draw.multiline_textbbox((x, y), text, font=font, spacing=spacing)
    return bbox[3]


def cta(draw: ImageDraw.ImageDraw, label: str, x: int, y: int, width: int | None = None) -> None:
    font = typeface(27, "bold")
    text_box = draw.textbbox((0, 0), label, font=font)
    actual_width = width or (text_box[2] - text_box[0] + 72)
    draw.rounded_rectangle((x, y, x + actual_width, y + 64), radius=20, fill=BLUE)
    draw.text((x + actual_width / 2, y + 32), label, font=font, fill=WHITE, anchor="mm")


def footer(draw: ImageDraw.ImageDraw, y: int, dark: bool = True) -> None:
    fill = MUTED if dark else NAVY
    draw.text((72, y), "nexus-ai.software", font=typeface(24, "semibold"), fill=fill)


def create_feed_ad(source: Path, filename: str, eyebrow: str, headline: str, subhead: str, button: str, anchor_y: float = 0.5, accent=CYAN) -> Path:
    size = (1080, 1350)
    base = cover(Image.open(source), size, anchor_y=anchor_y).convert("RGBA")
    base.alpha_composite(rgba_gradient(size, top_alpha=178, bottom_alpha=28, left_alpha=200))
    add_glow(base, (120, 160), 250, BLUE, 55)
    draw = ImageDraw.Draw(base)
    brand(draw, 68, 56)
    pill(draw, eyebrow, 68, 145, accent)
    headline_bottom = multiline(draw, headline, 68, 225, typeface(77, "bold"), WHITE, 2)
    sub_y = headline_bottom + 30
    multiline(draw, subhead, 72, sub_y, typeface(31, "regular"), MUTED, 11)
    cta(draw, button, 68, 1194)
    footer(draw, 1283)
    path = OUTPUT / filename
    base.convert("RGB").save(path, quality=96)
    return path


def create_carousel_slide(source: Path, filename: str, number: str, headline: str, body: str, final: bool = False) -> Path:
    size = (1080, 1350)
    base = cover(Image.open(source), size, anchor_y=0.52).convert("RGBA")
    overlay = Image.new("RGBA", size, (4, 20, 47, 112 if final else 148))
    base.alpha_composite(overlay)
    base.alpha_composite(rgba_gradient(size, top_alpha=210, bottom_alpha=50, left_alpha=150))
    draw = ImageDraw.Draw(base)
    brand(draw, 68, 58)
    draw.text((1012, 71), number, font=typeface(28, "bold"), fill=CYAN, anchor="ra")
    line_y = 167
    draw.rounded_rectangle((68, line_y, 220, line_y + 8), radius=4, fill=CYAN)
    headline_bottom = multiline(draw, headline, 68, 218, typeface(77, "bold"), WHITE, 4)
    multiline(draw, body, 72, headline_bottom + 34, typeface(32, "regular"), MUTED, 12)
    if final:
        cta(draw, "Claim a free pilot report", 68, 1168, width=470)
    footer(draw, 1283)
    path = OUTPUT / filename
    base.convert("RGB").save(path, quality=96)
    return path


def create_story_frame(source: Path, filename: str, eyebrow: str, headline: str, body: str, button: str = "") -> Path:
    size = (1080, 1920)
    base = cover(Image.open(source), size, anchor_y=0.48).convert("RGBA")
    base.alpha_composite(rgba_gradient(size, top_alpha=205, bottom_alpha=80, left_alpha=180))
    draw = ImageDraw.Draw(base)
    brand(draw, 72, 86)
    pill(draw, eyebrow, 72, 188)
    headline_bottom = multiline(draw, headline, 72, 290, typeface(84, "bold"), WHITE, 4)
    multiline(draw, body, 76, headline_bottom + 40, typeface(34, "regular"), MUTED, 13)
    if button:
        cta(draw, button, 72, 1730, width=500)
    footer(draw, 1845)
    path = OUTPUT / filename
    base.convert("RGB").save(path, quality=96)
    return path


def render_video(frame_paths: list[Path], output_path: Path) -> None:
    package_dir = ROOT.parent / ".python-packages"
    sys.path.insert(0, str(package_dir))
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [ffmpeg, "-y"]
    for frame in frame_paths:
        command.extend(["-loop", "1", "-framerate", "30", "-t", "3", "-i", str(frame)])

    filters = []
    for index in range(len(frame_paths)):
        filters.append(
            f"[{index}:v]scale=1080:1920,fps=30,trim=duration=3,settb=AVTB,setpts=PTS-STARTPTS,"
            f"fade=t=in:st=0:d=0.25,fade=t=out:st=2.75:d=0.25,format=yuv420p[v{index}]"
        )
    filters.append("".join(f"[v{index}]" for index in range(len(frame_paths))) + f"concat=n={len(frame_paths)}:v=1:a=0[outv]")
    command.extend([
        "-filter_complex", ";".join(filters),
        "-map", "[outv]",
        "-t", "15",
        "-r", "30",
        "-c:v", "libx264",
        "-level:v", "4.2",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-video_track_timescale", "30000",
        "-movflags", "+faststart",
        str(output_path),
    ])
    subprocess.run(command, check=True)


def main() -> None:
    master_output = ROOT / "master-output.png"
    master_report = ROOT / "master-free-report.png"
    master_bundle = ROOT / "master-bundle.png"

    required = [master_output, master_report, master_bundle]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing campaign master(s): {', '.join(missing)}")

    feed_ads = [
        create_feed_ad(master_output, "ad-01-output-not-ai-1080x1350.png", "NEXUS", "AI is not\nthe product.\nThe output is.", "Verified automations.\nClear business results.", "Explore Nexus"),
        create_feed_ad(master_report, "ad-02-free-social-report-1080x1350.png", "FOUNDING CUSTOMER PILOT", "Get a free\nsocial media\nreport.", "See what is working, what is not,\nand what to do next.", "Claim a pilot report", anchor_y=0.42, accent=GREEN),
        create_feed_ad(master_bundle, "ad-03-visibility-bundle-1080x1350.png", "ONLINE VISIBILITY BUNDLE", "Four reports.\nOne clear view.", "Social performance, competitors,\nwebsite activity and brand sentiment.", "See the bundle", anchor_y=0.55, accent=VIOLET),
        create_feed_ad(master_output, "ad-04-preview-before-buying-1080x1350.png", "BUY WITH CLARITY", "See what you get\nbefore you buy.", "Preview the output. Complete setup.\nReceive the result in your dashboard.", "Browse verified products", anchor_y=0.52),
    ]

    carousel_specs = [
        (master_output, "carousel-01-1080x1350.png", "01 / 05", "Your business does not\nneed more AI.", "Most teams already have enough tools.\nWhat they need is a result they can use.", False),
        (master_output, "carousel-02-1080x1350.png", "02 / 05", "You need clear\noutputs.", "Reports. Alerts. Summaries. Insights.\nUseful work delivered in a clear format.", False),
        (master_report, "carousel-03-1080x1350.png", "03 / 05", "Preview before\nyou buy.", "Understand what the product creates and\nwhat setup it needs before checkout.", False),
        (master_bundle, "carousel-04-1080x1350.png", "04 / 05", "Set it up once.\nReceive the result.", "Your setup, orders and delivered outputs\nstay together in the Nexus dashboard.", False),
        (master_report, "carousel-05-1080x1350.png", "05 / 05", "Start with a free\nsocial media report.", "See the quality first. No technical setup\nlanguage. Just a report you can use.", True),
    ]
    carousel = [create_carousel_slide(*spec) for spec in carousel_specs]

    story_specs = [
        (master_output, "story-01-1080x1920.png", "A BETTER WAY TO BUY AUTOMATION", "Your business does\nnot need more AI.", "It needs a result your team\ncan actually use.", ""),
        (master_output, "story-02-1080x1920.png", "CLEAR BUSINESS OUTPUTS", "Reports. Alerts.\nInsights. Next steps.", "Nexus packages automation around\nwhat gets delivered.", ""),
        (master_report, "story-03-1080x1920.png", "PREVIEW BEFORE CHECKOUT", "See what you get\nbefore you buy.", "Know the output, setup and support\nroute before committing.", ""),
        (master_bundle, "story-04-1080x1920.png", "ONE CONNECTED BUYER JOURNEY", "Choose. Set up.\nReceive the output.", "Orders and results stay together\nin your Nexus dashboard.", ""),
        (master_report, "story-05-1080x1920.png", "FOUNDING CUSTOMER PILOT", "Start with a free\nsocial media report.", "See the quality first. Then decide\nwhat your business needs next.", "Claim your pilot"),
    ]
    story_frames = [create_story_frame(*spec) for spec in story_specs]
    render_video(story_frames, OUTPUT / "video-01-nexus-launch-15s-1080x1920.mp4")

    print(f"Rendered {len(feed_ads)} feed ads, {len(carousel)} carousel slides, {len(story_frames)} story frames and 1 MP4 to {OUTPUT}")


if __name__ == "__main__":
    main()
