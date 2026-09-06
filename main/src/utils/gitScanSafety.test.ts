import { describe, expect, it } from 'vitest';
import { isHomeDirectory } from './gitScanSafety';

describe('home directory Git scan safeguard', () => {
  it('normalizes Windows casing, separators, trailing slashes and dot segments', () => {
    const home = 'C:\\Users\\Alice';
    for (const candidate of [home, 'c:/users/ALICE/', 'C:\\Users\\Alice\\repo\\..']) {
      expect(isHomeDirectory(candidate, home, 'win32')).toBe(true);
    }
    expect(isHomeDirectory('C:\\Users\\Alice\\repo', home, 'win32')).toBe(false);
    expect(isHomeDirectory('C:\\Users\\Alice-other', home, 'win32')).toBe(false);
  });

  it('preserves POSIX case sensitivity and allows project folders', () => {
    expect(isHomeDirectory('/home/alice/./', '/home/alice', 'linux')).toBe(true);
    expect(isHomeDirectory('/home/Alice', '/home/alice', 'linux')).toBe(false);
    expect(isHomeDirectory('/home/alice/repo', '/home/alice', 'linux')).toBe(false);
    expect(isHomeDirectory('', '/home/alice', 'linux')).toBe(false);
  });
});
