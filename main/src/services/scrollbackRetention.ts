import type { DatabaseService } from '../database/database';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const RETENTION_DAYS = 21;

export interface RetentionSweepResult {
  panelsCleared: number;
  sessionsTouched: number;
  bytesFreed: number;
}

/**
 * Drops persisted terminal bytes for panels of sessions archived more than
 * RETENTION_DAYS ago. Bytes live in `panel_buffers`, never in
 * `tool_panels.state`, so the sweep deletes rows there.
 */
export class ScrollbackRetentionService {
  constructor(private db: DatabaseService) {}

  runRetentionSweep(): RetentionSweepResult {
    const sqlite = this.db.getDb();

    const targetSessions = decodeBoundary(sqlite
      .prepare(
        `SELECT id FROM sessions
         WHERE archived = 1
           AND (last_viewed_at IS NULL OR last_viewed_at < datetime('now', ?))`
      )
      .all(`-${RETENTION_DAYS} days`), boundary.array(boundary.object({ id: boundary.string })));

    if (targetSessions.length === 0) {
      return { panelsCleared: 0, sessionsTouched: 0, bytesFreed: 0 };
    }

    const idsJson = JSON.stringify(targetSessions.map(s => s.id));
    const panelFilter = `panel_id IN (
      SELECT id FROM tool_panels WHERE session_id IN (SELECT value FROM json_each(?))
    )`;

    const sizeRow = decodeBoundary(sqlite
      .prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes FROM panel_buffers WHERE ${panelFilter}`)
      .get(idsJson), boundary.object({ bytes: boundary.number }));

    const result = sqlite
      .prepare(`DELETE FROM panel_buffers WHERE ${panelFilter}`)
      .run(idsJson);

    return {
      panelsCleared: result.changes,
      sessionsTouched: targetSessions.length,
      bytesFreed: sizeRow.bytes,
    };
  }
}
