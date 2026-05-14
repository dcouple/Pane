import type { App, BrowserWindow } from 'electron';
import type { CoreServices } from '../core/services';
import type { TaskQueue } from '../services/taskQueue';
import type { AnalyticsManager } from '../services/analyticsManager';
import type { SpotlightManager } from '../services/spotlightManager';

export interface AppServices extends CoreServices {
  app: App;
  taskQueue: TaskQueue | null;
  getMainWindow: () => BrowserWindow | null;
  analyticsManager?: AnalyticsManager;
  spotlightManager: SpotlightManager;
}
