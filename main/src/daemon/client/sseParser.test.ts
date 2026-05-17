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

  it('preserves UTF-8 characters split across buffer boundaries', () => {
    const parser = new PaneSseParser();
    const message = 'hello 🙂';
    const encoded = Buffer.from(`event: ready\ndata: ${message}\n\n`, 'utf8');
    const splitIndex = encoded.indexOf(Buffer.from('🙂')) + 2;

    expect(parser.push(encoded.subarray(0, splitIndex))).toEqual([]);
    expect(parser.push(encoded.subarray(splitIndex))).toEqual([{
      event: 'ready',
      data: message,
    }]);
  });

  it('ignores comments and blank events', () => {
    const parser = new PaneSseParser();

    expect(parser.push(': keep-alive\n\n')).toEqual([]);
    expect(parser.push('event: ready\n\n')).toEqual([]);
  });
});
