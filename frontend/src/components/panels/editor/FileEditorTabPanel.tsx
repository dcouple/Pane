import React, { useState, useEffect, useCallback } from 'react';
import { FileEditorView } from './FileEditorView';
import { EditorPanelState, ToolPanel } from '../../../../../shared/types/panels';
import { panelApi } from '../../../services/panelApi';
import { debounce } from '../../../utils/debounce';
import { usePanelStore } from '../../../stores/panelStore';
import { editorTitleFor, pinEditorPanel } from '../../../services/openFileInEditor';

interface FileEditorTabPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}

/** A center `editor` tab: one file, persisted cursor/scroll, pins itself on edit. */
const FileEditorTabPanel: React.FC<FileEditorTabPanelProps> = ({ panel, isActive }) => {
  // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
  const editorState = panel.state?.customState as EditorPanelState | undefined;
  const filePath = editorState?.filePath ?? '';

  useEffect(() => {
    if (isActive && !panel.state?.hasBeenViewed) {
      panelApi.updatePanel(panel.id, { state: { ...panel.state, hasBeenViewed: true } });
    }
  }, [isActive, panel.id, panel.state]);

  const [debouncedUpdate] = useState(() => debounce((panelId: string, sessionId: string, newState: Partial<EditorPanelState>) => {
    const current = usePanelStore.getState().getSessionPanels(sessionId).find((p) => p.id === panelId);
    if (!current) return;
    // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
    const customState = (current.state?.customState || {}) as EditorPanelState;
    const state = {
      isActive: current.state?.isActive || false,
      isPinned: current.state?.isPinned,
      hasBeenViewed: current.state?.hasBeenViewed,
      customState: { ...customState, ...newState },
    };
    usePanelStore.getState().updatePanelState({ ...current, state });
    panelApi.updatePanel(panelId, { state }).catch((err) => {
      console.error('[FileEditorTabPanel] Failed to update editor panel state:', err);
    });
  }, 500));

  useEffect(() => () => { debouncedUpdate.flush?.(); }, [debouncedUpdate]);
  useEffect(() => {
    const flush = () => debouncedUpdate.flush?.();
    window.addEventListener('session-switched', flush);
    return () => window.removeEventListener('session-switched', flush);
  }, [debouncedUpdate]);
  useEffect(() => {
    if (!isActive) debouncedUpdate.flush?.();
  }, [debouncedUpdate, isActive]);

  const handleStateChange = useCallback((newState: Partial<EditorPanelState>) => {
    debouncedUpdate(panel.id, panel.sessionId, newState);
  }, [debouncedUpdate, panel.id, panel.sessionId]);

  const handleFileChange = useCallback((changedPath: string | undefined, isDirty: boolean) => {
    if (!changedPath) return;
    const title = editorTitleFor(changedPath, isDirty);
    if (title !== panel.title) panelApi.updatePanel(panel.id, { title });
    handleStateChange({ isDirty });
  }, [panel.id, panel.title, handleStateChange]);

  const handleUserEdit = useCallback(() => {
    const current = usePanelStore.getState().getSessionPanels(panel.sessionId).find((p) => p.id === panel.id);
    if (current) void pinEditorPanel(current);
  }, [panel.id, panel.sessionId]);

  if (!isActive) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary">
        <div className="text-center">
          <div className="text-sm">{panel.title}</div>
          <div className="text-xs mt-1 text-text-tertiary">Click to activate</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <FileEditorView
        sessionId={panel.sessionId}
        filePath={filePath}
        initialState={editorState}
        onFileChange={handleFileChange}
        onStateChange={handleStateChange}
        onUserEdit={handleUserEdit}
      />
    </div>
  );
};

export default FileEditorTabPanel;
