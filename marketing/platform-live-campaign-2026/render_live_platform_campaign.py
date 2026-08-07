from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw-live"
OUTPUT = ROOT / "final"
OUTPUT.mkdir(parents=True, exist_ok=True)

NAVY = (7, 31, 63)
DEEP = (3, 14, 34)
BLUE = (37, 99, 255)
CYAN = (0, 194, 255)
VIOLET = (124, 58, 237)
GREEN = (16, 185, 129)
WHITE = (248, 251, 255)
MUTED = (190, 211, 233)
FONT_REGULAR = Path(r"C:\Windows\Fonts\segoeui.ttf")
FONT_SEMIBOLD = Path(r"C:\Windows\Fonts\seguisb.ttf")
FONT_BOLD = Path(r"C:\Windows\Fonts\segoeuib.ttf")


def font(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont:
    path = FONT_BOLD if weight == "bold" else FONT_SEMIBOLD if weight == "semibold" else FONT_REGULAR
    return ImageFont.truetype(str(path), size=size)


def background(size: tuple[int, int]) -> Image.Image:
    width, height = size
    line = Image.new("RGBA", (1, height))
    pixels = line.load()
    for y in range(height):
        t = y / max(1, height - 1)
        pixels[0, y] = (
            round(DEEP[0] * (1 - t) + NAVY[0] * t),
            round(DEEP[1] * (1 - t) + NAVY[1] * t),
            round(DEEP[2] * (1 - t) + NAVY[2] * t),
            255,
        )
    canvas = line.resize(size)
    glow = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    draw.ellipse((-180, -240, 700, 650), fill=(*BLUE, 74))
    draw.ellipse((width - 650, height - 720, width + 200, height + 160), fill=(*CYAN, 45))
    glow = glow.filter(ImageFilter.GaussianBlur(150))
    canvas.alpha_composite(glow)
    return canvas


def fit(image: Image.Image, size: tuple[int, int], mode: str = "cover") -> Image.Image:
    image = image.convert("RGB")
    target_w, target_h = size
    if mode == "contain":
        scale = min(target_w / image.width, target_h / image.height)
    else:
        scale = max(target_w / image.width, target_h / image.height)
    resized = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)
    if mode == "contain":
        result = Image.new("RGB", size, WHITE)
        result.paste(resized, ((target_w - resized.width) // 2, (target_h - resized.height) // 2))
        return result
    left = max(0, (resized.width - target_w) // 2)
    top = max(0, (resized.height - target_h) // 2)
    return resized.crop((left, top, left + target_w, top + target_h))


def rounded_image(image: Image.Image, radius: int) -> Image.Image:
    image = image.convert("RGBA")
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width, image.height), radius=radius, fill=255)
    image.putalpha(mask)
    return image


def shadow(canvas: Image.Image, box: tuple[int, int, int, int], radius: int = 34, alpha: int = 105) -> None:
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(box, radius=radius, fill=(0, 0, 0, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(28))
    canvas.alpha_composite(layer)


def brand(draw: ImageDraw.ImageDraw, x: int, y: int, scale: float = 1.0) -> None:
    box = round(46 * scale)
    draw.rounded_rectangle((x, y, x + box, y + box), radius=round(13 * scale), fill=BLUE)
    draw.text((x + box / 2, y + box / 2 - 1), "N", font=font(round(25 * scale), "bold"), fill=WHITE, anchor="mm")
    draw.text((x + box + round(13 * scale), y + box / 2 - 1), "NEXUS", font=font(round(24 * scale), "bold"), fill=WHITE, anchor="lm")


def live_badge(draw: ImageDraw.ImageDraw, x: int, y: int, text: str = "LIVE PLATFORM") -> None:
    label_font = font(21, "bold")
    width = draw.textbbox((0, 0), text, font=label_font)[2] + 54
    draw.rounded_rectangle((x, y, x + width, y + 44), radius=22, fill=(*GREEN, 45), outline=(*GREEN, 180), width=2)
    draw.ellipse((x + 15, y + 16, x + 27, y + 28), fill=GREEN)
    draw.text((x + 35, y + 22), text, font=label_font, fill=WHITE, anchor="lm")


def header(canvas: Image.Image, eyebrow: str, headline: str, subhead: str, *, y: int = 58, story: bool = False) -> int:
    draw = ImageDraw.Draw(canvas)
    brand(draw, 68 if not story else 72, y)
    live_badge(draw, 68 if not story else 72, y + 78, eyebrow)
    headline_font = font(72 if not story else 84, "bold")
    body_font = font(30 if not story else 34)
    start_x = 68 if not story else 72
    headline_y = y + 150
    draw.multiline_text((start_x, headline_y), headline, font=headline_font, fill=WHITE, spacing=2)
    box = draw.multiline_textbbox((start_x, headline_y), headline, font=headline_font, spacing=2)
    body_y = box[3] + 28
    draw.multiline_text((start_x + 4, body_y), subhead, font=body_font, fill=MUTED, spacing=10)
    body_box = draw.multiline_textbbox((start_x + 4, body_y), subhead, font=body_font, spacing=10)
    return body_box[3]


def browser_frame(canvas: Image.Image, screenshot_path: Path, box: tuple[int, int, int, int], url_label: str = "nexus-ai.software") -> None:
    x1, y1, x2, y2 = box
    width, height = x2 - x1, y2 - y1
    shadow(canvas, (x1 - 8, y1 + 8, x2 + 8, y2 + 18), radius=30)
    frame = Image.new("RGBA", (width, height), (245, 249, 255, 255))
    draw = ImageDraw.Draw(frame)
    draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=25, fill=(247, 250, 255), outline=(135, 166, 208), width=2)
    bar_h = 50
    draw.rounded_rectangle((0, 0, width, bar_h + 16), radius=25, fill=(235, 243, 252))
    draw.rectangle((0, 25, width, bar_h + 1), fill=(235, 243, 252))
    for index, color in enumerate(((255, 101, 101), (255, 190, 78), (73, 204, 130))):
        draw.ellipse((18 + index * 23, 18, 30 + index * 23, 30), fill=color)
    draw.rounded_rectangle((118, 12, width - 24, 38), radius=13, fill=WHITE)
    draw.text((137, 25), url_label, font=font(15, "semibold"), fill=(75, 98, 129), anchor="lm")
    screen = fit(Image.open(screenshot_path), (width - 12, height - bar_h - 8), "cover")
    screen = rounded_image(screen, 12)
    frame.alpha_composite(screen, (6, bar_h + 2))
    canvas.alpha_composite(frame, (x1, y1))


def phone_frame(canvas: Image.Image, screenshot_path: Path, box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    width, height = x2 - x1, y2 - y1
    shadow(canvas, (x1 - 8, y1 + 8, x2 + 8, y2 + 18), radius=45)
    frame = Image.new("RGBA", (width, height), (9, 19, 36, 255))
    draw = ImageDraw.Draw(frame)
    draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=48, fill=(7, 17, 31), outline=(114, 144, 188), width=3)
    screen = fit(Image.open(screenshot_path), (width - 22, height - 24), "cover")
    screen = rounded_image(screen, 37)
    frame.alpha_composite(screen, (11, 12))
    draw.rounded_rectangle((width // 2 - 48, 14, width // 2 + 48, 28), radius=7, fill=(10, 18, 30))
    canvas.alpha_composite(frame, (x1, y1))


def footer(draw: ImageDraw.ImageDraw, y: int) -> None:
    draw.text((68, y), "nexus-ai.software", font=font(24, "semibold"), fill=MUTED)


def create_feed_ads() -> list[Path]:
    ads: list[Path] = []
    specs = [
        (
            "platform-ad-01-live-home-1080x1350.png",
            "LIVE NEXUS",
            "This is Nexus.\nLive and ready.",
            "Browse business automation by the result\nyou actually want to receive.",
            RAW / "01-home-hero-desktop.png",
            "browser",
        ),
        (
            "platform-ad-02-live-marketplace-1080x1350.png",
            "REAL MARKETPLACE",
            "Choose the output.\nNot the tool.",
            "See pricing, setup and expected delivery\nbefore checkout.",
            RAW / "02-marketplace-live-desktop.png",
            "browser",
        ),
        (
            "platform-ad-03-live-preview-1080x1350.png",
            "REAL PRODUCT PREVIEW",
            "See what you get\nbefore you buy.",
            "Open the product, review the outcome and\nunderstand setup before committing.",
            RAW / "05-social-report-output-preview.png",
            "browser",
        ),
        (
            "platform-ad-04-live-mobile-1080x1350.png",
            "LIVE ON MOBILE",
            "A complete buyer\njourney. Any screen.",
            "Browse, compare and preview products\nwithout becoming technical.",
            RAW / "06-home-live-mobile.png",
            "phones",
        ),
    ]

    for filename, eyebrow, headline, subhead, screen, mode in specs:
        canvas = background((1080, 1350))
        header(canvas, eyebrow, headline, subhead)
        if mode == "browser":
            browser_frame(canvas, screen, (55, 655, 1025, 1220))
        else:
            phone_frame(canvas, RAW / "06-home-live-mobile.png", (132, 570, 482, 1260))
            phone_frame(canvas, RAW / "07-marketplace-live-mobile.png", (598, 570, 948, 1260))
        footer(ImageDraw.Draw(canvas), 1285)
        output = OUTPUT / filename
        canvas.convert("RGB").save(output, quality=96)
        ads.append(output)
    return ads


def create_product_card_ad() -> Path:
    canvas = background((1080, 1350))
    header(canvas, "REAL PRODUCT LISTING", "The product page\nshows the details.", "Output, pricing, setup and delivery expectations—\nvisible before purchase.")
    phone_frame(canvas, RAW / "03-social-report-product-card.png", (350, 565, 730, 1265))
    footer(ImageDraw.Draw(canvas), 1285)
    output = OUTPUT / "platform-ad-05-real-product-card-1080x1350.png"
    canvas.convert("RGB").save(output, quality=96)
    return output


def create_story_frame(filename: str, eyebrow: str, headline: str, subhead: str, screen: Path, mode: str) -> Path:
    canvas = background((1080, 1920))
    header(canvas, eyebrow, headline, subhead, y=85, story=True)
    if mode == "browser":
        browser_frame(canvas, screen, (55, 760, 1025, 1450))
    elif mode == "phone":
        phone_frame(canvas, screen, (330, 720, 750, 1585))
    else:
        phone_frame(canvas, RAW / "06-home-live-mobile.png", (110, 720, 470, 1515))
        phone_frame(canvas, RAW / "07-marketplace-live-mobile.png", (610, 720, 970, 1515))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((72, 1725, 520, 1800), radius=23, fill=BLUE)
    draw.text((296, 1762), "Explore Nexus", font=font(30, "bold"), fill=WHITE, anchor="mm")
    draw.text((72, 1845), "nexus-ai.software", font=font(26, "semibold"), fill=MUTED)
    output = OUTPUT / filename
    canvas.convert("RGB").save(output, quality=96)
    return output


def render_video(frames: list[Path], output: Path) -> None:
    sys.path.insert(0, str(ROOT.parent / ".python-packages"))
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [ffmpeg, "-y"]
    for frame in frames:
        command.extend(["-loop", "1", "-framerate", "30", "-t", "3", "-i", str(frame)])
    filters = []
    for index in range(len(frames)):
        filters.append(
            f"[{index}:v]scale=1080:1920,fps=30,trim=duration=3,settb=AVTB,setpts=PTS-STARTPTS,"
            f"fade=t=in:st=0:d=0.25,fade=t=out:st=2.75:d=0.25,format=yuv420p[v{index}]"
        )
    filters.append("".join(f"[v{i}]" for i in range(len(frames))) + f"concat=n={len(frames)}:v=1:a=0[outv]")
    command.extend([
        "-filter_complex", ";".join(filters),
        "-map", "[outv]",
        "-t", str(len(frames) * 3),
        "-r", "30",
        "-c:v", "libx264",
        "-level:v", "4.2",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-video_track_timescale", "30000",
        "-movflags", "+faststart",
        str(output),
    ])
    subprocess.run(command, check=True)


def main() -> None:
    required = [
        RAW / "01-home-hero-desktop.png",
        RAW / "02-marketplace-live-desktop.png",
        RAW / "03-social-report-product-card.png",
        RAW / "05-social-report-output-preview.png",
        RAW / "06-home-live-mobile.png",
        RAW / "07-marketplace-live-mobile.png",
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing live capture(s): {', '.join(missing)}")

    feed_ads = create_feed_ads()
    feed_ads.append(create_product_card_ad())

    story_specs = [
        ("platform-story-01-1080x1920.png", "LIVE NEXUS", "Meet Nexus.\nThe platform is live.", "Buy business outputs without learning\nautomation tools.", RAW / "01-home-hero-desktop.png", "browser"),
        ("platform-story-02-1080x1920.png", "REAL MARKETPLACE", "Browse by the\nresult you need.", "Reports, alerts, intelligence and\nready-made business solutions.", RAW / "02-marketplace-live-desktop.png", "browser"),
        ("platform-story-03-1080x1920.png", "REAL PRODUCT LISTING", "See pricing and\nsetup first.", "Know what the product needs before\nyou reach checkout.", RAW / "03-social-report-product-card.png", "phone"),
        ("platform-story-04-1080x1920.png", "REAL PRODUCT PREVIEW", "Preview the\nbusiness outcome.", "Understand what you receive and how\nthe product is maintained.", RAW / "05-social-report-output-preview.png", "browser"),
        ("platform-story-05-1080x1920.png", "LIVE ON MOBILE", "Choose. Set up.\nReceive the output.", "A connected buyer journey, built around\nclear business results.", RAW / "07-marketplace-live-mobile.png", "phones"),
    ]
    story_frames = [create_story_frame(*spec) for spec in story_specs]
    render_video(story_frames, OUTPUT / "platform-video-live-nexus-15s-1080x1920.mp4")

    print(f"Rendered {len(feed_ads)} platform ads, {len(story_frames)} vertical frames and 1 MP4 to {OUTPUT}")


if __name__ == "__main__":
    main()
