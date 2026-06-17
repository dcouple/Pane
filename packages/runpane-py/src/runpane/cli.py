from __future__ import annotations

from dataclasses import dataclass, field
import os
import socket
import sys
from typing import Dict, List, Optional, Tuple, TypeVar

from .doctor import run_doctor
from .download import download_artifact
from .generated_contract import RUNPANE_CONTRACT
from .installers import (
    install_pane_artifact,
    launch_pane_client,
    resolve_existing_pane_path,
    should_reuse_existing_pane,
    spawn_pane,
)
from .local_control import run_panes_create, run_repos_add, run_repos_list
from .platforms import detect_platform
from .releases import resolve_release
from .version import print_version

SOURCE = "pip"

COMMAND_MATCHERS = sorted(
    ((command["name"], command["name"].split(" ")) for command in RUNPANE_CONTRACT["commands"]),
    key=lambda item: len(item[1]),
    reverse=True,
)
TARGETS = set(RUNPANE_CONTRACT["enums"]["installTargets"])
FORMATS = set(RUNPANE_CONTRACT["enums"]["artifactFormats"])
CHANNELS = set(RUNPANE_CONTRACT["enums"]["channels"])
AGENTS = set(RUNPANE_CONTRACT["enums"]["agents"])

REMOTE_VALUE_FLAGS = {flag["name"] for flag in RUNPANE_CONTRACT["flags"]["remoteValue"]}
REMOTE_BOOLEAN_FLAGS = {flag["name"] for flag in RUNPANE_CONTRACT["flags"]["remoteBoolean"]}
LOCAL_VALUE_FLAGS = {
    value
    for flag in RUNPANE_CONTRACT["flags"]["localValue"]
    for value in [flag["name"], *flag.get("aliases", [])]
}
LOCAL_BOOLEAN_FLAGS = {
    value
    for flag in RUNPANE_CONTRACT["flags"]["localBoolean"]
    for value in [flag["name"], *flag.get("aliases", [])]
}
DEFAULTS = RUNPANE_CONTRACT["defaults"]


@dataclass
class ParsedArgs:
    command: str
    target: str = DEFAULTS["target"]
    pane_version: str = DEFAULTS["paneVersion"]
    channel: str = DEFAULTS["channel"]
    format: str = DEFAULTS["format"]
    download_dir: Optional[str] = None
    pane_path: Optional[str] = None
    dry_run: bool = DEFAULTS["dryRun"]
    yes: bool = DEFAULTS["yes"]
    verbose: bool = DEFAULTS["verbose"]
    json: bool = False
    pane_dir: Optional[str] = None
    repo: Optional[str] = None
    repo_path: Optional[str] = None
    name: Optional[str] = None
    worktree_name: Optional[str] = None
    base_branch: Optional[str] = None
    agent: Optional[str] = None
    tool_command: Optional[str] = None
    title: Optional[str] = None
    initial_input: Optional[str] = None
    initial_input_file: Optional[str] = None
    from_json: Optional[str] = None
    timeout_ms: Optional[float] = None
    help_topic: Optional[str] = None
    remote_setup_args: List[str] = field(default_factory=list)


def main(argv: Optional[List[str]] = None) -> int:
    try:
        effective_argv = sys.argv[1:] if argv is None else argv
        if not effective_argv:
            return run_no_args_entrypoint()

        parsed = parse_args(effective_argv)
        if parsed.command == "help":
            print(help_text(parsed.help_topic))
            return 0
        if parsed.command == "setup":
            return run_no_args_entrypoint()
        if parsed.command == "version":
            return print_version(parsed.pane_path)
        if parsed.command == "doctor":
            return run_doctor(parsed, SOURCE)
        if parsed.command == "repos list":
            return run_repos_list(parsed)
        if parsed.command == "repos add":
            return run_repos_add(parsed)
        if parsed.command == "panes create":
            return run_panes_create(parsed)
        if parsed.command in {"install", "update"}:
            return install_or_update(parsed)
        print(help_text(None))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


def run_no_args_entrypoint() -> int:
    if not is_interactive_shell():
        print(help_text(None))
        return 0

    return run_interactive_wizard()


def is_interactive_shell() -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty() and not os.environ.get("CI"))


