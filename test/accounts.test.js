import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAccountInput, PROVIDERS } from '../src/accounts.js';

const base = { email: 'me@gmail.com', imap: { host: 'imap.gmail.com', port: 993, tls: 'on' }, smtp: { host: 'smtp.gmail.com', port: 465, tls: 'on' } };

test('accepts a normal account and defaults the username to the address', () => {
  const a = cleanAccountInput({ ...base, name: 'Me\r\nX' }, {});
  assert.equal(a.username, 'me@gmail.com');
  assert.equal(a.name, 'Me X');
  assert.deepEqual(a.imap, { host: 'imap.gmail.com', port: 993, tls: 'on' });
});

test('rejects plaintext, odd ports and local hosts in production', () => {
  assert.throws(() => cleanAccountInput({ ...base, imap: { host: 'imap.gmail.com', port: 993, tls: 'off' } }, {}));
  assert.throws(() => cleanAccountInput({ ...base, imap: { host: 'imap.gmail.com', port: 22, tls: 'on' } }, {}));
  assert.throws(() => cleanAccountInput({ ...base, smtp: { host: '127.0.0.1', port: 465, tls: 'on' } }, {}));
  assert.throws(() => cleanAccountInput({ ...base, email: 'not-an-address' }, {}));
});

test('allows a local plaintext server only when testing', () => {
  const a = cleanAccountInput({ ...base, imap: { host: '127.0.0.1', port: 9143, tls: 'off' } }, { ALLOW_PLAINTEXT_ACCOUNTS: '1' });
  assert.equal(a.imap.tls, 'off');
});

test('presets have both servers on secure ports', () => {
  for (const p of PROVIDERS) {
    assert.ok([993].includes(p.imap.port), p.id);
    assert.ok([465, 587].includes(p.smtp.port), p.id);
  }
});
