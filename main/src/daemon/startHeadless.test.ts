import { describe, expect, it, vi } from 'vitest';
import { startHeadlessHost } from './startHeadless';

describe('startHeadlessHost', () => {
  it('starts transcript indexing after the daemon host is ready', async () => {
    const callOrder: string[] = [];
    const host = { shutdown: vi.fn() };

    const result = await startHeadlessHost(
      async () => {
        callOrder.push('host');
        return host;
      },
      {
        async start() {
          callOrder.push('usage');
        },
      },
    );

    expect(result).toBe(host);
    expect(callOrder).toEqual(['host', 'usage']);
  });
});
