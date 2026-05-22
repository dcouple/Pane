import type { IpcMain } from 'electron';
import type { VoiceTranscriptionRequest } from '../../../shared/types/voiceTranscription';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { VoiceTranscriptionService } from '../services/voiceTranscriptionService';
import type { AppServices } from './types';

const DAEMON_VOICE_CHANNELS = [
  'voice:transcribe',
] as const;

export function registerVoiceHandlers(
  ipcMain: IpcMain,
  { analyticsManager, configManager }: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const voiceTranscriptionService = new VoiceTranscriptionService(configManager, analyticsManager);

  commandRegistry.register('voice:transcribe', async (request: VoiceTranscriptionRequest) => (
    voiceTranscriptionService.transcribe(request)
  ));

  commandRegistry.bindChannels(ipcMain, DAEMON_VOICE_CHANNELS);
}
