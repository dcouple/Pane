/**
 * FileEditorView: the editor half of the old Explorer split. Renders one file
 * (Monaco, markdown/notebook preview, image or PDF) for a center `editor`
 * tab. The tree that opens files lives in the Files inspector (FileEditor).
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { File, Eye, Code } from 'lucide-react';
import { MonacoErrorBoundary } from '../../MonacoErrorBoundary';
import { isLightTheme, useTheme } from '../../../contexts/ThemeContext';
import { debounce } from '../../../utils/debounce';
import { MarkdownPreview } from '../../MarkdownPreview';
import { NotebookPreview } from './NotebookPreview';
import type { EditorPanelState } from '../../../../../shared/types/panels';
import { isHtmlFile } from './htmlFile';
import { previewHtmlFileInBrowser } from './previewHtmlFile';
import { getLanguageFromPath, IMAGE_EXTENSIONS, PDF_EXTENSIONS } from './fileKinds';

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FileEditorViewProps {
  sessionId: string;
  filePath: string;
  initialState?: EditorPanelState;
  onFileChange?: (filePath: string | undefined, isDirty: boolean) => void;
  onStateChange?: (state: Partial<EditorPanelState>) => void;
  /** Fired when the user edits or saves (⌘S) the file — pins preview tabs. */
  onUserEdit?: () => void;
}

