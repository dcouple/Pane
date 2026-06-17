from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, Optional

from .daemon_client import invoke_daemon
from .generated_contract import RUNPANE_CONTRACT


def run_repos_list(parsed: Any) -> int:
    result = invoke_daemon("runpane:repos:list", pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    repos = result.get("repos", [])
    if not repos:
        print("No Pane repositories found.")
        return 0

    for repo in repos:
        marker = "*" if repo.get("active") else " "
        environment = f" {repo.get('environment')}" if repo.get("environment") else ""
        print(f"{marker} {repo.get('id')}\t{repo.get('name')}\t{repo.get('path')}\t{repo.get('sessionCount')} sessions{environment}")
    return 0


def run_panes_create(parsed: Any) -> int:
    request = build_pane_create_request(parsed)
    confirm_pane_create(parsed, request)
    result = invoke_daemon(
        "runpane:panes:create",
        [request],
        pane_dir=parsed.pane_dir,
        timeout_ms=(parsed.timeout_ms or 120_000) + 10_000,
    )

    if parsed.json:
        print_json(result)
    else:
        print_pane_create_result(result)

    return 0 if result.get("ok") else 1


def build_pane_create_request(parsed: Any) -> Dict[str, Any]:
    if parsed.from_json:
        payload = json.loads(read_input_source(parsed.from_json))
        if not isinstance(payload, dict):
            raise ValueError("--from-json payload must be an object.")
        if parsed.dry_run:
            payload["dryRun"] = True
        if parsed.timeout_ms is not None:
            payload["timeoutMs"] = parsed.timeout_ms
        return payload

    if not parsed.repo:
        raise ValueError("runpane panes create requires --repo unless --from-json is used.")
    if not parsed.name:
        raise ValueError("runpane panes create requires --name unless --from-json is used.")

    return {
        "repo": parsed.repo,
        "panes": [{
            "name": parsed.name,
            **optional_value("worktreeName", parsed.worktree_name),
            **optional_value("baseBranch", parsed.base_branch),
            "tool": build_tool_spec(parsed),
        }],
        **optional_value("dryRun", True if parsed.dry_run else None),
        **optional_value("timeoutMs", parsed.timeout_ms),
    }


def build_tool_spec(parsed: Any) -> Dict[str, Any]:
    if parsed.agent and parsed.tool_command:
        raise ValueError("Use either --agent or --tool-command, not both.")

    initial_input = resolve_initial_input(parsed)
    agent = parsed.agent

    if not agent and not parsed.tool_command:
        if not is_interactive_shell():
            raise ValueError("runpane panes create requires --agent or --tool-command in non-interactive shells.")
        agent = ask_agent_choice()

    if agent:
        return {
            "agent": agent,
            **optional_value("title", parsed.title),
            **optional_value("initialInput", initial_input),
        }

    if not parsed.tool_command:
        raise ValueError("runpane panes create requires --agent or --tool-command.")

    return {
        "command": parsed.tool_command,
        **optional_value("title", parsed.title),
        **optional_value("initialInput", initial_input),
    }


def resolve_initial_input(parsed: Any) -> Optional[str]:
    if parsed.initial_input and parsed.initial_input_file:
        raise ValueError("Use either --initial-input/--prompt or --initial-input-file, not both.")
    if parsed.initial_input_file:
        return read_input_source(parsed.initial_input_file)
    return parsed.initial_input


def confirm_pane_create(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.dry_run or parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panes create mutates Pane state. Rerun with --yes in non-interactive shells.")

    count = len(request.get("panes", []))
    answer = input(f"Create {count} Pane pane{'s' if count != 1 else ''}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def ask_agent_choice() -> str:
    agents = RUNPANE_CONTRACT["enums"]["agents"]
    print("Choose an agent:")
    for index, agent in enumerate(agents, start=1):
        print(f"{index}) {RUNPANE_CONTRACT['agentTemplates'][agent]['title']}")

    while True:
        answer = input("Agent [1]: ").strip().lower()
        if not answer:
            return agents[0]
        if answer.isdigit() and 1 <= int(answer) <= len(agents):
            return agents[int(answer) - 1]
        if answer in agents:
            return answer
        print(f"Choose one of: {', '.join(agents)}")


def read_input_source(source: str) -> str:
    if source == "-":
        return sys.stdin.read()
    with open(source, "r", encoding="utf-8") as handle:
        return handle.read()


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2))


def print_pane_create_result(result: Dict[str, Any]) -> None:
    for item in result.get("items", []):
        name = item.get("name") or f"pane {item.get('index')}"
        if item.get("ok"):
            worktree = f" at {item.get('worktreePath')}" if item.get("worktreePath") else ""
            print(f"Created {name}: session {item.get('sessionId', 'unknown')} panel {item.get('panelId', 'unknown')}{worktree}")
        else:
            error = item.get("error") or {}
            print(f"Failed {name}: {error.get('message', 'unknown error')}", file=sys.stderr)


def optional_value(key: str, value: Any) -> Dict[str, Any]:
    return {key: value} if value is not None else {}


def is_interactive_shell() -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty() and not os.environ.get("CI"))
