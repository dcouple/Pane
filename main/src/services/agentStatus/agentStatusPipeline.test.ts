import { describe, expect, it } from 'vitest';
import { TerminalStateEmulator } from '../terminalStateEmulator';
import { AgentStatusMonitor } from './agentStatusMonitor';
import { detectAgentState } from './manifestEngine';
import { CLAUDE_MANIFEST, CURSOR_MANIFEST } from './manifests';
import type { AgentManifest } from './manifestEngine';

/**
 * End-to-end pipeline: raw PTY bytes -> TerminalStateEmulator screen/OSC ->
 * manifest detection -> monitor arbitration. Proves the pieces compose on real
 * ANSI/OSC sequences, not just synthetic inputs.
 */
async function classify(
  emulator: TerminalStateEmulator,
  monitor: AgentStatusMonitor,
  now: number,
  manifest: AgentManifest = CLAUDE_MANIFEST,
) {
  await emulator.waitForIdle();
  const detection = detectAgentState(manifest, {
    screen: emulator.getScreenText(),
    oscTitle: emulator.getOscTitle(),
    oscProgress: emulator.getOscProgress(),
  });
  return monitor.update('p', detection, now);
}

describe('agent status pipeline (emulator -> detect -> monitor)', () => {
  it('goes working (spinner title) -> blocked (permission prompt) on real sequences', async () => {
    const emulator = new TerminalStateEmulator(60, 12);
    const monitor = new AgentStatusMonitor({
      workingActivityWindowMs: 600,
      workingToIdleHoldMs: 700,
      startupGraceMs: 3000,
    });
    monitor.register('p', 0);

    // Agent starts working: OSC title carries a braille spinner + PTY bytes flow.
    emulator.write('\x1b]2;⠹ Claude\x07Thinking...');
    monitor.noteActivity('p', 4000);
    expect(await classify(emulator, monitor, 4010)).toBe('working');

    // Agent pauses for approval: title clears, a permission prompt is drawn.
    emulator.write('\x1b[2J\x1b[H');
    emulator.write('\x1b]2;\x07'); // clear title
    emulator.write('Bash command\r\n  rm -rf build\r\n\r\n');
    emulator.write('Do you want to proceed?\r\n');
    emulator.write('❯ 1. Yes\r\n  2. No, tell Claude what to do differently (esc)\r\n');
    // Bytes stopped flowing; blocker should win regardless of prior activity.
    expect(await classify(emulator, monitor, 5000)).toBe('blocked');
  });

  it('classifies cursor-agent frames: working spinner -> approval prompt -> idle composer', async () => {
    const emulator = new TerminalStateEmulator(60, 14);
    const monitor = new AgentStatusMonitor({
      workingActivityWindowMs: 600,
      workingToIdleHoldMs: 700,
      startupGraceMs: 3000,
    });
    monitor.register('p', 0);

    // Real cursor-agent 2026.08.11 sequences: OSC 0 title + spinner status line.
    emulator.write('\x1b]0;Cursor Agent\x07');
    emulator.write(' \x1b[38;2;21;21;21m▄▄▄▄▄▄▄▄\x1b[39m\r\n');
    emulator.write('  → Add a follow-up          ctrl+c to stop\r\n');
    emulator.write(' \x1b[38;2;21;21;21m▀▀▀▀▀▀▀▀\x1b[39m\r\n');
    emulator.write(' ⠘⠤ Working  410 tokens\r\n');
    monitor.noteActivity('p', 4000);
    expect(await classify(emulator, monitor, 4010, CURSOR_MANIFEST)).toBe('working');

    emulator.write('\x1b[2J\x1b[H');
    emulator.write('  $ rm -f probe.txt Waiting for approval...\r\n');
    emulator.write('────────────────────────────────────────\r\n');
    emulator.write(' $  rm -f probe.txt in .\r\n Run this command?\r\n Not in allowlist: rm\r\n');
    emulator.write('  → Run (once) (y)\r\n    Skip & tell the agent what to do instead (esc or n)\r\n');
    expect(await classify(emulator, monitor, 5000, CURSOR_MANIFEST)).toBe('blocked');

    emulator.write('\x1b[2J\x1b[H');
    emulator.write('  Deleted probe.txt.\r\n');
    emulator.write(' ▄▄▄▄▄▄▄▄\r\n  → Add a follow-up\r\n ▀▀▀▀▀▀▀▀\r\n  /repo | Gemini 3.5 Flash\r\n');
    expect(await classify(emulator, monitor, 9000, CURSOR_MANIFEST)).toBe('idle');
  });
});
