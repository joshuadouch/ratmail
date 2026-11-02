// Minimal SMTP submission client (RFC 6409) for Workers.
// Supports implicit TLS (465), STARTTLS (587) and AUTH PLAIN / LOGIN.

import { openSocket, SocketReader, SocketWriter } from './socket.js';
import { utf8Encode } from './bytes.js';

export class SmtpError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.reader = new SocketReader(socket.readable, 60000);
    this.writer = new SocketWriter(socket.writable);
  }
  async reply() {
    const lines = [];
    for (;;) {
      const l = await this.reader.readLine();
      lines.push(l.slice(4));
      if (l[3] !== '-') return { code: parseInt(l.slice(0, 3), 10), text: lines.join('\n'), lines };
    }
  }
  async cmd(line, ok) {
    await this.writer.write(line + '\r\n');
    const r = await this.reply();
    if (ok && !ok.includes(r.code)) {
      const shown = /^AUTH /i.test(line) ? 'AUTH' : line.split(' ')[0];
      throw new SmtpError(`${shown}: ${r.code} ${r.text}`, r.code);
    }
    return r;
  }
}

/**
 * Sends one message.
 * @param server  { host, port, tls }
 * @param auth    { username, password }
 * @param envelope { from, recipients: [] }, or null to only check the login
 * @param data    message as a binary string with CRLF line endings
 */
export async function sendMail(server, auth, envelope, data, heloName = 'ratmail', clientIp = null) {
  const socket = openSocket(server);
  let c = new Conn(socket);
  try {
    let r = await c.reply();
    if (r.code !== 220) throw new SmtpError(`Greeting: ${r.code} ${r.text}`, r.code);
    r = await c.cmd(`EHLO ${heloName}`, [250]);
    if (server.tls === 'starttls') {
      await c.cmd('STARTTLS', [220]);
      c.reader.release();
      c.writer.release();
      c = new Conn(socket.startTls());
      r = await c.cmd(`EHLO ${heloName}`, [250]);
    }
    let caps = r.lines.map((l) => l.toUpperCase());
    // Postfix only offers XCLIENT to hosts in smtpd_authorized_xclient_hosts.
    // It makes the server log and rate-limit the browser's address.
    const xclient = caps.find((l) => /^XCLIENT\b/.test(l));
    if (clientIp && xclient && /\bADDR\b/.test(xclient)) {
      const addr = clientIp.includes(':') ? 'IPV6:' + clientIp : clientIp;
      const x = await c.cmd(`XCLIENT ADDR=${addr}`, [220]);
      if (x.code === 220) {
        r = await c.cmd(`EHLO ${heloName}`, [250]);
        caps = r.lines.map((l) => l.toUpperCase());
      }
    }
    const authLine = caps.find((l) => l.startsWith('AUTH ') || l.startsWith('AUTH=')) || '';
    const user = utf8Encode(auth.username);
    const pass = utf8Encode(auth.password);
    if (/\bPLAIN\b/.test(authLine) || !authLine) {
      await c.cmd('AUTH PLAIN ' + btoa('\0' + user + '\0' + pass), [235]);
    } else if (/\bLOGIN\b/.test(authLine)) {
      await c.cmd('AUTH LOGIN', [334]);
      await c.cmd(btoa(user), [334]);
      await c.cmd(btoa(pass), [235]);
    } else {
      throw new SmtpError('The mail server offers no supported login method');
    }
    if (!envelope) {
      // Login check only (adding an account).
      try { await c.writer.write('QUIT\r\n'); } catch {}
      return { response: 'authenticated' };
    }
    const smtpUtf8 = caps.some((l) => l === 'SMTPUTF8');
    await c.cmd(`MAIL FROM:<${envelope.from}>${smtpUtf8 && /[^\x00-\x7f]/.test(envelope.from) ? ' SMTPUTF8' : ''}`, [250]);
    for (const rcpt of envelope.recipients) {
      await c.cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    }
    await c.cmd('DATA', [354]);
    // Dot-stuff lines that start with "." and end with <CRLF>.<CRLF>
    let body = data.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
    if (!body.endsWith('\r\n')) body += '\r\n';
    await c.writer.write(body + '.\r\n');
    const done = await c.reply();
    if (done.code !== 250) throw new SmtpError(`DATA: ${done.code} ${done.text}`, done.code);
    try { await c.writer.write('QUIT\r\n'); } catch {}
    return { response: done.text };
  } finally {
    try { socket.close(); } catch {}
  }
}

