from __future__ import annotations

import json
from typing import Any, Dict, Optional

from .daemon_client import get_pane_daemon_endpoint, invoke_daemon, resolve_pane_directory
from .installers import resolve_existing_pane_path
from .platforms import PanePlatform, detect_platform
from .releases import resolve_release
from .version import pane_version, wrapper_version

DOCTOR_DAEMON_TIMEOUT_MS = 5_000


def run_doctor(parsed, source: str = "pip") -> int:
    report = build_doctor_report(parsed, source)

    if parsed.json:
        print(json.dumps(without_none(report), indent=2))
        return 0

    render_doctor_text(report)
    return 0 if report["release"]["ok"] else 1


def build_doctor_report(parsed, source: str) -> Dict[str, Any]:
    pane_dir = resolve_pane_directory(parsed.pane_dir)
    endpoint = get_pane_daemon_endpoint(pane_dir)
    platform_result = collect_platform()
    release = (
        collect_release_check(parsed, source, platform_result["platform"])
        if platform_result["ok"]
        else {"ok": False, "error": platform_result["error"]}
    )
    installed_pane = collect_installed_pane(parsed.pane_path)
    daemon = collect_daemon_health(parsed.pane_dir, endpoint)

    return {
        "ok": bool(release["ok"] and daemon["reachable"]),
        "source": source,
        "wrapper": {
            "runtime": "python",
            "version": wrapper_version(),
            "paneDir": pane_dir,
            "endpoint": endpoint,
        },
        "platform": platform_to_json(platform_result["platform"]) if platform_result["ok"] else None,
        "release": release,
        "installedPane": installed_pane,
        "daemon": daemon,
        "nextCommands": [
            "runpane agent-context --json",
            "runpane agent-context --command \"<command>\" --json",
            "runpane repos list --json",
        ],
    }


def collect_platform() -> Dict[str, Any]:
    try:
        return {"ok": True, "platform": detect_platform()}
    except Exception as error:
        return {"ok": False, "error": str(error)}


def collect_release_check(parsed, source: str, platform: PanePlatform) -> Dict[str, Any]:
    try:
        release = resolve_release(
            version=parsed.pane_version,
            channel=parsed.channel,
            source=source,
            platform=platform,
            format_name=parsed.format,
            target="client",
        )
        return {
            "ok": True,
            "tagName": release.release["tag_name"],
            "artifactName": release.artifact["name"],
            "format": release.format,
            "preferredDownloadUrl": release.preferred_download_url,
            "fallbackDownloadUrl": release.fallback_download_url,
        }
    except Exception as error:
        return {
            "ok": False,
            "error": str(error),
        }


def collect_installed_pane(pane_path: Optional[str]) -> Dict[str, Any]:
    installed = resolve_existing_pane_path(pane_path)
    if not installed:
        return {"found": False}

    return {
        "found": True,
        "path": installed,
        "version": pane_version(installed),
    }


def collect_daemon_health(pane_dir: Optional[str], endpoint: Dict[str, str]) -> Dict[str, Any]:
    try:
        return {
            "reachable": True,
            "endpoint": endpoint,
            "result": invoke_daemon("runpane:doctor", [], pane_dir=pane_dir, timeout_ms=DOCTOR_DAEMON_TIMEOUT_MS),
        }
    except Exception as error:
        return {
            "reachable": False,
            "endpoint": endpoint,
            "error": str(error),
            "nextCommand": "Open Pane, then rerun runpane doctor --json",
        }


def render_doctor_text(report: Dict[str, Any]) -> None:
    platform = report.get("platform")
    if platform:
        print(f"Platform: {platform['os']}/{platform['arch']}")

    release = report["release"]
    if release["ok"]:
        print(f"Latest release: {release['tagName']}")
        print(f"Selected artifact: {release['artifactName']}")
        print(f"Website URL: {release['preferredDownloadUrl']}")
        print(f"GitHub fallback: {release['fallbackDownloadUrl']}")
    else:
        print(f"Release check: failed - {release.get('error') or 'unknown error'}")

    installed = report["installedPane"]
    if installed["found"]:
        print(f"Installed Pane: {installed['path']}")
        print(f"Installed version: {installed.get('version') or 'unknown'}")
    else:
        print("Installed Pane: not found")

    daemon = report["daemon"]
    endpoint = daemon["endpoint"]
    print(f"Pane directory: {report['wrapper']['paneDir']}")
    print(f"Daemon endpoint: {endpoint['transport']} {endpoint['path']}")
    if daemon["reachable"]:
        repo_count = ((daemon.get("result") or {}).get("repos") or {}).get("count", 0)
        print(f"Pane daemon: reachable ({repo_count} repos)")
    else:
        print(f"Pane daemon: unreachable - {daemon.get('error') or 'unknown error'}")

    print('Agent discovery: run "runpane doctor --json" before Pane actions, then "runpane agent-context --json" for full CLI context.')
    print('Remote setup: run "runpane setup" for guided setup, or "runpane install daemon --label <name>" for scripting.')


def platform_to_json(platform: PanePlatform) -> Dict[str, str]:
    return {
        "os": platform.os,
        "arch": platform.arch,
    }


def without_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: without_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [without_none(item) for item in value]
    return value