def run_interactive_wizard() -> int:
    print("Pane setup")
    print("Choose what this machine should do. You can rerun setup any time.")
    print()
    print("1) Install Pane desktop app on this machine")
    print("2) Set up this machine as a remote host")
    print("3) Update Pane desktop app")
    print("4) Run diagnostics")
    print()

    action = ask_choice("Choose an action [1]: ", {
        "": "client",
        "1": "client",
        "client": "client",
        "install": "client",
        "desktop": "client",
        "2": "daemon",
        "daemon": "daemon",
        "remote": "daemon",
        "host": "daemon",
        "3": "update",
        "update": "update",
        "4": "doctor",
        "doctor": "doctor",
        "diagnostics": "doctor",
    })

    if action == "client":
        print()
        print("Installing Pane desktop app on this machine...")
        return install_or_update(create_parsed_args("install", target="client"))
    if action == "update":
        print()
        print("Updating Pane desktop app on this machine...")
        return install_or_update(create_parsed_args("update", target="client"))
    if action == "doctor":
        print()
        print("Running runpane diagnostics...")
        return run_doctor(create_parsed_args("doctor"), SOURCE)

    print()
    print("A remote host runs your repos, terminals, agents, and git state.")
    print("Your desktop Pane or browser client connects with the generated pane-remote:// code.")

    default_label = socket.gethostname() or "Remote Host"
    label = input(f"Remote host label [{default_label}]: ").strip() or default_label

    print()
    print("Connection method:")
    print("1) auto")
    print("2) tailscale")
    print("3) ssh")
    print("4) manual")
    print()
    print("Use auto unless you already know you want Tailscale, SSH, or a manual URL.")
    print()

    tunnel = ask_choice("Choose a connection method [1]: ", {
        "": "auto",
        "1": "auto",
        "auto": "auto",
        "2": "tailscale",
        "tailscale": "tailscale",
        "3": "ssh",
        "ssh": "ssh",
        "4": "manual",
        "manual": "manual",
    })

    remote_setup_args = ["--label", label]
    if tunnel != "auto":
        remote_setup_args.extend(["--prefer-tunnel", tunnel])

    print()
    print("Setting up this machine as a Pane remote host...")
    print("When setup finishes, paste the printed pane-remote:// code into Pane or runpane.com/app.")

    return install_or_update(create_parsed_args(
        "install",
        target="daemon",
        remote_setup_args=remote_setup_args,
    ))


ChoiceT = TypeVar("ChoiceT", bound=str)


def ask_choice(prompt: str, choices: Dict[str, ChoiceT]) -> ChoiceT:
    while True:
        answer = input(prompt).strip().lower()
        choice = choices.get(answer)
        if choice:
            return choice
        print(f"Choose one of: {', '.join(key for key in choices.keys() if key)}")


def create_parsed_args(command: str, **overrides: object) -> ParsedArgs:
    parsed = ParsedArgs(command=command)
    for key, value in overrides.items():
        setattr(parsed, key, value)
    return parsed


def parse_args(argv: List[str]) -> ParsedArgs:
    args = list(argv)
    if not args or args[0] in {"-h", "--help"}:
        return ParsedArgs(command="help")
    first = args[0]
    if first in {"-v", "--version"}:
        return ParsedArgs(command="version")
    if first == "help":
        args.pop(0)
        return ParsedArgs(command="help", help_topic=" ".join(args) or None)

    matched = match_command(args)
    if not matched:
        raise ValueError(f"Unknown command: {first}\n\n{help_text(None)}")

    command, tokens = matched
    del args[:len(tokens)]

    parsed = ParsedArgs(command=command)
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
        is_local_command = parsed.command in {"repos list", "repos add", "panes create"}
        if arg in {"-h", "--help"}:
            parsed.help_topic = parsed.command
            parsed.command = "help"
        elif arg == "--dry-run":
            parsed.dry_run = True
        elif arg in {"--yes", "-y"}:
            parsed.yes = True
        elif arg == "--verbose":
            parsed.verbose = True
        elif is_local_command and arg in LOCAL_BOOLEAN_FLAGS:
            parse_local_boolean_flag(parsed, arg)
        elif is_local_command and arg in LOCAL_VALUE_FLAGS:
            index += 1
            parse_local_value_flag(parsed, arg, read_value(args, index, arg))
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


