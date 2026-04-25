import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { ChevronRight, ChevronDown, File, Folder, RefreshCw, Plus, Trash2, FolderPlus, Search, X, Eye, Code, Copy, FolderOpen, Pencil, Clipboard, ClipboardPaste, CopyPlus } from 'lucide-react';
import { useTree } from '@headless-tree/react';
import { asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, expandAllFeature } from '@headless-tree/core';
import type { ItemInstance } from '@headless-tree/core';
import { MonacoErrorBoundary } from '../../MonacoErrorBoundary';
import { useTheme } from '../../../contexts/ThemeContext';
import { debounce } from '../../../utils/debounce';
import { MarkdownPreview } from '../../MarkdownPreview';
import { NotebookPreview } from './NotebookPreview';
import { useResizablePanel } from '../../../hooks/useResizablePanel';
import { ExplorerPanelState } from '../../../../../shared/types/panels';
import { isMac, isWindows } from '../../../utils/platformUtils';
import { formatKeyDisplay } from '../../../utils/hotkeyUtils';
import { TerminalPopover, PopoverButton } from '../../terminal/TerminalPopover';

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: Date;
}

const ROOT_ID = '\0root';
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp']);
const PDF_EXTENSIONS = new Set(['pdf']);

interface HeadlessFileTreeProps {
  sessionId: string;
  onFileSelect: (file: FileItem | null) => void;
  onFileCreateSelect?: (filePath: string) => void;
  selectedPath: string | null;
  initialExpandedDirs?: string[];
  initialSearchQuery?: string;
  initialShowSearch?: boolean;
  onTreeStateChange?: (state: { expandedDirs: string[]; searchQuery: string; showSearch: boolean }) => void;
}

