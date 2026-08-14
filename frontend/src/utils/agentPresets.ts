import { AGENT_LAUNCH_PRESETS, AgentLaunchPreset, agentPresetsForPlatform } from '../../../shared/constants/agentLaunchPresets';
import { isMac, isWindows } from './platformUtils';

export type { AgentLaunchPreset };
export { AGENT_LAUNCH_PRESETS };

export function visibleAgentPresets(): readonly AgentLaunchPreset[] {
  const platform = isWindows() ? 'win32' : isMac() ? 'darwin' : 'linux';
  return agentPresetsForPlatform(platform);
}
