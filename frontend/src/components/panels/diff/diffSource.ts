import type { DiffHighlighter } from '@git-diff-view/shiki';
import { getDiffViewHighlighter } from '@git-diff-view/shiki';

let shikiPromise: Promise<DiffHighlighter> | null = null;

export function getShikiHighlighter(): Promise<DiffHighlighter> {
  if (!shikiPromise) shikiPromise = getDiffViewHighlighter();
  return shikiPromise;
}
