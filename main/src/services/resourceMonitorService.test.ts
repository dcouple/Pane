import { describe, expect, it } from 'vitest';
import { ResourceMonitorService } from './resourceMonitorService';

describe('ResourceMonitorService', () => {
  it('returns no Electron metrics when initialized without an app', () => {
    const service = new ResourceMonitorService();
    service.initialize();

    expect((service as { getElectronMetrics(): unknown[] }).getElectronMetrics()).toEqual([]);
  });
});
