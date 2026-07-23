import { describe, expect, it } from 'vitest';
import { detectPanelBlocker } from './runpaneBlockerDetection';
import { classifyRunpaneInterstitial } from './runpaneInterstitials';

describe('classifyRunpaneInterstitial', () => {
  it('allowlists only the reversible Codex update skip', () => {
    expect(classifyRunpaneInterstitial('Codex update available — Skip', 'codex', 'p1')).toMatchObject({
      disposition: 'allow', response: '2', kind: 'codex-update',
    });
  });

  it('evaluates directory trust before the allowlist', () => {
    expect(classifyRunpaneInterstitial('Codex update available — Skip. Do you trust this directory?', 'codex', 'p1')).toMatchObject({
      disposition: 'deny', blocker: { kind: 'unknown' },
    });
  });

  it.each([
    ['trust-canonical', 'Do you trust the contents of this directory?\n> 1. Yes, proceed\n  2. No, exit'],
    ['auth-trailing-prose', 'Authentication required to continue using this service.'],
    ['auth-colon', 'Authentication required:'],
    ['auth-mcp-signin', 'Please sign in to continue with your account'],
    ['perm-question', 'Grant access to your GitHub repositories? [y/N]'],
    ['perm-allow-line', 'Allow access to the filesystem?'],
    ['destructive-confirm', 'This will delete 42 files and cannot be undone. Are you sure?'],
    ['destructive-typeconfirm', 'Type DELETE to confirm removal of the production database'],
    ['payment-question', 'Confirm payment of $20.00 to continue?'],
    ['terms-accept', 'Do you accept the terms of service?'],
    ['perm-caret', 'Permission required for shell access\n❯ Yes'],
  ])('D6 fail-closed probe blocks %s', (_name, screen) => {
    expect(classifyRunpaneInterstitial(screen, 'codex', 'p1').disposition).not.toBe('clear');
    expect(detectPanelBlocker(screen, 'codex', 'p1')).toMatchObject({ kind: 'agent-prompt' });
  });

  it.each([
    ['prose-delete', 'deleting obsolete files from the build directory'],
    ['prose-permission', 'reviewing permission handling in the auth module'],
    ['prose-billing', 'updated the billing module and removed the payment stub'],
    ['prose-destroy', 'the destroy() method overwrites the cache on teardown'],
    ['prose-terms', 'documented the terms of the license in README'],
  ])('D6 false-positive probe clears %s', (_name, screen) => {
    expect(classifyRunpaneInterstitial(screen, 'codex', 'p1')).toEqual({ disposition: 'clear' });
    expect(detectPanelBlocker(screen, 'codex', 'p1')).toBeUndefined();
  });

  it.each([
    ['auth-trailing-prose', 'Authentication required to continue using this service.'],
    ['auth-colon', 'Authentication required:'],
    ['auth-mcp-signin', 'Please sign in to continue with your account'],
  ])('D6 detectPanelBlocker blocks auth prompt %s', (_name, screen) => {
    expect(detectPanelBlocker(screen, 'codex', 'p1')).toMatchObject({ kind: 'agent-prompt' });
  });

  it('stops on an unknown planning modal', () => {
    expect(classifyRunpaneInterstitial('Planning suggestion: would you like to switch modes?', 'codex', 'p1').disposition).toBe('unknown');
  });

  it('recognizes numbered and arrowed selection menus without mistaking the Codex composer for one', () => {
    expect(classifyRunpaneInterstitial('Choose an option:\n› Continue\n  Cancel', 'codex', 'p1').disposition).toBe('unknown');
    expect(classifyRunpaneInterstitial('› /do TM-x', 'codex', 'p1')).toEqual({ disposition: 'clear' });
  });

  it('does not treat a passive MCP authentication banner as an interstitial', () => {
    expect(classifyRunpaneInterstitial('4 MCP servers need authentication\n›', 'claude', 'p1').disposition).toBe('clear');
  });

  it('P1-B maps unknown prompts to an agent-prompt blocker', () => {
    expect(detectPanelBlocker('Planning suggestion: would you like to switch modes?', 'codex', 'p1')).toMatchObject({
      kind: 'agent-prompt',
      message: 'An unrecognized interactive prompt requires explicit input.',
    });
  });

  it('P1-B preserves the Codex update blocker response command', () => {
    expect(detectPanelBlocker('Codex update available — Skip', 'codex', 'p1')).toEqual({
      kind: 'codex-update',
      message: 'Codex is showing an update prompt instead of accepting the task prompt.',
      suggestedCommand: 'runpane panels submit --panel p1 --text "2" --yes --json',
    });
  });
});
