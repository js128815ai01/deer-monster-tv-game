import base64
import io
import json
import os
import sys
from collections import deque

from PIL import Image, ImageFilter


def clamp(value, low, high):
    return max(low, min(high, value))


def parse_data_url(data_url):
    if "," not in data_url:
        raise ValueError("invalid data url")
    return base64.b64decode(data_url.split(",", 1)[1])


def color_distance(a, b):
    return sum((a[i] - b[i]) ** 2 for i in range(3)) ** 0.5


def center_on_canvas(image):
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox:
        left, top, right, bottom = bbox
        pad = int(max(right - left, bottom - top) * 0.16)
        left = clamp(left - pad, 0, image.width)
        top = clamp(top - pad, 0, image.height)
        right = clamp(right + pad, 0, image.width)
        bottom = clamp(bottom + pad, 0, image.height)
        image = image.crop((left, top, right, bottom))

    canvas = Image.new("RGBA", (640, 640), (0, 0, 0, 0))
    image.thumbnail((560, 560), Image.Resampling.LANCZOS)
    x = (640 - image.width) // 2
    y = (640 - image.height) // 2
    canvas.alpha_composite(image, (x, y))
    return canvas


def encode_png(image):
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode("ascii")


def remove_background_ai(data_url):
    from rembg import new_session, remove

    source = parse_data_url(data_url)
    session = new_session("u2netp")
    result = remove(source, session=session)
    image = Image.open(io.BytesIO(result)).convert("RGBA")
    return encode_png(center_on_canvas(image))


def sample_background(pixels, width, height):
    samples = []
    points = [
        (0.04, 0.04),
        (0.50, 0.03),
        (0.96, 0.04),
        (0.04, 0.96),
        (0.50, 0.97),
        (0.96, 0.96),
    ]
    for px, py in points:
        x = clamp(int(width * px), 0, width - 1)
        y = clamp(int(height * py), 0, height - 1)
        samples.append(pixels[x, y][:3])
    return tuple(int(sum(c[i] for c in samples) / len(samples)) for i in range(3))


def remove_background(data_url):
    image = Image.open(io.BytesIO(parse_data_url(data_url))).convert("RGBA")
    image.thumbnail((900, 900), Image.Resampling.LANCZOS)
    width, height = image.size
    pixels = image.load()
    bg = sample_background(pixels, width, height)
    bg_brightness = sum(bg) / 3
    tolerance = 62 if bg_brightness > 160 else 48

    visited = bytearray(width * height)
    remove = bytearray(width * height)
    queue = deque()

    def add(x, y):
        if x < 0 or y < 0 or x >= width or y >= height:
            return
        idx = y * width + x
        if visited[idx]:
            return
        visited[idx] = 1
        r, g, b, a = pixels[x, y]
        bright = (r + g + b) / 3
        saturation = max(r, g, b) - min(r, g, b)
        similar = color_distance((r, g, b), bg) < tolerance
        paper_like = bright > 150 and saturation < 74
        if a < 12 or similar or paper_like:
            remove[idx] = 1
            queue.append((x, y))

    for x in range(width):
        add(x, 0)
        add(x, height - 1)
    for y in range(height):
        add(0, y)
        add(width - 1, y)

    while queue:
        x, y = queue.popleft()
        add(x + 1, y)
        add(x - 1, y)
        add(x, y + 1)
        add(x, y - 1)

    alpha = Image.new("L", (width, height), 255)
    alpha_pixels = alpha.load()
    for y in range(height):
        for x in range(width):
            if remove[y * width + x]:
                alpha_pixels[x, y] = 0

    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=1.1))
    image.putalpha(alpha)

    return encode_png(center_on_canvas(image))


def main():
    payload = json.loads(sys.stdin.read())
    data_url = payload["image"]
    if payload.get("removeBackground", True):
        try:
            if os.environ.get("USE_REMBG", "1") != "0":
                data_url = remove_background_ai(data_url)
            else:
                data_url = remove_background(data_url)
        except Exception:
            data_url = remove_background(data_url)
    sys.stdout.write(json.dumps({"ok": True, "image": data_url}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)
