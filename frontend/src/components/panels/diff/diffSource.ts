import type { EditorDiffRef } from '../../../../../shared/types/panels';
import type { DiffHighlighter } from '@git-diff-view/shiki';
import { getDiffViewHighlighter } from '@git-diff-view/shiki';
import { API } from '../../../utils/api';
import type { FileDiff, GitDiffResult } from '../../../types/diff';

/** Split a unified diff into per-file chunks (shared by the Review list and diff tabs). */
export function parseUnifiedDiffToFiles(diff: string): FileDiff[] {
  if (!diff?.trim()) return [];

  const fileChunks = diff.match(/diff --git[\s\S]*?(?=diff --git|$)/g);
  if (!fileChunks) return [];

  return fileChunks.flatMap(chunk => {
    const nameMatch = chunk.match(/diff --git a\/(.*?) b\/(.*?)(?:\n|$)/);
    if (!nameMatch) return [];
    const oldPath = nameMatch[1];
    const newPath = nameMatch[2];
    const isBinary = chunk.includes('Binary files') || chunk.includes('GIT binary patch');

    let type: FileDiff['type'] = 'modified';
    if (chunk.includes('new file mode')) type = 'added';
    else if (chunk.includes('deleted file mode')) type = 'deleted';
    else if (chunk.includes('rename from') && chunk.includes('rename to')) type = 'renamed';

    const additions = (chunk.match(/^\+(?!\+\+)/gm) || []).length;
    const deletions = (chunk.match(/^-(?!--)/gm) || []).length;

    return [{ path: newPath || oldPath, oldPath, type, isBinary, additions, deletions, rawDiff: chunk }];
  });
}

/** Fetch the diff a ref points at, using the same channels as the Review panel. */
export async function loadDiffForRef(sessionId: string, ref: EditorDiffRef): Promise<GitDiffResult> {
  const response = ref.kind === 'commit'
    ? await API.sessions.getCommitDiffByHash(sessionId, ref.hash)
    : await API.sessions.getCombinedDiff(sessionId, ref.executionIds);
  if (!response.success || !response.data) {
    throw new Error(response.error || 'Failed to load diff');
  }
  return response.data;
}

export function isWorkingTreeRef(ref: EditorDiffRef): boolean {
  return ref.kind === 'commit' ? ref.hash === 'index' : ref.executionIds?.length === 1 && ref.executionIds[0] === 0;
}

/** Short label for a diff tab title: "(Working Tree)", "(abc1234)", "(Changes)". */
export function diffRefLabel(ref: EditorDiffRef): string {
  if (isWorkingTreeRef(ref)) return 'Working Tree';
  if (ref.kind === 'commit') return ref.hash.slice(0, 7);
  return 'Changes';
}

export function sameDiffRef(a: EditorDiffRef | undefined, b: EditorDiffRef | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'commit' && b.kind === 'commit') return a.hash === b.hash;
  if (a.kind === 'range' && b.kind === 'range') {
    return JSON.stringify(a.executionIds ?? null) === JSON.stringify(b.executionIds ?? null);
  }
  return false;
}

// --- Shiki singleton (shared by every diff surface) ---
let shikiPromise: Promise<DiffHighlighter> | null = null;

export function getShikiHighlighter(): Promise<DiffHighlighter> {
  if (!shikiPromise) {
    shikiPromise = getDiffViewHighlighter();
  }
  return shikiPromise;
}
