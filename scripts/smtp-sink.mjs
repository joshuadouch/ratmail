// Tiny SMTP server for local testing: accepts AUTH PLAIN/LOGIN and saves
// each message to ./.wrangler/sent-mail/<n>.eml. Not for production.
import net from 'node:net';
import fs from 'node:fs';

const port = +(process.argv[2] || 2525);
const dir = new URL('../.wrangler/sent-mail/', import.meta.url).pathname;
fs.mkdirSync(dir, { recursive: true });
let n = 0;

net.createServer((sock) => {
  let buf = '';
  let data = null;
  let envelope = { rcpt: [] };
  const say = (s) => sock.write(s + '\r\n');
  say('220 sink ESMTP');
  sock.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    for (;;) {
      if (data !== null) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        data += buf.slice(0, end);
        buf = buf.slice(end + 5);
        const file = `${dir}${++n}.eml`;
        fs.writeFileSync(file, `X-Envelope-From: ${envelope.from}\r\nX-Envelope-To: ${envelope.rcpt.join(', ')}\r\n` + data.replace(/\r\n\.\./g, '\r\n.'), 'latin1');
        console.log('saved', file);
        data = null;
        envelope = { rcpt: [] };
        say('250 OK queued');
        continue;
      }
      const i = buf.indexOf('\r\n');
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const cmd = line.split(' ')[0].toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
      else if (cmd === 'AUTH') say('235 OK');
      else if (cmd === 'MAIL') { envelope.from = line.slice(10); say('250 OK'); }
      else if (cmd === 'RCPT') { envelope.rcpt.push(line.slice(8)); say('250 OK'); }
      else if (cmd === 'DATA') { data = ''; say('354 go'); }
      else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
      else say('250 OK');
    }
  });
  sock.on('error', () => {});
}).listen(port, '127.0.0.1', () => console.log('SMTP sink on', port));
