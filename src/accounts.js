// Extra mail accounts (Gmail, Yahoo, Outlook, any IMAP/SMTP server) that a
// signed-in user adds under Settings > Accounts.
//
// Their passwords are stored encrypted in D1 without giving the Worker a
// secret:
//
//   - Each user has a random "vault key" (AES-GCM, 256 bit).
//   - The vault key is stored wrapped with a key derived (PBKDF2) from the
//     user's own sign-in password, which the Worker only sees at sign-in.
//   - At sign-in the vault key is unwrapped and copied into the session row,
//     encrypted with that session's cookie key (see session.js).
//   - Each extra account's password is encrypted with the vault key.
//
// So the database alone reveals nothing, and nothing works without either the
// sign-in password or a live session cookie. If the sign-in password changes,
// the old vault cannot be opened: a new one is made and the extra accounts ask
// for their passwords again.

import { b64url, bytesToB64, b64ToBytes } from './bytes.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PBKDF2_ROUNDS = 100000; // the most Workers allows
export const MAX_ACCOUNTS = 20;

function now() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Schema. Older installs only have sessions + prefs, so add what is missing
// the first time an isolate needs it (no manual migration step).

let schemaReady = null;

export function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS vaults (
          user_key TEXT PRIMARY KEY, vault_id TEXT NOT NULL, salt TEXT NOT NULL,
          wrapped TEXT NOT NULL, iv TEXT NOT NULL, created_at INTEGER NOT NULL)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY, user_key TEXT NOT NULL, vault_id TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL,
          secret TEXT NOT NULL, iv TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS accounts_user ON accounts (user_key)'),
      ]);
      try {
        await env.DB.prepare('SELECT vault FROM sessions LIMIT 0').all();
      } catch {
        await env.DB.batch([env.DB.prepare('ALTER TABLE sessions ADD COLUMN vault TEXT'), env.DB.prepare('ALTER TABLE sessions ADD COLUMN vault_iv TEXT')]);
      }
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Vault

async function passwordKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ROUNDS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * Called at sign-in with the password that just worked. Returns
 * { vaultId, key } where key is the raw 32-byte vault key.
 */
export async function openVault(env, userKey, password) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT * FROM vaults WHERE user_key = ?').bind(userKey).first();
  if (row) {
    try {
      const kek = await passwordKey(password, b64ToBytes(row.salt));
      const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(row.iv), additionalData: enc.encode(`vault\n${userKey}\n${row.vault_id}`) }, kek, b64ToBytes(row.wrapped));
      return { vaultId: row.vault_id, key: new Uint8Array(raw) };
    } catch {
      // The sign-in password changed since the vault was made. Start a new
      // vault; accounts on the old one show as needing their password.
    }
  }
  const vaultId = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const key = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await passwordKey(password, salt);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`vault\n${userKey}\n${vaultId}`) }, kek, key));
  await env.DB.prepare(
    `INSERT INTO vaults (user_key, vault_id, salt, wrapped, iv, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_key) DO UPDATE SET vault_id = excluded.vault_id, salt = excluded.salt, wrapped = excluded.wrapped, iv = excluded.iv, created_at = excluded.created_at`,
  )
    .bind(userKey, vaultId, bytesToB64(salt), bytesToB64(wrapped), bytesToB64(iv), now())
    .run();
  return { vaultId, key };
}

async function vaultCrypto(sess, usage) {
  if (!sess.vault) throw new VaultMissing();
  return crypto.subtle.importKey('raw', sess.vault.key, 'AES-GCM', false, [usage]);
}

export class VaultMissing extends Error {
  constructor() {
    super('Sign out and sign in again to use your other mail accounts');
  }
}

// ---------------------------------------------------------------------------
// Validation

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const PORTS = { imap: [143, 993], smtp: [465, 587, 2525] };

function cleanServer(kind, s, env) {
  const host = String(s?.host || '').trim().toLowerCase().replace(/\.$/, '');
  const port = Number(s?.port);
  const tls = String(s?.tls || 'on');
  const dev = !!env.ALLOW_PLAINTEXT_ACCOUNTS; // local testing only
  if (!(HOST_RE.test(host) || (dev && /^(127\.0\.0\.1|localhost)$/.test(host)))) throw new Error(`Enter a valid ${kind.toUpperCase()} server name`);
  if (!Number.isInteger(port) || (!PORTS[kind].includes(port) && !dev)) throw new Error(`${kind.toUpperCase()} port must be one of ${PORTS[kind].join(', ')}`);
  if (!['on', 'starttls'].includes(tls) && !(dev && tls === 'off')) throw new Error('Choose SSL/TLS or STARTTLS');
  return { host, port, tls };
}

