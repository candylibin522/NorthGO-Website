CREATE TABLE team_users_next (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'viewer')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  deleted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT INTO team_users_next (id, username, salt, password_hash, role, enabled)
SELECT id, username, salt, password_hash, role, enabled FROM team_users;
DROP TABLE team_users;
ALTER TABLE team_users_next RENAME TO team_users;
