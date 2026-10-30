// A small IMAP4rev1 client for Workers (cloudflare:sockets).
// It covers what a webmail needs: login, folders, listing, fetching,
// flags, moving, searching and appending.

import { openSocket, SocketReader, SocketWriter } from './socket.js';
import { decodeMailboxName, encodeMailboxName, utf8Decode, utf8Encode } from './bytes.js';
import { parseTokens, fetchObject, quote, parseEnvelope, hasAttachment, expandSet } from './imap-parse.js';

export { parseTokens, parseEnvelope, hasAttachment, expandSet, searchCriteria } from './imap-parse.js';

export class ImapError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class AuthError extends ImapError {}

// ---------------------------------------------------------------------------

let tagCounter = 0;

export class ImapClient {
  constructor(socket) {
    this.socket = socket;
    this.reader = new SocketReader(socket.readable);
    this.writer = new SocketWriter(socket.writable);
    this.capabilities = new Set();
    this.selected = null;
    this.queue = Promise.resolve();
  }

  /**
   * Connects, upgrades with STARTTLS if configured, and logs in.
   * clientIp is the browser's address. It is sent with the IMAP ID command
   * (x-originating-ip) so a server that trusts us (Dovecot
   * login_trusted_networks) logs and rate-limits the real user, not the
   * Cloudflare address. Servers that don't trust us ignore it.
   */
  static async open(server, username, password, clientIp = null) {
    const socket = openSocket(server);
    let client = new ImapClient(socket);
    try {
      const greeting = await client.readResponse();
      if (/^\* BYE/i.test(greeting)) throw new ImapError('Mail server refused the connection');
      client.parseCapabilityText(greeting);
      if (server.tls === 'starttls') {
        await client.command('STARTTLS');
        client.reader.release();
        client.writer.release();
        const secure = socket.startTls();
        client = new ImapClient(secure);
        const caps = await client.command('CAPABILITY');
        for (const l of caps.untagged) client.parseCapabilityText(l);
      }
      if (clientIp) await client.sendId(clientIp);
      await client.login(username, password);
      return client;
    } catch (err) {
      try { socket.close(); } catch {}
      throw err;
    }
  }

  async readResponse() {
    let line = await this.reader.readLine();
    let out = line;
    for (;;) {
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (!m) return out;
      const literal = await this.reader.readBytes(parseInt(m[1], 10));
      line = await this.reader.readLine();
      out += '\r\n' + literal + line;
    }
  }

