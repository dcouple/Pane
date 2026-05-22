import type { ConfigManager } from './configManager';
import type { AnalyticsManager } from './analyticsManager';
import type {
  VoiceTranscriptionChunk,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from '../../../shared/types/voiceTranscription';

const FAL_WIZPER_ENDPOINT = 'https://fal.run/fal-ai/wizper';
const FAL_STORAGE_UPLOAD_INITIATE_ENDPOINT = 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';
const OPENROUTER_CHAT_COMPLETIONS_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const CLEANUP_MODEL = 'google/gemini-3.1-flash-lite' as const;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 60_000;
const MAX_PROVIDER_ERROR_LENGTH = 400;

const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/mpga',
  'audio/mp3',
  'audio/m4a',
  'audio/x-m4a',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
]);

const ASR_CLEANUP_PROMPT = `# ROLE

You are an automatic-speech-recognition (ASR) post-processor. You receive a raw transcript from a speech-to-text model and return a corrected version. You are NOT an assistant. You do NOT respond, summarize, or help. You have exactly one job: fix obvious ASR errors and return the corrected text. Nothing else.

# ABSOLUTE RULES

- Output ONLY the corrected transcript. No preamble, no explanation, no JSON, no markdown fences, no quotes around the output.
- NEVER add, remove, paraphrase, reorder, or summarize content. Same words, same order, same meaning.
- NEVER respond to the content. If the speaker asks a question, return the question. If the speaker requests code, return the request.
- If the input is empty or unintelligible, return it unchanged.

# WHAT TO FIX

1. Technical terms: restore correct spelling and casing. Treat the glossary below as authoritative.
2. Homophones: pick the version that fits the surrounding context.
3. Filler removal: drop "uh", "um", "uhh", "mm", "hmm", "you know", and "like" when used only as filler.
4. Capitalization: first word of every sentence, "I", proper nouns, brand names.
5. Punctuation: add natural punctuation based on speech rhythm. Do not over-punctuate.
6. Acronyms: uppercase known acronyms including API, SDK, LLM, REST, gRPC, SQL, JSON, YAML, CSV, URL, HTTP, HTTPS, AWS, GCP.
7. Internet slang: lowercase lol, lmao, btw, tbh, idk, imo, ftw.

# WHAT NOT TO TOUCH

- Word choice and phrasing. Preserve exactly as spoken, even if awkward.
- Contractions. Keep them as spoken.
- Style. Do not improve, shorten, or polish the text beyond ASR correction.
- Repetition. Keep intentional repetition.

# GLOSSARY

Kubernetes, Postgres, PostgreSQL, useState, useEffect, useMemo, useCallback, useRef, Next.js, Node.js, TypeScript, JavaScript, Tailwind, shadcn/ui, Supabase, Vercel, Anthropic, Claude, Sonnet, Opus, Haiku, GPT, Gemini, Gemini 3.1 Flash Lite, Composio, n8n, Cursor, Aider, Codex, Doozy, Pane, Dcouple, fal.ai, Wizper, OpenRouter, Groq, gRPC, GraphQL, OAuth, JWT, Redis, MongoDB, ClickHouse, DuckDB, BM25, RAG, embeddings, Cohere, SWE-bench, NIAH, Whisper, Parakeet, Deepgram

# OUTPUT

Return only the corrected transcript. Nothing before it, nothing after it.`;

interface ValidatedAudioInput {
  dataUrl: string;
  mimeType: string;
  byteLength: number;
  audioBuffer: Buffer;
}

interface FalWizperResponse {
  text?: unknown;
  chunks?: unknown;
  languages?: unknown;
  usage?: unknown;
  cost?: unknown;
  metadata?: unknown;
  metrics?: unknown;
}

interface FalStorageInitiateResponse {
  file_url?: unknown;
  upload_url?: unknown;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: unknown;
}

interface ProviderUsage {
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export class VoiceTranscriptionService {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly analyticsManager?: AnalyticsManager,
  ) {}

  async transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    const input = validateVoiceTranscriptionRequest(request);
    const falApiKey = this.getFalApiKey();
    const openRouterApiKey = this.getOpenRouterApiKey();
    if (!falApiKey) {
      throw new Error('Fal API key is not configured. Add it in Settings under Voice Transcription.');
    }
    if (!openRouterApiKey) {
      throw new Error('OpenRouter API key is not configured. Add it in Settings under Voice Transcription.');
    }

