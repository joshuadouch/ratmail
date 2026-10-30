// ratmail: an OX App Suite style webmail that runs on Cloudflare Workers.
// Static files come from /public; this Worker answers /api/*.
// Mail stays on the mail server: every request talks IMAP/SMTP live.

import PostalMime from 'postal-mime';
import defaultConfig from '../config/servers.json';
import { ImapClient, ImapError, AuthError, searchCriteria } from './imap.js';
import { sendMail, SmtpError } from './smtp.js';
import { buildMessage } from './mime.js';
import { sanitizeHtml, textToHtml } from './sanitize.js';
import { str2bin, b64decode } from './bytes.js';
import { createSession, loadSession, deleteSession, clearCookie, listSessions, deleteOtherSessions, getPrefs, savePrefs } from './session.js';

// ---------------------------------------------------------------------------
// Config

function getConfig(env) {
  let cfg = defaultConfig;
  if (env.SERVERS_JSON) {
    try {
      cfg = { ...defaultConfig, ...JSON.parse(env.SERVERS_JSON) };
    } catch {}
  }
  return cfg;
}

function findServer(env, id) {
  const cfg = getConfig(env);
  return cfg.servers.find((s) => s.id === id) || null;
}

// ---------------------------------------------------------------------------
// Responses

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers } });
}

