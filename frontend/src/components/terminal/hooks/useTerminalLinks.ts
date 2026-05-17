import { useState, useEffect, useCallback, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { LinkProviderConfig } from '../linkProviders/types';
import { registerAllLinkProviders } from '../linkProviders';
import { panelApi } from '../../../services/panelApi';
import { usePanelStore } from '../../../stores/panelStore';
import { useConfigStore } from '../../../stores/configStore';

export interface UseTerminalLinksConfig {
  workingDirectory: string;
  sessionId: string;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  text: string;
  hint: string;
}

interface FilePopoverState {
  visible: boolean;
  x: number;
  y: number;
  path: string;
  line: number;
}

interface SelectionPopoverState {
  visible: boolean;
  x: number;
  y: number;
  text: string;
}

export function useTerminalLinks(terminal: Terminal | null, config: UseTerminalLinksConfig) {
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    text: '',
    hint: '',
  });

  const [filePopover, setFilePopover] = useState<FilePopoverState>({
    visible: false,
    x: 0,
    y: 0,
    path: '',
    line: 0,
  });

  const [selectionPopover, setSelectionPopover] = useState<SelectionPopoverState>({
    visible: false,
    x: 0,
    y: 0,
    text: '',
  });

  const [githubRemoteUrl, setGithubRemoteUrl] = useState<string | null>(null);
  const isRemoteMode = useConfigStore((state) => state.config?.remoteDaemon?.client.mode === 'remote');
  const mousePositionRef = useRef({ x: 0, y: 0 });

  // Track mouse position for selection popover
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    mousePositionRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Fetch GitHub remote URL on mount
  useEffect(() => {
    window.electronAPI
      .invoke('git:get-github-remote', config.sessionId)
      .then((result: { success: boolean; data?: string | null }) => {
        if (result.success) {
          setGithubRemoteUrl(result.data ?? null);
        }
      })
      .catch((error) => {
        console.error('Failed to fetch GitHub remote:', error);
      });
  }, [config.sessionId]);

  // Register link providers when terminal is ready
  useEffect(() => {
    if (!terminal) return;

    const providerConfig: LinkProviderConfig = {
      terminal,
      workingDirectory: config.workingDirectory,
      githubRemoteUrl: githubRemoteUrl ?? undefined,
      onShowTooltip: (event, text, hint) => {
        setTooltip({ visible: true, x: event.clientX, y: event.clientY, text, hint });
      },
      onHideTooltip: () => {
        setTooltip((prev) => ({ ...prev, visible: false }));
      },
      onShowFilePopover: (event, path, line) => {
        setFilePopover({ visible: true, x: event.clientX, y: event.clientY, path, line: line ?? 0 });
      },
      onOpenUrl: (url) => {
        window.electronAPI.openExternal(url);
      },
    };

    const disposables = registerAllLinkProviders(providerConfig);

    return () => {
      disposables.forEach((d) => d.dispose());
    };
  }, [terminal, config.workingDirectory, githubRemoteUrl]);

  // Listen for selection changes
  useEffect(() => {
    if (!terminal) return;

    const disposable = terminal.onSelectionChange(() => {
      if (terminal.hasSelection()) {
        const text = terminal.getSelection();
        const { x, y } = mousePositionRef.current;
        setSelectionPopover({ visible: true, x, y, text });
      } else {
        setSelectionPopover((prev) => ({ ...prev, visible: false }));
      }
    });

    return () => {
      disposable.dispose();
    };
  }, [terminal]);

  // Get panel store methods
  const addPanel = usePanelStore((state) => state.addPanel);
  const setActivePanelInStore = usePanelStore((state) => state.setActivePanel);

  // File popover action handlers
  const handleOpenInEditor = useCallback(async () => {
    const { path, line } = filePopover;

    // Check if file exists - file:exists returns a bare boolean
    const exists = await window.electronAPI.invoke('file:exists', {
      sessionId: config.sessionId,
      filePath: path,
    });

    if (exists) {
      // Create an Explorer panel with the file path
      const filename = path.split(/[/\\]/).pop() || 'Editor';
      const newPanel = await panelApi.createPanel({
        sessionId: config.sessionId,
        type: 'explorer',
        title: filename,
        initialState: {
          customState: {
            filePath: path,
            cursorPosition: line ? { line, column: 1 } : undefined,
          },
        },
      });

      // Add to store and set as active
      addPanel(newPanel);
      setActivePanelInStore(config.sessionId, newPanel.id);
      await panelApi.setActivePanel(config.sessionId, newPanel.id);
    }

    setFilePopover((prev) => ({ ...prev, visible: false }));
  }, [filePopover, config.sessionId, addPanel, setActivePanelInStore]);

  const handleShowInExplorer = useCallback(async () => {
    const { path } = filePopover;

    if (isRemoteMode) {
      console.warn('Show in Explorer is only available in local mode.');
      setFilePopover((prev) => ({ ...prev, visible: false }));
      return;
    }

    try {
      await window.electronAPI.invoke('app:showItemInFolder', path);
    } catch (error) {
      console.error('Failed to show item in folder:', error);
    }

    setFilePopover((prev) => ({ ...prev, visible: false }));
  }, [filePopover, isRemoteMode]);

  const closeTooltip = useCallback(() => {
    setTooltip((prev) => ({ ...prev, visible: false }));
  }, []);

  const closeFilePopover = useCallback(() => {
    setFilePopover((prev) => ({ ...prev, visible: false }));
  }, []);

  const closeSelectionPopover = useCallback(() => {
    setSelectionPopover((prev) => ({ ...prev, visible: false }));
  }, []);

  return {
    onMouseMove,
    tooltip,
    filePopover,
    isRemoteMode,
    selectionPopover,
    handleOpenInEditor,
    handleShowInExplorer,
    closeTooltip,
    closeFilePopover,
    closeSelectionPopover,
  };
}
