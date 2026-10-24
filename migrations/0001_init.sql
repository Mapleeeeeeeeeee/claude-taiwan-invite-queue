-- migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  invalid_retry_count INTEGER NOT NULL DEFAULT 0,
  invalid_link_strike_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_user_id INTEGER NOT NULL,
  referral_code TEXT NOT NULL UNIQUE,
  normalized_url TEXT NOT NULL,
  total_slots INTEGER NOT NULL CHECK (total_slots IN (1, 2, 3)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (provider_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_invite_links_provider ON invite_links(provider_user_id);

CREATE TABLE IF NOT EXISTS invite_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL,
  slot_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'reserved', 'revealed', 'confirmed', 'invalidated', 'closed')),
  assigned_user_id INTEGER,
  reserved_at TEXT,
  reserve_expires_at TEXT,
  revealed_at TEXT,
  confirm_expires_at TEXT,
  confirmed_at TEXT,
  invalidated_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (link_id) REFERENCES invite_links(id),
  FOREIGN KEY (assigned_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_invite_slots_status ON invite_slots(status, created_at);
CREATE INDEX IF NOT EXISTS idx_invite_slots_link_id ON invite_slots(link_id);
CREATE INDEX IF NOT EXISTS idx_invite_slots_assigned_user ON invite_slots(assigned_user_id);

CREATE TABLE IF NOT EXISTS queue_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'reserved', 'revealed', 'confirmed', 'expired', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  thank_you_message TEXT NOT NULL,
  slot_id INTEGER,
  reserve_expires_at TEXT,
  confirm_expires_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (slot_id) REFERENCES invite_slots(id)
);

CREATE INDEX IF NOT EXISTS idx_queue_entries_waiting_order ON queue_entries(status, priority DESC, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_queue_entries_user_id ON queue_entries(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_queue_entries_slot_id ON queue_entries(slot_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_entries_active_user ON queue_entries(user_id) WHERE status IN ('waiting', 'reserved', 'revealed', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_queue_entries_confirmed_order ON queue_entries(status, confirmed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_queue_entries_reserve_expires ON queue_entries(status, reserve_expires_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_queue_entries_confirm_expires ON queue_entries(status, confirm_expires_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