/** Checks the fields from the settings form. Returns the public part. */
export function cleanAccountInput(body, env) {
  const email = String(body.email || '').trim();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw new Error('Enter a valid email address');
  const username = String(body.username || '').trim() || email;
  return {
    email,
    name: String(body.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100),
    label: String(body.label || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60),
    provider: String(body.provider || 'other').slice(0, 20),
    username: username.slice(0, 200),
    imap: cleanServer('imap', body.imap, env),
    smtp: cleanServer('smtp', body.smtp, env),
  };
}

// ---------------------------------------------------------------------------
// Storage

function aad(id, userKey) {
  return enc.encode(`account\n${id}\n${userKey}`);
}

function publicView(row, sess) {
  const data = JSON.parse(row.data);
  return { id: row.id, ...data, locked: !sess.vault || row.vault_id !== sess.vault.id };
}

export async function listAccounts(env, sess) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare('SELECT id, vault_id, data, position FROM accounts WHERE user_key = ? ORDER BY position, created_at').bind(sess.userKey).all();
  return results.map((r) => publicView(r, sess));
}

export async function saveAccount(env, sess, { id, data, password }) {
  await ensureSchema(env);
  const key = await vaultCrypto(sess, 'encrypt');
  const t = now();
  let existing = null;
  if (id) {
    existing = await env.DB.prepare('SELECT * FROM accounts WHERE id = ? AND user_key = ?').bind(id, sess.userKey).first();
    if (!existing) throw new Error('That account no longer exists');
  } else {
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_key = ?').bind(sess.userKey).first();
    if (n >= MAX_ACCOUNTS) throw new Error(`You can add up to ${MAX_ACCOUNTS} accounts`);
    id = b64url(crypto.getRandomValues(new Uint8Array(9)));
  }
  if (!password && existing) {
    // Keep the old password (only possible while it is readable).
    if (existing.vault_id !== sess.vault.id) throw new Error('Enter the password for this account');
    password = await decryptPassword(sess, existing);
  }
  if (!password) throw new Error('Enter the password for this account');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id, sess.userKey) }, key, enc.encode(password)));
  const text = JSON.stringify(data);
  if (existing) {
    await env.DB.prepare('UPDATE accounts SET vault_id = ?, data = ?, secret = ?, iv = ?, updated_at = ? WHERE id = ? AND user_key = ?')
      .bind(sess.vault.id, text, bytesToB64(ct), bytesToB64(iv), t, id, sess.userKey)
      .run();
  } else {
    const { p } = await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM accounts WHERE user_key = ?').bind(sess.userKey).first();
    await env.DB.prepare('INSERT INTO accounts (id, user_key, vault_id, position, data, secret, iv, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, sess.userKey, sess.vault.id, p, text, bytesToB64(ct), bytesToB64(iv), t, t)
      .run();
  }
  return { id, ...data, locked: false };
}

export async function deleteAccount(env, sess, id) {
  await ensureSchema(env);
  await env.DB.prepare('DELETE FROM accounts WHERE id = ? AND user_key = ?').bind(id, sess.userKey).run();
}

export async function reorderAccounts(env, sess, ids) {
  await ensureSchema(env);
  if (!Array.isArray(ids) || !ids.length) return;
  await env.DB.batch(ids.slice(0, MAX_ACCOUNTS).map((id, i) => env.DB.prepare('UPDATE accounts SET position = ? WHERE id = ? AND user_key = ?').bind(i, String(id), sess.userKey)));
}

async function decryptPassword(sess, row) {
  const key = await vaultCrypto(sess, 'decrypt');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(row.iv), additionalData: aad(row.id, sess.userKey) }, key, b64ToBytes(row.secret));
  return dec.decode(pt);
}

export class AccountLocked extends Error {}

/** Loads one account with its password, for IMAP/SMTP. */
export async function loadAccount(env, sess, id) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT * FROM accounts WHERE id = ? AND user_key = ?').bind(id, sess.userKey).first();
  if (!row) return null;
  const data = JSON.parse(row.data);
  if (!sess.vault) throw new VaultMissing();
  if (row.vault_id !== sess.vault.id) throw new AccountLocked(`Your sign-in password changed, so ${data.email} needs its password again. Open Settings > Accounts to enter it.`);
  return { id: row.id, ...data, password: await decryptPassword(sess, row) };
}

// ---------------------------------------------------------------------------
// Provider presets and auto-detection for the "Add account" form.

