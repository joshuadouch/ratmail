// Builds outgoing RFC 5322 / MIME messages as binary strings (CRLF endings).

import { utf8Encode, encodeWord, bin2str } from './bytes.js';

function wrap76(b64) {
  return b64.replace(/.{1,76}/g, '$&\r\n');
}

function randomToken(n = 12) {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** "Name" <a@b> with the display name encoded when needed. */
export function formatAddress({ name, email }) {
  if (!name) return `<${email}>`;
  if (/[^\x20-\x7e]/.test(name)) return `${encodeWord(name)} <${email}>`;
  const safe = /^[\w .!#$%&'*+/=?^`{|}~-]*$/.test(name) && !/[.]/.test(name) ? name : `"${name.replace(/(["\\])/g, '\\$1')}"`;
  return `${safe} <${email}>`;
}

function formatList(list) {
  return list.map(formatAddress).join(',\r\n ');
}

function qpLine(line) {
  // quoted-printable for one UTF-8 binary string line
  let out = '';
  let len = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    let enc;
    if ((c >= 33 && c <= 126 && c !== 61) || (c === 32 && i < line.length - 1)) enc = line[i];
    else enc = '=' + c.toString(16).toUpperCase().padStart(2, '0');
    if (len + enc.length > 75) {
      out += '=\r\n';
      len = 0;
    }
    out += enc;
    len += enc.length;
  }
  return out;
}

function quotedPrintable(text) {
  return utf8Encode(text).split(/\r?\n/).map(qpLine).join('\r\n');
}

function filenameParams(name) {
  if (!/[^\x20-\x7e]/.test(name) && !/["\\]/.test(name)) return `filename="${name}"`;
  return `filename*=UTF-8''${encodeURIComponent(name)}`;
}

function nameParam(name) {
  if (!/[^\x20-\x7e]/.test(name) && !/["\\]/.test(name)) return `name="${name}"`;
  return `name="${encodeWord(name)}"`;
}

/** Converts HTML to readable plain text for the text/plain alternative. */
export function htmlToText(html) {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '* ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => (text.replace(/<[^>]+>/g, '').trim() === href ? href : `${text} (${href})`))
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param msg {
 *   from: {name,email}, to:[], cc:[], bcc:[], replyTo?: {name,email},
 *   subject, html?, text?, inReplyTo?, references?, priority?: 'high'|'low',
 *   readReceipt?: bool,
 *   attachments: [{ filename, contentType, content: Uint8Array, contentId? }]
 * }
 * @param includeBcc keep the Bcc header (for the copy saved to Drafts)
 * @returns { raw: binary string, messageId }
 */
export function buildMessage(msg, { includeBcc = false } = {}) {
  const domain = (msg.from.email.split('@')[1] || 'ratmail.local').replace(/[^\w.-]/g, '');
  const messageId = msg.messageId || `<${randomToken(16)}@${domain}>`;
  const h = [];
  h.push(`From: ${formatAddress(msg.from)}`);
  if (msg.to?.length) h.push(`To: ${formatList(msg.to)}`);
  if (msg.cc?.length) h.push(`Cc: ${formatList(msg.cc)}`);
  if (includeBcc && msg.bcc?.length) h.push(`Bcc: ${formatList(msg.bcc)}`);
  if (msg.replyTo?.email) h.push(`Reply-To: ${formatAddress(msg.replyTo)}`);
  h.push(`Subject: ${encodeWord(msg.subject || '')}`);
  h.push(`Date: ${new Date().toUTCString().replace('GMT', '+0000')}`);
  h.push(`Message-ID: ${messageId}`);
  if (msg.inReplyTo) h.push(`In-Reply-To: ${msg.inReplyTo}`);
  if (msg.references) h.push(`References: ${msg.references}`);
  if (msg.priority === 'high') h.push('X-Priority: 1 (Highest)', 'Importance: High');
  if (msg.priority === 'low') h.push('X-Priority: 5 (Lowest)', 'Importance: Low');
  if (msg.readReceipt) h.push(`Disposition-Notification-To: ${formatAddress(msg.from)}`);
  h.push('User-Agent: ratmail');
  h.push('MIME-Version: 1.0');

  const text = msg.text ?? (msg.html ? htmlToText(msg.html) : '');
  const textPart = ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(text)].join('\r\n');

  let body;
  if (msg.html) {
    const htmlDoc = /<html[\s>]/i.test(msg.html) ? msg.html : `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${msg.html}</body></html>`;
    const htmlPart = ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(htmlDoc)].join('\r\n');
    const alt = 'alt_' + randomToken(8);
    body = [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, textPart, `--${alt}`, htmlPart, `--${alt}--`, ''].join('\r\n');
  } else {
    body = textPart;
  }

  const inline = (msg.attachments || []).filter((a) => a.contentId);
  const files = (msg.attachments || []).filter((a) => !a.contentId);

  const attachmentPart = (a, disposition) => {
    const ct = a.contentType || 'application/octet-stream';
    const lines = [`Content-Type: ${ct}; ${nameParam(a.filename || 'attachment')}`, 'Content-Transfer-Encoding: base64', `Content-Disposition: ${disposition}; ${filenameParams(a.filename || 'attachment')}`];
    if (a.contentId) lines.push(`Content-ID: <${a.contentId}>`);
    lines.push('', wrap76(btoa(bin2str(a.content))));
    return lines.join('\r\n');
  };

  if (inline.length) {
    const rel = 'rel_' + randomToken(8);
    body = [`Content-Type: multipart/related; boundary="${rel}"`, '', `--${rel}`, body, ...inline.flatMap((a) => [`--${rel}`, attachmentPart(a, 'inline')]), `--${rel}--`, ''].join('\r\n');
  }
  if (files.length) {
    const mix = 'mix_' + randomToken(8);
    body = [`Content-Type: multipart/mixed; boundary="${mix}"`, '', `--${mix}`, body, ...files.flatMap((a) => [`--${mix}`, attachmentPart(a, 'attachment')]), `--${mix}--`, ''].join('\r\n');
  }

  // `body` begins with its own Content-Type header line(s), so join directly.
  const raw = h.join('\r\n') + '\r\n' + body;
  return { raw, messageId };
}
