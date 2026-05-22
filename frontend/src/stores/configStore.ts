import { create } from 'zustand';
import { API } from '../utils/api';
import type { AppConfig, UpdateConfigRequest } from '../types/config';

interface ConfigStore {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;
  fetchConfig: () => Promise<void>;
  updateConfig: (updates: UpdateConfigRequest) => Promise<void>;
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  fetchConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await API.config.get();
      if (response.success && response.data) {
        set({ config: response.data, isLoading: false });
      } else {
        set({ error: response.error || 'Failed to fetch config', isLoading: false });
      }
    } catch {
      set({ error: 'Failed to fetch config', isLoading: false });
    }
  },

  updateConfig: async (updates: UpdateConfigRequest) => {
    try {
      const response = await API.config.update(updates);
      if (response.success) {
        // Refetch to ensure we have the latest config
        await get().fetchConfig();
      } else {
        const msg = response.error || 'Failed to update config';
        set({ error: msg });
        throw new Error(msg);
      }
    } catch (error) {
      if (error instanceof Error && get().error) {
        // Already set above — re-throw so callers can react
        throw error;
      }
      set({ error: 'Failed to update config' });
      throw new Error('Failed to update config');
    }
  },
}));
