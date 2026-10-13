"""Generate the app icon for Claude Multi-Instance Setup in every format the
build scripts need: icon.ico (Windows), icon.icns (macOS), icon.png (Linux)."""

import os

from PIL import Image

SOURCE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "assets", "app-icon.png")


def draw(sz: int) -> Image.Image:
    """Resize the supplied app artwork without redrawing it."""
    with Image.open(SOURCE) as img:
        return img.convert("RGBA").resize((sz, sz), Image.Resampling.LANCZOS)


def make_all(root: str) -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [draw(s) for s in sizes]
    frames[-1].save(os.path.join(root, "icon.ico"), format="ICO",
                    sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    draw(1024).save(os.path.join(root, "icon.icns"), format="ICNS")
    draw(512).save(os.path.join(root, "icon.png"), format="PNG")
    print(f"icons saved in {root}: icon.ico, icon.icns, icon.png")


if __name__ == "__main__":
    make_all(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
