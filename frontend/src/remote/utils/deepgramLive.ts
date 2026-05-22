import type { VoiceDeepgramStreamingMetadata } from '../../../../shared/types/voiceTranscription';

export const DEEPGRAM_STREAMING_KEYTERMS = [
  'Doozy',
  'Pane',
  'Dcouple',
  'Composio',
  'Anthropic',
  'Claude',
  'Claude Opus',
  'Claude Sonnet',
  'GPT',
  'GPT-5.5',
  'GPT-5.5 medium',
  'GPT-5.5 medium-high',
  'Gemini',
  'Gemini 3.1 Flash Lite',
  'Postgres',
  'PostgreSQL',
  'Supabase',
  'Next.js',
  'TypeScript',
  'JavaScript',
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'gRPC',
  'GraphQL',
  'OAuth',
  'JWT',
  'Kubernetes',
  'Cursor',
  'Aider',
  'Codex',
  'OpenRouter',
  'RAG',
  'embeddings',
  'BM25',
  'SWE-bench',
  'n8n',
  'Tailwind',
  'shadcn/ui',
];

export interface DeepgramTranscriptUpdate {
  transcript: string;
  isFinal: boolean;
  speechFinal: boolean;
}

export type DeepgramLiveMessage =
  | { type: 'transcript'; update: DeepgramTranscriptUpdate }
  | { type: 'metadata'; metadata: VoiceDeepgramStreamingMetadata }
  | { type: 'other' };

export function buildDeepgramListenUrl(keyterms = DEEPGRAM_STREAMING_KEYTERMS): string {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-3');
  url.searchParams.set('language', 'en-US');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('endpointing', '300');
  url.searchParams.set('vad_events', 'true');
  url.searchParams.set('tag', 'pane-pwa-voice');
  for (const term of keyterms) {
    url.searchParams.append('keyterm', term);
  }
  return url.toString();
}

export function parseDeepgramLiveMessage(data: string): DeepgramLiveMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return { type: 'other' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { type: 'other' };
  }

  const record = parsed as Record<string, unknown>;
  if (record.type === 'Results') {
    const transcript = readTranscript(record);
    if (!transcript) {
      return { type: 'other' };
    }
    return {
      type: 'transcript',
      update: {
        transcript,
        isFinal: record.is_final === true,
        speechFinal: record.speech_final === true,
      },
    };
  }

  if (record.type === 'Metadata') {
    return {
      type: 'metadata',
      metadata: {
        requestId: typeof record.request_id === 'string' ? record.request_id : undefined,
        duration: typeof record.duration === 'number' ? record.duration : undefined,
      },
    };
  }

  return { type: 'other' };
}

export function readResultsMetadata(data: string): VoiceDeepgramStreamingMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const metadata = (parsed as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }

  const record = metadata as Record<string, unknown>;
  const modelInfo = record.model_info && typeof record.model_info === 'object'
    ? record.model_info as Record<string, unknown>
    : undefined;
  return {
    requestId: typeof record.request_id === 'string' ? record.request_id : undefined,
    modelName: typeof modelInfo?.name === 'string' ? modelInfo.name : undefined,
    modelVersion: typeof modelInfo?.version === 'string' ? modelInfo.version : undefined,
  };
}

function readTranscript(record: Record<string, unknown>): string | null {
  const channel = record.channel;
  if (!channel || typeof channel !== 'object') {
    return null;
  }

  const alternatives = (channel as Record<string, unknown>).alternatives;
  if (!Array.isArray(alternatives)) {
    return null;
  }

  const first = alternatives[0];
  if (!first || typeof first !== 'object') {
    return null;
  }

  const transcript = (first as Record<string, unknown>).transcript;
  return typeof transcript === 'string' && transcript.trim()
    ? transcript.trim()
    : null;
}
