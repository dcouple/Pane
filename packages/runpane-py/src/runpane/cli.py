from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from .doctor import run_doctor
from .download import download_artifact
from .installers import (
    install_pane_artifact,
    launch_pane_client,
    resolve_existing_pane_path,
    should_reuse_existing_pane,
    spawn_pane,
)
from .platforms import detect_platform
from .releases import resolve_release
from .version import print_version

SOURCE = "pip"

COMMANDS = {"help", "install", "update", "version", "doctor"}
TARGETS = {"client", "daemon"}
FORMATS = {"auto", "appimage", "deb", "dmg", "zip", "exe"}
CHANNELS = {"stable", "nightly"}

REMOTE_VALUE_FLAGS = {
    "--label",
    "--prefer-tunnel",
    "--channel",
    "--base-url",
    "--pane-dir",
    "--listen-port",
    "--port",
    "--repo-ref",
}

REMOTE_BOOLEAN_FLAGS = {
    "--auto-listen-port",
    "--interactive-tailscale-setup",
    "--no-install-service",
    "--no-tailscale-serve",
    "--print-only",
}


@dataclass
class ParsedArgs:
    command: str
    target: str = "client"
    pane_version: str = "latest"
    channel: str = "stable"
    format: str = "auto"
    download_dir: Optional[str] = None
    pane_path: Optional[str] = None
    dry_run: bool = False
    yes: bool = False
    verbose: bool = False
    help_topic: Optional[str] = None
    remote_setup_args: List[str] = field(default_factory=list)


def main(argv: Optional[List[str]] = None) -> int:
    import sys

    try:
        parsed = parse_args(sys.argv[1:] if argv is None else argv)
        if parsed.command == "help":
            print(help_text(parsed.help_topic))
            return 0
        if parsed.command == "version":
            return print_version(parsed.pane_path)
        if parsed.command == "doctor":
            return run_doctor(parsed, SOURCE)
        if parsed.command in {"install", "update"}:
            return install_or_update(parsed)
        print(help_text(None))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


def parse_args(argv: List[str]) -> ParsedArgs:
    args = list(argv)
    if not args or args[0] in {"-h", "--help"}:
        return ParsedArgs(command="help")
    first = args.pop(0)
    if first in {"-v", "--version"}:
        return ParsedArgs(command="version")
    if first not in COMMANDS:
        raise ValueError(f"Unknown command: {first}\n\n{help_text(None)}")
    if first == "help":
        return ParsedArgs(command="help", help_topic=args[0] if args else None)

    parsed = ParsedArgs(command=first)
    if parsed.command == "install" and args and not args[0].startswith("-"):
        target = args.pop(0)
        if target not in TARGETS:
            raise ValueError(f'Unknown install target: {target}. Expected "client" or "daemon".')
        parsed.target = target

    if parsed.command == "update":
        parsed.target = "client"

    parse_flags(args, parsed)
    return parsed


def parse_flags(args: List[str], parsed: ParsedArgs) -> None:
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in {"-h", "--help"}:
            parsed.help_topic = parsed.command
            parsed.command = "help"
        elif arg == "--dry-run":
            parsed.dry_run = True
        elif arg in {"--yes", "-y"}:
            parsed.yes = True
        elif arg == "--verbose":
            parsed.verbose = True
        elif arg == "--version":
            index += 1
            parsed.pane_version = read_value(args, index, arg)
        elif arg == "--download-dir":
            index += 1
            parsed.download_dir = read_value(args, index, arg)
        elif arg == "--pane-path":
            index += 1
            parsed.pane_path = read_value(args, index, arg)
        elif arg == "--format":
            index += 1
            value = read_value(args, index, arg)
            if value not in FORMATS:
                raise ValueError(f"Invalid --format {value}. Expected one of: {', '.join(sorted(FORMATS))}")
            parsed.format = value
        elif arg in REMOTE_VALUE_FLAGS:
            index += 1
            value = read_value(args, index, arg)
            if arg == "--channel":
                if value not in CHANNELS:
                    raise ValueError(f"Invalid --channel {value}. Expected stable or nightly.")
                parsed.channel = value
            append_remote_arg(parsed, arg, value)
        elif arg in REMOTE_BOOLEAN_FLAGS:
            append_remote_arg(parsed, arg)
        elif parsed.command == "install" and parsed.target == "daemon":
            parsed.remote_setup_args.append(arg)
            if arg.startswith("-") and index + 1 < len(args) and not args[index + 1].startswith("-"):
                index += 1
                parsed.remote_setup_args.append(args[index])
        else:
            raise ValueError(f"Unknown option for {parsed.command}: {arg}")
        index += 1


