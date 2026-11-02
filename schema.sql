-- ratmail keeps no mail. Only sessions, per-user UI preferences and the
-- logins for extra mail accounts (encrypted).

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
  agent       TEXT,
  vault       TEXT,                   -- "<vault id>.<vault key encrypted with the cookie key>"
  vault_iv    TEXT
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

-- Extra mail accounts (Settings > Accounts). The Worker also creates these
-- tables (and the two sessions columns above) by itself on older installs.
--
-- Each user has one vault key. It is stored here only wrapped with a key
-- derived (PBKDF2) from their sign-in password, and copied into each session
-- encrypted with that session's cookie key.
CREATE TABLE IF NOT EXISTS vaults (
  user_key    TEXT PRIMARY KEY,
  vault_id    TEXT NOT NULL,
  salt        TEXT NOT NULL,
  wrapped     TEXT NOT NULL,          -- vault key, AES-GCM with the password-derived key
  iv          TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- One row per extra account. `data` is the public part (address, servers,
-- username); `secret` is its password encrypted with the vault key.
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  user_key    TEXT NOT NULL,
  vault_id    TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL,
  secret      TEXT NOT NULL,
  iv          TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_user ON accounts (user_key);
