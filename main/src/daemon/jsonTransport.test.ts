import { describe, expect, it } from 'vitest';
import { boundary } from '../../../shared/validation/boundaryDecoder';
import { serializeJsonTransport } from './jsonTransport';

describe('serializeJsonTransport', () => {
  it('matches JSON semantics for dates and omitted object properties', () => {
    const value = serializeJsonTransport({
      omitted: undefined,
      timestamp: new Date('2026-08-17T00:00:00.000Z'),
    }, boundary.jsonObject);

    expect(value).toEqual({
      timestamp: '2026-08-17T00:00:00.000Z',
    });
  });

  it('matches JSON semantics for undefined array entries', () => {
    expect(serializeJsonTransport(['value', undefined], boundary.array(boundary.json)))
      .toEqual(['value', null]);
  });
});
