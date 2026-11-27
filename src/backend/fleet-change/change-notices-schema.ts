/**
 * change-notices-schema.ts — the table behind change-notices.ts: which machine notices
 * each person has already had (told directly, dismissed, or a pop-up one device claimed).
 *
 * No imports: db/index.ts execs this at boot and tests exec it against an in-memory database.
 */
export const CHANGE_NOTICE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS machine_change_notices_seen (
      user_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      notice_key TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, host_id, notice_key),
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );
`;
