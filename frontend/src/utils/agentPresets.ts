import { AgentLaunchPreset, agentPresetsForPlatform } from '../../../shared/constants/agentLaunchPresets';
import type { ProjectEnvironment } from '../../../shared/types/panels';
import { isMac, isWindows } from './platformUtils';

export type { AgentLaunchPreset };

export function visibleAgentPresets(projectEnvironment?: ProjectEnvironment): readonly AgentLaunchPreset[] {
  const platform = isWindows()
    ? projectEnvironment === 'wsl' ? 'wsl' : 'win32'
    : isMac() ? 'darwin' : 'linux';
  return agentPresetsForPlatform(platform);
}
