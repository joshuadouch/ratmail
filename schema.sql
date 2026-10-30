-- ratmail keeps no mail. Only sessions and per-user UI preferences.

-- One row per signed-in browser. The password is stored encrypted (AES-GCM).
-- The key is not here: it lives only in the browser's session cookie, so this
-- table alone cannot reveal a password. `id_hash` is SHA-256 of the session id.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash     TEXT PRIMARY KEY,
  user_key    TEXT NOT NULL,          -- SHA-256 of server id + username
  server      TEXT NOT NULL,
  username    TEXT NOT NULL,
  secret      TEXT NOT NULL,          -- base64 AES-GCM ciphertext of the password
  iv          TEXT NOT NULL,
  remember    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  agent       TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_key);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- UI settings (theme, layout, signature, trusted image senders) so they follow
-- the user between devices.
CREATE TABLE IF NOT EXISTS prefs (
  user_key    TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
