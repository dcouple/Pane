import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
import type { AnalyticsManager } from './analyticsManager';
import { VoiceTranscriptionService } from './voiceTranscriptionService';

describe('VoiceTranscriptionService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts browser audio data URLs with MIME parameters', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);
      if (urlText.includes('/storage/upload/initiate')) {
        const body = JSON.parse(String(init?.body)) as { file_name?: string; content_type?: string };
        expect(body.content_type).toBe('audio/webm');
        expect(body.file_name).toMatch(/^pane-voice-\d+\.webm$/);
        return new Response(JSON.stringify({
          file_url: 'https://v3b.fal.media/files/test/pane-voice.webm',
          upload_url: 'https://v3b.fal.media/files/test/pane-voice.webm?upload=1',
        }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      }

      if (urlText.includes('v3b.fal.media')) {
        expect(init?.method).toBe('PUT');
        expect(init?.headers).toMatchObject({ 'Content-Type': 'audio/webm' });
        return new Response(null, { status: 200 });
      }

      if (urlText.includes('fal.run')) {
        const body = JSON.parse(String(init?.body)) as { audio_url?: string };
        expect(body.audio_url).toBe('https://v3b.fal.media/files/test/pane-voice.webm');
        return new Response(JSON.stringify({
          text: 'we should use type script with open router',
          chunks: [{ text: 'we should use type script with open router', timestamp: [0, 2] }],
          languages: ['en'],
          metadata: { cost_usd: 0.0002 },
        }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      }

      expect(urlText).toContain('openrouter.ai');
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role: string; content: string }>;
      };
      expect(body.messages?.[0]?.content).toContain('GPT-5.5');
      expect(body.messages?.[0]?.content).toContain('medium-high');
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: 'We should use TypeScript with OpenRouter.',
          },
        }],
        usage: {
          prompt_tokens: 321,
          completion_tokens: 18,
          total_tokens: 339,
          cost: 0.00004,
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const analyticsTrack = vi.fn();

    const service = new VoiceTranscriptionService({
      getConfig: () => ({
        falApiKey: 'fal-test-key',
        openRouterApiKey: 'openrouter-test-key',
      }),
      isVerbose: () => false,
    } as ConfigManager, {
      track: analyticsTrack,
      categorizeDuration: (seconds: number) => `${seconds}s`,
      categorizeNumber: (value: number) => `${value} bytes`,
    } as unknown as AnalyticsManager);

    await expect(service.transcribe({
      audioDataUrl: 'data:audio/webm;codecs=opus;base64,AAAA',
      mimeType: 'audio/webm;codecs=opus',
      durationMs: 1_000,
      language: 'en',
    })).resolves.toMatchObject({
      mode: 'recorded',
      provider: 'fal-ai/wizper',
      cleanupModel: 'google/gemini-3.1-flash-lite',
      rawText: 'we should use type script with open router',
      text: 'We should use TypeScript with OpenRouter.',
      chunks: [{ text: 'we should use type script with open router', timestamp: [0, 2] }],
      languages: ['en'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(analyticsTrack).toHaveBeenCalledWith('voice_transcription_used', expect.objectContaining({
      mode: 'recorded',
      provider: 'fal-ai/wizper',
      asr_provider: 'fal-ai/wizper',
      cleanup_model: 'google/gemini-3.1-flash-lite',
      language: 'en',
      mime_type: 'audio/webm',
      audio_duration_ms: 1_000,
      audio_seconds: 1,
      asr_ms: expect.any(Number),
      fal_cost: 0.0002,
      provider_cost: 0.0002,
      provider_cost_source: 'provider',
      openrouter_cost: 0.00004,
      total_cost: 0.00024,
      openrouter_prompt_tokens: 321,
      openrouter_completion_tokens: 18,
      openrouter_total_tokens: 339,
      chunk_count: 1,
    }));
  });

  it('grants temporary Deepgram streaming tokens without exposing the configured API key', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.deepgram.com/v1/auth/grant');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: 'Token deepgram-test-key' });
      return new Response(JSON.stringify({
        access_token: 'temporary-jwt',
        expires_in: 30,
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = new VoiceTranscriptionService({
      getConfig: () => ({
        deepgramApiKey: 'deepgram-test-key',
      }),
      isVerbose: () => false,
    } as ConfigManager);

    await expect(service.getDeepgramStreamingToken()).resolves.toMatchObject({
      accessToken: 'temporary-jwt',
      expiresIn: 30,
      expiresAt: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires a Deepgram API key before granting streaming tokens', async () => {
    const service = new VoiceTranscriptionService({
      getConfig: () => ({}),
      isVerbose: () => false,
    } as ConfigManager);

    await expect(service.getDeepgramStreamingToken()).rejects.toThrow('Deepgram API key is not configured');
  });

  it('finalizes streaming transcripts through OpenRouter cleanup and tracks Deepgram metadata', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('openrouter.ai');
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role: string; content: string }>;
      };
      expect(body.messages?.[0]?.content).toContain('GPT-5.5');
      expect(body.messages?.[1]?.content).toBe('i use gpt five point five medium high with claude opus');
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: 'I use GPT-5.5 medium-high with Claude Opus.',
          },
        }],
        usage: {
          prompt_tokens: 111,
          completion_tokens: 12,
          total_tokens: 123,
          cost: 0.00002,
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const analyticsTrack = vi.fn();

    const service = new VoiceTranscriptionService({
      getConfig: () => ({
        openRouterApiKey: 'openrouter-test-key',
      }),
      isVerbose: () => false,
    } as ConfigManager, {
      track: analyticsTrack,
      categorizeDuration: (seconds: number) => `${seconds}s`,
      categorizeNumber: (value: number) => `${value} bytes`,
    } as unknown as AnalyticsManager);

    await expect(service.finalizeStreaming({
      rawText: 'i use gpt five point five medium high with claude opus',
      durationMs: 2_000,
      language: 'en',
      timings: {
        asrMs: 1_200,
        firstTranscriptMs: 350,
      },
      metadata: {
        requestId: 'dg-request-1',
        duration: 2,
        modelName: 'nova-3',
        modelVersion: '2026-01-01',
      },
    })).resolves.toMatchObject({
      mode: 'streaming',
      provider: 'deepgram/nova-3',
      cleanupModel: 'google/gemini-3.1-flash-lite',
      rawText: 'i use gpt five point five medium high with claude opus',
      text: 'I use GPT-5.5 medium-high with Claude Opus.',
      languages: ['en-US'],
      timings: {
        asrMs: 1_200,
        firstTranscriptMs: 350,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(analyticsTrack).toHaveBeenCalledWith('voice_transcription_used', expect.objectContaining({
      mode: 'streaming',
      provider: 'deepgram/nova-3',
      asr_provider: 'deepgram/nova-3',
      language: 'en-US',
      audio_duration_ms: 2_000,
      audio_seconds: 2,
      asr_ms: 1_200,
      deepgram_ms: 1_200,
      time_to_first_transcript_ms: 350,
      deepgram_cost: expect.any(Number),
      deepgram_cost_source: 'estimate',
      provider_cost_source: 'estimate',
      deepgram_request_id: 'dg-request-1',
      deepgram_duration_seconds: 2,
      deepgram_model_name: 'nova-3',
      deepgram_model_version: '2026-01-01',
      openrouter_cost: 0.00002,
      openrouter_prompt_tokens: 111,
      openrouter_completion_tokens: 12,
      openrouter_total_tokens: 123,
    }));
  });
});
