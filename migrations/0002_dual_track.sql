-- migrations/0002_dual_track.sql

ALTER TABLE invite_slots ADD COLUMN track TEXT NOT NULL DEFAULT 'newbie';
ALTER TABLE queue_entries ADD COLUMN track TEXT NOT NULL DEFAULT 'newbie';

DROP INDEX IF EXISTS idx_queue_entries_active_user;

-- 已確認的排隊紀錄不再占用唯一性，community 軌可重複領取。
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_entries_active_user
  ON queue_entries(user_id)
  WHERE status IN ('waiting', 'reserved', 'revealed');

-- 新手軌每個使用者終身只能有 1 筆已確認的排隊紀錄。
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_entries_newbie_confirmed
  ON queue_entries(user_id)
  WHERE track = 'newbie' AND status = 'confirmed';

-- 配對與看板分軌統計依 track 分組。
CREATE INDEX IF NOT EXISTS idx_invite_slots_track_status
  ON invite_slots(track, status, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_entries_track_waiting
  ON queue_entries(track, status, priority DESC, created_at ASC, id ASC);
