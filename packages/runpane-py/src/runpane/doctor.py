from __future__ import annotations

from .installers import resolve_existing_pane_path
from .platforms import detect_platform
from .releases import resolve_release
from .version import pane_version


def run_doctor(parsed, source: str = "pip") -> int:
    ok = True
    try:
        platform = detect_platform()
        print(f"Platform: {platform.os}/{platform.arch}")
        release = resolve_release(
            version=parsed.pane_version,
            channel=parsed.channel,
            source=source,
            platform=platform,
            format_name=parsed.format,
            target="client",
        )
        print(f"Latest release: {release.release['tag_name']}")
        print(f"Selected artifact: {release.artifact['name']}")
        print(f"Website URL: {release.preferred_download_url}")
        print(f"GitHub fallback: {release.fallback_download_url}")
    except Exception as error:
        ok = False
        print(f"Release check: failed - {error}")

    installed = resolve_existing_pane_path(parsed.pane_path)
    if installed:
        print(f"Installed Pane: {installed}")
        print(f"Installed version: {pane_version(installed) or 'unknown'}")
    else:
        print("Installed Pane: not found")

    print('Remote setup: run "runpane install daemon --label <name>" to configure a headless host.')
    return 0 if ok else 1
