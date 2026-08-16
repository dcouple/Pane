import { describe, expect, it } from 'vitest';
import {
  AGENT_LAUNCH_PRESETS,
  agentPresetsForPlatform,
  isAgentSupportedOnPlatform,
} from '../../../../shared/constants/agentLaunchPresets';
import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';

describe('AGENT_LAUNCH_PRESETS', () => {
  it('mirrors the RunPane contract agent templates exactly', () => {
    expect(AGENT_LAUNCH_PRESETS.map(p => p.id).sort()).toEqual([...RUNPANE_CONTRACT.enums.agents].sort());
    for (const preset of AGENT_LAUNCH_PRESETS) {
      const template = RUNPANE_CONTRACT.agentTemplates[preset.id];
      expect(preset.title, `${preset.id} title`).toBe(template.title);
      expect(preset.command, `${preset.id} command`).toBe(template.command);
    }
  });

  it('assigns unique, contiguous hotkey slots starting at mod+alt+3', () => {
    const slots = AGENT_LAUNCH_PRESETS.map(p => Number(p.hotkey.replace('mod+alt+', '')));
    expect(slots).toEqual(slots.map((_, i) => 3 + i));
    expect(new Set(AGENT_LAUNCH_PRESETS.map(p => p.hotkeyId)).size).toBe(AGENT_LAUNCH_PRESETS.length);
  });

  it('hides cursor on Windows and keeps it on macOS/Linux', () => {
    expect(agentPresetsForPlatform('win32').map(p => p.id)).toEqual(['claude', 'codex']);
    expect(agentPresetsForPlatform('darwin').map(p => p.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(agentPresetsForPlatform('linux').map(p => p.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(agentPresetsForPlatform('windows').map(p => p.id)).toEqual(['claude', 'codex']);
    expect(agentPresetsForPlatform('macos').map(p => p.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(agentPresetsForPlatform('wsl').map(p => p.id)).toEqual(['claude', 'codex']);
    expect(isAgentSupportedOnPlatform('cursor', 'windows')).toBe(false);
    expect(isAgentSupportedOnPlatform('cursor', 'wsl')).toBe(false);
  });
});
