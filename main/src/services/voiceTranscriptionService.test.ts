import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
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
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = new VoiceTranscriptionService({
      getConfig: () => ({
        falApiKey: 'fal-test-key',
        openRouterApiKey: 'openrouter-test-key',
      }),
    } as ConfigManager);

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
  });
});