  parseCapabilityText(line) {
    const m = /\[CAPABILITY ([^\]]+)\]/i.exec(line) || /^\* CAPABILITY (.+)$/i.exec(line);
    if (m) this.capabilities = new Set(m[1].toUpperCase().split(/\s+/));
  }

  has(cap) {
    return this.capabilities.has(cap.toUpperCase());
  }

  /**
   * Runs one command. `parts` is a string, or an array of strings and
   * { literal: binaryString } items. Returns { untagged: [lines], text }.
   */
  command(parts, opts = {}) {
    const run = () => this._command(parts, opts);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async _command(parts, { allowNo = false } = {}) {
    const tag = 'R' + (++tagCounter).toString(36);
    if (typeof parts === 'string') parts = [parts];
    const literalPlus = this.has('LITERAL+');
    let pending = tag + ' ';
    for (const part of parts) {
      if (typeof part === 'string') {
        pending += part;
        continue;
      }
      const data = part.literal;
      if (literalPlus) {
        pending += `{${data.length}+}\r\n` + data;
      } else {
        await this.writer.write(pending + `{${data.length}}\r\n`);
        pending = '';
        for (;;) {
          const line = await this.readResponse();
          if (line.startsWith('+')) break;
          if (line.startsWith(tag + ' ')) throw new ImapError(line.slice(tag.length + 1));
        }
        pending = data;
      }
    }
    await this.writer.write(pending + '\r\n');
    const untagged = [];
    for (;;) {
      const line = await this.readResponse();
      if (line.startsWith(tag + ' ')) {
        const rest = line.slice(tag.length + 1);
        const status = rest.split(' ', 1)[0].toUpperCase();
        this.parseCapabilityText(rest);
        if (status === 'OK' || (allowNo && status === 'NO')) return { untagged, text: rest, status };
        const code = (/^\w+ \[([^\]\s]+)/.exec(rest) || [])[1];
        throw new ImapError(rest.replace(/^\w+ (\[[^\]]*\] )?/, ''), { status, code });
      }
      if (line.startsWith('*')) {
        if (/^\* CAPABILITY /i.test(line)) this.parseCapabilityText(line);
        untagged.push(line);
      }
      // continuation requests outside of literals are not expected; ignore
    }
  }

  async sendId(clientIp) {
    if (!this.has('ID')) return;
    try {
      await this.command(`ID ("name" "ratmail" "x-originating-ip" ${quote(clientIp)})`, { allowNo: true });
    } catch {}
  }

  async login(username, password) {
    const u = utf8Encode(username);
    const p = utf8Encode(password);
    try {
      if (this.has('AUTH=PLAIN') && this.has('SASL-IR')) {
        const token = btoa('\0' + u + '\0' + p);
        await this.command('AUTHENTICATE PLAIN ' + token);
      } else {
        await this.command(['LOGIN ', { literal: u }, ' ', { literal: p }]);
      }
    } catch (err) {
      if (err instanceof ImapError && (err.status === 'NO' || err.status === 'BAD')) {
        throw new AuthError(err.message || 'Login failed', err);
      }
      throw err;
    }
    if (!this.capabilities.has('IMAP4REV1') || this.capabilities.size < 3) {
      const res = await this.command('CAPABILITY');
      for (const l of res.untagged) this.parseCapabilityText(l);
    }
  }

  async logout() {
    try {
      await Promise.race([this.command('LOGOUT'), new Promise((r) => setTimeout(r, 1000))]);
    } catch {}
    try { this.socket.close(); } catch {}
  }

  mailbox(name) {
    const enc = encodeMailboxName(name);
    if (/[^\x20-\x7e]/.test(enc)) return { literal: utf8Encode(name) };
    return quote(enc);
  }

  // -------------------------------------------------------------------------
  // Folders

  async listFolders() {
    let res;
    const listStatus = this.has('LIST-STATUS');
    const specialUse = this.has('SPECIAL-USE');
    if (listStatus) {
      res = await this.command(`LIST "" "*" RETURN (${specialUse ? 'SPECIAL-USE ' : ''}SUBSCRIBED CHILDREN STATUS (MESSAGES UNSEEN))`);
    } else {
      res = await this.command('LIST "" "*"');
    }
    const folders = new Map();
    for (const line of res.untagged) {
      const m = /^\* (LIST|STATUS) (.*)$/is.exec(line);
      if (!m) continue;
      const t = parseTokens(m[2]);
      if (m[1].toUpperCase() === 'LIST') {
        const [flags, delimiter, rawName] = t;
        const path = String(rawName);
        const flagSet = (flags || []).map((f) => String(f).toLowerCase());
        const f = folders.get(path) || { path };
        Object.assign(f, {
          name: decodeMailboxName(path),
          delimiter: delimiter || '/',
          flags: flagSet,
          selectable: !flagSet.includes('\\noselect') && !flagSet.includes('\\nonexistent'),
          specialUse: (flagSet.find((x) => ['\\sent', '\\drafts', '\\trash', '\\junk', '\\archive', '\\all', '\\flagged'].includes(x)) || '').slice(1) || null,
        });
        folders.set(path, f);
      } else {
        const [rawName, items] = t;
        const path = String(rawName);
        const f = folders.get(path) || { path };
        const o = fetchObject(items || []);
        f.total = +o.MESSAGES || 0;
        f.unread = +o.UNSEEN || 0;
        folders.set(path, f);
      }
    }
    const list = [...folders.values()].filter((f) => f.name !== undefined);
    if (!listStatus) {
      for (const f of list) {
        if (!f.selectable) continue;
        try {
          const st = await this.status(f.path);
          f.total = st.messages;
          f.unread = st.unseen;
        } catch {}
      }
    }
    // Guess special folders by name for servers without SPECIAL-USE.
    const guesses = { sent: /^(sent|sent items|sent messages|gesendet)$/i, drafts: /^(drafts|entwürfe)$/i, trash: /^(trash|deleted items|deleted messages|papierkorb)$/i, junk: /^(junk|spam|junk e-mail)$/i, archive: /^(archive|archives)$/i };
    for (const [use, re] of Object.entries(guesses)) {
      if (list.some((f) => f.specialUse === use)) continue;
      const hit = list.find((f) => re.test(f.name.split(f.delimiter).pop()));
      if (hit) hit.specialUse = use;
    }
    for (const f of list) if (f.path.toUpperCase() === 'INBOX') f.specialUse = 'inbox';
    return list;
  }

  async status(path) {
    const res = await this.command(['STATUS ', this.mailbox(path), ' (MESSAGES UNSEEN UIDNEXT)']);
    for (const line of res.untagged) {
      const m = /^\* STATUS (.*)$/is.exec(line);
      if (!m) continue;
      const t = parseTokens(m[1]);
      const o = fetchObject(t[1] || []);
      return { messages: +o.MESSAGES || 0, unseen: +o.UNSEEN || 0, uidNext: +o.UIDNEXT || 0 };
    }
    return { messages: 0, unseen: 0 };
  }

  async createFolder(path) {
    await this.command(['CREATE ', this.mailbox(path)]);
    await this.command(['SUBSCRIBE ', this.mailbox(path)], { allowNo: true });
  }

  async renameFolder(from, to) {
    await this.command(['RENAME ', this.mailbox(from), ' ', this.mailbox(to)]);
    await this.command(['SUBSCRIBE ', this.mailbox(to)], { allowNo: true });
  }

  async deleteFolder(path) {
    await this.command(['UNSUBSCRIBE ', this.mailbox(path)], { allowNo: true });
    await this.command(['DELETE ', this.mailbox(path)]);
  }

  /** Selects a folder (read-write unless readOnly). Returns { exists, uidValidity, uidNext }. */
  async select(path, readOnly = false) {
    if (this.selected && this.selected.path === path && (readOnly || !this.selected.readOnly)) return this.selected;
    const res = await this.command([readOnly ? 'EXAMINE ' : 'SELECT ', this.mailbox(path)]);
    const info = { path, readOnly, exists: 0, uidValidity: 0, uidNext: 0 };
    for (const line of res.untagged) {
      let m;
      if ((m = /^\* (\d+) EXISTS/i.exec(line))) info.exists = +m[1];
      else if ((m = /\[UIDVALIDITY (\d+)\]/i.exec(line))) info.uidValidity = +m[1];
      else if ((m = /\[UIDNEXT (\d+)\]/i.exec(line))) info.uidNext = +m[1];
    }
    this.selected = info;
    return info;
  }

  // -------------------------------------------------------------------------
  // Messages

  /** Fetch items for the message list. */
  listItems() {
    const items = ['UID', 'FLAGS', 'ENVELOPE', 'BODYSTRUCTURE', 'RFC822.SIZE', 'INTERNALDATE', 'BODY.PEEK[HEADER.FIELDS (X-PRIORITY IMPORTANCE)]'];
    if (this.has('PREVIEW')) items.push('PREVIEW');
    else if (this.has('SNIPPET=FUZZY')) items.push('SNIPPET (FUZZY)');
    return items.join(' ');
  }

  /** Runs FETCH and returns [{ seq, ...items }]. `set` is a sequence set. */
  async fetch(set, items, { uid = false, changedSince } = {}) {
    const res = await this.command(`${uid ? 'UID ' : ''}FETCH ${set} (${items})${changedSince ? ` (CHANGEDSINCE ${changedSince})` : ''}`);
    const out = [];
    for (const line of res.untagged) {
      const m = /^\* (\d+) FETCH (.*)$/is.exec(line);
      if (!m) continue;
      const t = parseTokens(m[2]);
      const o = fetchObject(t[0] || []);
      o.seq = +m[1];
      out.push(o);
    }
    return out;
  }

  summarize(o) {
    const env = parseEnvelope(o.ENVELOPE);
    const flags = (o.FLAGS || []).map((f) => String(f));
    let preview = o.PREVIEW ?? (Array.isArray(o.SNIPPET) ? o.SNIPPET[1] : null);
    preview = preview ? utf8Decode(preview).replace(/\s+/g, ' ').trim() : '';
    const prioHeader = Object.keys(o).find((k) => k.startsWith('BODY[HEADER.FIELDS'));
    const prioText = prioHeader ? String(o[prioHeader] || '') : '';
    let priority = 'normal';
    const xp = /X-Priority:\s*(\d)/i.exec(prioText);
    const imp = /Importance:\s*(\w+)/i.exec(prioText);
    if ((xp && +xp[1] <= 2) || (imp && /high/i.test(imp[1]))) priority = 'high';
    else if ((xp && +xp[1] >= 4) || (imp && /low/i.test(imp[1]))) priority = 'low';
    return {
      uid: +o.UID,
      seq: o.seq,
      flags,
      seen: flags.includes('\\Seen'),
      flagged: flags.includes('\\Flagged'),
      answered: flags.includes('\\Answered'),
      forwarded: flags.includes('$Forwarded'),
      draft: flags.includes('\\Draft'),
      subject: env.subject,
      from: env.from,
      to: env.to,
      cc: env.cc,
      date: env.date || (o.INTERNALDATE ? new Date(o.INTERNALDATE).toISOString() : null),
      received: o.INTERNALDATE ? new Date(o.INTERNALDATE).toISOString() : null,
      size: +o['RFC822.SIZE'] || 0,
      attachment: hasAttachment(o.BODYSTRUCTURE),
      priority,
      preview,
    };
  }

  /** Newest-first page of a folder. Uses SORT by date when the server has it. */
  async listMessages(path, { offset = 0, limit = 50, sort = 'date' } = {}) {
    const box = await this.select(path, true);
    const total = box.exists;
    if (!total || offset >= total) return { total, messages: [] };
    let messages;
    if (sort === 'date' && this.has('SORT')) {
      const page = (await this.sortedPage(offset, limit)).map(String);
      if (!page.length) return { total, messages: [] };
      const rows = await this.fetch(page.join(','), this.listItems(), { uid: true });
      const byUid = new Map(rows.map((r) => [String(r.UID), r]));
      messages = page.map((u) => byUid.get(u)).filter(Boolean).map((r) => this.summarize(r));
    } else {
      const hi = total - offset;
      const lo = Math.max(1, hi - limit + 1);
      const rows = await this.fetch(`${lo}:${hi}`, this.listItems());
      messages = rows.sort((a, b) => b.seq - a.seq).map((r) => this.summarize(r));
    }
    return { total, messages };
  }

  /**
   * UIDs for one page of the selected folder, newest date first.
   * Uses ESORT PARTIAL (Dovecot) so big folders don't send every UID.
   */
  async sortedPage(offset, limit) {
    if (this.has('ESORT') && this.partialSort !== false) {
      try {
        const res = await this.command(`UID SORT RETURN (PARTIAL ${offset + 1}:${offset + limit}) (REVERSE DATE) UTF-8 ALL`);
        this.partialSort = true;
        const line = res.untagged.find((l) => /^\* ESEARCH/i.test(l)) || '';
        const m = /PARTIAL \(\S+ ([^)]+)\)/i.exec(line);
        return m ? expandSet(m[1]) : [];
      } catch (err) {
        if (!(err instanceof ImapError) || err.status !== 'BAD') throw err;
        this.partialSort = false;
      }
    }
    const res = await this.command('UID SORT (REVERSE DATE) UTF-8 ALL');
    const line = res.untagged.find((l) => /^\* SORT/i.test(l)) || '';
    return line.replace(/^\* SORT\s*/i, '').trim().split(/\s+/).filter(Boolean).map(Number).slice(offset, offset + limit);
  }

  /** UIDs matching a search, newest first. */
  async search(path, criteria) {
    await this.select(path, true);
    const res = await this.command(['UID SEARCH CHARSET UTF-8 ', ...criteria]);
    const line = res.untagged.find((l) => /^\* SEARCH/i.test(l)) || '';
    return line.replace(/^\* SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean).map(Number).sort((a, b) => b - a);
  }

  async summariesByUid(path, uids) {
    if (!uids.length) return [];
    await this.select(path, true);
    const rows = await this.fetch(uids.join(','), this.listItems(), { uid: true });
    const byUid = new Map(rows.map((r) => [+r.UID, r]));
    return uids.map((u) => byUid.get(u)).filter(Boolean).map((r) => this.summarize(r));
  }

  /** Full raw message (binary string) plus flags. */
  async fetchRaw(path, uid) {
    await this.select(path, true);
    const rows = await this.fetch(String(uid), 'UID FLAGS BODY.PEEK[]', { uid: true });
    const row = rows.find((r) => +r.UID === +uid);
    if (!row) return null;
    return { raw: row['BODY[]'] || '', flags: (row.FLAGS || []).map(String) };
  }

  async setFlags(path, uids, { add = [], remove = [] }) {
    if (!uids.length) return;
    await this.select(path);
    if (add.length) await this.command(`UID STORE ${uids.join(',')} +FLAGS.SILENT (${add.join(' ')})`);
    if (remove.length) await this.command(`UID STORE ${uids.join(',')} -FLAGS.SILENT (${remove.join(' ')})`);
  }

  async markAllRead(path) {
    await this.select(path);
    await this.command('STORE 1:* +FLAGS.SILENT (\\Seen)', { allowNo: true });
  }

  async move(path, uids, target) {
    if (!uids.length) return;
    await this.select(path);
    if (this.has('MOVE')) {
      await this.command([`UID MOVE ${uids.join(',')} `, this.mailbox(target)]);
    } else {
      await this.command([`UID COPY ${uids.join(',')} `, this.mailbox(target)]);
      await this.expungeUids(uids);
    }
  }

  async expungeUids(uids) {
    await this.command(`UID STORE ${uids.join(',')} +FLAGS.SILENT (\\Deleted)`);
    if (this.has('UIDPLUS')) await this.command(`UID EXPUNGE ${uids.join(',')}`);
    else await this.command('EXPUNGE');
  }

  async deletePermanently(path, uids) {
    if (!uids.length) return;
    await this.select(path);
    await this.expungeUids(uids);
  }

  async emptyFolder(path) {
    const box = await this.select(path);
    if (!box.exists) return;
    await this.command('STORE 1:* +FLAGS.SILENT (\\Deleted)');
    await this.command('EXPUNGE');
  }

  /** Appends a message. Returns the new UID when the server reports it. */
  async append(path, raw, flags = []) {
    const res = await this.command(['APPEND ', this.mailbox(path), ` (${flags.join(' ')}) `, { literal: raw }]);
    const m = /\[APPENDUID \d+ (\d+)\]/i.exec(res.text);
    if (this.selected && this.selected.path === path) this.selected = null; // EXISTS changed
    return m ? +m[1] : null;
  }
}

