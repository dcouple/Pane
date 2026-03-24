import React from 'react';
import { Copy, ExternalLink, FolderOpen, Globe } from 'lucide-react';
import { TerminalPopover, PopoverButton } from './TerminalPopover';
import { isWindows } from '../../utils/platformUtils';

export interface SelectionPopoverProps {
  visible: boolean;
  x: number;
  y: number;
  text: string;
  workingDirectory?: string;
  sessionId?: string;
  onClose: () => void;
}

const URL_PATTERN = /https?:\/\/[^\s<>"{}|\\^`[\]]+/;
const LOCALHOST_URL_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/;

// File path patterns - detect Unix paths, Windows paths, and relative paths with extensions
const FILE_PATH_PATTERNS = [
  /^[.~]?\/[\w\-./]+/, // Unix absolute or relative paths starting with / ./ ~/
  /^[A-Za-z]:[\\\/][\w\-.\\/]+/, // Windows absolute paths C:\ or C:/
  /^[\w\-./\\]+\.[a-z]{1,10}(:\d+)?$/i, // Relative paths with extension like foo.ts, foo.ts:42, or dir\foo.ts
];

function isFilePath(text: string): boolean {
  const trimmed = text.trim();
  return FILE_PATH_PATTERNS.some(pattern => pattern.test(trimmed));
}

function resolveFilePath(text: string, workingDirectory?: string): string {
  const trimmed = text.trim();
  // Remove line:col suffix if present
  const pathOnly = trimmed.replace(/:\d+(:\d+)?$/, '');

  // If it's an absolute path, return as-is
  if (pathOnly.startsWith('/') || /^[A-Za-z]:/.test(pathOnly)) {
    return pathOnly;
  }

  // Resolve relative to working directory
  if (workingDirectory) {
    const separator = isWindows() ? '\\' : '/';
    // Normalize path separators to the platform's separator
    const normalizedPath = pathOnly.replace(/[/\\]/g, separator);
    const normalizedDir = workingDirectory.replace(/[/\\]/g, separator);
    return `${normalizedDir}${separator}${normalizedPath}`;
  }

  return pathOnly;
}

export const SelectionPopover: React.FC<SelectionPopoverProps> = ({
  visible,
  x,
  y,
  text,
  workingDirectory,
  sessionId,
  onClose,
}) => {
  // Early return when not visible to avoid unnecessary computation
  if (!visible) return null;

  const trimmedText = text.trim();
  const urlMatch = trimmedText.match(URL_PATTERN);
  const isUrl = urlMatch !== null;
  const isLocalhostUrl = urlMatch ? LOCALHOST_URL_PATTERN.test(urlMatch[0]) : false;
  const isFile = !isUrl && isFilePath(trimmedText);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      onClose();
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  const handleOpenUrl = () => {
    if (urlMatch) {
      // Extract just the URL, not surrounding text like "error: https://..."
      window.electronAPI.openExternal(urlMatch[0]);
      onClose();
    }
  };

  const handleOpenInBrowser = () => {
    if (urlMatch && sessionId) {
      window.dispatchEvent(new CustomEvent('browser-panel:navigate', {
        detail: { url: urlMatch[0], sessionId }
      }));
      onClose();
    }
  };

  const handleShowInExplorer = async () => {
    if (isFile) {
      const resolvedPath = resolveFilePath(trimmedText, workingDirectory);
      try {
        await window.electronAPI.invoke('app:showItemInFolder', resolvedPath);
      } catch (error) {
        console.error('Failed to show in explorer:', error);
      }
      onClose();
    }
  };

  return (
    <TerminalPopover visible={visible} x={x} y={y} onClose={onClose}>
      <PopoverButton onClick={handleCopy}>
        <span className="flex items-center gap-2">
          <Copy className="w-4 h-4" />
          Copy
        </span>
      </PopoverButton>
      {isLocalhostUrl && sessionId && (
        <PopoverButton onClick={handleOpenInBrowser}>
          <span className="flex items-center gap-2">
            <Globe className="w-4 h-4" />
            Open in Browser
          </span>
        </PopoverButton>
      )}
      {isUrl && (
        <PopoverButton onClick={handleOpenUrl}>
          <span className="flex items-center gap-2">
            <ExternalLink className="w-4 h-4" />
            Open URL
          </span>
        </PopoverButton>
      )}
      {isFile && (
        <PopoverButton onClick={handleShowInExplorer}>
          <span className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            Show in Explorer
          </span>
        </PopoverButton>
      )}
    </TerminalPopover>
  );
};