function HeadlessFileTree({
  sessionId,
  onFileSelect,
  onFileCreateSelect,
  selectedPath,
  initialExpandedDirs,
  initialSearchQuery,
  initialShowSearch,
  onTreeStateChange,
}: HeadlessFileTreeProps) {
  // Cache stores loaded directory contents. Key = dirPath, Value = FileItem[].
  const filesCacheRef = useRef(new Map<string, FileItem[]>());

  // Refs for values used in dataLoader (avoids stale closures)
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const [error, setError] = useState<string | null>(null);
  const setErrorRef = useRef(setError);
  setErrorRef.current = setError;
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery || '');
  const [showSearch, setShowSearch] = useState(initialShowSearch || false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showNewItemDialog, setShowNewItemDialog] = useState<'file' | 'folder' | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [newItemParentPath, setNewItemParentPath] = useState('');
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<{ paths: string[]; mode: 'copy' | 'cut' } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');
  const skipRenameCommitRef = useRef(false);
  const itemElementRefs = useRef(new Map<string, HTMLDivElement>());

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FileItem | null;
  } | null>(null);

  // Platform-adaptive label
  const revealLabel = isMac() ? 'Reveal in Finder' : isWindows() ? 'Show in Explorer' : 'Show in File Manager';

  // Initialize expanded state from persisted state or default to root expanded.
  // Normalize legacy '' root to ROOT_ID so saved state from the old FileTree still works.
  const [expandedItems, setExpandedItems] = useState<string[]>(() => {
    if (!initialExpandedDirs?.length) return [ROOT_ID];
    const normalized = initialExpandedDirs.map(d => d === '' ? ROOT_ID : d);
    if (!normalized.includes(ROOT_ID)) normalized.unshift(ROOT_ID);
    return normalized;
  });

  // Data loader using getChildrenWithData for efficient loading
  const dataLoader = useMemo(() => ({
    getItem: (itemId: string): FileItem => {
      if (itemId === ROOT_ID) {
        return { name: '', path: '', isDirectory: true };
      }
      // Look up item in cache by checking its parent directory
      const parentPath = itemId.includes('/')
        ? itemId.substring(0, itemId.lastIndexOf('/'))
        : '';
      const siblings = filesCacheRef.current.get(parentPath);
      const found = siblings?.find(f => f.path === itemId);
      if (found) return found;

      // Fallback: return a placeholder that will be replaced when parent loads
      return { name: itemId.split('/').pop() || '', path: itemId, isDirectory: false };
    },

    getChildrenWithData: async (itemId: string): Promise<Array<{ id: string; data: FileItem }>> => {
      const dirPath = itemId === ROOT_ID ? '' : itemId;

      // If not root, check if this is actually a directory
      if (itemId !== ROOT_ID) {
        const parentPath = itemId.includes('/')
          ? itemId.substring(0, itemId.lastIndexOf('/'))
          : '';
        const parentItems = filesCacheRef.current.get(parentPath);
        const item = parentItems?.find(f => f.path === itemId);
        if (item && !item.isDirectory) return [];
      }

      try {
        const result = await window.electronAPI.invoke('file:list', {
          sessionId: sessionIdRef.current,
          path: dirPath,
        });
        if (result.success) {
          filesCacheRef.current.set(dirPath, result.files);
          return result.files.map((f: FileItem) => ({ id: f.path, data: f }));
        }
        setErrorRef.current(result.error ?? 'Failed to load directory');
      } catch (err) {
        console.error('Failed to load directory:', dirPath, err);
        setErrorRef.current(err instanceof Error ? err.message : 'Failed to load directory');
      }
      return [];
    },
  }), []); // Empty deps — uses refs internally

  const tree = useTree<FileItem>({
    rootItemId: ROOT_ID,
    getItemName: (item: ItemInstance<FileItem>) => item.getItemData()?.name ?? '',
    isItemFolder: (item: ItemInstance<FileItem>) => item.getItemData()?.isDirectory ?? false,
    dataLoader,
    createLoadingItemData: () => ({ name: 'Loading...', path: '', isDirectory: false }),
    features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, expandAllFeature],
    state: { expandedItems, selectedItems },
    setExpandedItems,
    setSelectedItems,
  });

  const getParentPath = useCallback((filePath: string) => (
    filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : ''
  ), []);

  const getAncestorDirs = useCallback((filePath: string) => {
    const parts = filePath.split('/').filter(Boolean);
    const ancestors: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      ancestors.push(parts.slice(0, i).join('/'));
    }
    return ancestors;
  }, []);

  const revealItem = useCallback((filePath: string) => {
    let attempts = 0;
    const tryReveal = () => {
      const element = itemElementRefs.current.get(filePath);
      if (element) {
        element.scrollIntoView({ block: 'nearest' });
        return;
      }

      attempts += 1;
      if (attempts < 10) {
        window.setTimeout(tryReveal, 50);
      }
    };

    window.setTimeout(tryReveal, 0);
  }, []);

  const refreshDirectory = useCallback((dirPath: string) => {
    filesCacheRef.current.delete(dirPath);
    tree.getItemInstance(dirPath || ROOT_ID)?.invalidateChildrenIds();
  }, [tree]);

  const refreshAfterPathsChanged = useCallback((paths: string[]) => {
    const dirs = new Set<string>(['']);
    for (const filePath of paths) {
      dirs.add(getParentPath(filePath));
      getAncestorDirs(filePath).forEach(dir => dirs.add(dir));
      filesCacheRef.current.delete(filePath);
      const prefix = `${filePath}/`;
      for (const key of filesCacheRef.current.keys()) {
        if (key.startsWith(prefix)) filesCacheRef.current.delete(key);
      }
    }
    dirs.forEach(refreshDirectory);
  }, [getParentPath, getAncestorDirs, refreshDirectory]);

  useEffect(() => {
    if (!selectedPath) return;
    setSelectedItems([selectedPath]);
    setExpandedItems(prev => Array.from(new Set([ROOT_ID, ...prev, ...getAncestorDirs(selectedPath)])));
    revealItem(selectedPath);
  }, [selectedPath, getAncestorDirs, revealItem]);

  const getSelectedFilesForAction = useCallback((fallback: FileItem | null) => {
    if (fallback && !selectedItems.includes(fallback.path)) return [fallback];
    const selectedFiles = tree.getSelectedItems()
      .map(item => item.getItemData())
      .filter((item): item is FileItem => !!item && item.path !== '');
    return selectedFiles.length > 0 ? selectedFiles : fallback ? [fallback] : [];
  }, [selectedItems, tree]);

  const getContextTargetDir = useCallback((file: FileItem | null) => {
    if (!file) return '';
    return file.isDirectory ? file.path : getParentPath(file.path);
  }, [getParentPath]);

  // Session switch: clear cache and invalidate root
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      filesCacheRef.current.clear();
      tree.getItemInstance(ROOT_ID)?.invalidateChildrenIds();
      prevSessionIdRef.current = sessionId;
    }
  }, [sessionId, tree]);

  // Highlight matching text in search results
  const highlightText = useCallback((text: string, query: string) => {
    if (!query) return text;
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escapedQuery})`, 'gi'));
    return (
      <>
        {parts.map((part, index) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <span key={index} className="bg-status-warning text-text-primary">
              {part}
            </span>
          ) : (
            part
          )
        )}
      </>
    );
  }, []);

  // Search: flat filtered results from cache
  const getFilteredFiles = useCallback((): FileItem[] => {
    if (!searchQuery) return [];
    const results: FileItem[] = [];
    const query = searchQuery.toLowerCase();
    filesCacheRef.current.forEach((items) => {
      for (const item of items) {
        if (item.name.toLowerCase().includes(query) || item.path.toLowerCase().includes(query)) {
          results.push(item);
        }
      }
    });
    return results;
  }, [searchQuery]);

  // Context menu handlers
  const handleCopyPath = useCallback(async () => {
    if (!contextMenu?.file) return;
    try {
      const result = await window.electronAPI.invoke('file:resolveAbsolutePath', {
        sessionId,
        path: contextMenu.file.path,
      });
      if (result.success && result.path) {
        await navigator.clipboard.writeText(result.path);
      }
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
    setContextMenu(null);
  }, [contextMenu, sessionId]);

  const handleCopyRelativePath = useCallback(async () => {
    if (!contextMenu?.file) return;
    try {
      await navigator.clipboard.writeText(contextMenu.file.path);
    } catch (err) {
      console.error('Failed to copy relative path:', err);
    }
    setContextMenu(null);
  }, [contextMenu]);

  const handleRevealInFileManager = useCallback(async () => {
    if (!contextMenu?.file) return;
    try {
      await window.electronAPI.invoke('file:showInFolder', {
        sessionId,
        path: contextMenu.file.path,
      });
    } catch (err) {
      console.error('Failed to reveal in file manager:', err);
    }
    setContextMenu(null);
  }, [contextMenu, sessionId]);

  // Delete handler
  const handleDelete = useCallback(async (file: FileItem) => {
    const files = getSelectedFilesForAction(file);
    const confirmMessage = files.length > 1
      ? `Move ${files.length} items to trash?`
      : files[0]?.isDirectory
        ? `Move folder "${files[0].name}" and all its contents to trash?`
        : `Move file "${files[0]?.name}" to trash?`;
    if (!confirm(confirmMessage)) return;

    try {
      for (const target of files) {
        const result = await window.electronAPI.invoke('file:delete', {
          sessionId,
          filePath: target.path,
          useTrash: true,
        });

        if (!result.success) {
          setError(`Failed to delete: ${result.error}`);
          return;
        }
      }

      refreshAfterPathsChanged(files.map(f => f.path));
      setSelectedItems(prev => prev.filter(path => !files.some(f => f.path === path || path.startsWith(`${f.path}/`))));

      if (files.some(target => selectedPath === target.path || selectedPath?.startsWith(`${target.path}/`))) {
        onFileSelect(null);
      }
    } catch (err) {
      console.error('Failed to delete:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete item');
    }
  }, [getSelectedFilesForAction, sessionId, refreshAfterPathsChanged, selectedPath, onFileSelect]);

  const startRename = useCallback((file: FileItem) => {
    skipRenameCommitRef.current = false;
    setRenamingPath(file.path);
    setRenamingValue(file.name);
    setContextMenu(null);
  }, []);

  const commitRename = useCallback(async (file: FileItem, value: string) => {
    const newName = value.trim();
    setRenamingPath(null);
    if (!newName || newName === file.name) return;

    try {
      const result = await window.electronAPI.invoke('file:rename', {
        sessionId,
        filePath: file.path,
        newName: newName.trim(),
      });

      if (!result.success) {
        setError(`Failed to rename: ${result.error}`);
        return;
      }

      const newPath = result.path as string;
      refreshAfterPathsChanged([file.path, newPath]);
      setSelectedItems([newPath]);
      if (selectedPath === file.path) {
        onFileSelect({ ...file, name: newName.trim(), path: newPath });
      }
    } catch (err) {
      console.error('Failed to rename:', err);
      setError(err instanceof Error ? err.message : 'Failed to rename item');
    }
  }, [sessionId, refreshAfterPathsChanged, selectedPath, onFileSelect]);

  const handleDuplicate = useCallback(async (file: FileItem) => {
    try {
      const result = await window.electronAPI.invoke('file:duplicate', {
        sessionId,
        filePath: file.path,
      });

      if (!result.success) {
        setError(`Failed to duplicate: ${result.error}`);
        return;
      }

      refreshAfterPathsChanged([file.path, result.path as string]);
    } catch (err) {
      console.error('Failed to duplicate:', err);
      setError(err instanceof Error ? err.message : 'Failed to duplicate item');
    }
  }, [sessionId, refreshAfterPathsChanged]);

  const handleSetClipboard = useCallback((file: FileItem, mode: 'copy' | 'cut') => {
    const files = getSelectedFilesForAction(file);
    setClipboard({ paths: files.map(f => f.path), mode });
    setContextMenu(null);
  }, [getSelectedFilesForAction]);

  const handlePaste = useCallback(async (targetFile: FileItem | null) => {
    if (!clipboard || clipboard.paths.length === 0) return;
    const targetDir = getContextTargetDir(targetFile);

    try {
      for (const sourcePath of clipboard.paths) {
        if (clipboard.mode === 'cut' && getParentPath(sourcePath) === targetDir) {
          continue;
        }
        const result = await window.electronAPI.invoke(clipboard.mode === 'cut' ? 'file:move' : 'file:copy', {
          sessionId,
          sourcePath,
          targetDir,
        });

        if (!result.success) {
          setError(`Failed to ${clipboard.mode === 'cut' ? 'move' : 'copy'}: ${result.error}`);
          return;
        }
      }

      refreshAfterPathsChanged([...clipboard.paths, targetDir]);
      if (clipboard.mode === 'cut') setClipboard(null);
    } catch (err) {
      console.error('Failed to paste:', err);
      setError(err instanceof Error ? err.message : 'Failed to paste item');
    } finally {
      setContextMenu(null);
    }
  }, [clipboard, getContextTargetDir, getParentPath, sessionId, refreshAfterPathsChanged]);

  const openCreateDialog = useCallback((type: 'file' | 'folder', parent: FileItem | null) => {
    setShowNewItemDialog(type);
    setNewItemName('');
    setNewItemParentPath(getContextTargetDir(parent));
    setContextMenu(null);
  }, [getContextTargetDir]);

  // New file/folder creation with auto-open (the .md bug fix)
  const handleCreateNewItem = useCallback(async () => {
    if (!newItemName.trim()) return;

    try {
      const isFolder = showNewItemDialog === 'folder';
      const relativePath = newItemParentPath
        ? `${newItemParentPath}/${newItemName}`
        : newItemName;
      const filePath = isFolder ? `${relativePath}/.gitkeep` : relativePath;

      const result = await window.electronAPI.invoke('file:write', {
        sessionId,
        filePath,
        content: '',
      });

      if (result.success) {
        const createdItemPath = isFolder ? relativePath : filePath;
        refreshAfterPathsChanged([createdItemPath]);
        const dirsToExpand = [
          ROOT_ID,
          ...getAncestorDirs(createdItemPath),
          ...(isFolder ? [relativePath] : []),
        ];
        setExpandedItems(prev => Array.from(new Set([...prev, ...dirsToExpand])));
        setSelectedItems([createdItemPath]);
        revealItem(createdItemPath);

        // AUTO-OPEN: Select and open the new file in editor — this is the bug fix
        if (!isFolder) {
          const newFile: FileItem = {
            name: newItemName,
            path: relativePath,
            isDirectory: false,
          };
          onFileCreateSelect?.(newFile.path);
          onFileSelect(newFile);
        }

        setShowNewItemDialog(null);
        setNewItemName('');
        setNewItemParentPath('');
      } else {
        setError(`Failed to create ${isFolder ? 'folder' : 'file'}: ${result.error}`);
      }
    } catch (err) {
      console.error('Failed to create item:', err);
      setError(err instanceof Error ? err.message : 'Failed to create item');
    }
  }, [sessionId, newItemName, newItemParentPath, showNewItemDialog, onFileSelect, onFileCreateSelect, getAncestorDirs, revealItem, refreshAfterPathsChanged]);

  // Refresh all
  const handleRefreshAll = useCallback(() => {
    filesCacheRef.current.clear();
    tree.getItemInstance(ROOT_ID)?.invalidateChildrenIds();
    for (const item of tree.getItems()) {
      if (item.getItemData()?.isDirectory) {
        item.invalidateChildrenIds();
      }
    }
  }, [tree]);

  const uploadFile = useCallback((file: File, targetDir = ''): Promise<{ success: boolean; name: string; error?: string; filePath?: string }> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64 = (reader.result as string).split(',')[1]; // Strip data URL prefix
          const result = await window.electronAPI.invoke('file:write-binary', {
            sessionId: sessionIdRef.current,
            fileName: file.name,
            contentBase64: base64,
            targetDir,
          });
          if (result.success) {
            resolve({ success: true, name: file.name, filePath: result.filePath });
          } else {
            resolve({ success: false, name: file.name, error: result.error });
          }
        } catch (err) {
          resolve({ success: false, name: file.name, error: err instanceof Error ? err.message : 'Unknown error' });
        }
      };
      reader.onerror = () => resolve({ success: false, name: file.name, error: 'Failed to read file' });
      reader.readAsDataURL(file);
    });
  }, []);

  const handleMoveToDirectory = useCallback(async (files: FileItem[], targetDir: string) => {
    const movingFiles = files.filter(file => file.path !== targetDir && !targetDir.startsWith(`${file.path}/`));
    if (movingFiles.length === 0) return;

    try {
      for (const file of movingFiles) {
        const result = await window.electronAPI.invoke('file:move', {
          sessionId,
          sourcePath: file.path,
          targetDir,
        });
        if (!result.success) {
          setError(`Failed to move "${file.name}": ${result.error}`);
          return;
        }
      }
      refreshAfterPathsChanged([...movingFiles.map(f => f.path), targetDir]);
    } catch (err) {
      console.error('Failed to move files:', err);
      setError(err instanceof Error ? err.message : 'Failed to move files');
    }
  }, [sessionId, refreshAfterPathsChanged]);

  const handleExternalFileDrop = useCallback(async (files: File[], targetDir = '') => {
    if (files.length === 0) return;

    const oversized = files.filter(f => f.size > MAX_FILE_SIZE);
    const validFiles = files.filter(f => f.size <= MAX_FILE_SIZE);

    if (validFiles.length === 0) {
      if (oversized.length > 0) {
        setError(`Files too large (max 15MB): ${oversized.map(f => f.name).join(', ')}`);
      }
      return;
    }

    setUploadStatus(`Uploading ${validFiles.length} file${validFiles.length > 1 ? 's' : ''}...`);

    try {
      const results: { success: boolean; name: string; error?: string; filePath?: string }[] = [];
      for (const file of validFiles) {
        results.push(await uploadFile(file, targetDir));
      }
      const failed = results.filter(r => !r.success);

      const errors: string[] = [];
      if (oversized.length > 0) {
        errors.push(`Too large (max 15MB): ${oversized.map(f => f.name).join(', ')}`);
      }
      if (failed.length > 0) {
        errors.push(`Failed: ${failed.map(r => `${r.name}${r.error ? ` (${r.error})` : ''}`).join(', ')}`);
      }
      if (errors.length > 0) setError(errors.join('. '));

      if (results.some(r => r.success)) {
        refreshDirectory(targetDir);
      }
    } finally {
      setUploadStatus(null);
    }
  }, [refreshDirectory, uploadFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
      if (!isDragOver) setIsDragOver(true);
    }
  }, [isDragOver]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    setDragOverPath(null);
    setError(null);

    const files = Array.from(e.dataTransfer.files);
    await handleExternalFileDrop(files, '');
  }, [handleExternalFileDrop]);

  const handleInternalDrop = useCallback(async (e: React.DragEvent, targetDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    setIsDragOver(false);

    const internalPayload = e.dataTransfer.getData('application/x-pane-file-paths');
    if (internalPayload) {
      try {
        const paths = JSON.parse(internalPayload) as string[];
        const files = paths
          .map(filePath => tree.getItemInstance(filePath)?.getItemData())
          .filter((item): item is FileItem => !!item);
        await handleMoveToDirectory(files, targetDir);
      } catch (err) {
        console.error('Failed to parse dropped file paths:', err);
        setError('Failed to move dropped items');
      }
      return;
    }

    await handleExternalFileDrop(Array.from(e.dataTransfer.files), targetDir);
  }, [handleExternalFileDrop, handleMoveToDirectory, tree]);

  // Focus input when dialog is shown
  useEffect(() => {
    if (showNewItemDialog && newItemInputRef.current) {
      newItemInputRef.current.focus();
    }
  }, [showNewItemDialog]);

  // Clear error after 5 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  // Focus search input when shown
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  // State persistence: notify parent about tree state changes
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (onTreeStateChange) {
      onTreeStateChange({
        expandedDirs: expandedItems,
        searchQuery,
        showSearch,
      });
    }
  }, [expandedItems, searchQuery, showSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditingText = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || !!target?.isContentEditable;
      if (isEditingText && e.key !== 'Escape') return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
      if (e.key === 'Escape') {
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        if (showNewItemDialog) {
          setShowNewItemDialog(null);
          setNewItemName('');
          return;
        }
        if (searchQuery) {
          setSearchQuery('');
          searchInputRef.current?.focus();
        }
      }
      if (e.key === 'F2' && selectedItems.length === 1) {
        const item = tree.getItemInstance(selectedItems[0])?.getItemData();
        if (item) {
          e.preventDefault();
          startRename(item);
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItems.length > 0) {
        const item = tree.getItemInstance(selectedItems[0])?.getItemData();
        if (item) {
          e.preventDefault();
          handleDelete(item);
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && selectedItems.length > 0) {
        e.preventDefault();
        setClipboard({ paths: selectedItems, mode: 'copy' });
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x' && selectedItems.length > 0) {
        e.preventDefault();
        setClipboard({ paths: selectedItems, mode: 'cut' });
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && clipboard) {
        e.preventDefault();
        handlePaste(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchQuery, showNewItemDialog, contextMenu, selectedItems, tree, startRename, handleDelete, clipboard, handlePaste]);

  return (
    <div
      className={`h-full flex flex-col ${isDragOver ? 'ring-2 ring-interactive ring-inset bg-interactive/10' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between p-2 border-b border-border-primary">
        <span className="text-sm font-medium text-text-primary">Files</span>
        <div className="flex gap-1">
          <button
            onClick={() => setShowSearch(prev => !prev)}
            className={`p-1 rounded text-text-tertiary hover:text-text-primary ${showSearch ? 'bg-surface-tertiary' : 'hover:bg-surface-hover'}`}
            title={`Search files (${formatKeyDisplay('mod+f')})`}
          >
            <Search className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setShowNewItemDialog('file'); setNewItemName(''); setNewItemParentPath(''); }}
            className="p-1 hover:bg-surface-hover rounded text-text-tertiary hover:text-text-primary"
            title="New file"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setShowNewItemDialog('folder'); setNewItemName(''); setNewItemParentPath(''); }}
            className="p-1 hover:bg-surface-hover rounded text-text-tertiary hover:text-text-primary"
            title="New folder"
          >
            <FolderPlus className="w-4 h-4" />
          </button>
          <button
            onClick={handleRefreshAll}
            className="p-1 hover:bg-surface-hover rounded text-text-tertiary hover:text-text-primary"
            title="Refresh all"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>
      {showSearch && (
        <div className="p-2 border-b border-border-primary">
          <div className="relative">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files..."
              className="w-full pl-8 pr-8 py-1 bg-surface-primary border border-border-primary rounded text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-interactive focus:ring-1 focus:ring-interactive"
            />
            <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-text-tertiary" />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 transform -translate-y-1/2 p-0.5 hover:bg-surface-hover rounded"
              >
                <X className="w-3 h-3 text-text-tertiary" />
              </button>
            )}
          </div>
          {searchQuery && (
            <div className="mt-1 text-xs text-text-tertiary">
              Press ESC to clear • {formatKeyDisplay('mod+f')} to toggle search
            </div>
          )}
        </div>
      )}
      {showNewItemDialog && (
        <div className="p-2 border-b border-border-primary bg-surface-secondary">
          <form onSubmit={(e) => { e.preventDefault(); handleCreateNewItem(); }}>
            <input
              ref={newItemInputRef}
              type="text"
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              placeholder={`Enter ${showNewItemDialog} name${newItemParentPath ? ` in ${newItemParentPath}` : ''}...`}
              className="w-full px-2 py-1 mb-2 bg-surface-primary border border-border-primary rounded text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-interactive focus:ring-1 focus:ring-interactive"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!newItemName.trim()}
                className="flex-1 px-3 py-1 bg-interactive hover:bg-interactive-hover disabled:bg-surface-tertiary disabled:text-text-tertiary text-text-on-interactive rounded text-sm transition-colors"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => { setShowNewItemDialog(null); setNewItemName(''); setNewItemParentPath(''); }}
                className="flex-1 px-3 py-1 bg-surface-tertiary hover:bg-surface-hover text-text-secondary rounded text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      {error && (
        <div className="px-3 py-2 bg-status-error/20 text-status-error text-sm border-b border-status-error/30">
          {error}
        </div>
      )}
      {uploadStatus && (
        <div className="px-3 py-2 bg-interactive/20 text-interactive text-sm border-b border-interactive/30">
          {uploadStatus}
        </div>
      )}
      {/* Search mode: flat filtered results overlay */}
      {searchQuery && (
        <div className="flex-1 overflow-auto">
          {getFilteredFiles().map(file => (
            <div
              key={file.path}
              className={`flex items-center px-2 py-1 hover:bg-surface-hover cursor-pointer group ${
                selectedPath === file.path ? 'bg-interactive' : ''
              }`}
              style={{ paddingLeft: '8px' }}
              onClick={() => {
                if (!file.isDirectory) onFileSelect(file);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ x: e.clientX, y: e.clientY, file });
              }}
            >
              {file.isDirectory ? (
                <Folder className="w-4 h-4 mr-2 text-interactive flex-shrink-0" />
              ) : (
                <File className="w-4 h-4 mr-2 text-text-tertiary flex-shrink-0" />
              )}
              <span className="flex-1 text-sm truncate text-text-primary">
                {highlightText(file.name, searchQuery)}
              </span>
              <span className="text-xs text-text-tertiary ml-2 truncate max-w-[120px]">
                {file.path}
              </span>
            </div>
          ))}
          {getFilteredFiles().length === 0 && (
            <div className="p-4 text-text-secondary text-sm">No matching files</div>
          )}
        </div>
      )}
      {/* Tree view: always rendered so the async data loader stays active and
          populates the cache. Hidden (not unmounted) when search is active. */}
      <div
        {...tree.getContainerProps()}
        className={`overflow-auto outline-none ${searchQuery ? 'hidden' : 'flex-1'}`}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, file: null });
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOverPath('');
          e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-pane-file-paths') ? 'move' : 'copy';
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOverPath(null);
        }}
        onDrop={(e) => handleInternalDrop(e, '')}
      >
        {tree.getItems().map((item: ItemInstance<FileItem>) => {
          const data = item.getItemData();
          if (!data || item.getId() === ROOT_ID) return null;

          const isFolder = data.isDirectory;
          const level = item.getItemMeta().level;
          const isExpanded = item.isExpanded();
          const isItemSelected = item.isSelected();
          const isOpenFile = selectedPath === data.path && !isFolder;

          return (
            <div
              key={item.getId()}
              {...item.getProps()}
              ref={(element) => {
                if (element) itemElementRefs.current.set(data.path, element);
                else itemElementRefs.current.delete(data.path);
              }}
              className={`flex items-center px-2 py-1 hover:bg-surface-hover cursor-pointer group ${
                isItemSelected ? 'bg-interactive' : ''
              } ${
                isOpenFile && !isItemSelected ? 'bg-surface-hover/60' : ''
              } ${
                dragOverPath === data.path ? 'ring-1 ring-interactive bg-interactive/10' : ''
              }`}
              style={{ paddingLeft: `${level * 16 + 8}px` }}
              draggable
              onDragStart={(e) => {
                const files = getSelectedFilesForAction(data);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('application/x-pane-file-paths', JSON.stringify(files.map(file => file.path)));
                e.dataTransfer.setData('text/plain', files.map(file => file.path).join('\n'));
              }}
              onDragOver={(e) => {
                if (!isFolder) return;
                e.preventDefault();
                e.stopPropagation();
                setDragOverPath(data.path);
                e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-pane-file-paths') ? 'move' : 'copy';
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOverPath(null);
              }}
              onDrop={(e) => {
                if (!isFolder) return;
                handleInternalDrop(e, data.path);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (e.metaKey || e.ctrlKey) {
                  item.toggleSelect();
                } else if (e.shiftKey) {
                  item.selectUpTo(false);
                } else {
                  item.select();
                }
                if (isFolder) {
                  if (isExpanded) item.collapse();
                  else item.expand();
                } else {
                  onFileSelect(data);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (isFolder) {
                    if (isExpanded) item.collapse();
                    else item.expand();
                  } else {
                    onFileSelect(data);
                  }
                }
              }}
              onDoubleClick={(e) => e.preventDefault()}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!item.isSelected()) item.select();
                setContextMenu({ x: e.clientX, y: e.clientY, file: data });
              }}
            >
              {isFolder ? (
                <>
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 mr-1 text-text-tertiary" />
                  ) : (
                    <ChevronRight className="w-4 h-4 mr-1 text-text-tertiary" />
                  )}
                  <Folder className="w-4 h-4 mr-2 text-interactive" />
                </>
              ) : (
                <>
                  <div className="w-4 h-4 mr-1" />
                  <File className="w-4 h-4 mr-2 text-text-tertiary" />
                </>
              )}
              {renamingPath === data.path ? (
                <input
                  autoFocus
                  value={renamingValue}
                  onChange={(e) => setRenamingValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename(data, renamingValue);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      skipRenameCommitRef.current = true;
                      setRenamingPath(null);
                    }
                  }}
                  onBlur={() => {
                    if (skipRenameCommitRef.current) {
                      skipRenameCommitRef.current = false;
                      return;
                    }
                    commitRename(data, renamingValue);
                  }}
                  className="flex-1 min-w-0 px-1 py-0.5 bg-surface-primary border border-interactive rounded text-sm text-text-primary focus:outline-none"
                />
              ) : (
                <span className="flex-1 text-sm truncate text-text-primary">{data.name}</span>
              )}
              {isFolder && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    filesCacheRef.current.delete(data.path);
                    item.invalidateChildrenIds();
                  }}
                  className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 p-1 hover:bg-surface-hover rounded text-text-tertiary hover:text-text-primary"
                  title="Refresh folder"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(data);
                }}
                className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 p-1 hover:bg-surface-hover rounded ml-1"
                title={`Delete ${isFolder ? 'folder' : 'file'}`}
              >
                <Trash2 className="w-3 h-3 text-status-error" />
              </button>
            </div>
          );
        })}
      </div>
      <TerminalPopover
        visible={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        onClose={() => setContextMenu(null)}
      >
        <PopoverButton onClick={() => openCreateDialog('file', contextMenu?.file ?? null)}>
          <span className="flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New File
          </span>
        </PopoverButton>
        <PopoverButton onClick={() => openCreateDialog('folder', contextMenu?.file ?? null)}>
          <span className="flex items-center gap-2">
            <FolderPlus className="w-4 h-4" />
            New Folder
          </span>
        </PopoverButton>
        {contextMenu?.file && (
          <>
            <div className="my-1 border-t border-border-primary" />
            <PopoverButton onClick={() => { if (contextMenu.file) startRename(contextMenu.file); }}>
              <span className="flex items-center gap-2">
                <Pencil className="w-4 h-4" />
                Rename
              </span>
            </PopoverButton>
            <PopoverButton onClick={() => { if (contextMenu.file) handleSetClipboard(contextMenu.file, 'copy'); }}>
              <span className="flex items-center gap-2">
                <Clipboard className="w-4 h-4" />
                Copy
              </span>
            </PopoverButton>
            <PopoverButton onClick={() => { if (contextMenu.file) handleSetClipboard(contextMenu.file, 'cut'); }}>
              <span className="flex items-center gap-2">
                <Clipboard className="w-4 h-4" />
                Cut
              </span>
            </PopoverButton>
            <PopoverButton onClick={() => { if (contextMenu.file) { handleDuplicate(contextMenu.file); setContextMenu(null); } }}>
              <span className="flex items-center gap-2">
                <CopyPlus className="w-4 h-4" />
                Duplicate
              </span>
            </PopoverButton>
          </>
        )}
        <PopoverButton disabled={!clipboard} onClick={() => handlePaste(contextMenu?.file ?? null)}>
          <span className="flex items-center gap-2">
            <ClipboardPaste className="w-4 h-4" />
            Paste
          </span>
        </PopoverButton>
        {contextMenu?.file && (
          <>
            <div className="my-1 border-t border-border-primary" />
            <PopoverButton onClick={handleCopyRelativePath}>
              <span className="flex items-center gap-2">
                <Copy className="w-4 h-4" />
                Copy Relative Path
              </span>
            </PopoverButton>
            <PopoverButton onClick={handleCopyPath}>
              <span className="flex items-center gap-2">
                <Copy className="w-4 h-4" />
                Copy Absolute Path
              </span>
            </PopoverButton>
            <PopoverButton onClick={handleRevealInFileManager}>
              <span className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4" />
                {revealLabel}
              </span>
            </PopoverButton>
            <div className="my-1 border-t border-border-primary" />
            <PopoverButton variant="danger" onClick={() => { if (contextMenu.file) { handleDelete(contextMenu.file); setContextMenu(null); } }}>
              <span className="flex items-center gap-2">
                <Trash2 className="w-4 h-4" />
                Move to Trash
              </span>
            </PopoverButton>
          </>
        )}
      </TerminalPopover>
    </div>
  );
}

