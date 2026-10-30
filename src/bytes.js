// Small helpers for moving between bytes and strings.
// IMAP and SMTP are byte protocols, so the clients work with "binary strings":
// one JS char per byte (latin1). Text is decoded to UTF-8 only at the edges.

const encoder = new TextEncoder();

export function bin2str(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return s;
}

export function str2bin(s) {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
  return u;
}

/** UTF-8 text -> binary string */
export function utf8Encode(text) {
  return bin2str(encoder.encode(text));
}

/** binary string -> text, decoded as UTF-8 (falls back to latin1 on bad bytes) */
export function utf8Decode(bin) {
  if (bin == null) return '';
  if (!/[\x80-\xff]/.test(bin)) return bin;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(str2bin(bin));
  } catch {
    return bin;
  }
}

export function b64encode(bin) {
  return btoa(bin);
}

export function b64decode(b64) {
  return atob(b64.replace(/[^A-Za-z0-9+/=]/g, ''));
}

export function bytesToB64(u8) {
  return btoa(bin2str(u8));
}

export function b64ToBytes(b64) {
  return str2bin(b64decode(b64));
}

export function b64url(u8) {
  return bytesToB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return b64ToBytes(s);
}

/** Decode RFC 2047 encoded words, e.g. =?UTF-8?B?...?= */
export function decodeWords(s) {
  if (!s || s.indexOf('=?') < 0) return s || '';
  return s.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=(?:\s+(?==\?))?/g, (m, charset, enc, text) => {
    let bytes;
    if (enc.toUpperCase() === 'B') {
      try { bytes = b64ToBytes(text); } catch { return m; }
    } else {
      const bin = text.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      bytes = str2bin(bin);
    }
    const cs = charset.split('*')[0].toLowerCase();
    try {
      return new TextDecoder(cs).decode(bytes);
    } catch {
      return new TextDecoder().decode(bytes);
    }
  });
}

/** Encode a header value as an RFC 2047 word if it is not plain ASCII. */
export function encodeWord(text) {
  if (!/[^\x20-\x7e]/.test(text)) return text;
  // Split into chunks so each encoded word stays under ~75 chars.
  const out = [];
  let chunk = '';
  for (const ch of text) {
    if (utf8Encode(chunk + ch).length > 45) {
      out.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) out.push(chunk);
  return out.map((c) => `=?UTF-8?B?${btoa(utf8Encode(c))}?=`).join('\r\n ');
}

// Modified UTF-7 (RFC 3501 section 5.1.3) for IMAP folder names.
export function decodeMailboxName(s) {
  return s.replace(/&([^-]*)-/g, (_, b) => {
    if (b === '') return '&';
    const bin = b64decode(b.replace(/,/g, '/'));
    let out = '';
    for (let i = 0; i + 1 < bin.length; i += 2) out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    return out;
  });
}

export function encodeMailboxName(s) {
  let out = '';
  let buf = '';
  const flush = () => {
    if (!buf) return;
    let bin = '';
    for (let i = 0; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      bin += String.fromCharCode(c >> 8, c & 255);
    }
    out += '&' + btoa(bin).replace(/=+$/, '').replace(/\//g, ',') + '-';
    buf = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += c === 0x26 ? '&-' : s[i];
    } else {
      buf += s[i];
    }
  }
  flush();
  return out;
}
