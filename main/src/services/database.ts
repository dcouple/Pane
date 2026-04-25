import { DatabaseService } from '../database/database';
import { join } from 'path';
import { getAppDirectory } from '../utils/appDirectory';
import { ScrollbackRetentionService, RetentionSweepResult } from './scrollbackRetention';

// Create and export a singleton instance
const dbPath = join(getAppDirectory(), 'sessions.db');
export const databaseService = new DatabaseService(dbPath);

// Initialize the database schema and run migrations
databaseService.initialize();

// Scrollback retention sweep: runs synchronously at module load, which happens
// before panelManager's constructor caches any panels into RAM. Deferring this
// (e.g. via a setTimeout in app.whenReady) would let the in-memory panel cache
// keep the stale scrollback for the whole first launch even after the DB is
// trimmed. Result is captured here and logged later once Logger is initialized.
export const startupRetentionResult: {
  readonly result: RetentionSweepResult | null;
  readonly error: Error | null;
} = (() => {
  try {
    return {
      result: new ScrollbackRetentionService(databaseService).runRetentionSweep(),
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
})();