import type { GitCommitFileChange, GitFileChangeStatus } from '../../../shared/types/git';

interface NumstatEntry {
  oldPath: string;
  path: string;
  additions: number | null;
  deletions: number | null;
  isBinary: boolean;
}

interface NameStatusEntry {
  oldPath: string;
  path: string;
  status: GitFileChangeStatus;
  similarity?: number;
}

/** Split NUL-delimited Git output without altering repository-controlled paths. */
export function splitNulSeparated(raw: string): string[] {
  return raw.split('\0').filter(entry => entry.length > 0);
}

/** Parse `--numstat -z`, including rename records and binary markers. */
export function parseNumstatZ(raw: string): NumstatEntry[] {
  const tokens = raw.split('\0');
  const entries: NumstatEntry[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index++];
    if (!token) continue;

    const firstTab = token.indexOf('\t');
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;

    const addRaw = token.slice(0, firstTab);
    const deleteRaw = token.slice(firstTab + 1, secondTab);
    const pathField = token.slice(secondTab + 1);
    const oldPath = pathField || tokens[index++] || '';
    const path = pathField || tokens[index++] || oldPath;
    const isBinary = addRaw === '-' || deleteRaw === '-';

    entries.push({
      oldPath,
      path,
      additions: isBinary ? null : Number.parseInt(addRaw, 10) || 0,
      deletions: isBinary ? null : Number.parseInt(deleteRaw, 10) || 0,
      isBinary,
    });
  }

  return entries;
}

function toFileChangeStatus(code: string): GitFileChangeStatus {
  switch (code) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'typechange';
    case 'U': return 'unmerged';
    default: return 'unknown';
  }
}

/** Parse `--name-status -z`, retaining rename and copy similarity. */
export function parseNameStatusZ(raw: string): NameStatusEntry[] {
  const tokens = raw.split('\0');
  const entries: NameStatusEntry[] = [];
  let index = 0;

  while (index < tokens.length) {
    const statusToken = tokens[index++];
    if (!statusToken) continue;

    const code = statusToken[0];
    const status = toFileChangeStatus(code);
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[index++] ?? '';
      const path = tokens[index++] || oldPath;
      if (!oldPath && !path) continue;
      const similarity = Number.parseInt(statusToken.slice(1), 10);
      entries.push({ oldPath, path, status });
      if (!Number.isNaN(similarity)) entries.at(-1)!.similarity = similarity;
      continue;
    }

    const path = tokens[index++] ?? '';
    if (path) entries.push({ oldPath: path, path, status });
  }

  return entries;
}

/** Combine Git counts and status records by their post-change path. */
export function mergeFileChanges(
  numstat: NumstatEntry[],
  nameStatus: NameStatusEntry[],
): GitCommitFileChange[] {
  const statusByPath = new Map(nameStatus.map(entry => [entry.path, entry]));
  return numstat.map(entry => {
    const match = statusByPath.get(entry.path);
    const file: GitCommitFileChange = {
      path: entry.path,
      oldPath: match?.oldPath || entry.oldPath || entry.path,
      status: match?.status ?? 'modified',
      additions: entry.additions,
      deletions: entry.deletions,
      isBinary: entry.isBinary,
    };
    if (match?.similarity !== undefined) file.similarity = match.similarity;
    return file;
  });
}

/** Read untracked paths from `git status --porcelain -z`. */
export function parseUntrackedPathsZ(raw: string): string[] {
  const tokens = raw.split('\0');
  const paths: string[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index++];
    if (!token || token.length < 4) continue;
    const code = token.slice(0, 2);
    if (code[0] === 'R' || code[0] === 'C') index++;
    if (code === '??') paths.push(token.slice(3));
  }

  return paths;
}
