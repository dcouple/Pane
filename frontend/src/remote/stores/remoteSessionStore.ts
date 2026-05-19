import { create } from 'zustand';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { Session } from '../../types/session';
import type { RemoteProjectWithSessions } from '../runtime/remoteRuntimeAdapter';

interface RemoteSessionState {
  projects: RemoteProjectWithSessions[];
  selectedSessionId: string | null;
  selectedPanelId: string | null;
  panelsBySessionId: Record<string, ToolPanel[]>;
  setProjects: (projects: RemoteProjectWithSessions[]) => void;
  selectSession: (sessionId: string | null) => void;
  setPanels: (sessionId: string, panels: ToolPanel[]) => void;
  setSelectedPanel: (panelId: string | null) => void;
  upsertPanel: (panel: ToolPanel) => void;
  removePanel: (sessionId: string, panelId: string) => void;
  getSelectedSession: () => Session | null;
  getSelectedPanels: () => ToolPanel[];
}

export const useRemoteSessionStore = create<RemoteSessionState>((set, get) => ({
  projects: [],
  selectedSessionId: null,
  selectedPanelId: null,
  panelsBySessionId: {},

  setProjects: (projects) => set((state) => ({
    projects,
    selectedSessionId: state.selectedSessionId ?? findFirstSessionId(projects),
  })),

  selectSession: (sessionId) => set({
    selectedSessionId: sessionId,
    selectedPanelId: null,
  }),

  setPanels: (sessionId, panels) => set((state) => ({
    panelsBySessionId: {
      ...state.panelsBySessionId,
      [sessionId]: panels,
    },
    selectedPanelId: state.selectedPanelId ?? panels[0]?.id ?? null,
  })),

  setSelectedPanel: (panelId) => set({ selectedPanelId: panelId }),

  upsertPanel: (panel) => set((state) => {
    const panels = state.panelsBySessionId[panel.sessionId] ?? [];
    const nextPanels = panels.some(existing => existing.id === panel.id)
      ? panels.map(existing => existing.id === panel.id ? panel : existing)
      : [...panels, panel];

    return {
      panelsBySessionId: {
        ...state.panelsBySessionId,
        [panel.sessionId]: nextPanels,
      },
      selectedPanelId: state.selectedPanelId ?? panel.id,
    };
  }),

  removePanel: (sessionId, panelId) => set((state) => ({
    panelsBySessionId: {
      ...state.panelsBySessionId,
      [sessionId]: (state.panelsBySessionId[sessionId] ?? []).filter(panel => panel.id !== panelId),
    },
    selectedPanelId: state.selectedPanelId === panelId ? null : state.selectedPanelId,
  })),

  getSelectedSession: () => {
    const { projects, selectedSessionId } = get();
    if (!selectedSessionId) return null;
    for (const project of projects) {
      const session = project.sessions?.find(candidate => candidate.id === selectedSessionId);
      if (session) return session;
    }
    return null;
  },

  getSelectedPanels: () => {
    const { panelsBySessionId, selectedSessionId } = get();
    return selectedSessionId ? panelsBySessionId[selectedSessionId] ?? [] : [];
  },
}));

function findFirstSessionId(projects: RemoteProjectWithSessions[]): string | null {
  for (const project of projects) {
    const session = project.sessions?.[0];
    if (session) {
      return session.id;
    }
  }
  return null;
}
