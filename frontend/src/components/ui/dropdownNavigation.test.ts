import { describe, it, expect } from 'vitest';
import {
  firstEnabledIndex,
  nextEnabledIndex,
  initialActiveIndex,
  type NavigableItem,
} from './dropdownNavigation';

const items = (spec: Array<string | { id: string; disabled: boolean }>): NavigableItem[] =>
  spec.map((item) => (item instanceof Object ? item : { id: item }));

describe('firstEnabledIndex', () => {
  it('finds the first item of an all-enabled list', () => {
    expect(firstEnabledIndex(items(['a', 'b', 'c']))).toBe(0);
  });

  it('skips disabled items at the start', () => {
    const list = items([{ id: 'a', disabled: true }, 'b', 'c']);
    expect(firstEnabledIndex(list)).toBe(1);
  });

  it('returns -1 when nothing is enabled', () => {
    const list = items([{ id: 'a', disabled: true }, { id: 'b', disabled: true }]);
    expect(firstEnabledIndex(list)).toBe(-1);
    expect(firstEnabledIndex([])).toBe(-1);
  });
});

describe('nextEnabledIndex', () => {
  it('moves down and up by one', () => {
    const list = items(['a', 'b', 'c']);
    expect(nextEnabledIndex(list, 0, 1)).toBe(1);
    expect(nextEnabledIndex(list, 1, -1)).toBe(0);
  });

  it('wraps around both ends', () => {
    const list = items(['a', 'b', 'c']);
    expect(nextEnabledIndex(list, 2, 1)).toBe(0);
    expect(nextEnabledIndex(list, 0, -1)).toBe(2);
  });

  it('skips disabled items while moving', () => {
    const list = items(['a', { id: 'b', disabled: true }, 'c']);
    expect(nextEnabledIndex(list, 0, 1)).toBe(2);
    expect(nextEnabledIndex(list, 2, -1)).toBe(0);
  });

  it('skips a disabled item across the wrap boundary', () => {
    const list = items(['a', 'b', { id: 'c', disabled: true }]);
    expect(nextEnabledIndex(list, 1, 1)).toBe(0);
  });

  it('stays put when it is the only enabled item', () => {
    const list = items([{ id: 'a', disabled: true }, 'b', { id: 'c', disabled: true }]);
    expect(nextEnabledIndex(list, 1, 1)).toBe(1);
    expect(nextEnabledIndex(list, 1, -1)).toBe(1);
  });

  it('returns -1 when nothing is enabled', () => {
    const list = items([{ id: 'a', disabled: true }]);
    expect(nextEnabledIndex(list, 0, 1)).toBe(-1);
    expect(nextEnabledIndex([], 0, 1)).toBe(-1);
  });
});

describe('initialActiveIndex', () => {
  it('seeds the active item from the current selection', () => {
    const list = items(['a', 'b', 'c']);
    expect(initialActiveIndex(list, 'c')).toBe(2);
  });

  it('falls back to the first enabled item when nothing is selected', () => {
    const list = items([{ id: 'a', disabled: true }, 'b', 'c']);
    expect(initialActiveIndex(list, undefined)).toBe(1);
  });

  it('falls back when the selected id is missing or disabled', () => {
    const list = items(['a', { id: 'b', disabled: true }, 'c']);
    expect(initialActiveIndex(list, 'missing')).toBe(0);
    expect(initialActiveIndex(list, 'b')).toBe(0);
  });
});
