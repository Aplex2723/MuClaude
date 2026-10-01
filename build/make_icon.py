"""Generate the app icon for Claude Multi-Instance Setup in every format the
build scripts need: icon.ico (Windows), icon.icns (macOS), icon.png (Linux).

The canonical source is the static toggle-switch design at
    desktop/src/renderer/app-icon.png
(1024px). This script only converts/copies it — it no longer draws the
old procedural icon, so re-running it won't revert the new design."""

import os
import shutil
import subprocess
import sys

SOURCE_CANDIDATES = (
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "desktop", "src", "renderer", "app-icon.png"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "desktop", "build", "icon.png"),
)


def _find_source() -> str:
    for p in SOURCE_CANDIDATES:
        if os.path.isfile(p):
            return p
    sys.exit("app icon source not found (desktop/src/renderer/app-icon.png)")


def _convert_with_pil(src: str, root: str) -> bool:
    try:
        from PIL import Image
    except ImportError:
        return False
    img = Image.open(src).convert("RGBA")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [img.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[-1].save(os.path.join(root, "icon.ico"), format="ICO",
                    sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    img.resize((1024, 1024), Image.LANCZOS).save(os.path.join(root, "icon.icns"), format="ICNS")
    shutil.copyfile(src, os.path.join(root, "icon.png"))
    return True


def _convert_with_macos_tools(src: str, root: str) -> bool:
    if sys.platform != "darwin":
        return False
    try:
        import tempfile
        with tempfile.TemporaryDirectory(prefix="muclaude-iconset-") as tmp:
            iconset = os.path.join(tmp, "AppIcon.iconset")
            os.makedirs(iconset)
            for base in (16, 32, 128, 256, 512):
                for suffix, size in (("", base), ("@2x", base * 2)):
                    dst = os.path.join(iconset, f"icon_{base}x{base}{suffix}.png")
                    subprocess.run(["/usr/bin/sips", "-z", str(size), str(size), src, "--out", dst],
                                   check=True, capture_output=True)
            subprocess.run(["/usr/bin/iconutil", "-c", "icns", iconset,
                            "-o", os.path.join(root, "icon.icns")],
                           check=True, capture_output=True)
        shutil.copyfile(src, os.path.join(root, "icon.png"))
        print("note: icon.ico not regenerated (needs Pillow); kept existing file")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"macOS icon conversion failed: {exc}")
        return False


def make_all(root: str) -> None:
    src = _find_source()
    if _convert_with_pil(src, root) or _convert_with_macos_tools(src, root):
        print(f"icons saved in {root} from {src}: icon.ico, icon.icns, icon.png")
    else:
        # Last resort: at least refresh the PNG so the new design is used.
        shutil.copyfile(src, os.path.join(root, "icon.png"))
        print(f"copied {src} -> {os.path.join(root, 'icon.png')} (install Pillow to regenerate .ico/.icns)")


if __name__ == "__main__":
    make_all(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
