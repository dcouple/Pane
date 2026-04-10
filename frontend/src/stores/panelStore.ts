import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { PanelStore } from '../types/panelStore';
import { ToolPanel } from '../../../shared/types/panels';

// FIX: Use immer for safe immutable updates
export const usePanelStore = create<PanelStore>()(
  immer((set, get) => ({
    panels: {},
    activePanels: {},
    activityStatus: {},

    // Pure synchronous state updates
    setPanels: (sessionId, panels) => {
      set((state) => {
        // Replace panels array entirely to ensure React detects changes
        state.panels[sessionId] = panels;
      });
    },

    setActivePanel: (sessionId, panelId) => {
      set((state) => {
        state.activePanels[sessionId] = panelId;
      });
    },

    addPanel: (panel) => {
      set((state) => {
        if (!state.panels[panel.sessionId]) {
          state.panels[panel.sessionId] = [];
        }
        // Check if panel already exists to prevent duplicates
        const existing = state.panels[panel.sessionId].find((p: ToolPanel) => p.id === panel.id);
        if (!existing) {
          state.panels[panel.sessionId].push(panel);
          state.activePanels[panel.sessionId] = panel.id;
        }
      });
    },

    removePanel: (sessionId, panelId) => {
      set((state) => {
        if (state.panels[sessionId]) {
          state.panels[sessionId] = state.panels[sessionId].filter((p: ToolPanel) => p.id !== panelId);
        }
        // Clear active panel if it was the removed one
        if (state.activePanels[sessionId] === panelId) {
          delete state.activePanels[sessionId];
        }
        delete state.activityStatus[panelId];
      });
    },

    updatePanelState: (panel) => {
      set((state) => {
        const sessionPanels = state.panels[panel.sessionId];
        if (sessionPanels) {
          const index = sessionPanels.findIndex((p: ToolPanel) => p.id === panel.id);
          if (index !== -1) {
            sessionPanels[index] = panel;
          }
        }
      });
    },

    setActivityStatus: (panelId, status) => {
      set((state) => {
        state.activityStatus[panelId] = status;
      });
    },

    clearActivityStatus: (panelId) => {
      set((state) => {
        delete state.activityStatus[panelId];
      });
    },

    // Getters remain the same
    getSessionPanels: (sessionId) => get().panels[sessionId] || [],
    getActivePanel: (sessionId) => {
      const panels = get().panels[sessionId] || [];
      return panels.find(p => p.id === get().activePanels[sessionId]);
    },
    getPanelActivityStatus: (panelId) => get().activityStatus[panelId] || 'idle',
    getSessionActivityStatus: (sessionId) => {
      const sessionPanels = get().panels[sessionId] || [];
      const actStatus = get().activityStatus;
      return sessionPanels.some((p) => actStatus[p.id] === 'active') ? 'active' : 'idle';
    },
  }))
);