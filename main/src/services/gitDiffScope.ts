import {
  EMPTY_TREE_HASH,
  type ChangedFileSummary,
  type ChangeKind,
  type DiffScope,
  type ResolvedDiffEndpoint,
} from '../../../shared/types/gitDiff';

export interface ResolvedScope {
  base: ResolvedDiffEndpoint;
  target: ResolvedDiffEndpoint;
}

export interface ScopeResolutionDependencies {
  revParse(ref: string): Promise<string>;
  parents(hash: string): Promise<string[]>;
  emptyTree(): Promise<string>;
  mergeBase(ref: string, target: string): Promise<string | null>;
  comparisonBase(): Promise<string>;
}

const commitEndpoint = (hash: string): ResolvedDiffEndpoint => ({ kind: 'commit', hash });

async function parentOrEmpty(hash: string, deps: ScopeResolutionDependencies): Promise<ResolvedDiffEndpoint> {
  const parents = await deps.parents(hash);
  if (parents[0]) return commitEndpoint(parents[0]);
  const emptyTreeHash = hash.length === EMPTY_TREE_HASH.length ? EMPTY_TREE_HASH : await deps.emptyTree();
  return { kind: 'empty-tree', hash: emptyTreeHash };
}

export async function resolveScope(scope: DiffScope, deps: ScopeResolutionDependencies): Promise<ResolvedScope> {
  switch (scope.kind) {
    case 'session': {
      const ref = await deps.comparisonBase();
      const hash = await deps.mergeBase(ref, 'HEAD') ?? await deps.revParse(`${ref}^{commit}`);
      return {
        base: { kind: 'comparison-base', ref, hash },
        target: { kind: 'working-tree', hash: await deps.revParse('HEAD') },
      };
    }
    case 'commit': {
      const hash = await deps.revParse(`${scope.hash}^{commit}`);
      return { base: await parentOrEmpty(hash, deps), target: commitEndpoint(hash) };
    }
    case 'working-tree':
      return { base: commitEndpoint(await deps.revParse('HEAD')), target: { kind: 'working-tree' } };
    case 'commit-range': {
      const older = await deps.revParse(`${scope.olderHash}^{commit}`);
      const newer = await deps.revParse(`${scope.newerHash}^{commit}`);
      return { base: await parentOrEmpty(older, deps), target: commitEndpoint(newer) };
    }
    case 'working-tree-range':
      return {
        base: commitEndpoint(await deps.revParse(`${scope.baseHash}^{commit}`)),
        target: { kind: 'working-tree' },
      };
  }
}

export interface NameStatusRecord {
  status: string;
  path: string;
  previousPath?: string;
}

export interface NumstatRecord {
  path: string;
  previousPath?: string;
  additions: number | null;
  deletions: number | null;
}

const nulParts = (value: string): string[] => value.split('\0').filter((part, index, all) => part.length > 0 || index < all.length - 1);

export function parseNameStatusZ(output: string): NameStatusRecord[] {
  const parts = nulParts(output);
  const records: NameStatusRecord[] = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    const isPair = status.startsWith('R') || status.startsWith('C');
    if (isPair) {
      const previousPath = parts[index++];
      const path = parts[index++];
      if (path !== undefined && previousPath !== undefined) records.push({ status, path, previousPath });
    } else {
      const path = parts[index++];
      if (path !== undefined) records.push({ status, path });
    }
  }
  return records;
}

export function parseNumstatZ(output: string): NumstatRecord[] {
  const parts = nulParts(output);
  const records: NumstatRecord[] = [];
  for (let index = 0; index < parts.length;) {
    const header = parts[index++];
    const firstTab = header.indexOf('\t');
    const secondTab = header.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = header.slice(0, firstTab);
    const deleted = header.slice(firstTab + 1, secondTab);
    const inlinePath = header.slice(secondTab + 1);
    const counts = {
      additions: added === '-' ? null : Number.parseInt(added, 10),
      deletions: deleted === '-' ? null : Number.parseInt(deleted, 10),
    };
    if (inlinePath.length > 0) {
      records.push({ path: inlinePath, ...counts });
    } else {
      const previousPath = parts[index++];
      const path = parts[index++];
      if (path !== undefined && previousPath !== undefined) records.push({ path, previousPath, ...counts });
    }
  }
  return records;
}

