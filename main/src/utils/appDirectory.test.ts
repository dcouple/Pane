import { describe, expect, it } from 'vitest';
import { getAppDirectoryOverrideFromArgs } from './appDirectory';

describe('appDirectory CLI parsing', () => {
  it('parses pane-dir in both supported forms', () => {
    expect(getAppDirectoryOverrideFromArgs(['--pane-dir=/tmp/pane-a'])).toBe('/tmp/pane-a');
    expect(getAppDirectoryOverrideFromArgs(['--pane-dir', '/tmp/pane-b'])).toBe('/tmp/pane-b');
  });

  it('accepts the deprecated foozol-dir flags for backward compatibility', () => {
    expect(getAppDirectoryOverrideFromArgs(['--foozol-dir=/tmp/pane-c'])).toBe('/tmp/pane-c');
    expect(getAppDirectoryOverrideFromArgs(['--foozol-dir', '/tmp/pane-d'])).toBe('/tmp/pane-d');
  });

  it('returns undefined when no override flag is provided', () => {
    expect(getAppDirectoryOverrideFromArgs(['--verbose'])).toBeUndefined();
  });
});
