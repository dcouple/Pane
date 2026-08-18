import { describe, expect, it } from 'vitest';
import { ResourceMonitorService, parseWslEnvironScan } from './resourceMonitorService';

interface ResourceMonitorTestAccess {
  getElectronMetrics(): unknown[];
}

describe('ResourceMonitorService', () => {
  it('returns no Electron metrics when initialized without an app', () => {
    const service = new ResourceMonitorService();
    service.initialize();

    // SAFETY: The assertion exposes one private pure query solely to verify the no-app initialization path.
    expect((service as ResourceMonitorTestAccess).getElectronMetrics()).toEqual([]);
  });
});

describe('parseWslEnvironScan', () => {
  it('parses well-formed scan lines', () => {
    const stdout = 'sess-1|412|7|524288|node\nsess-1|413|0|1024|bash\nsess-2|99|3661|2048|claude\n';

    expect(parseWslEnvironScan(stdout)).toEqual([
      { sessionId: 'sess-1', pid: 412, name: 'node', cpuTimeSeconds: 7, memoryMB: 512 },
      { sessionId: 'sess-1', pid: 413, name: 'bash', cpuTimeSeconds: 0, memoryMB: 1 },
      { sessionId: 'sess-2', pid: 99, name: 'claude', cpuTimeSeconds: 3661, memoryMB: 2 },
    ]);
  });

  it('keeps pipes inside comm by joining trailing fields', () => {
    const samples = parseWslEnvironScan('sess-1|10|1|1024|odd|comm|name\n');

    expect(samples).toHaveLength(1);
    expect(samples[0].name).toBe('odd|comm|name');
  });

  it('skips malformed, partial, and empty lines', () => {
    const stdout = [
      '',
      '   ',
      'not-a-scan-line',
      'sess-1|abc|7|1024|node',
      'sess-1|10|x|1024|node',
      'sess-1|10|7|y|node',
      '|10|7|1024|node',
      'sess-1|10|7|1024',
      'sess-1|11|7|2048|node',
    ].join('\n');

    expect(parseWslEnvironScan(stdout)).toEqual([
      { sessionId: 'sess-1', pid: 11, name: 'node', cpuTimeSeconds: 7, memoryMB: 2 },
    ]);
  });

  it('falls back to unknown when comm is empty', () => {
    const samples = parseWslEnvironScan('sess-1|10|7|1024|\n');

    expect(samples).toEqual([
      { sessionId: 'sess-1', pid: 10, name: 'unknown', cpuTimeSeconds: 7, memoryMB: 1 },
    ]);
  });
});