export function FileEditorView({
  sessionId,
  filePath,
  initialState,
  onFileChange,
  onStateChange,
  onUserEdit,
}: FileEditorViewProps) {
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const selectedFilePathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedFilePathRef.current = selectedFile?.path ?? null;
  }, [selectedFile?.path]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [fileContent, setFileContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit');
  const [gitStatus, setGitStatus] = useState<'clean' | 'modified' | 'untracked'>('clean');
  const [binaryBlobUrl, setBinaryBlobUrl] = useState<string | null>(null);
  const binaryBlobUrlRef = useRef<string | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const pendingEditorFocusPathRef = useRef<string | null>(null);

  // Keep ref in sync and clean up blob URLs to prevent memory leaks
  useEffect(() => {
    binaryBlobUrlRef.current = binaryBlobUrl;
    return () => {
      if (binaryBlobUrl) URL.revokeObjectURL(binaryBlobUrl);
    };
  }, [binaryBlobUrl]);

  const { theme } = useTheme();
  const isDarkMode = !isLightTheme(theme);
  const hasUnsavedChanges = fileContent !== originalContent;

  const isMarkdownFile = useMemo(() => {
    if (!selectedFile) return false;
    const ext = selectedFile.path.split('.').pop()?.toLowerCase();
    return ext === 'md' || ext === 'markdown';
  }, [selectedFile]);

  // Check if this is a notebook file
  const isNotebookFile = useMemo(() => {
    if (!selectedFile) return false;
    const ext = selectedFile.path.split('.').pop()?.toLowerCase();
    return ext === 'ipynb';
  }, [selectedFile]);

  const isImageFile = useMemo(() => {
    if (!selectedFile) return false;
    const ext = selectedFile.path.split('.').pop()?.toLowerCase() || '';
    return IMAGE_EXTENSIONS.has(ext);
  }, [selectedFile]);

  const isPdfFile = useMemo(() => {
    if (!selectedFile) return false;
    const ext = selectedFile.path.split('.').pop()?.toLowerCase() || '';
    return PDF_EXTENSIONS.has(ext);
  }, [selectedFile]);

  const isBinaryPreview = isImageFile || isPdfFile;

  const previewHtmlFile = useCallback(async (path: string) => {
    setError(null);
    try {
      await previewHtmlFileInBrowser(sessionId, path);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Failed to preview HTML file');
    }
  }, [sessionId]);


  const loadFile = useCallback(async (file: FileItem | null) => {
    if (!file || file.isDirectory) return;

    setLoading(true);
    setError(null);
    setGitStatus('clean');
    try {
      // Binary file detection — render as image/PDF preview instead of Monaco
      const ext = file.path.split('.').pop()?.toLowerCase() || '';
      const isImage = IMAGE_EXTENSIONS.has(ext);
      const isPdf = PDF_EXTENSIONS.has(ext);

      if (isImage || isPdf) {
        const result = await window.electronAPI.invoke('file:read-binary', {
          sessionId,
          filePath: file.path,
        });
        if (result.success && result.contentBase64) {
          // Revoke previous blob URL via ref (avoids stale closure from useCallback)
          if (binaryBlobUrlRef.current) URL.revokeObjectURL(binaryBlobUrlRef.current);

          const mimeType = isImage
            ? `image/${ext === 'jpg' ? 'jpeg' : ext === 'ico' ? 'x-icon' : ext}`
            : 'application/pdf';
          const byteChars = atob(result.contentBase64);
          const byteArray = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) {
            byteArray[i] = byteChars.charCodeAt(i);
          }
          const blob = new Blob([byteArray], { type: mimeType });
          setBinaryBlobUrl(URL.createObjectURL(blob));
          setFileContent('');
          setOriginalContent('');
        } else {
          // Binary read failed — show error instead of blank/stale preview
          setBinaryBlobUrl(null);
          setError(result.error || 'Failed to load binary file');
        }
        setSelectedFile(file);
        setViewMode('edit');
        setLoading(false);
        onFileChange?.(file.path, false);
        onStateChange?.({ filePath: file.path });

        // Check git status for binary files too
        window.electronAPI.invoke('git:file-status', sessionId, file.path).then((statusResult: { success: boolean; data?: { status: 'clean' | 'modified' | 'untracked' } }) => {
          if (statusResult.success && statusResult.data) {
            setGitStatus(statusResult.data.status);
          }
        });
        return;
      }

      const result = await window.electronAPI.invoke('file:read', {
        sessionId,
        filePath: file.path
      });

      if (result.success) {
        setBinaryBlobUrl(null);
        setFileContent(result.content);
        setOriginalContent(result.content);
        setSelectedFile(file);
        setViewMode('edit'); // Reset to edit mode when opening a new file
        if (pendingEditorFocusPathRef.current === file.path) {
          window.setTimeout(() => editorRef.current?.focus(), 100);
        }
        
        // Notify parent about file change
        if (onFileChange) {
          onFileChange(file.path, false);
        }
        
        // After loading new file, we need to restore its position
        // This happens in handleEditorMount when editor re-renders
        // But we also need to tell parent the file path changed
        if (onStateChange) {
          onStateChange({ 
            filePath: file.path,
            isDirty: false 
          });
        }
        
        // If we have saved position for this file, restore it
        // The actual restoration happens in handleEditorMount
        // but we need to trigger a re-render with the right state
        if (editorRef.current && initialState?.filePath === file.path) {
          const monacoEditor = editorRef.current;
          
          // Restore cursor position
          if (initialState.cursorPosition && monacoEditor.setPosition) {
            const { line, column } = initialState.cursorPosition;
            setTimeout(() => {
              monacoEditor.setPosition({
                lineNumber: line,
                column: column
              });
              monacoEditor.revealPositionInCenter({
                lineNumber: line,
                column: column
              });
            }, 50);
          }
          
          // Restore scroll position
          if (initialState.scrollPosition !== undefined && monacoEditor.setScrollTop) {
            const scrollPos = initialState.scrollPosition;
            setTimeout(() => {
              monacoEditor.setScrollTop(scrollPos);
            }, 100);
          }
        }

        // Check git status for this file
        window.electronAPI.invoke('git:file-status', sessionId, file.path).then((statusResult: { success: boolean; data?: { status: 'clean' | 'modified' | 'untracked' } }) => {
          if (statusResult.success && statusResult.data) {
            setGitStatus(statusResult.data.status);
          }
        });
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      setLoading(false);
    }
  }, [sessionId, onFileChange, onStateChange, initialState, binaryBlobUrlRef]);

  const selectedFilePath = selectedFile?.path;

  useEffect(() => {
    if (!selectedFilePath || pendingEditorFocusPathRef.current !== selectedFilePath) return;
    const focusTimer = window.setTimeout(() => {
      editorRef.current?.focus();
      pendingEditorFocusPathRef.current = null;
    }, 100);
    return () => window.clearTimeout(focusTimer);
  }, [selectedFilePath]);


  const handleEditorMount = (editor: monaco.editor.IStandaloneCodeEditor, monacoInstance: typeof monaco) => {
    editorRef.current = editor;
    monacoRef.current = monacoInstance;
    
    // Now we have properly typed Monaco editor
    const monacoEditor = editor;
    
    // Track cursor position changes with debouncing
    const saveCursorPosition = debounce((position: { lineNumber: number; column: number }) => {
      if (onStateChange) {
        onStateChange({
          cursorPosition: {
            line: position.lineNumber,
            column: position.column
          }
        });
      }
    }, 500); // Debounce cursor position saves
    
    // Track scroll position changes with debouncing
    const saveScrollPosition = debounce((scrollTop: number) => {
      if (onStateChange) {
        onStateChange({
          scrollPosition: scrollTop
        });
      }
    }, 500); // Debounce scroll position saves
    
    // Listen for cursor position changes
    monacoEditor.onDidChangeCursorPosition?.((e: monaco.editor.ICursorPositionChangedEvent) => {
      saveCursorPosition(e.position);
    });
    
    // Listen for scroll position changes
    monacoEditor.onDidScrollChange?.((e: { scrollTop?: number; scrollLeft?: number }) => {
      if (e.scrollTop !== undefined) {
        saveScrollPosition(e.scrollTop);
      }
    });
    
    // Restore cursor and scroll position if available
    if (initialState?.cursorPosition && monacoEditor.setPosition) {
      const { line, column } = initialState.cursorPosition;
      setTimeout(() => {
        monacoEditor.setPosition({
          lineNumber: line,
          column: column
        });
        monacoEditor.revealPositionInCenter({
          lineNumber: line,
          column: column
        });
      }, 50); // Small delay to ensure editor is ready
    }
    
    if (initialState?.scrollPosition !== undefined && monacoEditor.setScrollTop) {
      // Delay to ensure editor is fully rendered and content is loaded
      const scrollPos = initialState.scrollPosition;
      setTimeout(() => {
        monacoEditor.setScrollTop(scrollPos);
      }, 100);
    }
  };

  // Auto-save functionality
  const pendingAutoSaveFilePathRef = useRef<string | null>(null);
  const autoSave = useMemo(
    () => debounce(async (file: FileItem, content: string) => {
      pendingAutoSaveFilePathRef.current = null;
      try {
        const result = await window.electronAPI.invoke('file:write', {
          sessionId,
          filePath: file.path,
          content,
        });
        
        if (result.success) {
          const isActiveFile = mountedRef.current && selectedFilePathRef.current === file.path;
          if (isActiveFile) {
            setOriginalContent(content);
            onFileChange?.(file.path, false);
            onStateChange?.({
              filePath: file.path,
              isDirty: false,
            });
          }

          // Re-check git status after save
          window.electronAPI.invoke('git:file-status', sessionId, file.path).then((statusResult: { success: boolean; data?: { status: 'clean' | 'modified' | 'untracked' } }) => {
            if (mountedRef.current && selectedFilePathRef.current === file.path && statusResult.success && statusResult.data) {
              setGitStatus(statusResult.data.status);
            }
          });
        } else if (mountedRef.current) {
          setError(result.error);
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to auto-save file');
        }
      }
    }, 1000), // Auto-save after 1 second of inactivity
    [sessionId, onFileChange, onStateChange]
  );

  useEffect(() => () => autoSave.flush(), [autoSave]);

  // ⌘S / Ctrl+S: write any pending edit now and pin the tab (VS Code pins
  // preview editors on save, whether or not anything changed).
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      autoSave.flush();
      onUserEdit?.();
    };
    container.addEventListener('keydown', handleKeyDown, true);
    return () => container.removeEventListener('keydown', handleKeyDown, true);
  }, [autoSave, onUserEdit]);

  const handleEditorChange = (value: string | undefined) => {
    const content = value || '';
    setFileContent(content);

    if (selectedFile && !selectedFile.isDirectory) {
      const isDirty = content !== originalContent;
      if (isDirty) onUserEdit?.();
      onFileChange?.(selectedFile.path, isDirty);
      if (isDirty) {
        if (pendingAutoSaveFilePathRef.current && pendingAutoSaveFilePathRef.current !== selectedFile.path) {
          autoSave.flush();
        }
        pendingAutoSaveFilePathRef.current = selectedFile.path;
        autoSave(selectedFile, content);
      } else if (pendingAutoSaveFilePathRef.current === selectedFile.path) {
        autoSave.cancel();
        pendingAutoSaveFilePathRef.current = null;
      }
    }
  };

  // Re-check git status when git operations complete (e.g. commit from diff panel or terminal)
  useEffect(() => {
    if (!selectedFile) return;
    const handlePanelEvent = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const { type } = event.detail || {};
      if (type === 'git:operation_completed' || type === 'diff:refreshed' || type === 'terminal:command_executed' || type === 'files:changed') {
        window.electronAPI.invoke('git:file-status', sessionId, selectedFile.path).then((statusResult: { success: boolean; data?: { status: 'clean' | 'modified' | 'untracked' } }) => {
          if (statusResult.success && statusResult.data) {
            setGitStatus(statusResult.data.status);
          }
        });
      }
    };
    window.addEventListener('panel:event', handlePanelEvent);
    return () => window.removeEventListener('panel:event', handlePanelEvent);
  }, [selectedFile, sessionId]);
  
  // Load the file this tab points at (and reload when it is re-targeted)
  useEffect(() => {
    if (selectedFile?.path === filePath) return;
    autoSave.flush();
    loadFile({ name: filePath.split('/').pop() || '', path: filePath, isDirectory: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // Terminal links / re-opens can ask for a specific position after mount
  useEffect(() => {
    const handleReveal = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const { cursorPosition, filePath: target } = event.detail || {};
      if (target !== filePath || !cursorPosition || !editorRef.current) return;
      editorRef.current.setPosition({ lineNumber: cursorPosition.line, column: cursorPosition.column });
      editorRef.current.revealPositionInCenter({ lineNumber: cursorPosition.line, column: cursorPosition.column });
      editorRef.current.focus();
    };
    window.addEventListener('editor-panel:reveal', handleReveal);
    return () => window.removeEventListener('editor-panel:reveal', handleReveal);
  }, [filePath]);

  // Dispose the Monaco model when the file changes or the tab unmounts
  useEffect(() => {
    return () => {
      try {
        editorRef.current?.getModel()?.dispose();
      } catch (cleanupError) {
        console.warn('[FileEditorView] Error during Monaco cleanup:', cleanupError);
      }
    };
  }, [selectedFile?.path]);

  return (
    <div ref={containerRef} className="h-full w-full min-w-0 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            <div className="flex items-center justify-between px-4 py-2 bg-surface-secondary border-b border-border-primary">
              <div className="flex min-w-0 items-center gap-2">
                {isHtmlFile(selectedFile.path) && (
                  <button
                    type="button"
                    onClick={() => previewHtmlFile(selectedFile.path)}
                    className="flex flex-shrink-0 items-center gap-1 rounded-lg border border-border-primary bg-surface-tertiary px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                    title="Preview file as HTML"
                    aria-label="Preview file as HTML"
                  >
                    <Eye className="w-3 h-3" />
                    Preview as HTML
                  </button>
                )}
                <File className="w-4 h-4 text-text-tertiary" />
                <span className="min-w-0 truncate text-sm text-text-primary">
                  {selectedFile.path}
                  {hasUnsavedChanges && <span className="text-status-warning ml-2">●</span>}
                </span>
                {gitStatus !== 'clean' && (
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                    gitStatus === 'untracked'
                      ? 'bg-status-success text-text-on-status-success'
                      : 'bg-interactive text-text-on-interactive'
                  }`}>
                    {gitStatus === 'untracked' ? 'U' : 'M'}
                  </span>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {/* Preview Toggle for Markdown/Notebook Files */}
                {!isBinaryPreview && (isMarkdownFile || isNotebookFile) && (
                  <div className="flex items-center rounded-lg border border-border-primary bg-surface-tertiary">
                    <button
                      onClick={() => setViewMode('edit')}
                      className={`px-2 py-1 text-xs font-medium rounded-l-lg transition-colors flex items-center gap-1 ${
                        viewMode === 'edit'
                          ? 'bg-interactive text-text-on-interactive'
                          : 'text-text-secondary hover:bg-surface-hover'
                      }`}
                      title="Edit mode"
                    >
                      <Code className="w-3 h-3" />
                      Edit
                    </button>
                    <button
                      onClick={() => setViewMode('preview')}
                      className={`px-2 py-1 text-xs font-medium rounded-r-lg transition-colors flex items-center gap-1 ${
                        viewMode === 'preview'
                          ? 'bg-interactive text-text-on-interactive'
                          : 'text-text-secondary hover:bg-surface-hover'
                      }`}
                      title="Preview mode"
                    >
                      <Eye className="w-3 h-3" />
                      Preview
                    </button>
                  </div>
                )}
                {!isBinaryPreview && (
                  <div className="flex items-center gap-2 text-sm">
                    {hasUnsavedChanges ? (
                      <>
                        <div className="w-2 h-2 bg-status-warning rounded-full animate-pulse" />
                        <span className="text-status-warning">Auto-saving...</span>
                      </>
                    ) : (
                      <>
                        <div className="w-2 h-2 bg-status-success rounded-full" />
                        <span className="text-status-success">All changes saved</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
            {error && (
              <div role="alert" className="px-4 py-2 bg-status-error/20 text-status-error text-sm">
                Error: {error}
              </div>
            )}
            <div className="flex-1 min-w-0 overflow-hidden">
              {viewMode === 'preview' && isMarkdownFile ? (
                <div className="h-full overflow-auto bg-bg-primary">
                  <MarkdownPreview
                    content={fileContent}
                    className="min-h-full"
                    id={`file-editor-preview-${sessionId}-${selectedFile.path.replace(/[^a-zA-Z0-9]/g, '-')}`}
                  />
                </div>
              ) : viewMode === 'preview' && isNotebookFile ? (
                <div className="h-full overflow-auto bg-bg-primary">
                  <NotebookPreview
                    content={fileContent}
                    className="min-h-full"
                  />
                </div>
              ) : isBinaryPreview && !binaryBlobUrl && !error ? (
                <div className="flex items-center justify-center h-full bg-surface-primary">
                  <div className="animate-pulse flex flex-col items-center gap-3">
                    <div className="w-48 h-48 bg-surface-tertiary rounded" />
                    <div className="w-32 h-3 bg-surface-tertiary rounded" />
                  </div>
                </div>
              ) : isImageFile && binaryBlobUrl ? (
                <div className="flex items-center justify-center h-full bg-surface-primary p-4 overflow-auto">
                  <img
                    src={binaryBlobUrl}
                    alt={selectedFile?.path.split('/').pop() || 'Image'}
                    className="max-w-full max-h-full object-contain rounded"
                  />
                </div>
              ) : isPdfFile && binaryBlobUrl ? (
                <object
                  data={binaryBlobUrl}
                  type="application/pdf"
                  className="w-full h-full"
                >
                  <div className="flex items-center justify-center h-full text-text-secondary">
                    PDF preview not available.
                  </div>
                </object>
              ) : (
                <MonacoErrorBoundary>
                  <Editor
                    theme={isDarkMode ? 'vs-dark' : 'light'}
                    value={fileContent}
                    onChange={handleEditorChange}
                    onMount={handleEditorMount}
                    options={{
                      minimap: { enabled: true },
                      fontSize: 14,
                      wordWrap: 'on',
                      automaticLayout: true,
                    }}
                    language={getLanguageFromPath(selectedFile.path)}
                  />
                </MonacoErrorBoundary>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-secondary">
            {error ? `Error: ${error}` : loading ? 'Loading...' : 'Select a file to edit'}
          </div>
        )}
    </div>
  );
}
