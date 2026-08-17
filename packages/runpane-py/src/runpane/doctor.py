from __future__ import annotations

import json
import os
import platform as system_platform
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional

from .daemon_client import get_pane_daemon_endpoint, invoke_daemon, resolve_pane_directory
from .installers import resolve_existing_pane_path
from .platforms import PanePlatform, detect_platform
from .releases import resolve_release
from .version import pane_version, wrapper_version

DOCTOR_DAEMON_TIMEOUT_MS = 5_000
DOCTOR_RELEASE_TIMEOUT_SECONDS = 5
REMOTE_LAUNCHER_MARKER = "pane-remote-daemon-launcher-v2"
REMOTE_DAEMON_UNIT = "pane-remote-daemon.service"


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
    remote_daemon_service = collect_remote_daemon_service_check(parsed, pane_dir, daemon)
    add_remote_daemon_health_diagnostic(remote_setup, remote_daemon_service)

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
        "remoteDaemonService": remote_daemon_service,
        "remoteSetup": remote_setup,
        "nextCommands": [
            "runpane agent-context --json",
            "runpane agent-context --command \"<command>\" --json",
            "runpane repos list --json",
        ],
    }


def collect_remote_daemon_service_check(parsed, desktop_pane_dir: str, desktop_daemon: Dict[str, Any]) -> Dict[str, Any]:
    default_remote_dir = os.path.join(os.path.expanduser("~"), ".pane_remote")
    requested_dir = resolve_pane_directory(parsed.pane_dir) if parsed.pane_dir else None
    pane_dir = requested_dir or (default_remote_dir if has_managed_remote_launcher(default_remote_dir) else desktop_pane_dir)
    endpoint = get_pane_daemon_endpoint(pane_dir)
    managed = has_managed_remote_launcher(pane_dir)
    daemon = desktop_daemon if pane_dir == desktop_pane_dir else collect_daemon_health(pane_dir, endpoint)
    self_reported = ((daemon.get("result") or {}).get("daemon") or {}).get("executableHealth")
    result = {
        "paneDir": pane_dir,
        "managed": managed,
        "reachable": daemon["reachable"],
        "endpoint": endpoint,
    }
    if self_reported:
        result["executableHealth"] = self_reported
    elif managed:
        result["executableHealth"] = inspect_legacy_remote_daemon_health(pane_dir, daemon["reachable"])
    return result


def has_managed_remote_launcher(pane_dir: str) -> bool:
    launcher_name = "start.cmd" if os.name == "nt" else "start.sh"
    return os.path.exists(os.path.join(pane_dir, "remote-daemon", launcher_name))


