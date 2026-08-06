import { describe, expect, it } from 'vitest';
import { detectAgentState } from './manifestEngine';
import {
  CLAUDE_MANIFEST,
  CODEX_MANIFEST,
  GENERIC_MANIFEST,
  getManifestForAgent,
} from './manifests';

const screen = (s: string, oscTitle = '', oscProgress = '') => ({ screen: s, oscTitle, oscProgress });

describe('getManifestForAgent', () => {
  it('resolves bespoke manifests, with the generic fallback covering everything else', () => {
    expect(getManifestForAgent('claude')).toBe(CLAUDE_MANIFEST);
    expect(getManifestForAgent('codex')).toBe(CODEX_MANIFEST);
    expect(getManifestForAgent('aider')).toBe(GENERIC_MANIFEST);
    expect(getManifestForAgent(undefined)).toBe(GENERIC_MANIFEST);
    expect(getManifestForAgent(null)).toBe(GENERIC_MANIFEST);
  });
});

describe('CLAUDE_MANIFEST', () => {
  it('classifies a bash permission prompt as blocked', () => {
    const s = [
      '● I will run a command',
      '',
      'Bash command',
      '  ls -la',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No, and tell Claude what to do differently (esc)',
    ].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
  });

  it('classifies a generic permission prompt after a rule as blocked', () => {
    const s = [
      'context',
      '──────────────────────',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No (esc to cancel)',
    ].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
  });

  it('classifies an empty prompt box as idle via live_prompt_box', () => {
    const s = ['some prior output', '────────────', ' ❯ ', '────────────'].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('idle');
    expect(r.matchedRuleId).toBe('live_prompt_box');
  });

  it('detects working from a braille-spinner OSC title', () => {
    const r = detectAgentState(CLAUDE_MANIFEST, screen('', '⠙ Building the thing'));
    expect(r.state).toBe('working');
    expect(r.visibleWorking).toBe(true);
  });

  it('detects idle from the ✳ OSC title', () => {
    const r = detectAgentState(CLAUDE_MANIFEST, screen('', '✳ Ready'));
    expect(r.state).toBe('idle');
  });

  it('holds prior state on the transcript viewer', () => {
    const s = ['Showing detailed transcript (ctrl+o to toggle)'].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.skipStateUpdate).toBe(true);
    expect(r.matchedRuleId).toBe('transcript_viewer');
  });
});

describe('CODEX_MANIFEST', () => {
  it('classifies the Action Required title as blocked', () => {
    const r = detectAgentState(CODEX_MANIFEST, screen('working on it', 'Action Required · Codex'));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
  });

  it('detects working from a codex spinner OSC title', () => {
    const r = detectAgentState(CODEX_MANIFEST, screen('', '⠹ Codex'));
    expect(r.state).toBe('working');
  });

  it('classifies an allow-command prompt as blocked', () => {
    const s = ['Codex wants to run a command', 'allow command?', '  Yes    No'].join('\n');
    const r = detectAgentState(CODEX_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
  });

  it('classifies a [y/n] weak blocker as blocked', () => {
    const r = detectAgentState(CODEX_MANIFEST, screen('Continue? [y/n]'));
    expect(r.state).toBe('blocked');
  });

  it('detects working from the "Working (… esc to interrupt)" status line', () => {
    const s = ['some output', '• Working (5s • esc to interrupt) · thinking'].join('\n');
    const r = detectAgentState(CODEX_MANIFEST, screen(s));
    expect(r.state).toBe('working');
  });

  it('classifies a plain title as idle', () => {
    const r = detectAgentState(CODEX_MANIFEST, screen('', 'Codex'));
    expect(r.state).toBe('idle');
  });
});

describe('GENERIC_MANIFEST', () => {
  it('detects a live prompt on the last line as blocked', () => {
    expect(detectAgentState(GENERIC_MANIFEST, screen('Overwrite file? (y/n)')).state).toBe('blocked');
    expect(detectAgentState(GENERIC_MANIFEST, screen('Do you want to proceed? [y/n] ')).state).toBe('blocked');
    expect(
      detectAgentState(GENERIC_MANIFEST, screen('Apply migration to database?\nDo you want to proceed? [y/n] ')).state,
    ).toBe('blocked');
    expect(detectAgentState(GENERIC_MANIFEST, screen('Continue? [Y/n]:')).state).toBe('blocked');
  });

  it('does not stay blocked once the prompt is answered or scrolled past', () => {
    expect(detectAgentState(GENERIC_MANIFEST, screen('Do you want to proceed? [y/n] y\nok: y')).state).toBe('idle');
    expect(detectAgentState(GENERIC_MANIFEST, screen('Overwrite file? (y/n)\n$ ')).state).toBe('idle');
    expect(detectAgentState(GENERIC_MANIFEST, screen('$ ')).state).toBe('idle');
  });
});
