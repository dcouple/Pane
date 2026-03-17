import { useState, useEffect, useMemo, memo, forwardRef, useImperativeHandle, useRef, useCallback } from 'react';
import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import type { DiffHighlighter } from '@git-diff-view/shiki';
import { getDiffViewHighlighter } from '@git-diff-view/shiki';
import { FileText, ChevronRight, ChevronDown, ExternalLink, ChevronsUpDown, ChevronsDownUp } from 'lucide-react';
import type { DiffViewerProps, FileDiff } from '../../../types/diff';
import { useTheme } from '../../../contexts/ThemeContext';
import "@git-diff-view/react/styles/diff-view.css";

// --- Shiki singleton ---
let shikiPromise: Promise<DiffHighlighter> | null = null;

function getShikiHighlighter(): Promise<DiffHighlighter> {
  if (!shikiPromise) {
    shikiPromise = getDiffViewHighlighter();
  }
  return shikiPromise;
}

// --- FileAccordion ---

interface FileAccordionProps {
  file: FileDiff;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  viewType: DiffModeEnum;
  isDarkMode: boolean;
  highlighter: DiffHighlighter | null;
  onOpenInEditor?: (filePath: string) => void;
}

const FileAccordion = memo<FileAccordionProps>(({
  file,
  index,
  isExpanded,
  onToggle,
  viewType,
  isDarkMode,
  highlighter,
  onOpenInEditor,
}) => {
  const hasHunks = file.rawDiff.includes('@@');
  const diffData = useMemo(() => {
    if (!isExpanded || file.isBinary || !hasHunks) return null;
    return {
      oldFile: { fileName: file.oldPath || file.path },
      newFile: { fileName: file.path },
      hunks: [file.rawDiff],
    };
  }, [isExpanded, file, hasHunks]);

  return (
    <div id={`file-${index}`} className="border-b border-border-primary">
      {/* Clickable header */}
      <div
        className="group px-4 py-2.5 bg-surface-secondary hover:bg-surface-hover cursor-pointer transition-colors flex items-center justify-between"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isExpanded
            ? <ChevronDown className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
            : <ChevronRight className="w-4 h-4 flex-shrink-0 text-text-tertiary" />}
          <FileText className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
          <span className="text-sm font-medium text-text-primary truncate">{file.path}</span>
          {file.type === 'deleted' && (
            <span className="text-xs bg-status-error text-white px-1.5 py-0.5 rounded flex-shrink-0">Deleted</span>
          )}
          {file.type === 'added' && (
            <span className="text-xs bg-status-success text-white px-1.5 py-0.5 rounded flex-shrink-0">New</span>
          )}
          {file.type === 'renamed' && (
            <span className="text-xs text-text-tertiary flex-shrink-0">
              from {file.oldPath}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {file.additions > 0 && (
            <span className="text-xs text-status-success font-semibold">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="text-xs text-status-error font-semibold">-{file.deletions}</span>
          )}
          {file.type !== 'deleted' && onOpenInEditor ? (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenInEditor(file.path); }}
              title="Open in Editor"
              className="p-1 rounded hover:bg-surface-hover opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <ExternalLink className="w-3.5 h-3.5 text-text-tertiary" />
            </button>
          ) : onOpenInEditor ? (
            <div className="p-1"><div className="w-3.5 h-3.5" /></div>
          ) : null}
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-border-primary">
          {file.isBinary ? (
            <div className="p-4 text-text-secondary text-sm">Binary file</div>
          ) : diffData && diffData.hunks.length > 0 ? (
            <DiffView
              data={diffData}
              diffViewMode={viewType}
              diffViewTheme={isDarkMode ? 'dark' : 'light'}
              diffViewHighlight={!!highlighter}
              registerHighlighter={highlighter ?? undefined}
              diffViewWrap={true}
              diffViewFontSize={13}
            />
          ) : (
            <div className="p-4 text-text-tertiary text-sm">
              {file.type === 'renamed' ? 'File renamed (no content changes)' : 'No content changes'}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

FileAccordion.displayName = 'FileAccordion';

// --- DiffViewer ---

export interface DiffViewerHandle {
  scrollToFile: (index: number) => void;
}

const DiffViewer = memo(forwardRef<DiffViewerHandle, DiffViewerProps>(({ files, className = '', onOpenInEditor }, ref) => {
  const { theme } = useTheme();
  const isDarkMode = theme !== 'light';
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(new Set());
  const [highlighter, setHighlighter] = useState<DiffHighlighter | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevFingerprintRef = useRef<string>('');

  const [viewType, setViewType] = useState<DiffModeEnum>(() => {
    const saved = localStorage.getItem('diffViewType');
    return saved === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified;
  });

  // Initialize Shiki once
  useEffect(() => {
    getShikiHighlighter().then(setHighlighter);
  }, []);

  const handleViewTypeChange = useCallback((mode: DiffModeEnum) => {
    setViewType(mode);
    localStorage.setItem('diffViewType', mode === DiffModeEnum.Split ? 'split' : 'inline');
  }, []);

  const toggleFile = useCallback((index: number) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpandedFiles(new Set(files.map((_, i) => i)));
  }, [files]);

  const collapseAll = useCallback(() => {
    setExpandedFiles(new Set());
  }, []);

  // Reset expanded files only when the actual file list changes (not just the array reference).
  // Expand all files by default.
  const fingerprint = useMemo(() => files.map(f => f.path).join('\0'), [files]);
  useEffect(() => {
    if (fingerprint !== prevFingerprintRef.current) {
      prevFingerprintRef.current = fingerprint;
      setExpandedFiles(new Set());
    }
  }, [fingerprint, files.length]);

  // Expose scrollToFile to parent
  useImperativeHandle(ref, () => ({
    scrollToFile: (index: number) => {
      // Expand the file if collapsed
      if (!expandedFiles.has(index)) {
        setExpandedFiles(prev => new Set([...prev, index]));
      }
      // Scroll after a tick so the DOM updates
      setTimeout(() => {
        const el = scrollContainerRef.current?.querySelector(`#file-${index}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 3);
    }
  }), [expandedFiles]);

  if (files.length === 0) {
    return (
      <div className={`p-4 text-text-secondary text-center ${className}`}>
        No changes to display
      </div>
    );
  }

  return (
    <div className={`diff-viewer ${className}`} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="flex justify-between items-center px-4 py-2 flex-shrink-0 bg-surface-secondary border-b border-border-primary">
        <span className="text-sm text-text-secondary">
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5">
            <button
              onClick={expandAll}
              title="Expand all files"
              className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
            >
              <ChevronsUpDown className="w-4 h-4" />
            </button>
            <button
              onClick={collapseAll}
              title="Collapse all files"
              className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
            >
              <ChevronsDownUp className="w-4 h-4" />
            </button>
          </div>
        <div className="inline-flex rounded-lg border border-border-primary bg-surface-primary">
          <button
            onClick={() => handleViewTypeChange(DiffModeEnum.Unified)}
            className={`px-3 py-1 text-sm font-medium rounded-l-lg transition-colors ${
              viewType === DiffModeEnum.Unified
                ? 'bg-interactive text-white'
                : 'text-text-secondary hover:bg-surface-hover'
            }`}
          >
            Unified
          </button>
          <button
            onClick={() => handleViewTypeChange(DiffModeEnum.Split)}
            className={`px-3 py-1 text-sm font-medium rounded-r-lg transition-colors ${
              viewType === DiffModeEnum.Split
                ? 'bg-interactive text-white'
                : 'text-text-secondary hover:bg-surface-hover'
            }`}
          >
            Split
          </button>
        </div>
        </div>
      </div>

      {/* File list */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto">
        {files.map((file, index) => (
          <FileAccordion
            key={`${file.path}-${index}`}
            file={file}
            index={index}
            isExpanded={expandedFiles.has(index)}
            onToggle={() => toggleFile(index)}
            viewType={viewType}
            isDarkMode={isDarkMode}
            highlighter={highlighter}
            onOpenInEditor={onOpenInEditor}
          />
        ))}
      </div>
    </div>
  );
}));

DiffViewer.displayName = 'DiffViewer';

export default DiffViewer;
