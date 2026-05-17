import { describe, expect, it } from 'vitest';
import { PaneSseParser } from './sseParser';

describe('PaneSseParser', () => {
  it('parses named SSE events with JSON payloads', () => {
    const parser = new PaneSseParser();

    expect(parser.push('event: daemon-event\ndata: {"channel":"session:created"}\n\n')).toEqual([{
      event: 'daemon-event',
      data: '{"channel":"session:created"}',
    }]);
  });

  it('joins multiline data fields with newlines', () => {
    const parser = new PaneSseParser();

    expect(parser.push('event: ready\ndata: line one\ndata: line two\n\n')).toEqual([{
      event: 'ready',
      data: 'line one\nline two',
    }]);
  });

  it('buffers partial chunks until an event boundary arrives', () => {
    const parser = new PaneSseParser();

    expect(parser.push('event: daemon-event\ndata: {"channel"')).toEqual([]);
    expect(parser.push(':"session:updated"}\n\n')).toEqual([{
      event: 'daemon-event',
      data: '{"channel":"session:updated"}',
    }]);
  });

  it('ignores comments and blank events', () => {
    const parser = new PaneSseParser();

    expect(parser.push(': keep-alive\n\n')).toEqual([]);
    expect(parser.push('event: ready\n\n')).toEqual([]);
  });
});
