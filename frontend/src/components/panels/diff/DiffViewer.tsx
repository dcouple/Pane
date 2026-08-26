import { memo, useRef } from 'react';
import { FileText } from 'lucide-react';
import type { DiffViewerProps, FileDiff } from '../../../types/diff';
import { cn } from '../../../utils/cn';
import { useScrollSurface } from '../../../hooks/useScrollSurface';

interface FileRowProps {
  file: FileDiff;
  isActive: boolean;
  onOpen: (file: FileDiff, pin: boolean) => void;
}

/** One changed file. Single-click previews its diff in a center tab; double-click pins it. */
const FileRow = memo<FileRowProps>(({ file, isActive, onOpen }) => (
  <div
    className={cn(
      'group relative flex h-8 items-center justify-between gap-2 pl-4 pr-3',
      isActive ? 'bg-surface-selected' : 'hover:bg-surface-hover',
    )}
  >
    <button
      type="button"
      aria-label={`Open diff for ${file.path}`}
      aria-current={isActive ? 'true' : undefined}
      onClick={() => onOpen(file, false)}
      onDoubleClick={() => onOpen(file, true)}
      className="absolute inset-0 z-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
    />
    <div className="relative z-10 pointer-events-none flex min-w-0 items-center gap-2">
      <FileText className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
      <span className="min-w-0 truncate text-[13px] text-text-primary">{file.path}</span>
      {file.type === 'deleted' && (
        <span className="flex-shrink-0 rounded bg-status-error px-1.5 py-0.5 text-[10px] text-text-on-status-error">Deleted</span>
      )}
      {file.type === 'added' && (
        <span className="flex-shrink-0 rounded bg-status-success px-1.5 py-0.5 text-[10px] text-text-on-status-success">New</span>
      )}
      {file.type === 'renamed' && (
        <span className="flex-shrink-0 text-xs text-text-tertiary">from {file.oldPath}</span>
      )}
    </div>
    <div className="relative z-10 pointer-events-none flex flex-shrink-0 items-center gap-1 text-xs tabular-nums">
      {file.additions > 0 && <span className="font-semibold text-status-success">+{file.additions}</span>}
      {file.deletions > 0 && <span className="font-semibold text-status-error">-{file.deletions}</span>}
    </div>
  </div>
));

FileRow.displayName = 'FileRow';

/** The Review panel's changed-file list. Diffs open as center tabs, not inline. */
const DiffViewer = memo<DiffViewerProps>(({ files, className = '', sessionId, activePath, onFileOpen }) => {
  const viewerRef = useRef<HTMLDivElement>(null);
  const registerScrollSurface = useScrollSurface<HTMLDivElement>({
    id: `diff:${sessionId ?? 'unscoped'}`,
    sessionId,
    priority: 90,
    ownerElement: () => viewerRef.current,
  });

  if (files.length === 0) {
    return (
      <div className={`p-4 text-text-secondary text-center ${className}`}>
        No changes to display
      </div>
    );
  }

  return (
    <div ref={viewerRef} className={`diff-viewer flex h-full flex-col ${className}`}>
      <div className="flex h-8 flex-shrink-0 items-center px-4 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary bg-surface-secondary border-b border-border-primary">
        {files.length} {files.length === 1 ? 'file' : 'files'} changed
      </div>
      <div ref={registerScrollSurface} tabIndex={-1} className="flex-1 overflow-auto py-1">
        {files.map((file, index) => (
          <FileRow
            key={`${file.path}-${index}`}
            file={file}
            isActive={file.path === activePath}
            onOpen={onFileOpen}
          />
        ))}
      </div>
    </div>
  );
});

DiffViewer.displayName = 'DiffViewer';

export default DiffViewer;