def inspect_legacy_remote_daemon_health(
    pane_dir: str,
    reachable: bool,
    *,
    platform_name: Optional[str] = None,
    launcher_path: Optional[str] = None,
    installed_candidates=None,
    runtime_path_marker=...,
    checked_at: Optional[str] = None,
) -> Dict[str, Any]:
    from datetime import datetime, timezone

    platform_name = platform_name or normalized_platform_name()
    launcher_path = launcher_path or os.path.join(
        pane_dir, "remote-daemon", "start.cmd" if platform_name == "win32" else "start.sh"
    )
    candidates = installed_candidates if installed_candidates is not None else remote_executable_candidates(platform_name)
    installed_path = next((candidate for candidate in candidates if executable_file(candidate)), None)
    checked_at = checked_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        with open(launcher_path, "r", encoding="utf-8") as handle:
            launcher_contents = handle.read()
    except OSError as error:
        evidence = f"The managed launcher could not be read: {error}"
        return {
            "processImage": {"status": "unknown", "runtimePath": None, "installedPath": installed_path, "evidence": evidence},
            "restart": {"status": "unknown", "launcherPath": launcher_path, "evidence": evidence},
            "checkedAt": checked_at,
        }

    saved_path = extract_legacy_executable_path(launcher_contents)
    source_launcher = f"{REMOTE_LAUNCHER_MARKER} source" in launcher_contents
    if REMOTE_LAUNCHER_MARKER in launcher_contents and not source_launcher:
        resolved_path = installed_path
    else:
        resolved_path = saved_path if saved_path and executable_file(saved_path) else None
    if source_launcher:
        restart = {
            "status": "unknown",
            "launcherPath": launcher_path,
            "evidence": "The source-development launcher is not tied to an installed Pane executable.",
        }
    elif resolved_path:
        restart = {
            "status": "ready",
            "launcherPath": launcher_path,
            "resolvedPath": resolved_path,
            "evidence": f"The managed launcher resolves {resolved_path}.",
        }
    elif saved_path:
        restart = {
            "status": "broken",
            "launcherPath": launcher_path,
            "evidence": f"The saved launcher target is missing: {saved_path}.",
        }
    elif REMOTE_LAUNCHER_MARKER in launcher_contents:
        restart = {
            "status": "broken",
            "launcherPath": launcher_path,
            "evidence": "The runtime resolver cannot find an installed Pane executable.",
        }
    else:
        restart = {"status": "unknown", "launcherPath": launcher_path, "evidence": "The launcher format is not recognized."}

    runtime_link = find_systemd_daemon_runtime_path(platform_name) if runtime_path_marker is ... else runtime_path_marker
    process_image = classify_legacy_process_image(runtime_link, installed_path, reachable)
    recovery = f"runpane daemon repair --pane-dir {format_pane_dir(pane_dir)}"
    result = {"processImage": process_image, "restart": restart, "checkedAt": checked_at}
    if reachable and process_image["status"] == "deleted" and restart["status"] == "broken" and saved_path is not None:
        result.update({"diagnosticCode": "PANE_REMOTE_DAEMON_EXECUTABLE_DELETED", "recoveryCommand": recovery})
    elif process_image["status"] in ("deleted", "replaced"):
        result["diagnosticCode"] = "PANE_REMOTE_DAEMON_UPDATE_PENDING"
        if restart["status"] == "broken":
            result["recoveryCommand"] = recovery
    elif restart["status"] == "broken":
        result.update({"diagnosticCode": "PANE_REMOTE_DAEMON_LAUNCHER_STALE", "recoveryCommand": recovery})
    return result


def classify_legacy_process_image(runtime_link, installed_path, reachable: bool) -> Dict[str, Any]:
    if not reachable or not runtime_link:
        return {
            "status": "unknown",
            "runtimePath": runtime_link,
            "installedPath": installed_path,
            "evidence": "The service process executable could not be inspected." if reachable else "The managed daemon is not reachable.",
        }
    if runtime_link.endswith(" (deleted)"):
        return {
            "status": "deleted",
            "runtimePath": runtime_link[:-len(" (deleted)")],
            "installedPath": installed_path,
            "evidence": "The running service executable points to a deleted inode in /proc.",
        }
    current = bool(installed_path and same_executable(runtime_link, installed_path))
    return {
        "status": "current" if current else "replaced" if installed_path else "unknown",
        "runtimePath": runtime_link,
        "installedPath": installed_path,
        "evidence": (
            "The running and installed executables have the same device and inode."
            if current else "The installed executable differs from the running service process."
            if installed_path else "No installed Pane executable was found for comparison."
        ),
    }


def find_systemd_daemon_runtime_path(platform_name: str):
    if platform_name != "linux" or not shutil.which("systemctl"):
        return None
    try:
        group = subprocess.run(
            ["systemctl", "--user", "show", REMOTE_DAEMON_UNIT, "--property=ControlGroup", "--value"],
            check=False, capture_output=True, text=True, timeout=2,
        ).stdout.strip()
        if not group:
            return None
        with open(os.path.join("/sys/fs/cgroup", group.lstrip("/"), "cgroup.procs"), "r", encoding="utf-8") as handle:
            pids = handle.read().split()
        for pid in pids:
            try:
                with open(os.path.join("/proc", pid, "cmdline"), "rb") as handle:
                    if b"--daemon-headless" not in handle.read():
                        continue
                return os.readlink(os.path.join("/proc", pid, "exe"))
            except OSError:
                # Processes can leave the cgroup while doctor is walking it.
                continue
    except OSError:
        return None
    except subprocess.SubprocessError:
        return None
    return None


