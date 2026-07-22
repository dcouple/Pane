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


def run_repos_add(parsed: Any) -> int:
    request = build_repo_add_request(parsed)
    confirm_repo_add(parsed, request)
    result = invoke_daemon("runpane:repos:add", [request], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        print_repo_add_result(result)

    return 0


def run_panes_list(parsed: Any) -> int:
    result = invoke_daemon("runpane:panes:list", [{
        "repo": parsed.repo,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    print_pane_list_result(result)
    return 0


def run_panes_create(parsed: Any) -> int:
    request = build_pane_create_request(parsed)
    confirm_pane_create(parsed, request)
    result = invoke_daemon(
        "runpane:panes:create",
        [request],
        pane_dir=parsed.pane_dir,
        timeout_ms=(parsed.timeout_ms or 120_000) + (parsed.ready_timeout_ms or 30_000) + 10_000,
    )

    if parsed.json:
        print_json(result)
    else:
        print_pane_create_result(result)

    return 0 if result.get("ok") else 1


def run_panes_archive(parsed: Any) -> int:
    if not parsed.pane_id:
        raise ValueError("runpane panes archive requires --pane.")

    request: Dict[str, Any] = {
        "paneId": parsed.pane_id,
        "force": parsed.force or None,
        "source": parsed.source if parsed.source in ("user", "agent") else None,
    }

    confirm_pane_archive(parsed, request)

    result = invoke_daemon(
        "runpane:panes:archive",
        [request],
        pane_dir=parsed.pane_dir,
        timeout_ms=40_000,
    )

    if parsed.json:
        print_json(result)
    else:
        print_pane_archive_result(result)

    return 0 if result.get("ok") else 1


def run_panes_pin(parsed: Any, pinned: bool) -> int:
    command = "pin" if pinned else "unpin"
    if not parsed.pane_id:
        raise ValueError(f"runpane panes {command} requires --pane.")

    request = {
        "paneId": parsed.pane_id,
        "pinned": pinned,
        **optional_value("dryRun", True if parsed.dry_run else None),
    }
    confirm_pane_pin(parsed, request)
    result = invoke_daemon(
        "runpane:panes:pin",
        [request],
        pane_dir=parsed.pane_dir,
    )

    if parsed.json:
        print_json(result)
    else:
        print(f"{'Pinned' if result.get('pinned') else 'Unpinned'} {result.get('paneId')}")

    return 0


def run_panels_list(parsed: Any) -> int:
    if not parsed.pane_id:
        raise ValueError("runpane panels list requires --pane.")

    result = invoke_daemon("runpane:panels:list", [{
        "paneId": parsed.pane_id,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    print_panel_list_result(result)
    return 0


def run_panels_create(parsed: Any) -> int:
    request = build_panel_create_request(parsed)
    confirm_panel_create(parsed, request)
    result = invoke_daemon(
        "runpane:panels:create",
        [request],
        pane_dir=parsed.pane_dir,
        timeout_ms=(parsed.ready_timeout_ms or 30_000) + 10_000,
    )

    if parsed.json:
        print_json(result)
    else:
        print_panel_create_result(result)
    return 0 if result.get("ok") else 1


def run_panels_output(parsed: Any) -> int:
    if not parsed.panel_id:
        raise ValueError("runpane panels output requires --panel.")

    result = invoke_daemon("runpane:panels:output", [{
        "panelId": parsed.panel_id,
        "limit": parsed.limit,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    text = result.get("text") or ""
    sys.stdout.write(text)
    if text and not text.endswith("\n"):
        sys.stdout.write("\n")
    return 0


def run_panels_input(parsed: Any) -> int:
    request = build_panel_input_request(parsed)
    confirm_panel_input(parsed, request)
    result = invoke_daemon("runpane:panels:input", [request], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        input_bytes = result.get("inputBytes", 0)
        suffix = "" if input_bytes == 1 else "s"
        print(f"Sent {input_bytes} byte{suffix} to panel {result.get('panelId')}.")

    return 0


def run_panels_screen(parsed: Any) -> int:
    if not parsed.panel_id:
        raise ValueError("runpane panels screen requires --panel.")

    result = invoke_daemon("runpane:panels:screen", [{
        "panelId": parsed.panel_id,
        "limit": parsed.limit,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
        return 0

    text = result.get("text") or ""
    sys.stdout.write(text)
    if text and not text.endswith("\n"):
        sys.stdout.write("\n")
    return 0


def run_panels_submit(parsed: Any) -> int:
    request = build_panel_input_request(parsed, "submit")
    confirm_panel_input(parsed, request, "submit")
    result = invoke_daemon("runpane:panels:submit", [request], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        input_bytes = result.get("inputBytes", 0)
        suffix = "" if input_bytes == 1 else "s"
        print(f"Submitted {input_bytes} byte{suffix} with Enter to panel {result.get('panelId')}.")
        if result.get("nextCommand"):
            print(f"Next: {result.get('nextCommand')}")
    return 0


def run_panels_submit_composer(parsed: Any) -> int:
    if not parsed.panel_id:
        raise ValueError("runpane panels submit-composer requires --panel.")
    confirm_panel_submit_composer(parsed)

    result = invoke_daemon("runpane:panels:submit-composer", [{
        "panelId": parsed.panel_id,
        "strategy": parsed.composer_strategy,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        verb = "Submitted" if result.get("ok") else "Could not verify"
        verified = " verified" if result.get("verifiedSubmitted") else " unverified"
        print(f"{verb} composer with {result.get('sequenceName')} to panel {result.get('panelId')}.{verified}")
        if result.get("blocked"):
            print(f"Blocked: {result['blocked'].get('message')}")
        if result.get("nextCommand"):
            print(f"Next: {result.get('nextCommand')}")
    return 0 if result.get("ok") else 1


def run_panels_wait(parsed: Any) -> int:
    if not parsed.panel_id:
        raise ValueError("runpane panels wait requires --panel.")

    result = invoke_daemon("runpane:panels:wait", [{
        "panelId": parsed.panel_id,
        "condition": parsed.wait_condition,
        "contains": parsed.contains,
        "timeoutMs": parsed.timeout_ms,
        "intervalMs": parsed.interval_ms,
    }], pane_dir=parsed.pane_dir, timeout_ms=(parsed.timeout_ms or 30_000) + 5_000)

    if parsed.json:
        print_json(result)
    else:
        print_panel_wait_result(result)
    return 0 if result.get("ok") else 1


def run_agents_doctor(parsed: Any) -> int:
    if not parsed.agent:
        raise ValueError("runpane agents doctor requires --agent codex|claude.")

    result = invoke_daemon("runpane:agents:doctor", [{
        "agent": parsed.agent,
        "repo": parsed.repo,
    }], pane_dir=parsed.pane_dir)

    if parsed.json:
        print_json(result)
    else:
        print_agent_doctor_result(result)
    return 0 if result.get("ok") else 1


def build_repo_add_request(parsed: Any) -> Dict[str, Any]:
    if not parsed.repo_path:
        raise ValueError("runpane repos add requires --path.")

    return {
        "path": parsed.repo_path,
        **optional_value("name", parsed.name),
        **optional_value("dryRun", True if parsed.dry_run else None),
    }


def build_panel_input_request(parsed: Any, command: str = "input") -> Dict[str, Any]:
    if not parsed.panel_id:
        raise ValueError(f"runpane panels {command} requires --panel.")
    if parsed.panel_input is not None and parsed.panel_input_file:
        raise ValueError("Use either --text or --input-file, not both.")
    if parsed.panel_input is None and not parsed.panel_input_file:
        raise ValueError(f"runpane panels {command} requires --text or --input-file.")

    return {
        "panelId": parsed.panel_id,
        "input": read_input_source(parsed.panel_input_file) if parsed.panel_input_file else parsed.panel_input or "",
    }


def build_panel_create_request(parsed: Any) -> Dict[str, Any]:
    if not parsed.pane_id:
        raise ValueError("runpane panels create requires --pane.")
    if parsed.no_focus and parsed.focus:
        raise ValueError("Use either --focus or --no-focus, not both.")

    return {
        "paneId": parsed.pane_id,
        "type": "terminal",
        "tool": build_tool_spec(parsed, "panels create"),
        **optional_value("noFocus", True if not parsed.focus and (parsed.no_focus or parsed.source == "agent" or bool(parsed.agent)) else None),
        **optional_value("focus", True if parsed.focus else None),
        **optional_value("source", parsed.source),
        **optional_value("waitReady", True if parsed.wait_ready else None),
        **optional_value("readyTimeoutMs", parsed.ready_timeout_ms),
    }


def build_pane_create_request(parsed: Any) -> Dict[str, Any]:
    if parsed.from_json:
        payload = json.loads(strip_utf8_bom(read_input_source(parsed.from_json)))
        if not isinstance(payload, dict):
            raise ValueError("--from-json payload must be an object.")
        if parsed.dry_run:
            payload["dryRun"] = True
        if parsed.timeout_ms is not None:
            payload["timeoutMs"] = parsed.timeout_ms
        if parsed.wait_ready:
            payload["waitReady"] = True
        if parsed.ready_timeout_ms is not None:
            payload["readyTimeoutMs"] = parsed.ready_timeout_ms
        if parsed.concurrency is not None:
            payload["concurrency"] = parsed.concurrency
        if parsed.pinned:
            payload["panes"] = [
                {**item, "pinned": True} if isinstance(item, dict) else item
                for item in payload.get("panes", [])
            ]
        apply_pane_focus_options(parsed, payload)
        return payload

    if not parsed.repo:
        raise ValueError("runpane panes create requires --repo unless --from-json is used.")
    if not parsed.name:
        raise ValueError("runpane panes create requires --name unless --from-json is used.")
    if parsed.no_focus and parsed.focus:
        raise ValueError("Use either --focus or --no-focus, not both.")

    return {
        "repo": parsed.repo,
        "panes": [{
            "name": parsed.name,
            **optional_value("worktreeName", parsed.worktree_name),
            **optional_value("baseBranch", parsed.base_branch),
            **optional_value("pinned", True if parsed.pinned else None),
            "tool": build_tool_spec(parsed),
        }],
        **optional_value("dryRun", True if parsed.dry_run else None),
        **optional_value("timeoutMs", parsed.timeout_ms),
        **optional_value("waitReady", True if parsed.wait_ready else None),
        **optional_value("readyTimeoutMs", parsed.ready_timeout_ms),
        **optional_value("concurrency", parsed.concurrency),
        **optional_value("noFocus", True if not parsed.focus and (parsed.no_focus or parsed.source == "agent" or bool(parsed.agent)) else None),
        **optional_value("focus", True if parsed.focus else None),
        **optional_value("source", parsed.source),
    }


def apply_pane_focus_options(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.no_focus and parsed.focus:
        raise ValueError("Use either --focus or --no-focus, not both.")
    if not parsed.focus and (parsed.no_focus or parsed.source == "agent" or bool(parsed.agent)):
        request["noFocus"] = True
    if parsed.focus:
        request["focus"] = True
    if parsed.source:
        request["source"] = parsed.source


def build_tool_spec(parsed: Any, command: str = "panes create") -> Dict[str, Any]:
    if parsed.agent and parsed.tool_command:
        raise ValueError("Use either --agent or --tool-command, not both.")

    initial_input = resolve_initial_input(parsed)
    agent = parsed.agent

    if not agent and not parsed.tool_command:
        if not is_interactive_shell():
            raise ValueError(f"runpane {command} requires --agent or --tool-command in non-interactive shells.")
        agent = ask_agent_choice()

    if agent:
        return {
            "agent": agent,
            **optional_value("title", parsed.title),
            **optional_value("initialInput", initial_input),
        }

    if not parsed.tool_command:
        raise ValueError(f"runpane {command} requires --agent or --tool-command.")

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


def confirm_repo_add(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.dry_run or parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane repos add mutates Pane state. Rerun with --yes in non-interactive shells.")

    label = f"{request.get('name')} at {request.get('path')}" if request.get("name") else request.get("path")
    answer = input(f"Add Pane repo {label}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_pane_create(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.dry_run or parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panes create mutates Pane state. Rerun with --yes in non-interactive shells.")

    count = len(request.get("panes", []))
    answer = input(f"Create {count} Pane pane{'s' if count != 1 else ''}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_pane_archive(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panes archive mutates Pane state. Rerun with --yes in non-interactive shells.")

    suffix = " (including any uncommitted or unpushed work)" if request.get("force") else ""
    answer = input(f"Archive pane {request.get('paneId')}{suffix}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_pane_pin(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.dry_run or parsed.yes:
        return
    command = "pin" if request.get("pinned") else "unpin"
    if not is_interactive_shell():
        raise ValueError(f"runpane panes {command} mutates Pane state. Rerun with --yes in non-interactive shells.")

    action = "Pin" if request.get("pinned") else "Unpin"
    answer = input(f"{action} pane {request.get('paneId')}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_panel_create(parsed: Any, request: Dict[str, Any]) -> None:
    if parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panels create mutates Pane state. Rerun with --yes in non-interactive shells.")

    tool = request.get("tool") or {}
    label = tool.get("agent") or tool.get("command")
    answer = input(f"Create a terminal panel for {label} in pane {request.get('paneId')}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_panel_input(parsed: Any, request: Dict[str, Any], command: str = "input") -> None:
    if parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError(f"runpane panels {command} mutates a Pane terminal. Rerun with --yes in non-interactive shells.")

    input_bytes = len(request.get("input", "").encode("utf-8"))
    suffix = "" if input_bytes == 1 else "s"
    verb = "Submit" if command == "submit" else "Send"
    enter_suffix = " plus Enter" if command == "submit" else ""
    answer = input(f"{verb} {input_bytes} byte{suffix}{enter_suffix} to panel {request.get('panelId')}? [y/N] ").strip().lower()
    if answer not in {"y", "yes"}:
        raise ValueError("Cancelled.")


def confirm_panel_submit_composer(parsed: Any) -> None:
    if parsed.yes:
        return
    if not is_interactive_shell():
        raise ValueError("runpane panels submit-composer mutates a Pane terminal. Rerun with --yes in non-interactive shells.")

    answer = input(f"Submit composer in panel {parsed.panel_id}? [y/N] ").strip().lower()
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


def strip_utf8_bom(value: str) -> str:
    return value.lstrip("\ufeff")


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2))


def print_repo_add_result(result: Dict[str, Any]) -> None:
    preview = result.get("preview") or {}
    if result.get("dryRun") and preview:
        if preview.get("alreadyExists"):
            print(f"Repo already exists: {preview.get('name')}\t{preview.get('path')}")
            return
        print(f"Would add Pane repo {preview.get('name')}\t{preview.get('path')}")
        return

    repo = result.get("repo")
    if repo:
        action = "Added Pane repo" if result.get("created") else "Repo already exists"
        print(f"{action}: {repo.get('id')}\t{repo.get('name')}\t{repo.get('path')}")
        return

    print("Repo add completed.")


def print_pane_list_result(result: Dict[str, Any]) -> None:
    panes = result.get("panes", [])
    if not panes:
        print("No Pane sessions found.")
        return

    for pane in panes:
        repo = f" {pane.get('repoName')}" if pane.get("repoName") else ""
        pinned = " pinned" if pane.get("pinned") else ""
        print(f"{pane.get('id')}\t{pane.get('name')}\t{pane.get('status')}{pinned}\t{pane.get('panelCount')} panels\t{pane.get('worktreePath')}{repo}")


def print_pane_create_result(result: Dict[str, Any]) -> None:
    for item in result.get("items", []):
        name = item.get("name") or f"pane {item.get('index')}"
        if item.get("ok"):
            worktree = f" at {item.get('worktreePath')}" if item.get("worktreePath") else ""
            print(f"Created {name}: session {item.get('sessionId', 'unknown')} panel {item.get('panelId', 'unknown')}{worktree}")
            readiness = item.get("readiness")
            if readiness:
                ready_state = "yes" if readiness.get("ok") else "timed out" if readiness.get("timedOut") else "blocked"
                print(f"  Ready: {ready_state} after {readiness.get('elapsedMs')}ms")
                blocked = readiness.get("blocked")
                if blocked:
                    print(f"  Blocked: {blocked.get('message')}")
            if item.get("nextCommand"):
                print(f"  Next: {item.get('nextCommand')}")
        else:
            error = item.get("error") or {}
            print(f"Failed {name}: {error.get('message', 'unknown error')}", file=sys.stderr)


def print_pane_archive_result(result: Dict[str, Any]) -> None:
    if "archived" not in result:
        blocked = result.get("blocked") or {}
        print(f"Refused to archive pane {result.get('paneId')}: {blocked.get('message')}", file=sys.stderr)
        print(f"Next: {result.get('nextCommand')}", file=sys.stderr)
        return

    forced = " (forced)" if result.get("forced") else ""
    print(f"Archived pane {result.get('paneId')}{forced}. Worktree cleanup: {result.get('worktreeCleanup')}.")


def print_panel_create_result(result: Dict[str, Any]) -> None:
    active = " active" if result.get("active") else " background"
    print(f"Created panel {result.get('panelId')} in pane {result.get('paneId')}: {result.get('title')}{active}")
    readiness = result.get("readiness")
    if readiness:
        ready_state = "yes" if readiness.get("ok") else "timed out" if readiness.get("timedOut") else "blocked"
        print(f"Ready: {ready_state} after {readiness.get('elapsedMs')}ms")
        blocked = readiness.get("blocked")
        if blocked:
            print(f"Blocked: {blocked.get('message')}")
    if result.get("nextCommand"):
        print(f"Next: {result.get('nextCommand')}")


def print_panel_wait_result(result: Dict[str, Any]) -> None:
    condition = result.get("condition")
    panel_id = result.get("panelId")
    elapsed = result.get("elapsedMs")
    if result.get("ok"):
        print(f"Matched {condition} for panel {panel_id} after {elapsed}ms.")
    elif result.get("blocked"):
        print(f"Blocked waiting for {condition} on panel {panel_id}: {result['blocked'].get('message')}")
    elif result.get("timedOut"):
        print(f"Timed out waiting for {condition} on panel {panel_id} after {elapsed}ms.")
    else:
        print(f"Did not match {condition} for panel {panel_id}.")

    state = result.get("state") or {}
    status_parts = [
        "initialized" if state.get("initialized") else "not-initialized",
        state.get("activityStatus"),
        None if state.get("isCliReady") is None else "cli-ready" if state.get("isCliReady") else "cli-not-ready",
        state.get("agentType"),
    ]
    status = ", ".join(part for part in status_parts if part)
    if status:
        print(f"State: {status}")
    if result.get("nextCommand"):
        print(f"Next: {result.get('nextCommand')}")


def print_agent_doctor_result(result: Dict[str, Any]) -> None:
    repo = f" in {result['repo'].get('name')}" if result.get("repo") else ""
    environment = f" ({result.get('environment')})" if result.get("environment") else ""
    print(f"{result.get('agent')}: {'available' if result.get('available') else 'not available'}{repo}{environment}")
    if result.get("executablePath"):
        print(f"Path: {result.get('executablePath')}")
    if result.get("version"):
        print(f"Version: {result.get('version')}")
    for check in result.get("checks", []):
        print(f"{'OK' if check.get('ok') else 'FAIL'} {check.get('name')}: {check.get('message')}")
    for warning in result.get("warnings") or []:
        print(f"Warning: {warning}")


def print_panel_list_result(result: Dict[str, Any]) -> None:
    panels = result.get("panels", [])
    pane_id = result.get("paneId")
    if not panels:
        print(f"No panels found for pane {pane_id}.")
        return

    for panel in panels:
        marker = "*" if panel.get("active") else " "
        initialized = ""
        if panel.get("initialized") is not None:
            initialized = " initialized" if panel.get("initialized") else " not-initialized"
        agent = f" {panel.get('agentType')}" if panel.get("agentType") else ""
        print(f"{marker} {panel.get('id')}\t{panel.get('type')}\t{panel.get('title')}{initialized}{agent}")


def optional_value(key: str, value: Any) -> Dict[str, Any]:
    return {key: value} if value is not None else {}


def is_interactive_shell() -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty() and not os.environ.get("CI"))
