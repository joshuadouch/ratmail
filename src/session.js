// Sessions without server-side secrets.
//
// At login the password is encrypted (AES-GCM) with a fresh random key.
// The ciphertext goes into D1; the key goes only into the browser's
// HttpOnly cookie. Each request brings the key back, the Worker decrypts the
// password in memory and talks to the mail server. Neither the database nor
// the cookie alone can reveal the password, and the Worker holds no secret.

import { b64url, b64urlToBytes, bytesToB64, b64ToBytes } from './bytes.js';

export const COOKIE = 'ratmail_session';
const DAY = 86400;
const REMEMBER_TTL = 30 * DAY; // "Stay signed in"
const SESSION_TTL = 12 * 3600; // otherwise: 12 hours idle

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function userKey(serverId, username) {
  return sha256Hex(`${serverId}\n${username.trim().toLowerCase()}`);
}

function aad(id, server, username) {
  return enc.encode(`${id}\n${server}\n${username}`);
}

function now() {
  return Math.floor(Date.now() / 1000);
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieHeader(value, maxAge, secure) {
  const attrs = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) attrs.push('Secure');
  if (maxAge !== null) attrs.push(`Max-Age=${maxAge}`);
  return attrs.join('; ');
}

export function clearCookie(secure) {
  return cookieHeader('', 0, secure);
}

/** Creates a session row and returns the Set-Cookie header value. */
export async function createSession(env, { server, username, password, remember, agent, secure }) {
  const id = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id, server, username) }, key, enc.encode(password)));
  const t = now();
  const ttl = remember ? REMEMBER_TTL : SESSION_TTL;
  await env.DB.prepare(
    `INSERT INTO sessions (id_hash, user_key, server, username, secret, iv, remember, created_at, last_seen, expires_at, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(id), await userKey(server, username), server, username, bytesToB64(ct), bytesToB64(iv), remember ? 1 : 0, t, t, t + ttl, (agent || '').slice(0, 200))
    .run();
  // Tidy up expired sessions now and then.
  if (Math.random() < 0.2) await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t).run();
  return cookieHeader(`${id}.${b64url(rawKey)}`, remember ? REMEMBER_TTL : null, secure);
}

/**
 * Reads the session from the request cookie.
 * Returns { idHash, server, username, password, userKey, remember } or null.
 */
export async function loadSession(env, request) {
  const value = parseCookies(request.headers.get('cookie'))[COOKIE];
  if (!value || !value.includes('.')) return null;
  const [id, keyText] = value.split('.');
  let rawKey;
  try {
    rawKey = b64urlToBytes(keyText);
    if (rawKey.length !== 32) return null;
  } catch {
    return null;
  }
  const idHash = await sha256Hex(id);
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE id_hash = ?').bind(idHash).first();
  const t = now();
  if (!row || row.expires_at < t) return null;
  let password;
  try {
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(row.iv), additionalData: aad(id, row.server, row.username) }, key, b64ToBytes(row.secret));
    password = dec.decode(pt);
  } catch {
    return null;
  }
  // Slide the expiry, at most once every 5 minutes to keep D1 writes low.
  if (t - row.last_seen > 300) {
    const ttl = row.remember ? REMEMBER_TTL : SESSION_TTL;
    await env.DB.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id_hash = ?').bind(t, t + ttl, idHash).run();
  }
  return { idHash, server: row.server, username: row.username, password, userKey: row.user_key, remember: !!row.remember, createdAt: row.created_at };
}

export async function deleteSession(env, idHash) {
  await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run();
}

export async function listSessions(env, uKey) {
  const { results } = await env.DB.prepare('SELECT id_hash, created_at, last_seen, expires_at, agent, remember FROM sessions WHERE user_key = ? AND expires_at > ? ORDER BY last_seen DESC')
    .bind(uKey, now())
    .all();
  return results;
}

export async function deleteOtherSessions(env, uKey, keepIdHash) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_key = ? AND id_hash != ?').bind(uKey, keepIdHash).run();
}

export async function getPrefs(env, uKey) {
  const row = await env.DB.prepare('SELECT data FROM prefs WHERE user_key = ?').bind(uKey).first();
  try {
    return row ? JSON.parse(row.data) : {};
  } catch {
    return {};
  }
}

export async function savePrefs(env, uKey, data) {
  const text = JSON.stringify(data);
  if (text.length > 64 * 1024) throw new Error('Settings are too large');
  await env.DB.prepare('INSERT INTO prefs (user_key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .bind(uKey, text, now())
    .run();
}
