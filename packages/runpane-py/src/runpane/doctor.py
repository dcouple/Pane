from __future__ import annotations

import json
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional

from .daemon_client import get_pane_daemon_endpoint, invoke_daemon, resolve_pane_directory
from .installers import resolve_existing_pane_path
from .platforms import PanePlatform, detect_platform
from .releases import resolve_release
from .version import pane_version, wrapper_version

DOCTOR_DAEMON_TIMEOUT_MS = 5_000
DOCTOR_RELEASE_TIMEOUT_SECONDS = 5


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
    with ThreadPoolExecutor(max_workers=2) as executor:
        release_future = (
            executor.submit(collect_release_check, parsed, source, platform_result["platform"])
            if platform_result["ok"]
            else None
        )
        daemon_future = executor.submit(collect_daemon_health, parsed.pane_dir, endpoint)
        release = (
            release_future.result()
            if release_future
            else {"ok": False, "error": platform_result["error"]}
        )
        daemon = daemon_future.result()
    installed_pane = collect_installed_pane(parsed.pane_path)
    remote_setup = collect_remote_setup_check(
        platform_result.get("platform") if platform_result["ok"] else None,
        release.get("format"),
    )

    return {
        "ok": bool(release["ok"] and daemon["reachable"] and remote_setup["ready"]),
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
        "remoteSetup": remote_setup,
        "nextCommands": [
            "runpane agent-context --json",
            "runpane agent-context --command \"<command>\" --json",
            "runpane repos list --json",
        ],
    }


def collect_remote_setup_check(
    platform: Optional[PanePlatform],
    release_format: Optional[str],
    probe_overrides: Optional[Dict[str, bool]] = None,
) -> Dict[str, Any]:
    if not platform or platform.os != "linux":
        return {
            "ready": True,
            "displayAvailable": True,
            "headlessEnvironmentApplied": False,
            "diagnostics": [],
        }

    probes = {
        "displayAvailable": bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")),
        "hasFuseRuntime": has_linux_fuse_runtime(),
        "isRoot": hasattr(os, "getuid") and os.getuid() == 0,
        "unprivilegedUserNamespaceDisabled": unprivileged_user_namespace_disabled(),
        "hasSystemctl": shutil.which("systemctl") is not None,
    }
    probes.update(probe_overrides or {})

    diagnostics = []
    if release_format == "appimage" and not probes["hasFuseRuntime"]:
        diagnostics.append({
            "code": "PANE_APPIMAGE_FUSE_MISSING",
            "severity": "error",
            "message": "The selected AppImage may not start because Pane could not find /dev/fuse and a FUSE mount helper.",
            "recoveryCommand": "Install FUSE for this Linux distribution, or rerun with --format deb on a Debian-based host.",
        })

    if probes["isRoot"]:
        diagnostics.append({
            "code": "PANE_ELECTRON_SANDBOX_ROOT",
            "severity": "error",
            "message": "The Pane Electron runtime should not be launched as root with its sandbox enabled.",
            "recoveryCommand": "Run runpane install daemon as a non-root user.",
        })
    elif probes["unprivilegedUserNamespaceDisabled"]:
        diagnostics.append({
            "code": "PANE_ELECTRON_SANDBOX_UNAVAILABLE",
            "severity": "error",
            "message": "Unprivileged user namespaces are disabled, so the Electron sandbox may not start.",
            "recoveryCommand": "Enable unprivileged user namespaces for this host, or explicitly use --no-sandbox only if you accept the security tradeoff.",
        })

    if not probes["hasSystemctl"]:
        diagnostics.append({
            "code": "PANE_USER_SERVICE_UNAVAILABLE",
            "severity": "warning",
            "message": "systemctl is unavailable; setup will print a manual daemon command instead of installing a user service.",
        })

    return {
        "ready": all(item["severity"] != "error" for item in diagnostics),
        "displayAvailable": probes["displayAvailable"],
        "headlessEnvironmentApplied": True,
        "diagnostics": diagnostics,
    }


def has_linux_fuse_runtime() -> bool:
    return os.path.exists("/dev/fuse") and bool(shutil.which("fusermount") or shutil.which("fusermount3"))


def unprivileged_user_namespace_disabled() -> bool:
    try:
        with open("/proc/sys/kernel/unprivileged_userns_clone", "r", encoding="utf-8") as handle:
            return handle.read().strip() == "0"
    except OSError:
        return False


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
            fetch_timeout_seconds=DOCTOR_RELEASE_TIMEOUT_SECONDS,
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

    remote_setup = report["remoteSetup"]
    print(f"Remote setup preflight: {'ready' if remote_setup['ready'] else 'action required'}")
    if (report.get("platform") or {}).get("os") == "linux":
        display_status = "yes" if remote_setup["displayAvailable"] else "no (headless mode will be applied)"
        print(f"  Display available: {display_status}")
    for diagnostic in remote_setup["diagnostics"]:
        print(f"  {diagnostic['code']}: {diagnostic['message']}")
        if diagnostic.get("recoveryCommand"):
            print(f"  Recovery: {diagnostic['recoveryCommand']}")

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
