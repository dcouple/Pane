import { describe, expect, it } from 'vitest';
import { CLI_AGENT_TYPES, isCliAgentType, resolveAgentTypeFromCommand } from './agentIdentity';

describe('CLI_AGENT_TYPES', () => {
  it('lists the supported agents', () => {
    expect([...CLI_AGENT_TYPES].sort()).toEqual(['claude', 'codex', 'cursor']);
  });
});

describe('isCliAgentType', () => {
  it('accepts known agents and rejects everything else', () => {
    expect(isCliAgentType('claude')).toBe(true);
    expect(isCliAgentType('codex')).toBe(true);
    expect(isCliAgentType('cursor')).toBe(true);
    expect(isCliAgentType('aider')).toBe(false);
    expect(isCliAgentType(undefined)).toBe(false);
    expect(isCliAgentType(null)).toBe(false);
    expect(isCliAgentType(42)).toBe(false);
  });
});

describe('resolveAgentTypeFromCommand', () => {
  it('detects each agent from its launch template', () => {
    expect(resolveAgentTypeFromCommand('claude --dangerously-skip-permissions')).toBe('claude');
    expect(resolveAgentTypeFromCommand('codex --yolo')).toBe('codex');
    expect(resolveAgentTypeFromCommand('cursor-agent --force --trust')).toBe('cursor');
  });

  it('detects agents from resume commands', () => {
    expect(resolveAgentTypeFromCommand('codex resume --yolo 7403f755-6758-40d3-bb69-2cd356dd9bf0')).toBe('codex');
    expect(resolveAgentTypeFromCommand('claude --resume abc --dangerously-skip-permissions')).toBe('claude');
    expect(resolveAgentTypeFromCommand('cursor-agent --force --trust --resume "abc123"')).toBe('cursor');
  });

  it('detects agents behind absolute paths', () => {
    expect(resolveAgentTypeFromCommand('/usr/local/bin/claude')).toBe('claude');
    expect(resolveAgentTypeFromCommand('/Users/me/.local/bin/cursor-agent --force')).toBe('cursor');
  });

  it('detects quoted executable paths, including paths with spaces', () => {
    expect(resolveAgentTypeFromCommand('"/Applications/Cursor Agent.app/Contents/bin/cursor-agent" --force')).toBe('cursor');
    expect(resolveAgentTypeFromCommand("'/opt/OpenAI tools/codex' --yolo")).toBe('codex');
    expect(resolveAgentTypeFromCommand('"/usr/local/bin/claude"')).toBe('claude');
  });

  it('detects agents behind simple command and environment wrappers', () => {
    expect(resolveAgentTypeFromCommand('env CURSOR_MODE=trusted cursor-agent --force')).toBe('cursor');
    expect(resolveAgentTypeFromCommand('command "/opt/OpenAI/codex" --yolo')).toBe('codex');
    expect(resolveAgentTypeFromCommand('FOO=bar exec claude')).toBe('claude');
  });

  it('classifies cursor-agent as cursor even when other agent names appear in arguments', () => {
    expect(resolveAgentTypeFromCommand('cursor-agent --force --model claude-opus-4-8')).toBe('cursor');
  });

  it('requires token boundaries, not substrings', () => {
    expect(resolveAgentTypeFromCommand('/tmp/claude-501/session.sh')).toBeUndefined();
    expect(resolveAgentTypeFromCommand('run-codexlike-tool')).toBeUndefined();
    expect(resolveAgentTypeFromCommand('echo cursor-agentish')).toBeUndefined();
    expect(resolveAgentTypeFromCommand('echo cursor-agent')).toBeUndefined();
    expect(resolveAgentTypeFromCommand('/tmp/cursor-agent/project/start.sh')).toBeUndefined();
    expect(resolveAgentTypeFromCommand('node script.js --agent codex')).toBeUndefined();
  });

  it('returns undefined for shells and empty input', () => {
    expect(resolveAgentTypeFromCommand('zsh -l')).toBeUndefined();
    expect(resolveAgentTypeFromCommand('')).toBeUndefined();
    expect(resolveAgentTypeFromCommand(undefined)).toBeUndefined();
  });
});
