import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokens, parseEnvelope, hasAttachment, expandSet, searchCriteria } from '../src/imap-parse.js';
import { decodeWords, encodeWord, encodeMailboxName, decodeMailboxName, utf8Encode, utf8Decode } from '../src/bytes.js';
import { buildMessage, formatAddress } from '../src/mime.js';

test('parses lists, quoted strings, NIL and literals', () => {
  const t = parseTokens('(UID 5 FLAGS (\\Seen) BODY[HEADER.FIELDS (X-PRIORITY)] {13}\r\nX-Priority: 1 X NIL "a \\"b\\"")');
  assert.deepEqual(t, [['UID', '5', 'FLAGS', ['\\Seen'], 'BODY[HEADER.FIELDS (X-PRIORITY)]', 'X-Priority: 1', 'X', null, 'a "b"']]);
});

test('parses an envelope with encoded names', () => {
  const env = parseTokens('("Fri, 30 Oct 2026 10:00:00 +0000" "=?UTF-8?B?wqMxNSBib251cw==?=" (("=?UTF-8?Q?Caf=C3=A9?=" NIL "a" "b.com")) NIL NIL (("Josh" NIL "me" "x.org")) NIL NIL NIL "<id@x>")')[0];
  const e = parseEnvelope(env);
  assert.equal(e.subject, '£15 bonus');
  assert.deepEqual(e.from, [{ name: 'Café', email: 'a@b.com' }]);
  assert.equal(e.to[0].email, 'me@x.org');
  assert.equal(e.messageId, '<id@x>');
});

test('detects attachments in BODYSTRUCTURE', () => {
  const plain = parseTokens('("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)')[0];
  assert.equal(hasAttachment(plain), false);
  const mixed = parseTokens('(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "a.pdf") NIL NIL "BASE64" 100 NIL ("ATTACHMENT" ("FILENAME" "a.pdf")) NIL NIL) "MIXED" ("BOUNDARY" "x") NIL NIL NIL)')[0];
  assert.equal(hasAttachment(mixed), true);
  const related = parseTokens('(("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)("IMAGE" "PNG" ("NAME" "a.png") "<c>" NIL "BASE64" 100 NIL ("INLINE" NIL) NIL NIL) "RELATED" NIL NIL NIL NIL)')[0];
  assert.equal(hasAttachment(related), false);
});

test('expands ESORT sets in written order', () => {
  assert.deepEqual(expandSet('3,7:5,9'), [3, 7, 6, 5, 9]);
  assert.deepEqual(expandSet('1:3'), [1, 2, 3]);
});

test('search criteria use literals for user text', () => {
  const c = searchCriteria('café', { scope: 'from' });
  assert.equal(c[0], 'FROM ');
  assert.deepEqual(c[1], { literal: utf8Encode('café') });
});

test('RFC 2047 and modified UTF-7 round trips', () => {
  assert.equal(decodeWords(encodeWord('Grüße aus München, 💰')), 'Grüße aus München, 💰');
  assert.equal(encodeMailboxName('Entwürfe & Co'), 'Entw&APw-rfe &- Co');
  assert.equal(decodeMailboxName('Entw&APw-rfe &- Co'), 'Entwürfe & Co');
  assert.equal(utf8Decode(utf8Encode('✓ ok')), '✓ ok');
});

test('builds a MIME message with attachment and hidden Bcc', () => {
  const { raw, messageId } = buildMessage({
    from: { name: 'Josh Douch', email: 'me@x.org' },
    to: [{ name: 'Café', email: 'a@b.com' }],
    bcc: [{ name: '', email: 'secret@b.com' }],
    subject: 'Hi ✓',
    html: '<p>Hello</p>',
    attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: new TextEncoder().encode('hey') }],
  });
  assert.match(raw, /^From: Josh Douch <me@x\.org>\r\n/);
  assert.match(raw, /To: =\?UTF-8\?B\?/);
  assert.doesNotMatch(raw, /secret@b\.com/);
  assert.match(raw, /multipart\/mixed/);
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /filename="a\.txt"/);
  assert.match(messageId, /^<[0-9a-f]+@x\.org>$/);
  assert.equal(formatAddress({ name: 'Doe, John', email: 'j@d.com' }), '"Doe, John" <j@d.com>');
});
