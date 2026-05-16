import { StringDecoder } from 'string_decoder';
import { isPaneDaemonFrame, type PaneDaemonFrame } from '../../../shared/types/daemon';

const FRAME_DELIMITER = '\n';

export function encodePaneDaemonFrame(frame: PaneDaemonFrame): string {
  return `${JSON.stringify(frame)}${FRAME_DELIMITER}`;
}

export class PaneDaemonFrameDecoder {
  private buffer = '';
  private decoder = new StringDecoder('utf8');

  push(chunk: string | Buffer): PaneDaemonFrame[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);

    const frames: PaneDaemonFrame[] = [];
    let delimiterIndex = this.buffer.indexOf(FRAME_DELIMITER);

    while (delimiterIndex !== -1) {
      const rawFrame = this.buffer.slice(0, delimiterIndex);
      this.buffer = this.buffer.slice(delimiterIndex + FRAME_DELIMITER.length);

      if (rawFrame.trim().length > 0) {
        frames.push(this.parseFrame(rawFrame));
      }

      delimiterIndex = this.buffer.indexOf(FRAME_DELIMITER);
    }

    return frames;
  }

  finish(): void {
    this.buffer += this.decoder.end();

    if (this.buffer.trim().length > 0) {
      throw new Error('Incomplete Pane daemon frame at end of stream');
    }

    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }

  pendingBuffer(): string {
    return this.buffer;
  }

  private parseFrame(rawFrame: string): PaneDaemonFrame {
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawFrame) as unknown;
    } catch (error) {
      throw new Error(
        `Failed to parse Pane daemon frame: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!isPaneDaemonFrame(parsed)) {
      throw new Error('Failed to parse Pane daemon frame: frame does not match Pane daemon protocol');
    }

    return parsed;
  }
}
