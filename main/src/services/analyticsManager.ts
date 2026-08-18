import { EventEmitter } from 'events';
import type { ConfigManager } from './configManager';
import { app, BrowserWindow } from 'electron';
import * as crypto from 'crypto';
import * as os from 'os';

export class AnalyticsManager extends EventEmitter {
  private configManager: ConfigManager;
  private mainWindow: BrowserWindow | null = null;

  constructor(configManager: ConfigManager) {
    super();
    this.configManager = configManager;
  }

  /**
   * Set the main window reference for IPC forwarding
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Track an event by forwarding to renderer via IPC
   */
  track(eventName: string, properties?: Record<string, string | number | boolean | string[] | undefined>): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.webContents) return;

    const enhanced = {
      ...properties,
      app_version: app.getVersion(),
      platform: os.platform(),
      electron_version: process.versions.electron,
    };

    const cleaned = Object.fromEntries(
      Object.entries(enhanced).filter(([_, v]) => v !== undefined)
    );

    try {
      this.mainWindow.webContents.send('analytics:main-event', { eventName, properties: cleaned });
    } catch {
      // Renderer may be crashed/reloading — swallow so callers aren't affected
      return;
    }

    if (this.configManager.isVerbose()) {
      console.log(`[Analytics] Forwarded to renderer: ${eventName}`, cleaned);
    }
  }

  /**
   * Helper to hash session IDs for privacy
   */
  hashSessionId(sessionId: string): string {
    return crypto.createHash('sha256').update(sessionId).digest('hex').substring(0, 16);
  }

  /**
   * Categorize numeric values for privacy
   */
  categorizeNumber(value: number, thresholds: number[]): string {
    for (let i = 0; i < thresholds.length; i++) {
      if (value <= thresholds[i]) {
        return i === 0 ? `0-${thresholds[i]}` : `${thresholds[i - 1] + 1}-${thresholds[i]}`;
      }
    }
    return `${thresholds[thresholds.length - 1] + 1}+`;
  }

  /**
   * Categorize duration for privacy
   */
  categorizeDuration(seconds: number): string {
    if (seconds < 10) return '0-10s';
    if (seconds < 30) return '10-30s';
    if (seconds < 60) return '30-60s';
    if (seconds < 300) return '1-5m';
    if (seconds < 600) return '5-10m';
    if (seconds < 1800) return '10-30m';
    if (seconds < 3600) return '30-60m';
    return '60m+';
  }

  /**
   * Categorize prompt length for privacy
   */
  categorizePromptLength(length: number): string {
    if (length < 50) return 'short';
    if (length < 200) return 'medium';
    if (length < 500) return 'long';
    return 'very_long';
  }

  /**
   * Check if analytics is enabled
   */
  isEnabled(): boolean {
    return this.configManager.isAnalyticsEnabled();
  }
}
