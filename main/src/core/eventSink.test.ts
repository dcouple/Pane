import { describe, expect, it, vi } from 'vitest';
import { createFanoutEventSink, noopPaneEventSink, type PaneEventSink } from './eventSink';

describe('PaneEventSink', () => {
  it('noopPaneEventSink ignores sends', () => {
    expect(() => noopPaneEventSink.send('session:created', { id: 'session-1' })).not.toThrow();
  });

  it('fans out channel payloads to every sink', () => {
    const sinkA = { send: vi.fn() } satisfies PaneEventSink;
    const sinkB = { send: vi.fn() } satisfies PaneEventSink;

    const sink = createFanoutEventSink([sinkA, sinkB]);
    const payload = { id: 'panel-1' };

    sink.send('panel:created', payload, 'extra');

    expect(sinkA.send).toHaveBeenCalledWith('panel:created', payload, 'extra');
    expect(sinkB.send).toHaveBeenCalledWith('panel:created', payload, 'extra');
  });

  it('continues delivering after one sink throws', () => {
    const failingSink = {
      send: vi.fn(() => {
        throw new Error('sink failed');
      }),
    } satisfies PaneEventSink;
    const healthySink = { send: vi.fn() } satisfies PaneEventSink;

    const sink = createFanoutEventSink([failingSink, healthySink]);

    expect(() => sink.send('terminal:output', { panelId: 'panel-1' })).toThrow('sink failed');
    expect(healthySink.send).toHaveBeenCalledWith('terminal:output', { panelId: 'panel-1' });
  });
});
