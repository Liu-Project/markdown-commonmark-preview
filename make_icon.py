from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os

DEJAVU = next(
    (p for p in [
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ] if os.path.exists(p)),
    None,
)


def gradient_bg(size, radius):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / size
        r = int(43 + (78 - 43) * t)
        g = int(88 + (67 - 88) * t)
        b = int(118 + (118 - 118) * t)
        d.line([(0, y), (size, y)], fill=(r, g, b, 255))
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    img.putalpha(mask)
    return img


def text_size(d, txt, font):
    bbox = d.textbbox((0, 0), txt, font=font)
    return (bbox[2] - bbox[0], bbox[3] - bbox[1], bbox[0], bbox[1])


def fit_font(d, txt, font_path, target_width, max_size):
    size = max_size
    while size > 8:
        f = ImageFont.truetype(font_path, size)
        w, _, _, _ = text_size(d, txt, f)
        if w <= target_width:
            return f
        size -= 1
    return ImageFont.truetype(font_path, size)


def draw_text(d, size, txt, font, fill, cy):
    w, h, x0, y0 = text_size(d, txt, font)
    d.text((size / 2 - w / 2 - x0, cy - h / 2 - y0), txt, font=font, fill=fill)


def make_512():
    S = 512
    img = gradient_bg(S, 96)
    d = ImageDraw.Draw(img)

    big = fit_font(d, "Markdown", DEJAVU, 460, 122)
    small = ImageFont.truetype(DEJAVU, 46)

    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    draw_text(sd, S, "Markdown", big, (0, 0, 0, 110), 182 + 5)
    draw_text(sd, S, "Edit & Preview", small, (0, 0, 0, 110), 352 + 4)
    shadow = shadow.filter(ImageFilter.GaussianBlur(5))
    img = Image.alpha_composite(img, shadow)

    d = ImageDraw.Draw(img)
    draw_text(d, S, "Markdown", big, (255, 255, 255, 255), 182)
    draw_text(d, S, "Edit & Preview", small, (255, 255, 255, 255), 352)
    return img


def make_128():
    S = 128
    img = gradient_bg(S, 24)
    d = ImageDraw.Draw(img)

    big = fit_font(d, "Markdown", DEJAVU, 112, 26)
    small = ImageFont.truetype(DEJAVU, 10)
    draw_text(d, S, "Markdown", big, (255, 255, 255, 255), 48)
    draw_text(d, S, "Edit & Preview", small, (255, 255, 255, 255), 88)
    return img


img512 = make_512()
img512.save("media/icon.png")
img128 = make_128()
img128.save("media/icon_128.png")
print("saved media/icon.png and media/icon_128.png")
