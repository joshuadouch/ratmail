import { connect } from 'cloudflare:sockets';
import { bin2str, str2bin } from './bytes.js';

/**
 * Opens a TCP connection. tls is "on" (implicit TLS), "starttls" or "off".
 * "off" is only meant for local testing.
 */
export function openSocket({ host, port, tls }) {
  const secureTransport = tls === 'on' ? 'on' : tls === 'starttls' ? 'starttls' : 'off';
  return connect({ hostname: host, port }, { secureTransport, allowHalfOpen: false });
}

/** Buffered reader over a socket that reads CRLF lines and exact byte counts. */
export class SocketReader {
  constructor(readable, timeoutMs = 30000) {
    this.reader = readable.getReader();
    this.buf = new Uint8Array(65536);
    this.start = 0;
    this.end = 0;
    this.timeoutMs = timeoutMs;
  }

  get available() {
    return this.end - this.start;
  }

  async fill() {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Mail server timed out')), this.timeoutMs);
    });
    let res;
    try {
      res = await Promise.race([this.reader.read(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (res.done) throw new Error('Mail server closed the connection');
    const chunk = res.value;
    if (this.start > 0 && this.start === this.end) {
      this.start = this.end = 0;
    }
    if (this.end + chunk.length > this.buf.length) {
      const live = this.end - this.start;
      let size = this.buf.length;
      while (live + chunk.length > size) size *= 2;
      const next = size === this.buf.length ? this.buf : new Uint8Array(size);
      next.set(this.buf.subarray(this.start, this.end), 0);
      this.buf = next;
      this.start = 0;
      this.end = live;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }

  /** Next line without the CRLF, as a binary string. */
  async readLine() {
    let scanned = 0; // bytes after this.start already checked (fill() may move the buffer)
    for (;;) {
      for (let i = this.start + scanned; i + 1 < this.end; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = bin2str(this.buf.subarray(this.start, i));
          this.start = i + 2;
          return line;
        }
      }
      scanned = Math.max(0, this.end - this.start - 1);
      await this.fill();
    }
  }

  /** Exactly n bytes, as a binary string. */
  async readBytes(n) {
    while (this.available < n) await this.fill();
    const out = bin2str(this.buf.subarray(this.start, this.start + n));
    this.start += n;
    return out;
  }

  release() {
    this.reader.releaseLock();
  }
}

export class SocketWriter {
  constructor(writable) {
    this.writer = writable.getWriter();
  }
  /** Writes a binary string. Large payloads go out in chunks. */
  async write(bin) {
    const CHUNK = 1 << 20;
    for (let i = 0; i < bin.length; i += CHUNK) {
      await this.writer.write(str2bin(bin.slice(i, i + CHUNK)));
    }
  }
  release() {
    this.writer.releaseLock();
  }
}
