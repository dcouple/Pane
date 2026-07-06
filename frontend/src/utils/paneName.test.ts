import { describe, expect, it } from 'vitest';
import { generatePaneName, sanitizePaneName, type PaneNameBranchInfo } from './paneName';

function branch(overrides: Partial<PaneNameBranchInfo> & Pick<PaneNameBranchInfo, 'name'>): PaneNameBranchInfo {
  return {
    isCurrent: false,
    hasWorktree: false,
    isRemote: false,
    ...overrides,
  };
}

describe('paneName', () => {
  it('uses the branch name when it is available', () => {
    expect(generatePaneName('origin/feature-x', new Set(), [
      branch({ name: 'main', isCurrent: true }),
      branch({ name: 'origin/feature-x', isRemote: true }),
    ])).toBe('feature-x');
  });

  it('suffixes auto-filled main when local main is already checked out', () => {
    expect(generatePaneName('origin/main', new Set(), [
      branch({ name: 'main', isCurrent: true }),
      branch({ name: 'origin/main', isRemote: true }),
    ])).toBe('main-1');
  });

  it('skips suffixes that are already used by panes or checked-out branches', () => {
    expect(generatePaneName('origin/main', new Set(['main-1']), [
      branch({ name: 'main', isCurrent: true }),
      branch({ name: 'main-2', hasWorktree: true }),
      branch({ name: 'origin/main', isRemote: true }),
    ])).toBe('main-3');
  });

  it('does not reserve idle local branches that can be opened as worktrees', () => {
    expect(generatePaneName('feature-x', new Set(), [
      branch({ name: 'feature-x' }),
    ])).toBe('feature-x');
  });

  it('sanitizes names consistently', () => {
    expect(sanitizePaneName('../main?')).toBe('main');
  });
});
