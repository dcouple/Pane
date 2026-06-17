from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from .generated_contract import RUNPANE_CONTRACT


def run_agent_context(parsed: Any) -> int:
    result = build_agent_context_result(parsed.context_command)
    if parsed.json:
        print(json.dumps(result, indent=2))
        return 0

    if result["mode"] == "brief":
        print(render_brief(result))
    else:
        print(render_command_detail(result["command"]))
    return 0


def build_agent_context_result(command_name: Optional[str] = None) -> Dict[str, Any]:
    if command_name:
        return {
            "ok": True,
            "mode": "command",
            "source": "runpane-contract",
            "command": get_command_detail(command_name),
        }

    brief = RUNPANE_CONTRACT["agentContext"]["brief"]
    return {
        "ok": True,
        "mode": "brief",
        "source": "runpane-contract",
        "summary": brief["summary"],
        "rules": brief["rules"],
        "tools": brief["tools"],
        "detailCommand": brief["detailCommand"],
    }


def get_command_detail(command_name: str) -> Dict[str, Any]:
    for command in RUNPANE_CONTRACT["agentContext"]["commands"].values():
        if command["name"] == command_name:
            return command

    raise ValueError(f"Unknown runpane command: {command_name}. Expected one of: {', '.join(command_names())}")


def render_brief(result: Dict[str, Any]) -> str:
    lines = [
        RUNPANE_CONTRACT["agentContext"]["brief"]["title"],
        "",
        result["summary"],
        "",
        "Rules:",
    ]
    lines.extend(f"- {rule}" for rule in result["rules"])
    lines.extend(["", "Tools:"])
    for tool in result["tools"]:
        lines.append(f"- {tool['name']}: {tool['summary']}")
        lines.append(f"  Args: {', '.join(tool['arguments'])}")
    lines.extend(["", f"Detailed definitions: {result['detailCommand']}"])
    return "\n".join(lines)


def render_command_detail(command: Dict[str, Any]) -> str:
    lines = [
        f"runpane {command['name']}",
        "",
        command["summary"],
        "",
        "Details:",
        command["details"],
        "",
        f"Requires Pane daemon: {'yes' if command.get('requiresPaneDaemon') else 'no'}",
        f"Mutates Pane state: {'yes' if command.get('mutates') else 'no'}",
        "",
        "Arguments:",
    ]

    if not command["arguments"]:
        lines.append("- none")
    else:
        for argument in command["arguments"]:
            value = f" {argument['value']}" if argument.get("value") else ""
            required = "required" if argument["required"] else "optional"
            lines.append(f"- {argument['name']}{value} ({required}): {argument['description']}")

    lines.extend(["", "Examples:"])
    lines.extend(f"- {example}" for example in command["examples"])

    if command.get("jsonSchemas"):
        lines.extend(["", "JSON schemas:"])
        lines.extend(f"- {schema}" for schema in command["jsonSchemas"])

    if command.get("notes"):
        lines.extend(["", "Notes:"])
        lines.extend(f"- {note}" for note in command["notes"])

    return "\n".join(lines)


def command_names() -> List[str]:
    return sorted(
        command["name"]
        for command in RUNPANE_CONTRACT["agentContext"]["commands"].values()
    )
