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
      provider: 'fal-ai/wizper',
      cleanupModel: 'google/gemini-3.1-flash-lite',
      rawText: 'we should use type script with open router',
      text: 'We should use TypeScript with OpenRouter.',
      chunks: [{ text: 'we should use type script with open router', timestamp: [0, 2] }],
      languages: ['en'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(analyticsTrack).toHaveBeenCalledWith('voice_transcription_used', expect.objectContaining({
      provider: 'fal-ai/wizper',
      cleanup_model: 'google/gemini-3.1-flash-lite',
      language: 'en',
      mime_type: 'audio/webm',
      audio_duration_ms: 1_000,
      audio_seconds: 1,
      fal_cost: 0.0002,
      openrouter_cost: 0.00004,
      total_cost: 0.00024,
      openrouter_prompt_tokens: 321,
      openrouter_completion_tokens: 18,
      openrouter_total_tokens: 339,
      chunk_count: 1,
    }));
  });
});
