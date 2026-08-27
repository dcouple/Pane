/**
 * IPC reads for a center editor tab: file bodies (text or a blob URL for
 * images/PDFs) and the per-file git status badge.
 */
import { fileExtension, IMAGE_EXTENSIONS, PDF_EXTENSIONS } from './fileKinds';

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

export type GitFileStatus = 'clean' | 'modified' | 'untracked';

export type EditorFileContent =
  | { kind: 'text'; content: string }
  | { kind: 'binary'; blobUrl: string }
  | { kind: 'error'; message: string };

export function isBinaryPath(filePath: string): boolean {
  const ext = fileExtension(filePath);
  return IMAGE_EXTENSIONS.has(ext) || PDF_EXTENSIONS.has(ext);
}

function binaryMimeType(ext: string): string {
  if (!IMAGE_EXTENSIONS.has(ext)) return 'application/pdf';
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'ico') return 'image/x-icon';
  return `image/${ext}`;
}

export async function readEditorFile(sessionId: string, filePath: string): Promise<EditorFileContent> {
  if (isBinaryPath(filePath)) {
    const result = await window.electronAPI.invoke('file:read-binary', { sessionId, filePath });
    if (!result.success || !result.contentBase64) {
      return { kind: 'error', message: result.error || 'Failed to load binary file' };
    }
    const byteChars = atob(result.contentBase64);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
    const blob = new Blob([byteArray], { type: binaryMimeType(fileExtension(filePath)) });
    return { kind: 'binary', blobUrl: URL.createObjectURL(blob) };
  }

  const result = await window.electronAPI.invoke('file:read', { sessionId, filePath });
  if (!result.success) return { kind: 'error', message: result.error };
  return { kind: 'text', content: result.content };
}

export async function fetchGitFileStatus(sessionId: string, filePath: string): Promise<GitFileStatus | null> {
  const result: { success: boolean; data?: { status: GitFileStatus } } =
    await window.electronAPI.invoke('git:file-status', sessionId, filePath);
  return result.success && result.data ? result.data.status : null;
}
