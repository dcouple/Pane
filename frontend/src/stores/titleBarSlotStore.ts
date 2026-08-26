import { create } from 'zustand';

/**
 * Mount points inside the window title strip. WindowTitleBar registers them;
 * chrome that belongs on the title plane (the sidebar toggle on the left, the
 * Run / inspector controls on the right) portals into them. Null when the
 * platform keeps its native title bar.
 */
interface TitleBarSlotState {
  trailingSlot: HTMLDivElement | null;
  setTrailingSlot: (element: HTMLDivElement | null) => void;
}

export const useTitleBarSlotStore = create<TitleBarSlotState>((set) => ({
  trailingSlot: null,
  setTrailingSlot: (element) => set({ trailingSlot: element }),
}));
