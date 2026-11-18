CREATE TABLE team_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager', 'viewer')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
CREATE INDEX sessions_by_user ON sessions(user_id);
