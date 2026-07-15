import { describe, expect, it } from 'vitest';
import { TerminalStateEmulator } from './terminalStateEmulator';

describe('TerminalStateEmulator', () => {
  it('renders cursor-addressed alternate-screen output as a coherent screen', async () => {
    const emulator = new TerminalStateEmulator(20, 5);

    emulator.write('\x1b[?1049h\x1b[2J\x1b[HClaude\x1b[2;1Hanswer\rworking');
    await emulator.waitForIdle();

    expect(emulator.isAlternateScreen).toBe(true);
    expect(emulator.getScreenText()).toBe('Claude\nworking');
    const serialized = emulator.serializeForRestore();
    expect(serialized).toContain('\x1b[?1049h');

    const restored = new TerminalStateEmulator(20, 5);
    restored.write(serialized);
    await restored.waitForIdle();
    expect(restored.isAlternateScreen).toBe(true);
    expect(restored.getScreenText()).toBe('Claude\nworking');
    restored.dispose();
    emulator.dispose();
  });

  it('restores the normal screen after leaving the alternate buffer', async () => {
    const emulator = new TerminalStateEmulator(20, 5);

    emulator.write('shell prompt\r\n$ claude');
    emulator.write('\x1b[?1049h\x1b[Hagent response');
    await emulator.waitForIdle();
    expect(emulator.getScreenText()).toBe('agent response');

    emulator.write('\x1b[?1049l');
    await emulator.waitForIdle();

    expect(emulator.isAlternateScreen).toBe(false);
    expect(emulator.getScreenText()).toBe('shell prompt\n$ claude');
    emulator.dispose();
  });

  it('tracks terminal resizes', async () => {
    const emulator = new TerminalStateEmulator(10, 2);
    emulator.write('1234567890abc');
    await emulator.waitForIdle();

    emulator.resize(20, 2);
    expect(emulator.getScreenText()).toContain('1234567890');
    emulator.dispose();
  });

  it('includes active input modes in restore serialization', async () => {
    const emulator = new TerminalStateEmulator(20, 5);
    emulator.write('\x1b[?1h\x1b[?1004h\x1b[?2004h');
    await emulator.waitForIdle();

    const serialized = emulator.serializeForRestore();
    expect(serialized).toContain('\x1b[?1h');
    expect(serialized).toContain('\x1b[?1004h');
    expect(serialized).toContain('\x1b[?2004h');
    emulator.dispose();
  });
});
