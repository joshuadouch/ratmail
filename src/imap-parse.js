// Pure helpers for the IMAP client (no sockets), so they can be unit tested.

import { decodeWords, utf8Decode, utf8Encode } from './bytes.js';

// ---------------------------------------------------------------------------
// Response parsing

/**
 * Parses IMAP response tokens: atoms, "quoted", {literal}, NIL and (lists).
 * Atoms like BODY[HEADER.FIELDS (A B)]<0> are kept whole.
 * NIL becomes null. Strings come back as binary strings.
 */
export function parseTokens(s) {
  let i = 0;
  const n = s.length;
  function list(closer) {
    const out = [];
    while (i < n) {
      const c = s[i];
      if (c === ' ') { i++; continue; }
      if (c === closer) { i++; return out; }
      if (c === '(') { i++; out.push(list(')')); continue; }
      if (c === '"') {
        i++;
        let v = '';
        while (i < n && s[i] !== '"') {
          if (s[i] === '\\') i++;
          v += s[i++];
        }
        i++;
        out.push(v);
        continue;
      }
      if (c === '{') {
        const close = s.indexOf('}', i);
        const len = parseInt(s.slice(i + 1, close), 10);
        i = close + 1;
        if (s[i] === '\r') i += 2;
        out.push(s.slice(i, i + len));
        i += len;
        continue;
      }
      // atom
      let v = '';
      while (i < n) {
        const ch = s[i];
        if (ch === ' ' || ch === '(' || ch === ')') break;
        if (ch === '[') {
          let depth = 0;
          while (i < n) {
            const x = s[i];
            v += x;
            i++;
            if (x === '[') depth++;
            else if (x === ']' && --depth === 0) break;
          }
          continue;
        }
        v += ch;
        i++;
      }
      out.push(v === 'NIL' ? null : v);
    }
    return out;
  }
  return list(null);
}

/** Turns a FETCH item list into an object keyed by upper-case item name. */
export function fetchObject(items) {
  const obj = {};
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = String(items[i]).toUpperCase().replace(/^BODY\.PEEK/, 'BODY');
    obj[key] = items[i + 1];
  }
  return obj;
}

/** Expands "3,7:5,9" into [3,7,6,5,9], keeping the written direction of ranges. */
export function expandSet(set) {
  const out = [];
  for (const part of set.split(',')) {
    const [a, b] = part.split(':').map(Number);
    if (b === undefined) { out.push(a); continue; }
    const step = a <= b ? 1 : -1;
    for (let x = a; step > 0 ? x <= b : x >= b; x += step) out.push(x);
  }
  return out;
}

export function quote(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ---------------------------------------------------------------------------
// Envelope / body structure helpers

export function parseAddresses(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!Array.isArray(a)) continue;
    const [name, , mailbox, host] = a;
    if (host == null) continue; // group start/end markers
    out.push({
      name: decodeWords(utf8Decode(name || '')).trim(),
      email: mailbox ? `${utf8Decode(mailbox)}@${utf8Decode(host)}` : '',
    });
  }
  return out;
}

export function parseEnvelope(env) {
  if (!Array.isArray(env)) return {};
  const [date, subject, from, sender, replyTo, to, cc, bcc, inReplyTo, messageId] = env;
  return {
    date: date ? new Date(date).toISOString() : null,
    subject: decodeWords(utf8Decode(subject || '')),
    from: parseAddresses(from),
    sender: parseAddresses(sender),
    replyTo: parseAddresses(replyTo),
    to: parseAddresses(to),
    cc: parseAddresses(cc),
    bcc: parseAddresses(bcc),
    inReplyTo: inReplyTo || null,
    messageId: messageId || null,
  };
}

/** True when a BODYSTRUCTURE contains something that looks like an attachment. */
export function hasAttachment(bs, parentSubtype = '') {
  if (!Array.isArray(bs)) return false;
  if (Array.isArray(bs[0])) {
    // multipart: parts..., subtype, ...
    let k = 0;
    while (Array.isArray(bs[k])) k++;
    const subtype = String(bs[k] || '').toUpperCase();
    for (let j = 0; j < k; j++) if (hasAttachment(bs[j], subtype)) return true;
    return false;
  }
  const type = String(bs[0] || '').toUpperCase();
  const params = Array.isArray(bs[2]) ? bs[2].map((x) => String(x || '').toUpperCase()) : [];
  // the disposition is a (TYPE (params)) list somewhere after the basic fields
  let disposition = '';
  for (let j = 7; j < bs.length; j++) {
    const v = bs[j];
    if (Array.isArray(v) && typeof v[0] === 'string' && /^(ATTACHMENT|INLINE)$/i.test(v[0]) && (v[1] === null || Array.isArray(v[1]))) {
      disposition = v[0].toUpperCase();
      break;
    }
  }
  if (disposition === 'ATTACHMENT') return true;
  if (type === 'TEXT' || type === 'MULTIPART') return false;
  if (parentSubtype === 'RELATED') return false; // inline images of an HTML body
  return params.includes('NAME') || disposition === 'INLINE' ? type !== 'TEXT' : type === 'APPLICATION';
}

/** Builds UID SEARCH criteria for a free-text query and options. */
export function searchCriteria(q, { scope = 'all' } = {}) {
  const lit = (s) => ({ literal: utf8Encode(s) });
  const words = (q || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const parts = [];
  for (const w of words) {
    let crit;
    if (scope === 'from') crit = ['FROM ', lit(w)];
    else if (scope === 'to') crit = ['OR TO ', lit(w), ' CC ', lit(w)];
    else if (scope === 'subject') crit = ['SUBJECT ', lit(w)];
    else if (scope === 'body') crit = ['BODY ', lit(w)];
    else crit = ['OR OR OR FROM ', lit(w), ' TO ', lit(w), ' SUBJECT ', lit(w), ' BODY ', lit(w)];
    if (parts.length) parts.push(' ');
    parts.push(...crit);
  }
  if (!parts.length) parts.push('ALL');
  return parts;
}
