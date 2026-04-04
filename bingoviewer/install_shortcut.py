"""
BiNgo Genome Viewer -- desktop shortcut installer.

Opens a small Tkinter dialog letting the user choose where to place
a shortcut, then creates a platform-appropriate launcher:

  * Windows  -- .lnk  via PowerShell
  * macOS    -- .app  bundle
  * Linux    -- .desktop  file (freedesktop)
"""

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

from bingoviewer.icon import generate_ico, generate_png

_APP_NAME = "BiNgo Genome Viewer"


# ── helpers ─────────────────────────────────────────────────────────────
def _find_bingo_exe():
    """Return the absolute path to the ``bingo`` entry-point script."""
    found = shutil.which("bingo")
    if found:
        return os.path.realpath(found)

    # Fall back: look next to the running Python interpreter
    if sys.platform == "win32":
        candidate = Path(sys.executable).parent / "Scripts" / "bingo.exe"
    else:
        candidate = Path(sys.executable).parent / "bingo"
    if candidate.exists():
        return str(candidate)

    return None


def _default_desktop():
    """Return the user's desktop directory (best-effort)."""
    if sys.platform == "win32":
        # Prefer the shell-folder value; fall back to USERPROFILE
        desktop = os.path.join(os.environ.get("USERPROFILE", "~"), "Desktop")
    elif sys.platform == "darwin":
        desktop = os.path.expanduser("~/Desktop")
    else:
        # XDG
        try:
            result = subprocess.run(
                ["xdg-user-dir", "DESKTOP"],
                capture_output=True, text=True, timeout=5,
            )
            desktop = result.stdout.strip() or os.path.expanduser("~/Desktop")
        except Exception:
            desktop = os.path.expanduser("~/Desktop")
    return desktop


# ── per-platform installers ─────────────────────────────────────────────
def _install_windows(target_dir):
    bingo = _find_bingo_exe()
    if not bingo:
        raise RuntimeError("Cannot locate the 'bingo' executable.")

    target_dir = Path(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    # Write icon
    ico_path = target_dir / "bingo_icon.ico"
    ico_path.write_bytes(generate_ico())

    lnk_path = target_dir / f"{_APP_NAME}.lnk"

    # PowerShell one-liner to create a .lnk
    ps_script = (
        "$ws = New-Object -ComObject WScript.Shell; "
        f"$s = $ws.CreateShortcut('{lnk_path}'); "
        f"$s.TargetPath = '{bingo}'; "
        f"$s.IconLocation = '{ico_path},0'; "
        f"$s.Description = '{_APP_NAME}'; "
        "$s.Save()"
    )

    subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps_script],
        check=True,
        capture_output=True,
        timeout=30,
    )
    return str(lnk_path)


def _install_macos(target_dir):
    bingo = _find_bingo_exe()
    if not bingo:
        raise RuntimeError("Cannot locate the 'bingo' executable.")

    target_dir = Path(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    app_dir = target_dir / f"{_APP_NAME}.app"
    contents = app_dir / "Contents"
    macos    = contents / "MacOS"
    resources = contents / "Resources"

    for d in (macos, resources):
        d.mkdir(parents=True, exist_ok=True)

    # launcher script
    launcher = macos / "launcher"
    launcher.write_text(textwrap.dedent(f"""\
        #!/usr/bin/env bash
        exec "{bingo}" "$@"
    """))
    launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    # Try to create an .icns from the PNG via sips
    icon_set = False
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp.write(generate_png(256))
            tmp_png = tmp.name
        icns_path = resources / "icon.icns"
        subprocess.run(
            ["sips", "-s", "format", "icns", tmp_png, "--out", str(icns_path)],
            check=True, capture_output=True, timeout=30,
        )
        icon_set = True
    except Exception:
        pass
    finally:
        try:
            os.unlink(tmp_png)
        except Exception:
            pass

    # Info.plist
    plist = contents / "Info.plist"
    icon_entry = "<key>CFBundleIconFile</key>\n    <string>icon</string>" if icon_set else ""
    plist.write_text(textwrap.dedent(f"""\
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
          "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>CFBundleName</key>
            <string>{_APP_NAME}</string>
            <key>CFBundleExecutable</key>
            <string>launcher</string>
            <key>CFBundleIdentifier</key>
            <string>com.bingoviewer.app</string>
            <key>CFBundleVersion</key>
            <string>1.0</string>
            <key>CFBundlePackageType</key>
            <string>APPL</string>
            {icon_entry}
        </dict>
        </plist>
    """))

    return str(app_dir)


def _install_linux(target_dir):
    bingo = _find_bingo_exe()
    if not bingo:
        raise RuntimeError("Cannot locate the 'bingo' executable.")

    target_dir = Path(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    # Write PNG icon
    icon_path = target_dir / "bingo-genome-viewer.png"
    icon_path.write_bytes(generate_png(48))

    desktop_path = target_dir / "bingo-genome-viewer.desktop"
    desktop_path.write_text(textwrap.dedent(f"""\
        [Desktop Entry]
        Type=Application
        Name={_APP_NAME}
        Comment=Lightweight browser-based genomics viewer
        Exec={bingo}
        Icon={icon_path}
        Terminal=false
        Categories=Science;Biology;
    """))
    # Make the .desktop file executable (required by some DEs)
    desktop_path.chmod(
        desktop_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
    )

    return str(desktop_path)


# ── Tkinter GUI ─────────────────────────────────────────────────────────
def main():
    """Open a dialog, create the shortcut, and report success / failure."""
    import tkinter as tk
    from tkinter import filedialog, messagebox

    root = tk.Tk()
    root.withdraw()  # hide root window

    default_dir = _default_desktop()

    chosen = filedialog.askdirectory(
        title="Choose shortcut location",
        initialdir=default_dir,
    )
    if not chosen:
        # User cancelled
        root.destroy()
        return

    try:
        plat = sys.platform
        if plat == "win32":
            result = _install_windows(chosen)
        elif plat == "darwin":
            result = _install_macos(chosen)
        else:
            result = _install_linux(chosen)

        messagebox.showinfo(
            "Shortcut Created",
            f"Shortcut installed successfully:\n{result}",
        )
    except Exception as exc:
        messagebox.showerror(
            "Error",
            f"Failed to create shortcut:\n{exc}",
        )
    finally:
        root.destroy()
