import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createTranscriptWatchers } from './usageManager';

class TestWatcher extends EventEmitter {
  async close(): Promise<void> {}
}

describe('createTranscriptWatchers', () => {
  it('watches roots before they exist and queues only JSONL files', () => {
    const createdPaths: string[] = [];
    const watchers: TestWatcher[] = [];
    const queueFile = vi.fn();

    createTranscriptWatchers(
      [
        { provider: 'claude', path: '/missing/.claude/projects', glob: '**/*.jsonl' },
        { provider: 'codex', path: '/missing/.codex/sessions', glob: '**/*.jsonl' },
        { provider: 'cursor', path: '/missing/.cursor/projects', glob: '**/agent-transcripts/**/*.jsonl' },
      ],
      path => {
        createdPaths.push(path);
        const watcher = new TestWatcher();
        watchers.push(watcher);
        return watcher;
      },
      queueFile,
    );

    expect(createdPaths).toEqual([
      '/missing/.claude/projects',
      '/missing/.codex/sessions',
      '/missing/.cursor/projects',
    ]);

    watchers[0].emit('add', '/missing/.claude/projects/session.jsonl');
    watchers[1].emit('change', '/missing/.codex/sessions/readme.txt');
    watchers[2].emit('add', '/missing/.cursor/projects/repo/other.jsonl');
    watchers[2].emit('add', '/missing/.cursor/projects/repo/agent-transcripts/78c0d50d-8589-46d8-b787-c38fc6f5c6a4/78c0d50d-8589-46d8-b787-c38fc6f5c6a4.jsonl');

    expect(queueFile).toHaveBeenCalledTimes(2);
    expect(queueFile).toHaveBeenCalledWith('/missing/.claude/projects/session.jsonl', 'claude');
    expect(queueFile).toHaveBeenCalledWith(
      '/missing/.cursor/projects/repo/agent-transcripts/78c0d50d-8589-46d8-b787-c38fc6f5c6a4/78c0d50d-8589-46d8-b787-c38fc6f5c6a4.jsonl',
      'cursor',
    );
  });
});
