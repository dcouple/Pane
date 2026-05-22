import type { IpcMain } from 'electron';
import type {
  VoiceStreamingFinalizeRequest,
  VoiceTranscriptionRequest,
} from '../../../shared/types/voiceTranscription';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { VoiceTranscriptionService } from '../services/voiceTranscriptionService';
import type { AppServices } from './types';

const DAEMON_VOICE_CHANNELS = [
  'voice:transcribe',
  'voice:deepgram-token',
  'voice:finalize-streaming',
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
  commandRegistry.register('voice:deepgram-token', async () => (
    voiceTranscriptionService.getDeepgramStreamingToken()
  ));
  commandRegistry.register('voice:finalize-streaming', async (request: VoiceStreamingFinalizeRequest) => (
    voiceTranscriptionService.finalizeStreaming(request)
  ));

  commandRegistry.bindChannels(ipcMain, DAEMON_VOICE_CHANNELS);
}
