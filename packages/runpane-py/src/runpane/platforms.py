from __future__ import annotations

import os
import platform
from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class PanePlatform:
    os: str
    arch: str


def detect_platform() -> PanePlatform:
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "darwin":
        os_name = "darwin"
    elif system == "linux":
        os_name = "linux"
    elif system == "windows":
        os_name = "win32"
    else:
        raise RuntimeError(f"Unsupported OS: {system}")

    if machine in {"x86_64", "amd64"}:
        arch = "x64"
    elif machine in {"arm64", "aarch64"}:
        arch = "arm64"
    else:
        raise RuntimeError(f"Unsupported CPU architecture: {machine}")

    return PanePlatform(os=os_name, arch=arch)


def default_format(platform_info: PanePlatform, target: str) -> str:
    if platform_info.os == "darwin":
        return "zip" if target == "daemon" else "dmg"
    if platform_info.os == "win32":
        return "exe"
    return "appimage"


def platform_param(platform_info: PanePlatform) -> str:
    if platform_info.os == "darwin":
        return "mac"
    if platform_info.os == "win32":
        return "windows"
    return "linux"


def arch_aliases(platform_info: PanePlatform) -> List[str]:
    if platform_info.arch == "arm64":
        return ["arm64", "aarch64"]
    if platform_info.os == "linux":
        return ["x64", "x86_64", "amd64"]
    return ["x64", "x86_64"]


def default_install_root() -> str:
    if os.name == "nt":
        return os.environ.get("LOCALAPPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Local", "Pane"))
    if platform.system().lower() == "darwin":
        return os.path.join(os.path.expanduser("~"), "Applications")
    return os.path.join(os.path.expanduser("~"), ".local", "bin")
