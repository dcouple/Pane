import { StringDecoder } from 'string_decoder';

export interface ParsedSseEvent {
  event: string;
  data: string;
}

export class PaneSseParser {
  private buffer = '';
  private decoder = new StringDecoder('utf8');

  push(chunk: Buffer | string): ParsedSseEvent[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const events: ParsedSseEvent[] = [];
    let boundaryIndex = this.buffer.indexOf('\n\n');
    while (boundaryIndex !== -1) {
      const rawEvent = this.buffer.slice(0, boundaryIndex);
      this.buffer = this.buffer.slice(boundaryIndex + 2);

      const parsedEvent = parseSseEvent(rawEvent);
      if (parsedEvent) {
        events.push(parsedEvent);
      }

      boundaryIndex = this.buffer.indexOf('\n\n');
    }

    return events;
  }

  reset(): void {
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }
}

function parseSseEvent(rawEvent: string): ParsedSseEvent | null {
  const lines = rawEvent.split('\n');
  let eventName = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) {
      continue;
    }

    const separatorIndex = line.indexOf(':');
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    let value = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'event') {
      eventName = value || 'message';
      continue;
    }

    if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event: eventName,
    data: dataLines.join('\n'),
  };
}
