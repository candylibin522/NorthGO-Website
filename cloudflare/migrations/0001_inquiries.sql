CREATE TABLE IF NOT EXISTS administrator (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  reference TEXT PRIMARY KEY,
  original_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS enquiries (
  reference TEXT PRIMARY KEY REFERENCES receipts(reference),
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  assignee TEXT NOT NULL,
  notes TEXT NOT NULL,
  corrections TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL,
  actor TEXT NOT NULL,
  happened_at TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_by_date ON receipts(received_at);
CREATE INDEX IF NOT EXISTS history_by_reference ON history(reference, id);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