def add_remote_daemon_health_diagnostic(setup: Dict[str, Any], service: Dict[str, Any]) -> None:
    health = service.get("executableHealth") or {}
    code = health.get("diagnosticCode")
    if not code:
        return
    process_image = health["processImage"]
    restart = health["restart"]
    fatal = (
        service["reachable"]
        and code == "PANE_REMOTE_DAEMON_EXECUTABLE_DELETED"
        and process_image["status"] == "deleted"
        and restart["status"] == "broken"
    )
    runtime_path = process_image.get("runtimePath") or "the previous Pane executable"
    installed_path = process_image.get("installedPath") or "the current Pane executable"
    if fatal:
        message = (
            f"Remote daemon is reachable but unsafe to restart. It is running {runtime_path} from a deleted inode; "
            f"Pane is now installed at {installed_path}, and the saved launcher still references the old path. "
            f"The daemon will not return after reboot or service restart. Run {health.get('recoveryCommand')} before restarting, then rerun doctor."
        )
    elif code == "PANE_REMOTE_DAEMON_UPDATE_PENDING":
        message = "The remote daemon is still running an older or deleted process image, but its launcher can resolve the installed Pane executable on restart."
    else:
        message = restart["evidence"]
    diagnostic = {"code": code, "severity": "error" if fatal else "warning", "message": message}
    if health.get("recoveryCommand"):
        diagnostic["recoveryCommand"] = health["recoveryCommand"]
    setup["diagnostics"].append(diagnostic)
    setup["ready"] = all(item["severity"] != "error" for item in setup["diagnostics"])


def normalized_platform_name() -> str:
    if os.name == "nt":
        return "win32"
    return "darwin" if system_platform.system().lower() == "darwin" else "linux"


def remote_executable_candidates(platform_name: str):
    home = os.path.expanduser("~")
    if platform_name == "darwin":
        return ["/Applications/Pane.app/Contents/MacOS/Pane", os.path.join(home, "Applications", "Pane.app", "Contents", "MacOS", "Pane")]
    if platform_name == "win32":
        local = os.environ.get("LOCALAPPDATA")
        program_files = os.environ.get("ProgramFiles")
        return [candidate for candidate in [
            os.path.join(local, "Programs", "Pane", "Pane.exe") if local else None,
            os.path.join(local, "Pane", "Pane.exe") if local else None,
            os.path.join(program_files, "Pane", "Pane.exe") if program_files else None,
        ] if candidate]
    return [os.path.join(home, ".local", "bin", "pane"), "/usr/bin/pane", "/opt/Pane/pane", "/opt/Pane/Pane"]


def extract_legacy_executable_path(contents: str):
    import re
    match = re.search(r"(?:'|\")?(/opt/Pane/(?:Pane|pane)|[^\s'\"]+[\\/](?:Pane\.exe|Pane|pane))(?:'|\")?", contents)
    return match.group(1) if match else None


def executable_file(file_path: str) -> bool:
    return os.path.isfile(file_path) and os.access(file_path, os.X_OK)


def same_executable(left: str, right: str) -> bool:
    try:
        left_stat = os.stat(left)
        right_stat = os.stat(right)
        return left_stat.st_dev == right_stat.st_dev and left_stat.st_ino == right_stat.st_ino
    except OSError:
        return False


def format_pane_dir(pane_dir: str) -> str:
    home = os.path.expanduser("~")
    try:
        relative = os.path.relpath(pane_dir, home)
    except ValueError:
        relative = pane_dir
    if relative != ".." and not relative.startswith(f"..{os.sep}") and not os.path.isabs(relative):
        return f"~/{relative}"
    return "'" + pane_dir.replace("'", "'\\''") + "'"


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