def append_remote_arg(parsed: ParsedArgs, flag: str, value: Optional[str] = None) -> None:
    if parsed.command == "install" and parsed.target == "daemon":
        parsed.remote_setup_args.append(flag)
        if value is not None:
            parsed.remote_setup_args.append(value)
        return
    raise ValueError(f'{flag} is only valid with "runpane install daemon".')


def read_value(args: List[str], index: int, flag: str) -> str:
    if index >= len(args) or args[index].startswith("-"):
        raise ValueError(f"{flag} requires a value.")
    return args[index]


def install_or_update(parsed: ParsedArgs) -> int:
    target = "client" if parsed.command == "update" else parsed.target
    if not parsed.dry_run and should_reuse_existing_pane(parsed, target):
        existing = resolve_existing_pane_path(parsed.pane_path)
        if existing:
            return spawn_pane(existing, ["--remote-setup", *parsed.remote_setup_args])

    platform = detect_platform()
    resolved = resolve_release(
        version=parsed.pane_version,
        channel=parsed.channel,
        source=SOURCE,
        platform=platform,
        format_name=parsed.format,
        target=target,
    )

    if parsed.dry_run:
        print("runpane dry run")
        print(f"Command: {parsed.command}")
        print(f"Target: {target}")
        print(f"Pane release: {parsed.pane_version}")
        print(f"Channel: {parsed.channel}")
        print(f"Format: {parsed.format}")
        print(f"Artifact: {resolved.artifact['name']}")
        print(f"Preferred download: {resolved.preferred_download_url}")
        print(f"GitHub fallback: {resolved.fallback_download_url}")
        if parsed.pane_path:
            print(f"Existing Pane path: {parsed.pane_path}")
        if target == "daemon":
            forwarded = " ".join(parsed.remote_setup_args)
            print(f"Pane command: <pane executable> --remote-setup {forwarded}".strip())
        return 0

    artifact = download_artifact(resolved, parsed.download_dir, parsed.verbose)
    installed = install_pane_artifact(artifact, parsed, platform, resolved.format, target)

    if target == "daemon":
        return spawn_pane(installed.executable_path, ["--remote-setup", *parsed.remote_setup_args])

    if installed.install_kind == "installed":
        launch_pane_client(installed.executable_path)

    print(f"Pane {installed.install_kind}: {installed.executable_path}")
    return 0


def help_text(topic: Optional[str]) -> str:
    if topic == "install":
        return "\n".join([
            "Usage:",
            "  runpane install [client|daemon] [options]",
            "",
            "Examples:",
            '  npx --yes runpane@latest install daemon --label "My Server"',
            '  pnpm dlx runpane@latest install daemon --prefer-tunnel ssh --label "VM"',
            '  pipx run runpane install daemon --label "My Server"',
            "",
            "Wrapper options:",
            "  --version <latest|vX.Y.Z>",
            "  --format <auto|appimage|deb|dmg|zip|exe>",
            "  --download-dir <path>",
            "  --pane-path <path>",
            "  --dry-run",
            "  --yes",
            "  --verbose",
            "",
            "Daemon passthrough options:",
            "  --label <name>",
            "  --prefer-tunnel <tailscale|ssh|manual|auto>",
            "  --channel <stable|nightly>",
            "  --base-url <url>",
            "  --pane-dir <path>",
            "  --listen-port <port> / --port <port>",
            "  --auto-listen-port",
            "  --interactive-tailscale-setup",
            "  --no-install-service",
            "  --no-tailscale-serve",
            "  --print-only",
            "  --repo-ref <ref>",
        ])

    if topic == "update":
        return "Usage:\n  runpane update [--version <latest|vX.Y.Z>] [--dry-run] [--yes]"
    if topic == "version":
        return "Usage:\n  runpane version\n  runpane --version"
    if topic == "doctor":
        return "Usage:\n  runpane doctor [--pane-path <path>] [--format <format>] [--verbose]"

    return "\n".join([
        "Usage:",
        "  runpane install [client|daemon] [options]",
        "  runpane update [options]",
        "  runpane version",
        "  runpane doctor",
        "  runpane help [command]",
        "",
        "Package manager examples:",
        '  pipx run runpane install daemon --label "My Server"',
        '  uvx runpane@latest install daemon --label "My Server"',
        '  python -m runpane install daemon --label "My Server"',
        "",
        'Run "runpane help install" for install options.',
    ])