interface FileEditorProps {
  sessionId: string;
  initialFilePath?: string;
  initialState?: ExplorerPanelState;
  onFileChange?: (filePath: string | undefined, isDirty: boolean) => void;
  onStateChange?: (state: Partial<ExplorerPanelState>) => void;
}

export function FileEditor({ 
  sessionId, 
  initialFilePath,
  initialState,
  onFileChange,
  onStateChange 
}: FileEditorProps) {
  console.log('[FileEditor] Mounting with:', {
    sessionId,
    initialFilePath,
    initialState,
    hasOnStateChange: !!onStateChange
  });
  
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
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
  const isDarkMode = theme !== 'light' && theme !== 'light-rounded';
  const hasUnsavedChanges = fileContent !== originalContent;
  
  // Wrap onResize callback to avoid recreating
  const handleTreeResize = useCallback((width: number) => {
    console.log('[FileEditor] Tree resized to:', width);
    if (onStateChange) {
      onStateChange({ fileTreeWidth: width });
    }
  }, [onStateChange]);
  
  // Add resizable hook for file tree column
  const { width: fileTreeWidth, startResize } = useResizablePanel({
    defaultWidth: initialState?.fileTreeWidth || 256,  // Use saved width or default
    minWidth: 200,
    maxWidth: 400,
    storageKey: 'pane-file-tree-width',
    onResize: handleTreeResize
  });
  
  // Check if this is a markdown file
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

  const handleEditorChange = (value: string | undefined) => {
    setFileContent(value || '');
    
    // Notify parent about dirty state
    if (onFileChange && selectedFile) {
      const isDirty = (value || '') !== originalContent;
      onFileChange(selectedFile.path, isDirty);
    }
  };

  // Auto-save functionality
  const autoSave = useCallback(
    debounce(async () => {
      if (!selectedFile || selectedFile.isDirectory || fileContent === originalContent) return;
      
      try {
        const result = await window.electronAPI.invoke('file:write', {
          sessionId,
          filePath: selectedFile.path,
          content: fileContent
        });
        
        if (result.success) {
          setOriginalContent(fileContent);

          // Notify parent that file is saved
          if (onFileChange && selectedFile) {
            onFileChange(selectedFile.path, false);
          }

          // Emit file saved event
          if (onStateChange) {
            onStateChange({
              filePath: selectedFile.path,
              isDirty: false
            });
          }

          // Re-check git status after save
          window.electronAPI.invoke('git:file-status', sessionId, selectedFile.path).then((statusResult: { success: boolean; data?: { status: 'clean' | 'modified' | 'untracked' } }) => {
            if (statusResult.success && statusResult.data) {
              setGitStatus(statusResult.data.status);
            }
          });
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to auto-save file');
      }
    }, 1000), // Auto-save after 1 second of inactivity
    [sessionId, selectedFile, fileContent, originalContent, onFileChange, onStateChange]
  );

  // Trigger auto-save when content changes
  useEffect(() => {
    if (fileContent !== originalContent && selectedFile && !selectedFile.isDirectory) {
      autoSave();
    }
  }, [fileContent, originalContent, selectedFile, autoSave]);

  // Re-check git status when git operations complete (e.g. commit from diff panel or terminal)
  useEffect(() => {
    if (!selectedFile) return;
    const handlePanelEvent = (event: CustomEvent) => {
      const { type } = event.detail || {};
      if (type === 'git:operation_completed' || type === 'diff:refreshed' || type === 'terminal:command_executed' || type === 'files:changed') {
        window.electronAPI.invoke('git:file-status', sessionId, selectedFile.path).then((statusResult: { success: boolean; data?: { status: 'clean' | 'modified' | 'untracked' } }) => {
          if (statusResult.success && statusResult.data) {
            setGitStatus(statusResult.data.status);
          }
        });
      }
    };
    window.addEventListener('panel:event', handlePanelEvent as EventListener);
    return () => window.removeEventListener('panel:event', handlePanelEvent as EventListener);
  }, [selectedFile, sessionId]);
  
  // Load initial file if provided
  useEffect(() => {
    if (initialFilePath && !selectedFile) {
      const file: FileItem = {
        name: initialFilePath.split('/').pop() || '',
        path: initialFilePath,
        isDirectory: false
      };
      loadFile(file);
    }
  }, [initialFilePath, selectedFile, loadFile]);

  // Memoize the tree state change handler to prevent infinite loops
  const handleTreeStateChange = useCallback((treeState: { expandedDirs: string[]; searchQuery: string; showSearch: boolean }) => {
    console.log('[FileEditor] handleTreeStateChange called with:', treeState);
    if (onStateChange) {
      console.log('[FileEditor] Calling onStateChange');
      onStateChange({
        expandedDirs: treeState.expandedDirs,
        searchQuery: treeState.searchQuery,
        showSearch: treeState.showSearch
      });
    } else {
      console.log('[FileEditor] No onStateChange callback');
    }
  }, [onStateChange]);
  
  // Cleanup effect for Monaco editor models
  useEffect(() => {
    return () => {
      // Cleanup Monaco editor models when component unmounts or file changes
      try {
        if (editorRef.current && typeof editorRef.current === 'object' && editorRef.current !== null && 'getModel' in editorRef.current) {
          const editor = editorRef.current as { getModel: () => unknown, dispose?: () => void };
          const model = editor.getModel();
          if (model && typeof model === 'object' && model !== null && 'dispose' in model) {
            const typedModel = model as { dispose: () => void };
            console.log('[FileEditor] Disposing Monaco model');
            typedModel.dispose();
          }
        }
      } catch (error) {
        console.warn('[FileEditor] Error during Monaco cleanup:', error);
      }
    };
  }, [selectedFile?.path]); // Run cleanup when file changes

  return (
    <div className="h-full flex">
      <div 
        className="bg-surface-secondary border-r border-border-primary relative flex-shrink-0"
        style={{ width: `${fileTreeWidth}px` }}
      >
        <HeadlessFileTree
          sessionId={sessionId}
          onFileSelect={loadFile}
          onFileCreateSelect={(filePath) => {
            pendingEditorFocusPathRef.current = filePath;
          }}
          selectedPath={selectedFile?.path || null}
          initialExpandedDirs={initialState?.expandedDirs}
          initialSearchQuery={initialState?.searchQuery}
          initialShowSearch={initialState?.showSearch}
          onTreeStateChange={handleTreeStateChange}
        />
        
        {/* Resize handle */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize group z-10"
          onMouseDown={startResize}
        >
          {/* Larger grab area */}
          <div className="absolute -left-2 -right-2 top-0 bottom-0" />
        </div>
      </div>
      <div className="flex-1 flex flex-col">
        {selectedFile ? (
          <>
            <div className="flex items-center justify-between px-4 py-2 bg-surface-secondary border-b border-border-primary">
              <div className="flex items-center gap-2">
                <File className="w-4 h-4 text-text-tertiary" />
                <span className="text-sm text-text-primary">
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
              <div className="flex items-center gap-2">
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
              <div className="px-4 py-2 bg-status-error/20 text-status-error text-sm">
                Error: {error}
              </div>
            )}
            <div className="flex-1 overflow-hidden">
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
            {loading ? 'Loading...' : 'Select a file to edit'}
          </div>
        )}
      </div>
    </div>
  );
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    ipynb: 'json',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    java: 'java',
    cs: 'csharp',
    php: 'php',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',
    ps1: 'powershell',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    sql: 'sql',
    graphql: 'graphql',
    vue: 'vue',
    svelte: 'svelte',
  };
  
  return languageMap[ext || ''] || 'plaintext';
}