export const PROVIDERS = [
  {
    id: 'gmail', name: 'Gmail', domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, tls: 'on' }, smtp: { host: 'smtp.gmail.com', port: 465, tls: 'on' },
    help: 'Google needs an app password: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords. Make sure IMAP is on in Gmail settings.',
    helpUrl: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 'outlook', name: 'Outlook.com / Hotmail', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.co.uk', 'live.co.uk', 'outlook.co.uk'],
    imap: { host: 'outlook.office365.com', port: 993, tls: 'on' }, smtp: { host: 'smtp-mail.outlook.com', port: 587, tls: 'starttls' },
    help: 'Microsoft has turned off password sign-in for other mail apps on most Outlook.com and Microsoft 365 accounts. If your password or app password is refused, this account cannot be added yet.',
    helpUrl: 'https://account.live.com/proofs/AppPassword',
  },
  {
    id: 'yahoo', name: 'Yahoo Mail', domains: ['yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, tls: 'on' }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, tls: 'on' },
    help: 'Yahoo needs an app password: Account security > Generate app password.',
    helpUrl: 'https://login.yahoo.com/account/security/app-passwords',
  },
  {
    id: 'icloud', name: 'iCloud Mail', domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, tls: 'on' }, smtp: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' },
    help: 'Apple needs an app-specific password from account.apple.com (Sign-In and Security > App-Specific Passwords). The username is your iCloud email address.',
    helpUrl: 'https://account.apple.com/account/manage',
  },
  {
    id: 'aol', name: 'AOL Mail', domains: ['aol.com', 'aim.com'],
    imap: { host: 'imap.aol.com', port: 993, tls: 'on' }, smtp: { host: 'smtp.aol.com', port: 465, tls: 'on' },
    help: 'AOL needs an app password: Account security > Generate app password.',
  },
  {
    id: 'fastmail', name: 'Fastmail', domains: ['fastmail.com', 'fastmail.fm'],
    imap: { host: 'imap.fastmail.com', port: 993, tls: 'on' }, smtp: { host: 'smtp.fastmail.com', port: 465, tls: 'on' },
    help: 'Fastmail needs an app password (Settings > Privacy & Security > App passwords).',
  },
  {
    id: 'zoho', name: 'Zoho Mail', domains: ['zoho.com', 'zohomail.com'],
    imap: { host: 'imap.zoho.com', port: 993, tls: 'on' }, smtp: { host: 'smtp.zoho.com', port: 465, tls: 'on' },
    help: 'Turn on IMAP access in Zoho Mail settings. With two-factor sign-in, use an app-specific password.',
  },
  {
    id: 'gmx', name: 'GMX', domains: ['gmx.com', 'gmx.co.uk', 'gmx.net', 'gmx.de'],
    imap: { host: 'imap.gmx.com', port: 993, tls: 'on' }, smtp: { host: 'mail.gmx.com', port: 587, tls: 'starttls' },
    help: 'Turn on "POP3 and IMAP access" in GMX settings first.',
  },
];

function xmlServer(block) {
  const tag = (t) => (new RegExp(`<${t}>([^<]*)</${t}>`, 'i').exec(block) || [])[1]?.trim();
  const socket = (tag('socketType') || '').toUpperCase();
  return { host: (tag('hostname') || '').toLowerCase(), port: Number(tag('port')), tls: socket === 'SSL' ? 'on' : socket === 'STARTTLS' ? 'starttls' : 'off', username: tag('username') };
}

function pickXml(xml, type) {
  const re = new RegExp(`<(incomingServer|outgoingServer)\\s+type="${type}"[^>]*>([\\s\\S]*?)</\\1>`, 'gi');
  let m;
  while ((m = re.exec(xml))) {
    const s = xmlServer(m[2]);
    if (s.host && s.tls !== 'off') return s;
  }
  return null;
}

/**
 * Finds IMAP/SMTP settings for an email address: built-in presets first,
 * then Thunderbird's public settings database, then the domain's own
 * autoconfig file.
 */
export async function detectSettings(email) {
  const domain = String(email || '').split('@')[1]?.trim().toLowerCase();
  if (!domain || !HOST_RE.test(domain)) return null;
  const preset = PROVIDERS.find((p) => p.domains.includes(domain));
  if (preset) return { provider: preset.id, imap: preset.imap, smtp: preset.smtp, username: email };
  const urls = [
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'follow' });
      if (!r.ok) continue;
      const xml = (await r.text()).slice(0, 100000);
      const imap = pickXml(xml, 'imap');
      const smtp = pickXml(xml, 'smtp');
      if (!imap || !smtp) continue;
      const fill = (u) => (u || '%EMAILADDRESS%').replace('%EMAILADDRESS%', email).replace('%EMAILLOCALPART%', email.split('@')[0]).replace('%EMAILDOMAIN%', domain);
      return { provider: 'other', imap: { host: imap.host, port: imap.port, tls: imap.tls }, smtp: { host: smtp.host, port: smtp.port, tls: smtp.tls }, username: fill(imap.username) };
    } catch {}
  }
  return null;
}
