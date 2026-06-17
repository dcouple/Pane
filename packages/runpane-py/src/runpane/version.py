from __future__ import annotations

import subprocess
from importlib import metadata
from typing import Optional

from . import __version__
from .installers import resolve_existing_pane_path
from .releases import fetch_release


def wrapper_version() -> str:
    try:
        return metadata.version("runpane")
    except metadata.PackageNotFoundError:
        return __version__


def print_version(pane_path: Optional[str] = None) -> int:
    installed_path = resolve_existing_pane_path(pane_path)
    installed_version = pane_version(installed_path) if installed_path else None
    try:
        latest = fetch_release("latest")["tag_name"].lstrip("v")
    except Exception:
        latest = "unavailable"

    print(f"runpane {wrapper_version()}")
    print(f"Pane installed: {installed_version or 'not found'}")
    print(f"Pane latest: {latest}")
    if installed_path:
        print(f"Pane path: {installed_path}")
    return 0


def pane_version(executable_path: str) -> Optional[str]:
    try:
        result = subprocess.run([executable_path, "--version"], capture_output=True, text=True, timeout=10)
    except OSError:
        return None
    output = (result.stdout + result.stderr).strip()
    return output or None