const hasOnlyCharactersBetween = (value: string, lower: string, upper: string): boolean =>
  [...value].every(character => character >= lower && character <= upper);

const isHexObjectId = (value: string): boolean => value.length >= 40 && [...value].every(character => {
  const lower = character.toLowerCase();
  return (character >= '0' && character <= '9') || (lower >= 'a' && lower <= 'f');
});

export function parseUnmergedFilesZ(output: string): string[] {
  const unmerged = new Set<string>();
  for (const record of nulParts(output)) {
    const separator = record.indexOf('\t');
    if (separator < 0) continue;
    const fields = record.slice(0, separator).split(' ');
    if (fields.length !== 3) continue;
    const [mode, objectId, stage] = fields;
    if (mode.length !== 6 || !hasOnlyCharactersBetween(mode, '0', '7')) continue;
    if (!isHexObjectId(objectId) || (stage !== '1' && stage !== '2' && stage !== '3')) continue;
    unmerged.add(record.slice(separator + 1));
  }
  return [...unmerged];
}

export function changeKindFromStatus(status: string): ChangeKind {
  switch (status[0]) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type-changed';
    case 'U': return 'unmerged';
    default: return 'modified';
  }
}

const recordKey = (path: string, previousPath?: string): string => `${previousPath ?? ''}\0${path}`;

const mergeCount = (left: number | null, right: number | null): number | null =>
  left === null || right === null ? null : left + right;

const kindPriority = (kind: ChangeKind): number => {
  if (kind === 'unmerged') return 3;
  if (kind === 'renamed' || kind === 'copied') return 2;
  return 1;
};

export function mergeSummaries(
  names: NameStatusRecord[],
  stats: NumstatRecord[],
  untracked: string[],
): ChangedFileSummary[] {
  const statsByPath = new Map<string, NumstatRecord>();
  for (const stat of stats) {
    const key = recordKey(stat.path, stat.previousPath);
    const current = statsByPath.get(key);
    statsByPath.set(key, current ? {
      ...current,
      additions: mergeCount(current.additions, stat.additions),
      deletions: mergeCount(current.deletions, stat.deletions),
    } : stat);
  }
  const consumedStats = new Set<string>();
  const filesByPath = new Map<string, ChangedFileSummary>();
  for (const record of names) {
    const key = recordKey(record.path, record.previousPath);
    const stat = consumedStats.has(key) ? undefined : statsByPath.get(key);
    consumedStats.add(key);
    const candidate: ChangedFileSummary = {
      path: record.path,
      previousPath: record.previousPath,
      kind: changeKindFromStatus(record.status),
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
      isBinary: stat?.additions === null && stat?.deletions === null,
    };
    const current = filesByPath.get(record.path);
    if (!current) {
      filesByPath.set(record.path, candidate);
      continue;
    }
    const preferred = kindPriority(candidate.kind) > kindPriority(current.kind) ? candidate : current;
    const secondary = preferred === candidate ? current : candidate;
    const isBinary = preferred.isBinary || secondary.isBinary;
    filesByPath.set(record.path, {
      ...preferred,
      additions: isBinary ? null : preferred.additions ?? secondary.additions,
      deletions: isBinary ? null : preferred.deletions ?? secondary.deletions,
      isBinary,
    });
  }
  const files = [...filesByPath.values()];
  for (const path of untracked) {
    if (!files.some(file => file.path === path)) {
      files.push({ path, kind: 'added', additions: null, deletions: null, isBinary: false });
    }
  }
  return files;
}