function fail(status, message, extra = {}) {
  return json({ error: message, ...extra }, status);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function need(value, message) {
  if (value === undefined || value === null || value === '') throw new HttpError(400, message);
  return value;
}

function uidList(v) {
  const list = (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw new HttpError(400, 'No messages given');
  return list;
}

// ---------------------------------------------------------------------------
// Helpers around a logged-in session

async function openImap(env, sess) {
  const server = findServer(env, sess.server);
  if (!server) throw new HttpError(401, 'This mail server is no longer configured');
  return ImapClient.open(server.imap, sess.username, sess.password);
}

async function folderBySpecialUse(imap, use) {
  if (!imap._folders) imap._folders = await imap.listFolders();
  return imap._folders.find((f) => f.specialUse === use) || null;
}

async function ensureFolder(imap, use, fallbackName) {
  const f = await folderBySpecialUse(imap, use);
  if (f) return f.path;
  await imap.createFolder(fallbackName);
  imap._folders = null;
  return fallbackName;
}

function addrOk(a) {
  return a && typeof a.email === 'string' && /^[^\s<>@]+@[^\s<>@]+$/.test(a.email.trim());
}

function cleanAddrs(list) {
  return (Array.isArray(list) ? list : []).filter(addrOk).map((a) => ({ name: String(a.name || '').replace(/[\r\n]/g, ' ').trim(), email: a.email.trim() }));
}

function attachmentUrl(folder, uid, q) {
  return `/api/attachment?folder=${encodeURIComponent(folder)}&uid=${uid}&${q}`;
}

/**
 * Collects attachments for an outgoing message:
 *  - files uploaded with the request
 *  - parts kept from an existing message (forward, or an earlier draft)
 *  - images in the HTML that point at /api/attachment or are data: URIs,
 *    which are turned into inline cid: parts
 */
async function collectAttachments(imap, meta, uploads, html) {
  const attachments = [];
  const parsedCache = new Map();
  const parsed = async (folder, uid) => {
    const k = `${folder}\n${uid}`;
    if (!parsedCache.has(k)) {
      const r = await imap.fetchRaw(folder, uid);
      parsedCache.set(k, r ? await PostalMime.parse(str2bin(r.raw)) : null);
    }
    return parsedCache.get(k);
  };

  for (const keep of Array.isArray(meta.keep) ? meta.keep : []) {
    const p = await parsed(String(keep.folder), +keep.uid);
    const att = p?.attachments?.[+keep.index];
    if (!att) continue;
    attachments.push({ filename: att.filename || 'attachment', contentType: att.mimeType, content: new Uint8Array(att.content) });
  }
  for (const f of uploads) {
    attachments.push({ filename: f.name || 'attachment', contentType: f.type || 'application/octet-stream', content: new Uint8Array(await f.arrayBuffer()) });
  }

  if (html) {
    let n = 0;
    const replacements = [];
    const re = /(<img\b[^>]*?\bsrc=)(["'])(.*?)\2/gi;
    let m;
    while ((m = re.exec(html))) {
      const src = m[3].replace(/&amp;/g, '&');
      let part = null;
      if (src.startsWith('/api/attachment?')) {
        const q = new URLSearchParams(src.split('?')[1]);
        const p = await parsed(q.get('folder'), +q.get('uid'));
        const list = p?.attachments || [];
        const att = q.has('cid') ? list.find((a) => (a.contentId || '').replace(/^<|>$/g, '') === q.get('cid')) : list[+q.get('part')];
        if (att) part = { filename: att.filename || `image${n}`, contentType: att.mimeType, content: new Uint8Array(att.content) };
      } else if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) {
        const [, type] = /^data:([^;]+);/.exec(src);
        part = { filename: `image${n}.${type.split('/')[1]}`, contentType: type, content: str2bin(b64decode(src.split(',')[1])) };
      }
      if (part) {
        part.contentId = `img${n++}.${crypto.randomUUID()}@ratmail`;
        attachments.push(part);
        replacements.push([m[0], `${m[1]}${m[2]}cid:${part.contentId}${m[2]}`]);
      }
    }
    for (const [from, to] of replacements) html = html.replace(from, to);
  }
  return { attachments, html };
}

async function readComposeRequest(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    const meta = JSON.parse(form.get('meta') || '{}');
    const uploads = form.getAll('file').filter((f) => typeof f === 'object');
    return { meta, uploads };
  }
  return { meta: await request.json(), uploads: [] };
}

function composeFields(meta, identityFallback) {
  const from = addrOk(meta.from) ? { name: String(meta.from.name || '').trim(), email: meta.from.email.trim() } : identityFallback;
  return {
    from,
    to: cleanAddrs(meta.to),
    cc: cleanAddrs(meta.cc),
    bcc: cleanAddrs(meta.bcc),
    replyTo: addrOk(meta.replyTo) ? meta.replyTo : null,
    subject: String(meta.subject || '').replace(/[\r\n]+/g, ' '),
    priority: ['high', 'low'].includes(meta.priority) ? meta.priority : null,
    readReceipt: !!meta.readReceipt,
    inReplyTo: /^<[^<>\s]+>$/.test(meta.inReplyTo || '') ? meta.inReplyTo : null,
    references: typeof meta.references === 'string' ? meta.references.replace(/[\r\n]+/g, ' ').slice(0, 4000) : null,
  };
}

// ---------------------------------------------------------------------------
// Route handlers. Each gets (ctx) with { env, request, url, sess, imap() }.

const routes = {
  'GET /api/config': async ({ env }) => {
    const cfg = getConfig(env);
    return json({ brand: cfg.brand || {}, servers: cfg.servers.map((s) => ({ id: s.id, name: s.name, domain: s.domain || null })) });
  },

  'POST /api/login': async ({ env, request, url }) => {
    const body = await request.json().catch(() => ({}));
    const server = findServer(env, body.server);
    if (!server) return fail(400, 'Choose a mail server');
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return fail(400, 'Enter your username and password');
    let imap;
    try {
      imap = await ImapClient.open(server.imap, username, password);
    } catch (err) {
      if (err instanceof AuthError) return fail(401, 'The username or password is incorrect');
      return fail(502, `Could not reach the mail server: ${err.message}`);
    }
    await imap.logout();
    const cookie = await createSession(env, {
      server: server.id,
      username,
      password,
      remember: !!body.remember,
      agent: request.headers.get('user-agent'),
      secure: url.protocol === 'https:',
    });
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  },

  'POST /api/logout': async ({ env, sess, url }) => {
    if (sess) await deleteSession(env, sess.idHash);
    return json({ ok: true }, 200, { 'set-cookie': clearCookie(url.protocol === 'https:') });
  },

  'GET /api/session': async ({ env, sess }) => {
    const server = findServer(env, sess.server);
    const email = sess.username.includes('@') ? sess.username : server?.domain ? `${sess.username}@${server.domain}` : sess.username;
    return json({ username: sess.username, email, server: { id: server?.id, name: server?.name }, prefs: await getPrefs(env, sess.userKey) });
  },

  'PUT /api/prefs': async ({ env, sess, request }) => {
    const data = await request.json();
    await savePrefs(env, sess.userKey, data);
    return json({ ok: true });
  },

  'GET /api/sessions': async ({ env, sess }) => {
    const list = await listSessions(env, sess.userKey);
    return json({ sessions: list.map((s) => ({ current: s.id_hash === sess.idHash, created: s.created_at, lastSeen: s.last_seen, expires: s.expires_at, agent: s.agent, remember: !!s.remember })) });
  },

  'POST /api/sessions/revoke-others': async ({ env, sess }) => {
    await deleteOtherSessions(env, sess.userKey, sess.idHash);
    return json({ ok: true });
  },

  'GET /api/folders': async ({ imap }) => {
    const c = await imap();
    const folders = await c.listFolders();
    return json({ folders });
  },

  'POST /api/folders': async ({ imap, request }) => {
    const body = await request.json();
    const c = await imap();
    if (body.action === 'create') await c.createFolder(need(body.path, 'Folder name missing'));
    else if (body.action === 'rename') await c.renameFolder(need(body.path, 'Folder missing'), need(body.to, 'New name missing'));
    else if (body.action === 'delete') await c.deleteFolder(need(body.path, 'Folder missing'));
    else if (body.action === 'markRead') await c.markAllRead(need(body.path, 'Folder missing'));
    else if (body.action === 'empty') await c.emptyFolder(need(body.path, 'Folder missing'));
    else return fail(400, 'Unknown folder action');
    return json({ ok: true });
  },

  'GET /api/messages': async ({ imap, url }) => {
    const folder = need(url.searchParams.get('folder'), 'Folder missing');
    const offset = Math.max(0, +url.searchParams.get('offset') || 0);
    const limit = Math.min(200, Math.max(1, +url.searchParams.get('limit') || 50));
    const c = await imap();
    const { total, messages } = await c.listMessages(folder, { offset, limit });
    return json({ folder, total, offset, messages });
  },

  'GET /api/search': async ({ imap, url }) => {
    const folder = need(url.searchParams.get('folder'), 'Folder missing');
    const q = url.searchParams.get('q') || '';
    const scope = url.searchParams.get('scope') || 'all';
    const c = await imap();
    const crit = searchCriteria(q, { scope });
    if (url.searchParams.get('unread') === '1') crit.push(' UNSEEN');
    if (url.searchParams.get('flagged') === '1') crit.push(' FLAGGED');
    if (url.searchParams.get('attachment') === '1') crit.push(' HEADER Content-Type multipart/mixed');
    const uids = await c.search(folder, crit);
    const messages = await c.summariesByUid(folder, uids.slice(0, 200));
    messages.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return json({ folder, total: uids.length, messages });
  },

  'GET /api/message': async ({ imap, url }) => {
    const folder = need(url.searchParams.get('folder'), 'Folder missing');
    const uid = +need(url.searchParams.get('uid'), 'Message missing');
    const allowExternal = url.searchParams.get('images') === '1';
    const markSeen = url.searchParams.get('seen') !== '0';
    const c = await imap();
    const r = await c.fetchRaw(folder, uid);
    if (!r) return fail(404, 'This message no longer exists');
    const p = await PostalMime.parse(str2bin(r.raw));
    const cids = new Map();
    (p.attachments || []).forEach((a, i) => {
      if (a.contentId) cids.set(a.contentId.replace(/^<|>$/g, ''), i);
    });
    const usedCids = new Set();
    const cidUrl = (cid) => {
      if (!cids.has(cid)) return null;
      usedCids.add(cid);
      return attachmentUrl(folder, uid, `cid=${encodeURIComponent(cid)}`);
    };
    let html;
    let external = false;
    if (p.html) {
      const s = await sanitizeHtml(p.html, { allowExternal, cidUrl });
      html = s.html;
      external = s.external;
    } else {
      html = textToHtml(p.text || '');
    }
    if (markSeen && !r.flags.includes('\\Seen')) {
      try {
        await c.setFlags(folder, [uid], { add: ['\\Seen'] });
        r.flags.push('\\Seen');
      } catch {}
    }
    const header = (name) => p.headers.find((h) => h.key === name)?.value || null;
    const prio = header('x-priority') || '';
    const importance = header('importance') || '';
    return json({
      folder,
      uid,
      flags: r.flags,
      seen: r.flags.includes('\\Seen'),
      flagged: r.flags.includes('\\Flagged'),
      subject: p.subject || '',
      from: p.from ? [p.from] : [],
      sender: p.sender || null,
      to: p.to || [],
      cc: p.cc || [],
      bcc: p.bcc || [],
      replyTo: p.replyTo || [],
      date: p.date || null,
      messageId: p.messageId || null,
      inReplyTo: p.inReplyTo || null,
      references: p.references || null,
      priority: /^[12]/.test(prio) || /high/i.test(importance) ? 'high' : /^[45]/.test(prio) || /low/i.test(importance) ? 'low' : 'normal',
      listUnsubscribe: header('list-unsubscribe'),
      dispositionNotificationTo: header('disposition-notification-to'),
      html,
      text: p.text || null,
      isPlain: !p.html,
      external,
      size: r.raw.length,
      attachments: (p.attachments || []).map((a, i) => ({
        index: i,
        filename: a.filename || (a.mimeType === 'message/rfc822' ? 'message.eml' : `attachment-${i + 1}`),
        mimeType: a.mimeType,
        size: a.content?.byteLength || 0,
        contentId: a.contentId ? a.contentId.replace(/^<|>$/g, '') : null,
        inline: !!(a.contentId && usedCids.has(a.contentId.replace(/^<|>$/g, ''))),
        url: attachmentUrl(folder, uid, `part=${i}`),
      })),
    });
  },

  'GET /api/source': async ({ imap, url }) => {
    const folder = need(url.searchParams.get('folder'), 'Folder missing');
    const uid = +need(url.searchParams.get('uid'), 'Message missing');
    const c = await imap();
    const r = await c.fetchRaw(folder, uid);
    if (!r) return fail(404, 'This message no longer exists');
    const download = url.searchParams.get('download') === '1';
    return new Response(str2bin(r.raw), {
      headers: {
        ...SECURITY_HEADERS,
        'content-type': download ? 'message/rfc822' : 'text/plain; charset=utf-8',
        'content-disposition': download ? `attachment; filename="message-${uid}.eml"` : 'inline',
        'content-security-policy': 'sandbox',
      },
    });
  },

  'GET /api/attachment': async ({ imap, url }) => {
    const folder = need(url.searchParams.get('folder'), 'Folder missing');
    const uid = +need(url.searchParams.get('uid'), 'Message missing');
    const c = await imap();
    const r = await c.fetchRaw(folder, uid);
    if (!r) return fail(404, 'This message no longer exists');
    const p = await PostalMime.parse(str2bin(r.raw));
    const list = p.attachments || [];
    let att;
    if (url.searchParams.has('cid')) {
      const cid = url.searchParams.get('cid');
      att = list.find((a) => (a.contentId || '').replace(/^<|>$/g, '') === cid);
    } else {
      att = list[+url.searchParams.get('part')];
    }
    if (!att) return fail(404, 'Attachment not found');
    const filename = att.filename || 'attachment';
    // Only show safe types inline; everything else downloads, so an HTML or
    // SVG attachment can never run on this origin.
    const safeInline = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain|audio\/|video\/)/i.test(att.mimeType || '');
    const download = url.searchParams.get('download') === '1' || !safeInline;
    return new Response(att.content, {
      headers: {
        ...SECURITY_HEADERS,
        'cache-control': 'private, max-age=3600',
        'content-type': safeInline ? att.mimeType : 'application/octet-stream',
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
    });
  },

  'POST /api/flags': async ({ imap, request }) => {
    const body = await request.json();
    const allowed = ['\\Seen', '\\Flagged', '\\Answered', '$Forwarded', '$Junk', '$NotJunk'];
    const add = (body.add || []).filter((f) => allowed.includes(f));
    const remove = (body.remove || []).filter((f) => allowed.includes(f));
    const c = await imap();
    await c.setFlags(need(body.folder, 'Folder missing'), uidList(body.uids), { add, remove });
    return json({ ok: true });
  },

  'POST /api/move': async ({ imap, request }) => {
    const body = await request.json();
    const c = await imap();
    let target = body.to;
    if (!target && body.toSpecial) {
      const names = { trash: 'Trash', archive: 'Archive', junk: 'Junk', inbox: 'INBOX' };
      target = body.toSpecial === 'inbox' ? 'INBOX' : await ensureFolder(c, body.toSpecial, names[body.toSpecial] || 'Archive');
    }
    need(target, 'Target folder missing');
    const from = need(body.folder, 'Folder missing');
    const uids = uidList(body.uids);
    if (body.toSpecial === 'junk') await c.setFlags(from, uids, { add: ['$Junk'], remove: ['$NotJunk'] }).catch(() => {});
    if (body.toSpecial === 'inbox' && body.notJunk) await c.setFlags(from, uids, { add: ['$NotJunk'], remove: ['$Junk'] }).catch(() => {});
    if (target === from) return json({ ok: true });
    await c.move(from, uids, target);
    return json({ ok: true, to: target });
  },

  'POST /api/delete': async ({ imap, request }) => {
    const body = await request.json();
    const folder = need(body.folder, 'Folder missing');
    const uids = uidList(body.uids);
    const c = await imap();
    const trash = await folderBySpecialUse(c, 'trash');
    if (body.permanent || !trash || trash.path === folder) {
      await c.deletePermanently(folder, uids);
      return json({ ok: true, permanent: true });
    }
    await c.move(folder, uids, trash.path);
    return json({ ok: true, to: trash.path });
  },

  'POST /api/draft': async ({ imap, request, sess, env }) => {
    const { meta, uploads } = await readComposeRequest(request);
    const c = await imap();
    const identity = defaultIdentity(env, sess);
    const fields = composeFields(meta, identity);
    const { attachments, html } = await collectAttachments(c, meta, uploads, meta.html || null);
    const { raw } = buildMessage({ ...fields, html: meta.isPlain ? null : html, text: meta.isPlain ? meta.text || '' : undefined, attachments }, { includeBcc: true });
    const drafts = await ensureFolder(c, 'drafts', 'Drafts');
    const uid = await c.append(drafts, raw, ['\\Draft', '\\Seen']);
    if (meta.draftUid) await c.deletePermanently(drafts, [+meta.draftUid]).catch(() => {});
    const files = attachments.filter((a) => !a.contentId);
    return json({ ok: true, folder: drafts, uid, attachments: files.map((a, i) => ({ filename: a.filename, mimeType: a.contentType, size: a.content.length, index: i })) });
  },

  'POST /api/send': async ({ imap, request, sess, env }) => {
    const { meta, uploads } = await readComposeRequest(request);
    const identity = defaultIdentity(env, sess);
    const fields = composeFields(meta, identity);
    const recipients = [...fields.to, ...fields.cc, ...fields.bcc].map((a) => a.email);
    if (!recipients.length) return fail(400, 'Add at least one recipient');
    const c = await imap();
    const { attachments, html } = await collectAttachments(c, meta, uploads, meta.html || null);
    const { raw, messageId } = buildMessage({ ...fields, html: meta.isPlain ? null : html, text: meta.isPlain ? meta.text || '' : undefined, attachments });
    const server = findServer(env, sess.server);
    try {
      await sendMail(server.smtp, { username: sess.username, password: sess.password }, { from: fields.from.email, recipients: [...new Set(recipients)] }, raw, new URL(request.url).hostname);
    } catch (err) {
      if (err instanceof SmtpError) return fail(502, `The mail server did not accept the message. ${err.message}`);
      throw err;
    }
    // Housekeeping. A failure here must not look like a failed send.
    const warnings = [];
    try {
      const sent = await ensureFolder(c, 'sent', 'Sent');
      await c.append(sent, raw, ['\\Seen']);
    } catch (err) {
      warnings.push(`Sent, but a copy could not be saved to Sent (${err.message})`);
    }
    try {
      if (meta.draftUid) {
        const drafts = await folderBySpecialUse(c, 'drafts');
        if (drafts) await c.deletePermanently(drafts.path, [+meta.draftUid]);
      }
      if (meta.source?.folder && meta.source?.uid) {
        const flag = meta.source.type === 'forward' ? '$Forwarded' : '\\Answered';
        await c.setFlags(meta.source.folder, [+meta.source.uid], { add: [flag] });
      }
    } catch {}
    return json({ ok: true, messageId, warnings });
  },
};

function defaultIdentity(env, sess) {
  const server = findServer(env, sess.server);
  const email = sess.username.includes('@') ? sess.username : `${sess.username}@${server?.domain || 'localhost'}`;
  return { name: '', email };
}

// Routes that work without a session.
const PUBLIC = new Set(['GET /api/config', 'POST /api/login', 'POST /api/logout']);

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return fail(404, 'Not found');

  // CSRF: the session cookie is SameSite=Strict, and state-changing calls must
  // carry a custom header, which other sites cannot send without CORS.
  if (request.method !== 'GET' && request.headers.get('x-ratmail') !== '1') return fail(403, 'Missing request header');

  const sess = await loadSession(env, request);
  if (!sess && !PUBLIC.has(key)) return fail(401, 'Not signed in', { signedOut: true });

  let client = null;
  const imap = async () => {
    if (!client) client = await openImap(env, sess);
    return client;
  };
  try {
    return await handler({ env, request, url, sess, imap });
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message);
    if (err instanceof AuthError) {
      // The password stopped working (changed on the server): end the session.
      if (sess) await deleteSession(env, sess.idHash);
      return fail(401, 'Your mail server rejected the saved login. Please sign in again.', { signedOut: true });
    }
    if (err instanceof ImapError) return fail(err.status === 'NO' ? 400 : 502, err.message || 'Mail server error');
    console.error(err);
    return fail(500, err.message || 'Something went wrong');
  } finally {
    if (client) ctx.waitUntil(client.logout());
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};

