import { RUNPANE_CONTRACT } from './generated/contract';
import type { ParsedArgs } from './commands';

type AgentContextCommand =
  typeof RUNPANE_CONTRACT.agentContext.commands[keyof typeof RUNPANE_CONTRACT.agentContext.commands];

interface AgentContextBriefResult {
  ok: true;
  mode: 'brief';
  source: 'runpane-contract';
  summary: string;
  rules: readonly string[];
  tools: typeof RUNPANE_CONTRACT.agentContext.brief.tools;
  detailCommand: string;
}

interface AgentContextCommandResult {
  ok: true;
  mode: 'command';
  source: 'runpane-contract';
  command: AgentContextCommand;
}

type AgentContextResult = AgentContextBriefResult | AgentContextCommandResult;

export function runAgentContext(parsed: Pick<ParsedArgs, 'contextCommand' | 'json'>): number {
  const result = buildAgentContextResult(parsed.contextCommand);
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(result.mode === 'brief'
    ? renderBrief(result)
    : renderCommandDetail(result.command));
  return 0;
}

export function buildAgentContextResult(commandName?: string): AgentContextResult {
  if (commandName) {
    return {
      ok: true,
      mode: 'command',
      source: 'runpane-contract',
      command: getCommandDetail(commandName)
    };
  }

  const brief = RUNPANE_CONTRACT.agentContext.brief;
  return {
    ok: true,
    mode: 'brief',
    source: 'runpane-contract',
    summary: brief.summary,
    rules: brief.rules,
    tools: brief.tools,
    detailCommand: brief.detailCommand
  };
}

function getCommandDetail(commandName: string): AgentContextCommand {
  const detail = Object.values(RUNPANE_CONTRACT.agentContext.commands)
    .find((command) => command.name === commandName);
  if (detail) {
    return detail;
  }

  throw new Error(`Unknown runpane command: ${commandName}. Expected one of: ${commandNames().join(', ')}`);
}

function renderBrief(result: AgentContextBriefResult): string {
  const lines = [
    RUNPANE_CONTRACT.agentContext.brief.title,
    '',
    result.summary,
    '',
    'Rules:',
    ...result.rules.map((rule) => `- ${rule}`),
    '',
    'Tools:',
    ...result.tools.map((tool) => `- ${tool.name}: ${tool.summary}\n  Args: ${tool.arguments.join(', ')}`),
    '',
    `Detailed definitions: ${result.detailCommand}`
  ];

  return lines.join('\n');
}

function renderCommandDetail(command: AgentContextCommand): string {
  const lines = [
    `runpane ${command.name}`,
    '',
    command.summary,
    '',
    'Details:',
    command.details,
    '',
    `Requires Pane daemon: ${command.requiresPaneDaemon ? 'yes' : 'no'}`,
    `Mutates Pane state: ${command.mutates ? 'yes' : 'no'}`,
    '',
    'Arguments:'
  ];

  if (command.arguments.length === 0) {
    lines.push('- none');
  } else {
    lines.push(...command.arguments.map((argument) => {
      const value = 'value' in argument && argument.value ? ` ${argument.value}` : '';
      const required = argument.required ? 'required' : 'optional';
      return `- ${argument.name}${value} (${required}): ${argument.description}`;
    }));
  }

  lines.push('', 'Examples:', ...command.examples.map((example) => `- ${example}`));

  const jsonSchemas = 'jsonSchemas' in command ? command.jsonSchemas : undefined;
  if (jsonSchemas?.length) {
    lines.push('', 'JSON schemas:', ...jsonSchemas.map((schema: string) => `- ${schema}`));
  }

  if (command.notes?.length) {
    lines.push('', 'Notes:', ...command.notes.map((note) => `- ${note}`));
  }

  return lines.join('\n');
}

function commandNames(): string[] {
  return Object.values(RUNPANE_CONTRACT.agentContext.commands)
    .map((command) => command.name)
    .sort();
}
