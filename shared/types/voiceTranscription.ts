export type VoiceTranscriptionProvider = 'fal-ai/wizper';
export type VoiceTranscriptionCleanupModel = 'google/gemini-3.1-flash-lite';

export interface VoiceTranscriptionRequest {
  audioDataUrl: string;
  mimeType: string;
  durationMs?: number;
  language?: 'en';
}

export interface VoiceTranscriptionChunk {
  text: string;
  timestamp?: [number, number];
}

export interface VoiceTranscriptionTimings {
  falMs: number;
  cleanupMs: number;
  totalMs: number;
}

export interface VoiceTranscriptionResult {
  provider: VoiceTranscriptionProvider;
  cleanupModel: VoiceTranscriptionCleanupModel;
  text: string;
  rawText: string;
  chunks?: VoiceTranscriptionChunk[];
  languages?: string[];
  timings: VoiceTranscriptionTimings;
}
