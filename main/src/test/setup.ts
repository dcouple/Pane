// Test setup file for Vitest
import { vi } from 'vitest';

export const app = {
  getPath: vi.fn(() => '/mock/path'),
  getName: vi.fn(() => 'Pane'),
  getVersion: vi.fn(() => '0.1.0'),
};

export const ipcMain = {
  handle: vi.fn(),
  on: vi.fn(),
  removeHandler: vi.fn(),
};

export const powerSaveBlocker = {
  start: vi.fn(() => 1),
  stop: vi.fn(),
  isStarted: vi.fn(() => false),
};

export const BrowserWindow = vi.fn();

// Set up global test environment
global.console = {
  ...console,
  // Suppress logs during tests unless debugging
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
