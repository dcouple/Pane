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
        { provider: 'claude', path: '/missing/.claude/projects' },
        { provider: 'codex', path: '/missing/.codex/sessions' },
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
    ]);

    watchers[0].emit('add', '/missing/.claude/projects/session.jsonl');
    watchers[1].emit('change', '/missing/.codex/sessions/readme.txt');

    expect(queueFile).toHaveBeenCalledOnce();
    expect(queueFile).toHaveBeenCalledWith('/missing/.claude/projects/session.jsonl', 'claude');
  });
});