def match_command(args: List[str]) -> Optional[Tuple[str, List[str]]]:
    for command, tokens in COMMAND_MATCHERS:
        if args[:len(tokens)] == tokens:
            return command, tokens
    return None


def parse_local_boolean_flag(parsed: ParsedArgs, flag: str) -> None:
    if flag == "--json":
        parsed.json = True
        return
    raise ValueError(f"Unknown option for {parsed.command}: {flag}")


def parse_local_value_flag(parsed: ParsedArgs, flag: str, value: str) -> None:
    if flag == "--pane-dir":
        parsed.pane_dir = value
        return
    if flag == "--repo":
        parsed.repo = value
        return
    if flag == "--path":
        parsed.repo_path = value
        return
    if flag == "--name":
        parsed.name = value
        return
    if flag == "--worktree-name":
        parsed.worktree_name = value
        return
    if flag == "--base-branch":
        parsed.base_branch = value
        return
    if flag == "--agent":
        if value not in AGENTS:
            raise ValueError(f"Invalid --agent {value}. Expected one of: {', '.join(sorted(AGENTS))}")
        parsed.agent = value
        return
    if flag == "--tool-command":
        parsed.tool_command = value
        return
    if flag == "--title":
        parsed.title = value
        return
    if flag in {"--initial-input", "--prompt"}:
        parsed.initial_input = value
        return
    if flag == "--initial-input-file":
        parsed.initial_input_file = value
        return
    if flag == "--from-json":
        parsed.from_json = value
        return
    if flag == "--timeout-ms":
        try:
            timeout_ms = float(value)
        except ValueError as error:
            raise ValueError("--timeout-ms must be a positive number.") from error
        if timeout_ms <= 0:
            raise ValueError("--timeout-ms must be a positive number.")
        parsed.timeout_ms = timeout_ms
        return
    raise ValueError(f"Unknown option for {parsed.command}: {flag}")


def append_remote_arg(parsed: ParsedArgs, flag: str, value: Optional[str] = None) -> None:
    if parsed.command == "install" and parsed.target == "daemon":
        parsed.remote_setup_args.append(flag)
        if value is not None:
            parsed.remote_setup_args.append(value)
        return
    raise ValueError(f'{flag} is only valid with "runpane install daemon".')


def read_value(args: List[str], index: int, flag: str) -> str:
    if index >= len(args) or (args[index].startswith("-") and args[index] != "-"):
        raise ValueError(f"{flag} requires a value.")
    return args[index]


def install_or_update(parsed: ParsedArgs) -> int:
    target = "client" if parsed.command == "update" else parsed.target
    if not parsed.dry_run and should_reuse_existing_pane(parsed, target):
        existing = resolve_existing_pane_path(parsed.pane_path)
        if existing:
            print(f"runpane: using existing Pane executable at {existing}")
            print("runpane: starting remote setup...")
            return spawn_pane(existing, ["--remote-setup", *parsed.remote_setup_args])

    platform = detect_platform()
    print(f"runpane: resolving Pane release {parsed.pane_version}...")
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

    print(f"runpane: selected {resolved.artifact['name']}")
    print(f"runpane: downloading {resolved.artifact['name']}...")
    artifact = download_artifact(resolved, parsed.download_dir, parsed.verbose)
    fallback = " from GitHub fallback" if artifact.used_fallback else ""
    print(f"runpane: downloaded {artifact.file_name}{fallback}")
    print("runpane: installing Pane...")
    installed = install_pane_artifact(artifact, parsed, platform, resolved.format, target)

    if target == "daemon":
        print("runpane: starting remote setup...")
        return spawn_pane(installed.executable_path, ["--remote-setup", *parsed.remote_setup_args])

    if installed.install_kind == "installed":
        launch_pane_client(installed.executable_path)

    print(f"Pane {installed.install_kind}: {installed.executable_path}")
    return 0


def help_text(topic: Optional[str]) -> str:
    help_topics = RUNPANE_CONTRACT["help"]["pip"]
    return "\n".join(help_topics.get(topic or "default", help_topics["default"]))
