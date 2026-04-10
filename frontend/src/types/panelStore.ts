import { ToolPanel } from '../../../shared/types/panels';

export interface PanelStore {
  // State (using plain objects instead of Maps for React reactivity)
  panels: Record<string, ToolPanel[]>;        // sessionId -> panels
  activePanels: Record<string, string>;       // sessionId -> active panelId
  activityStatus: Record<string, 'active' | 'idle'>; // panelId -> status

  // Synchronous state update actions
  setPanels: (sessionId: string, panels: ToolPanel[]) => void;
  setActivePanel: (sessionId: string, panelId: string) => void;
  addPanel: (panel: ToolPanel) => void;
  removePanel: (sessionId: string, panelId: string) => void;
  updatePanelState: (panel: ToolPanel) => void;
  setActivityStatus: (panelId: string, status: 'active' | 'idle') => void;
  clearActivityStatus: (panelId: string) => void;

  // Getters
  getSessionPanels: (sessionId: string) => ToolPanel[];
  getActivePanel: (sessionId: string) => ToolPanel | undefined;
  getPanelActivityStatus: (panelId: string) => 'active' | 'idle';
  getSessionActivityStatus: (sessionId: string) => 'active' | 'idle';
}