    const startedAt = Date.now();
    const raw = await this.transcribeWithFal(input, request.language ?? 'en', falApiKey);
    const cleanupStartedAt = Date.now();
    const cleanText = raw.text.trim().length > 0
      ? await this.cleanTranscript(raw.text, openRouterApiKey)
      : { text: raw.text };
    const completedAt = Date.now();

    const result: VoiceTranscriptionResult = {
      provider: 'fal-ai/wizper',
      cleanupModel: CLEANUP_MODEL,
      text: cleanText.text.trim(),
      rawText: raw.text,
      chunks: raw.chunks,
      languages: raw.languages,
      timings: {
        falMs: cleanupStartedAt - startedAt,
        cleanupMs: completedAt - cleanupStartedAt,
        totalMs: completedAt - startedAt,
      },
    };
    this.trackVoiceTranscriptionUsed({
      input,
      requestedDurationMs: request.durationMs,
      result,
      rawUsage: raw.usage,
      cleanupUsage: cleanText.usage,
    });
    return result;
  }

  private getFalApiKey(): string | undefined {
    return firstNonEmpty(this.configManager.getConfig().falApiKey, process.env.FAL_KEY);
  }

  private getOpenRouterApiKey(): string | undefined {
    return firstNonEmpty(this.configManager.getConfig().openRouterApiKey, process.env.OPENROUTER_API_KEY);
  }

  private async transcribeWithFal(
    input: ValidatedAudioInput,
    language: 'en',
    falApiKey: string,
  ): Promise<{ text: string; chunks?: VoiceTranscriptionChunk[]; languages?: string[]; usage?: ProviderUsage }> {
    const audioUrl = await this.uploadAudioToFalStorage(input, falApiKey);
    const response = await fetch(FAL_WIZPER_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Key ${falApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        task: 'transcribe',
        language,
        chunk_level: 'segment',
        max_segment_len: 29,
        merge_chunks: true,
        version: '3',
      }),
    });

    const payload = await readProviderJson<FalWizperResponse>(response, 'Fal Wizper transcription failed');
    if (typeof payload.text !== 'string') {
      throw new Error('Fal Wizper transcription response did not include text.');
    }

    return {
      text: payload.text,
      chunks: parseFalChunks(payload.chunks),
      languages: parseStringArray(payload.languages),
      usage: parseProviderUsage(payload),
    };
  }

  private async uploadAudioToFalStorage(input: ValidatedAudioInput, falApiKey: string): Promise<string> {
    const filename = `pane-voice-${Date.now()}.${getAudioFileExtension(input.mimeType)}`;
    const initiateResponse = await fetch(FAL_STORAGE_UPLOAD_INITIATE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Key ${falApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_name: filename,
        content_type: input.mimeType,
      }),
    });

    const initiatePayload = await readProviderJson<FalStorageInitiateResponse>(
      initiateResponse,
      'Fal audio upload initialization failed',
    );
    if (typeof initiatePayload.file_url !== 'string' || typeof initiatePayload.upload_url !== 'string') {
      throw new Error('Fal audio upload initialization response did not include upload URLs.');
    }

    const uploadResponse = await fetch(initiatePayload.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': input.mimeType,
      },
      body: new Blob([input.audioBuffer], { type: input.mimeType }),
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Fal audio upload failed: ${truncateProviderError(errorText || `HTTP ${uploadResponse.status}`)}`);
    }

    return initiatePayload.file_url;
  }

  private async cleanTranscript(
    rawTranscript: string,
    openRouterApiKey: string,
  ): Promise<{ text: string; usage?: ProviderUsage }> {
    const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://dcouple.ai',
        'X-Title': 'Pane Voice Transcription',
      },
      body: JSON.stringify({
        model: CLEANUP_MODEL,
        messages: [
          { role: 'system', content: ASR_CLEANUP_PROMPT },
          { role: 'user', content: rawTranscript },
        ],
        temperature: 0,
        reasoning: { enabled: false },
        max_tokens: calculateCleanupMaxTokens(rawTranscript),
      }),
    });

    const payload = await readProviderJson<OpenRouterResponse>(response, 'OpenRouter transcript cleanup failed');
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenRouter cleanup response did not include text.');
    }

    return {
      text: content.trim(),
      usage: parseProviderUsage(payload.usage),
    };
  }

  private trackVoiceTranscriptionUsed({
    input,
    requestedDurationMs,
    result,
    rawUsage,
    cleanupUsage,
  }: {
    input: ValidatedAudioInput;
    requestedDurationMs?: number;
    result: VoiceTranscriptionResult;
    rawUsage?: ProviderUsage;
    cleanupUsage?: ProviderUsage;
  }): void {
    if (!this.analyticsManager) {
      return;
    }

    try {
      const totalCost = sumDefinedNumbers(rawUsage?.cost, cleanupUsage?.cost);
      const audioDurationMs = typeof requestedDurationMs === 'number' ? Math.max(0, Math.round(requestedDurationMs)) : undefined;
      const audioSeconds = audioDurationMs !== undefined ? Math.round(audioDurationMs / 100) / 10 : undefined;
      this.analyticsManager.track('voice_transcription_used', {
        provider: result.provider,
        cleanup_model: result.cleanupModel,
        language: result.languages?.[0] ?? 'en',
        mime_type: input.mimeType,
        audio_duration_ms: audioDurationMs,
        audio_seconds: audioSeconds,
        audio_duration_bucket: audioSeconds !== undefined
          ? this.analyticsManager.categorizeDuration(audioSeconds)
          : undefined,
        audio_bytes: input.byteLength,
        audio_bytes_bucket: this.analyticsManager.categorizeNumber(input.byteLength, [
          100 * 1024,
          500 * 1024,
          1024 * 1024,
          5 * 1024 * 1024,
          10 * 1024 * 1024,
        ]),
        raw_transcript_chars: result.rawText.length,
        clean_transcript_chars: result.text.length,
        chunk_count: result.chunks?.length,
        fal_ms: result.timings.falMs,
        cleanup_ms: result.timings.cleanupMs,
        total_ms: result.timings.totalMs,
        fal_cost: rawUsage?.cost,
        openrouter_cost: cleanupUsage?.cost,
        total_cost: totalCost,
        openrouter_prompt_tokens: cleanupUsage?.inputTokens,
        openrouter_completion_tokens: cleanupUsage?.outputTokens,
        openrouter_total_tokens: cleanupUsage?.totalTokens,
      });
    } catch (error) {
      if (this.configManager.isVerbose()) {
        console.warn('[VoiceTranscription] Failed to track analytics event:', error);
      }
    }
  }
}

function validateVoiceTranscriptionRequest(request: VoiceTranscriptionRequest): ValidatedAudioInput {
  if (!request || typeof request !== 'object') {
    throw new Error('Voice transcription request is invalid.');
  }

  if (typeof request.audioDataUrl !== 'string' || request.audioDataUrl.trim().length === 0) {
    throw new Error('Voice transcription audio data is required.');
  }

  if (typeof request.mimeType !== 'string' || request.mimeType.trim().length === 0) {
    throw new Error('Voice transcription audio MIME type is required.');
  }

  if (request.durationMs !== undefined && request.durationMs > MAX_AUDIO_DURATION_MS + 1_000) {
    throw new Error('Recording is too long. Keep voice clips under 60 seconds.');
  }

  if (request.language !== undefined && request.language !== 'en') {
    throw new Error('Voice transcription currently supports English only.');
  }

  const match = request.audioDataUrl.match(/^data:([^,]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) {
    throw new Error('Voice transcription audio must be a base64 data URL.');
  }

  const dataUrlMimeType = normalizeMimeType(match[1]);
  const declaredMimeType = normalizeMimeType(request.mimeType);
  if (!SUPPORTED_AUDIO_MIME_TYPES.has(dataUrlMimeType) || !SUPPORTED_AUDIO_MIME_TYPES.has(declaredMimeType)) {
    throw new Error('Unsupported voice recording format. Use WebM, MP4, MP3, M4A, or WAV audio.');
  }

  const base64Payload = match[2].replace(/\s/g, '');
  const audioBuffer = Buffer.from(base64Payload, 'base64');
  const byteLength = audioBuffer.byteLength;
  if (byteLength === 0) {
    throw new Error('Voice recording was empty.');
  }
  if (byteLength > MAX_AUDIO_BYTES) {
    throw new Error('Recording is too large. Keep voice clips under 10 MB.');
  }

  return {
    dataUrl: `data:${dataUrlMimeType};base64,${base64Payload}`,
    mimeType: dataUrlMimeType,
    byteLength,
    audioBuffer,
  };
}

async function readProviderJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  let payload: unknown = null;
  const text = await response.text();
  if (text.trim().length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) {
        throw new Error(`${fallbackMessage}: HTTP ${response.status}`);
      }
      throw new Error(`${fallbackMessage}: invalid JSON response.`);
    }
  }

  if (!response.ok) {
    throw new Error(`${fallbackMessage}: ${extractProviderMessage(payload) ?? `HTTP ${response.status}`}`);
  }

  return (payload ?? {}) as T;
}

function extractProviderMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const candidates = [
    record.message,
    record.error,
    record.detail,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return truncateProviderError(candidate.trim());
    }
    if (candidate && typeof candidate === 'object') {
      const nested = candidate as Record<string, unknown>;
      if (typeof nested.message === 'string' && nested.message.trim()) {
        return truncateProviderError(nested.message.trim());
      }
    }
  }

  return truncateProviderError(JSON.stringify(payload));
}

function truncateProviderError(message: string): string {
  return message.length > MAX_PROVIDER_ERROR_LENGTH
    ? `${message.slice(0, MAX_PROVIDER_ERROR_LENGTH)}...`
    : message;
}

function parseFalChunks(value: unknown): VoiceTranscriptionChunk[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const chunks: VoiceTranscriptionChunk[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text !== 'string') {
      continue;
    }

    const timestamp = parseTimestamp(record.timestamp);
    chunks.push(timestamp ? { text: record.text, timestamp } : { text: record.text });
  }

  return chunks.length > 0 ? chunks : undefined;
}

function parseTimestamp(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }

  const [start, end] = value;
  return typeof start === 'number' && typeof end === 'number'
    ? [start, end]
    : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.filter((item): item is string => typeof item === 'string');
  return values.length > 0 ? values : undefined;
}

function parseProviderUsage(value: unknown): ProviderUsage | undefined {
  const values = collectUsageNumbers(value);
  const usage: ProviderUsage = {
    cost: firstDefinedNumber(
      values.cost,
      values.cost_usd,
      values.total_cost,
      values.total_cost_usd,
      values.upstream_inference_cost,
      values.upstream_inference_completions_cost,
    ),
    inputTokens: firstDefinedNumber(values.prompt_tokens, values.input_tokens),
    outputTokens: firstDefinedNumber(values.completion_tokens, values.output_tokens),
    totalTokens: firstDefinedNumber(values.total_tokens),
  };

  return Object.values(usage).some(item => item !== undefined) ? usage : undefined;
}

function collectUsageNumbers(value: unknown): Record<string, number> {
  const numbers: Record<string, number> = {};
  const seen = new Set<unknown>();
  const visit = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);

    for (const [key, nestedValue] of Object.entries(candidate as Record<string, unknown>)) {
      if (typeof nestedValue === 'number' && Number.isFinite(nestedValue)) {
        numbers[key] ??= nestedValue;
      } else if (typeof nestedValue === 'string' && nestedValue.trim() && Number.isFinite(Number(nestedValue))) {
        numbers[key] ??= Number(nestedValue);
      } else if (
        nestedValue
        && typeof nestedValue === 'object'
        && ['usage', 'cost', 'metadata', 'metrics'].includes(key)
      ) {
        visit(nestedValue);
      }
    }
  };

  visit(value);
  return numbers;
}

function firstDefinedNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function sumDefinedNumbers(...values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (numbers.length === 0) {
    return undefined;
  }
  return Number(numbers.reduce((sum, value) => sum + value, 0).toFixed(8));
}

function calculateCleanupMaxTokens(rawTranscript: string): number {
  return Math.min(8_192, Math.max(128, Math.ceil(rawTranscript.length / 2) + 256));
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function getAudioFileExtension(mimeType: string): string {
  switch (mimeType) {
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/mpeg':
    case 'audio/mpga':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/webm':
    default:
      return 'webm';
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
