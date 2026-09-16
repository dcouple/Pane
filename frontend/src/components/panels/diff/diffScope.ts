import type { DiffScope, ChangedFileSummary } from '../../../../../shared/types/gitDiff';
import type { EditorDiffRef, LegacyEditorDiffRef } from '../../../../../shared/types/panels';

export function scopeKey(scope: DiffScope): string {
  switch (scope.kind) {
    case 'session': case 'working-tree': return scope.kind;
    case 'commit': return `commit:${scope.hash}`;
    case 'commit-range': return `range:${scope.olderHash}:${scope.newerHash}`;
    case 'working-tree-range': return `working-range:${scope.baseHash}`;
  }
}

export const sameScope = (left: DiffScope, right: DiffScope): boolean => scopeKey(left) === scopeKey(right);
export const isMutableScope = (scope: DiffScope): boolean => scope.kind === 'session' || scope.kind === 'working-tree' || scope.kind === 'working-tree-range';
const short = (hash: string): string => hash.slice(0, 7);

export function scopeLabel(scope: DiffScope, context?: { ref?: string; message?: string }): string {
  switch (scope.kind) {
    case 'session': return context?.ref ? `All changes · vs ${context.ref}` : 'All changes';
    case 'commit': return `Commit ${short(scope.hash)}${context?.message ? ` · ${context.message}` : ''}`;
    case 'working-tree': return 'Uncommitted changes';
    case 'commit-range': return `Commits ${short(scope.olderHash)}…${short(scope.newerHash)}`;
    case 'working-tree-range': return `Commit ${short(scope.baseHash)} → working tree`;
  }
}

export function editorDiffRefForFile(scope: DiffScope, file: ChangedFileSummary): EditorDiffRef {
  // Omit previousPath entirely for non-renames: an explicit `undefined` survives the
  // structured-clone IPC boundary and the main process rejects it as a non-JSON value.
  return file.previousPath ? { kind: 'scope', scope, previousPath: file.previousPath } : { kind: 'scope', scope };
}

export function normalizeEditorDiffRef(ref: EditorDiffRef | LegacyEditorDiffRef): { scope: DiffScope; previousPath?: string } | null {
  if (ref.kind === 'scope') return { scope: ref.scope, previousPath: ref.previousPath };
  if (ref.kind === 'commit') return { scope: ref.hash === 'index' ? { kind: 'working-tree' } : { kind: 'commit', hash: ref.hash } };
  if (ref.executionIds?.length === 1 && ref.executionIds[0] === 0) return { scope: { kind: 'working-tree' } };
  return null;
}

export function diffRefLabel(ref: EditorDiffRef): string {
  const normalized = normalizeEditorDiffRef(ref);
  if (!normalized) return 'Legacy diff';
  const scope = normalized.scope;
  switch (scope.kind) {
    case 'session': return 'All changes';
    case 'commit': return short(scope.hash);
    case 'working-tree': return 'Working Tree';
    case 'commit-range': return `Commits ${short(scope.olderHash)}…${short(scope.newerHash)}`;
    case 'working-tree-range': return `${short(scope.baseHash)} → working tree`;
  }
}

export function sameDiffRef(left: EditorDiffRef | undefined, right: EditorDiffRef | undefined): boolean {
  if (!left || !right) return left === right;
  const a = normalizeEditorDiffRef(left);
  const b = normalizeEditorDiffRef(right);
  return Boolean(a && b && sameScope(a.scope, b.scope) && a.previousPath === b.previousPath);
}
