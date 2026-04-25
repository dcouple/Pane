import type { DatabaseService } from '../database/database';

const RETENTION_DAYS = 21;

export interface RetentionSweepResult {
  panelsCleared: number;
  sessionsTouched: number;
  bytesFreed: number;
}

export class ScrollbackRetentionService {
  constructor(private db: DatabaseService) {}

  runRetentionSweep(): RetentionSweepResult {
    const sqlite = this.db.getDb();

    const targetSessions = sqlite
      .prepare(
        `SELECT id FROM sessions
         WHERE archived = 1
           AND (last_viewed_at IS NULL OR last_viewed_at < datetime('now', ?))`
      )
      .all(`-${RETENTION_DAYS} days`) as { id: string }[];

    if (targetSessions.length === 0) {
      return { panelsCleared: 0, sessionsTouched: 0, bytesFreed: 0 };
    }

    const idsJson = JSON.stringify(targetSessions.map(s => s.id));

    const sizeRow = sqlite
      .prepare(
        `SELECT COALESCE(SUM(
           COALESCE(LENGTH(json_extract(state, '$.customState.scrollbackBuffer')), 0) +
           COALESCE(LENGTH(json_extract(state, '$.customState.serializedBuffer')), 0)
         ), 0) AS bytes
         FROM tool_panels
         WHERE session_id IN (SELECT value FROM json_each(?))
           AND (
             json_extract(state, '$.customState.scrollbackBuffer') IS NOT NULL
             OR json_extract(state, '$.customState.serializedBuffer') IS NOT NULL
           )`
      )
      .get(idsJson) as { bytes: number };

    const result = sqlite
      .prepare(
        `UPDATE tool_panels
         SET state = json_remove(state, '$.customState.scrollbackBuffer', '$.customState.serializedBuffer')
         WHERE session_id IN (SELECT value FROM json_each(?))
           AND (
             json_extract(state, '$.customState.scrollbackBuffer') IS NOT NULL
             OR json_extract(state, '$.customState.serializedBuffer') IS NOT NULL
           )`
      )
      .run(idsJson);

    return {
      panelsCleared: result.changes,
      sessionsTouched: targetSessions.length,
      bytesFreed: sizeRow.bytes,
    };
  }
}
