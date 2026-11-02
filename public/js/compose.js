// Compose window: floating, can be minimised or maximised, with rich text,
// recipients as tokens, attachments, drafts autosave and sending.

import { api, $, $$, h, esc, showMenu, dialog, toast, formatSize, parseAddressList, isEmail, fullDate, relativeTime } from './util.js';
import { icon } from './icons.js';
import { state, identities, rememberContacts, myAddresses, folderByUse, accountTitle } from './state.js';
import { appApi } from './main.js';

const windows = new Set();
const AUTOSAVE_MS = 30000;

export function hasOpenCompose() {
  return [...windows].some((w) => w.dirty);
}

// ---------------------------------------------------------------------------
// Starting points

const addr = (a) => ({ name: a.name || '', email: a.address || a.email || '' });
const flat = (list) => (list || []).flatMap((a) => (a.group ? a.group : [a])).map(addr).filter((a) => a.email);

function prefixed(prefix, subject) {
  const s = subject || '';
  return new RegExp(`^${prefix}:`, 'i').test(s) ? s : `${prefix}: ${s}`;
}

function bodyOf(html, { stripBlocked = true } = {}) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll('style, script, title, meta, link').forEach((n) => n.remove());
  if (stripBlocked) doc.querySelectorAll('img[data-blocked-src]').forEach((n) => n.remove());
  return doc.body.innerHTML;
}

function quoteHeader(m) {
  const from = flat(m.from)[0] || { name: '', email: '' };
  return `On ${esc(fullDate(m.date))} ${esc(from.name)} &lt;${esc(from.email)}&gt; wrote:`;
}

function forwardHeader(m) {
  const from = flat(m.from)[0] || { name: '', email: '' };
  const fmt = (l) => esc(flat(l).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', '));
  return `<div>---------- Original Message ----------</div>
    <div>From: ${esc(from.name ? `${from.name} <${from.email}>` : from.email)}</div>
    <div>To: ${fmt(m.to)}</div>${flat(m.cc).length ? `<div>Cc: ${fmt(m.cc)}</div>` : ''}
    <div>Date: ${esc(fullDate(m.date))}</div>
    <div>Subject: ${esc(m.subject || '')}</div><br>`;
}

/**
 * Starts a reply, reply all, forward, draft edit or "send as new" from a
 * message loaded by the reader (GET /api/message).
 */
export async function composeFromMessage(mode, m) {
  let source = m;
  if ((mode === 'reply' || mode === 'replyAll' || mode === 'forward') && m.external && !m.imagesShown) {
    const choice = await dialog({
      title: 'Email contains external images',
      body: '<p>This email contains images from external sources that are currently hidden.</p>',
      buttons: [
        { label: 'Cancel', value: null, left: true },
        { label: 'Compose email with external images', value: 'with' },
        { label: 'Compose email without external images', value: 'without', primary: true },
      ],
      wide: true,
    });
    if (!choice) return;
    if (choice === 'with') {
      try {
        source = await api('message', { query: { folder: m.folder, uid: m.uid, images: '1', seen: '0' }, acct: m.acct || '' });
        source.imagesShown = true;
      } catch (e) {
        toast(e.message, { type: 'error' });
        return;
      }
    }
  }

  const me = myAddresses();
  const from = flat(m.from);
  const replyTo = flat(m.replyTo).length ? flat(m.replyTo) : from;
  const identity = pickIdentity(m);
  const acct = m.acct || '';
  const atts = (m.attachments || []).filter((a) => !a.inline).map((a) => ({ kind: 'keep', acct, folder: m.folder, uid: m.uid, index: a.index, filename: a.filename, size: a.size, mimeType: a.mimeType }));
  const refs = [m.references, m.messageId].filter(Boolean).join(' ').trim();
  const quoted = bodyOf(source.html, { stripBlocked: !source.imagesShown });

  if (mode === 'reply' || mode === 'replyAll') {
    let to = replyTo;
    let cc = [];
    if (mode === 'replyAll') {
      const seen = new Set(to.map((a) => a.email.toLowerCase()));
      const add = (list, into) => {
        for (const a of list) {
          const k = a.email.toLowerCase();
          if (!seen.has(k) && !me.has(k)) {
            seen.add(k);
            into.push(a);
          }
        }
      };
      to = [...to];
      add(flat(m.to), to);
      add(flat(m.cc), cc);
    }
    // replying to my own sent message: go to the original recipients
    if (to.every((a) => me.has(a.email.toLowerCase())) && flat(m.to).length) to = flat(m.to);
    return openCompose({
      mode,
      from: identity,
      to,
      cc,
      subject: prefixed('Re', m.subject),
      quoteHtml: `<div>${quoteHeader(m)}</div><blockquote type="cite">${quoted}</blockquote>`,
      quoteText: m.text || '',
      quoteIntro: quoteHeader(m).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
      inReplyTo: m.messageId,
      references: refs,
      source: { acct, folder: m.folder, uid: m.uid, type: 'reply' },
    });
  }
  if (mode === 'forward') {
    return openCompose({
      mode,
      from: identity,
      subject: prefixed('Fwd', m.subject),
      quoteHtml: `<blockquote type="cite">${forwardHeader(m)}${quoted}</blockquote>`,
      quoteText: m.text || '',
      attachments: atts,
      source: { acct, folder: m.folder, uid: m.uid, type: 'forward' },
    });
  }
  // draft or edit copy
  return openCompose({
    mode,
    from: (from[0] && identities().find((i) => i.account === acct && i.email.toLowerCase() === from[0].email.toLowerCase()) && { ...from[0], account: acct }) || identity,
    to: flat(m.to),
    cc: flat(m.cc),
    bcc: flat(m.bcc),
    subject: m.subject || '',
    html: m.isPlain ? null : bodyOf(m.html, { stripBlocked: false }),
    text: m.isPlain ? m.text || '' : null,
    format: m.isPlain ? 'text' : 'html',
    attachments: atts,
    draftUid: mode === 'draft' ? m.uid : null,
    draftAcct: acct,
    inReplyTo: m.inReplyTo,
    references: m.references,
    noSignature: true,
  });
}

// The address a reply goes out from: one of the receiving account's addresses
// that the message was sent to, else that account's main address.
function pickIdentity(m) {
  const acct = m.acct || '';
  const ids = identities().filter((i) => i.account === acct);
  const mine = [...flat(m.to), ...flat(m.cc)].map((a) => a.email.toLowerCase());
  return ids.find((i) => mine.includes(i.email.toLowerCase())) || ids[0] || defaultIdentity();
}

/** New mail is sent from the account whose folders are open. */
function defaultIdentity() {
  const ids = identities();
  return ids.find((i) => i.account === state.account) || ids[0];
}

// ---------------------------------------------------------------------------
// The window

const FONT_SIZES = ['8pt', '9pt', '10pt', '11pt', '12pt', '14pt', '16pt', '18pt', '24pt', '36pt'];
const FONTS = [
  ['system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif', 'System'],
  ['Arial,Helvetica,sans-serif', 'Arial'],
  ['Georgia,serif', 'Georgia'],
  ['"Times New Roman",Times,serif', 'Times New Roman'],
  ['Verdana,Geneva,sans-serif', 'Verdana'],
  ['"Courier New",Courier,monospace', 'Courier New'],
];
const COLORS = ['#000000', '#444444', '#666666', '#999999', '#cccccc', '#eeeeee', '#f3f3f3', '#ffffff', '#e03e2d', '#e67e23', '#f1c40f', '#2dc26b', '#169179', '#3598db', '#236fa1', '#843fa1', '#ba372a', '#b96ad9', '#ced4d9', '#95a5a6', '#7e8c8d', '#34495e', '#fbeeb8', '#c2e0f4'];

export function openCompose(opts = {}) {
  const dock = $('.compose-dock');
  if (!dock) return;
  // Only one maximised at a time; minimise others to keep things tidy.
  for (const w of windows) w.minimize(true);
  const c = new ComposeWindow(opts);
  windows.add(c);
  dock.append(c.el);
  c.focusFirst();
  return c;
}

class ComposeWindow {
  constructor(o) {
    this.o = o;
    this.format = o.format || state.prefs.composeFormat || 'html';
    this.attachments = o.attachments ? [...o.attachments] : [];
    this.draftUid = o.draftUid || null;
    this.draftAcct = o.draftAcct || '';
    this.dirty = false;
    this.savedAt = 0;
    this.busy = false;
    this.from = o.from || defaultIdentity();
    this.replyToAddr = null;
    this.build();
    this.autosave = setInterval(() => {
      if (this.dirty && !this.busy) this.saveDraft(true);
      this.renderStatus();
    }, AUTOSAVE_MS);
  }

  title() {
    const s = $('.c-subject', this.el)?.value.trim();
    if (s) return s;
    return { reply: 'Reply', replyAll: 'Reply all', forward: 'Forward', draft: 'Draft' }[this.o.mode] || 'New email';
  }

  build() {
    const o = this.o;
    const el = (this.el = h(`<div class="compose" role="dialog" aria-label="Compose email">
      <div class="compose-head">
        <span class="title"></span>
        <button class="icon-btn" data-c="minimize" title="Minimize">${icon('minimize')}</button>
        <button class="icon-btn" data-c="maximize" title="Maximize">${icon('maximize')}</button>
        <button class="icon-btn" data-c="close" title="Close">${icon('x')}</button>
      </div>
      <div class="compose-scroll">
        <div class="c-row"><label>From</label><button type="button" class="c-from"><span></span>${icon('chevronDown')}</button>
          <div class="toggles"><button type="button" data-t="cc">CC</button><button type="button" data-t="bcc">BCC</button><button type="button" data-t="replyto" title="Reply to">RE</button></div></div>
        <div class="c-row" data-row="to"><label>To</label><div class="tokens"></div></div>
        <div class="c-row hidden" data-row="cc"><label>CC</label><div class="tokens"></div></div>
        <div class="c-row hidden" data-row="bcc"><label>BCC</label><div class="tokens"></div></div>
        <div class="c-row hidden" data-row="replyto"><label>Reply to</label><input class="c-subject c-replyto" placeholder="Address replies should go to" spellcheck="false"></div>
        <div class="c-row"><label>Subject</label><input class="c-subject" spellcheck="true"></div>
        <div class="c-attachments"></div>
        <div class="editor-wrap"></div>
      </div>
      <div class="c-toolbar"></div>
      <div class="c-foot">
        <button type="button" class="btn btn-primary" data-c="send">Send</button>
        <button type="button" class="icon-btn" data-c="format" title="Switch to plain text">${icon('text')}</button>
        <button type="button" class="icon-btn" data-c="attach" title="Add attachment">${icon('paperclip')}</button>
        <button type="button" class="icon-btn" data-c="more" title="More options">${icon('more')}</button>
        <span class="status"></span>
        <input type="file" multiple hidden class="file-in">
      </div>
    </div>`));

    this.tokens = {};
    for (const k of ['to', 'cc', 'bcc']) {
      this.tokens[k] = new TokenInput($(`[data-row="${k}"] .tokens`, el), o[k] || [], () => this.markDirty());
      if (k !== 'to' && (o[k] || []).length) this.toggleRow(k, true);
    }
    $('.c-subject:not(.c-replyto)', el).value = o.subject || '';
    this.renderFrom();
    this.renderEditor(this.initialHtml(), this.initialText());
    this.renderAttachments();
    this.updateTitle();

    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (b) this.action(b.dataset.c, b);
      const t = e.target.closest('[data-t]');
      if (t) this.toggleRow(t.dataset.t);
    });
    $('.compose-head', el).addEventListener('dblclick', (e) => {
      if (!e.target.closest('button')) this.action('maximize');
    });
    $('.c-from', el).addEventListener('click', (e) => this.fromMenu(e.currentTarget));
    $('.c-subject:not(.c-replyto)', el).addEventListener('input', () => {
      this.markDirty();
      this.updateTitle();
    });
    $('.c-replyto', el).addEventListener('input', () => this.markDirty());
    $('.file-in', el).addEventListener('change', (e) => {
      this.addFiles([...e.target.files]);
      e.target.value = '';
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.send();
      } else if (e.key === 'Escape' && !e.target.closest('.tokens')) {
        e.stopPropagation();
        this.minimize();
      }
    });
    // drag and drop files
    el.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        el.classList.add('dragover');
      }
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('dragover');
    });
    el.addEventListener('drop', (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      el.classList.remove('dragover');
      this.addFiles([...e.dataTransfer.files]);
    });
  }

  signatureHtml() {
    const sig = state.prefs.signature;
    if (!sig || this.o.noSignature || ((this.o.mode === 'reply' || this.o.mode === 'replyAll' || this.o.mode === 'forward') && !state.prefs.signatureOnReply)) return '';
    return `<div class="signature">-- <br>${esc(sig).replace(/\n/g, '<br>')}</div>`;
  }

  initialHtml() {
    const o = this.o;
    if (o.html != null) return o.html;
    const blank = `<div><br></div>`;
    const sig = this.signatureHtml();
    return `${blank}${sig ? blank + sig : ''}${o.quoteHtml ? blank + o.quoteHtml : ''}`;
  }

  initialText() {
    const o = this.o;
    if (o.text != null) return o.text;
    const sig = this.signatureHtml() ? `\n\n-- \n${state.prefs.signature}` : '';
    let quote = '';
    if (o.quoteText || o.quoteHtml) {
      const text = o.quoteText || htmlToText(o.quoteHtml);
      quote = o.mode === 'forward' ? `\n\n---------- Original Message ----------\n${text}` : `\n\n${o.quoteIntro || ''}\n${text.split('\n').map((l) => '> ' + l).join('\n')}`;
    }
    return `\n${sig}${quote}`;
  }

  /** The account that sends this message (and keeps its draft). */
  get account() {
    return this.from.account || '';
  }

  renderFrom() {
    const f = this.from;
    $('.c-from span', this.el).textContent = f.name ? `${f.name} <${f.email}>` : f.email;
  }

  fromMenu(anchor) {
    const ids = identities();
    const grouped = new Set(ids.map((i) => i.account)).size > 1;
    const items = [];
    let last = null;
    for (const i of ids) {
      if (grouped && i.account !== last) {
        items.push({ header: accountTitle(i.account) });
        last = i.account;
      }
      items.push({ label: i.name ? `${i.name} <${i.email}>` : i.email, radio: i.email === this.from.email && i.name === this.from.name && i.account === this.account, action: () => { this.from = i; this.renderFrom(); this.markDirty(); } });
    }
    showMenu(anchor, [
      ...items,
      '-',
      { label: 'Edit names and addresses…', icon: 'settings', action: () => import('./settings.js').then((s) => s.openSettings('accounts')) },
    ]);
  }

  toggleRow(name, force) {
    const row = $(`[data-row="${name}"]`, this.el);
    const show = force ?? row.classList.contains('hidden');
    row.classList.toggle('hidden', !show);
    $(`[data-t="${name}"]`, this.el).classList.toggle('on', show);
    if (show && force === undefined) ($('input', row) || row).focus();
  }

  // --- editor -------------------------------------------------------------

  renderEditor(html, text) {
    const wrap = $('.editor-wrap', this.el);
    const tb = $('.c-toolbar', this.el);
    $('[data-c="format"]', this.el).title = this.format === 'html' ? 'Switch to plain text' : 'Switch to formatted text';
    $('[data-c="format"]', this.el).classList.toggle('active', this.format === 'text');
    if (this.format === 'text') {
      wrap.innerHTML = '<textarea class="editor" spellcheck="true"></textarea>';
      this.editor = $('textarea', wrap);
      this.editor.value = text ?? htmlToText(html || '');
      this.editor.addEventListener('input', () => this.markDirty());
      tb.classList.add('hidden');
      return;
    }
    tb.classList.remove('hidden');
    wrap.innerHTML = `<div class="editor" contenteditable="true" spellcheck="true" style="font-size:${esc(state.prefs.fontSize || '11pt')}"></div>`;
    this.editor = $('.editor', wrap);
    this.editor.innerHTML = html ?? textToHtml(text || '');
    this.editor.addEventListener('input', () => this.markDirty());
    this.editor.addEventListener('paste', (e) => this.onPaste(e));
    this.editor.addEventListener('drop', (e) => {
      const imgs = [...(e.dataTransfer?.files || [])].filter((f) => /^image\//.test(f.type));
      if (imgs.length && e.dataTransfer.files.length === imgs.length && e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        imgs.forEach((f) => this.insertImage(f));
      }
    });
    try {
      document.execCommand('defaultParagraphSeparator', false, 'div');
      document.execCommand('styleWithCSS', false, true);
    } catch {}
    this.renderToolbar();
  }

  renderToolbar() {
    const tb = $('.c-toolbar', this.el);
    const btn = (cmd, ic, title, cls = '') => `<button type="button" class="icon-btn ${cls}" data-cmd="${cmd}" title="${title}">${icon(ic)}</button>`;
    tb.innerHTML = `
      ${btn('undo', 'undo', 'Undo', 'max-only')}${btn('redo', 'redo', 'Redo', 'max-only')}<span class="sep max-only"></span>
      ${btn('bold', 'bold', 'Bold (Ctrl+B)')}${btn('italic', 'italic', 'Italic (Ctrl+I)')}${btn('underline', 'underline', 'Underline (Ctrl+U)')}<span class="sep"></span>
      ${btn('insertUnorderedList', 'listUl', 'Bullet list')}${btn('insertOrderedList', 'listOl', 'Numbered list')}${btn('outdent', 'outdent', 'Decrease indent')}${btn('indent', 'indent', 'Increase indent')}<span class="sep"></span>
      <select class="max-only" data-sel="block" title="Paragraph format"><option value="div">Div</option><option value="p">Paragraph</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="pre">Preformatted</option><option value="blockquote">Quote</option></select>
      <select class="max-only" data-sel="font" title="Font">${FONTS.map(([v, l]) => `<option value='${v}'>${l}</option>`).join('')}</select>
      <select data-sel="size" title="Font size">${FONT_SIZES.map((s) => `<option ${s === (state.prefs.fontSize || '11pt') ? 'selected' : ''}>${s}</option>`).join('')}</select>
      ${btn('removeFormat', 'clearFormat', 'Clear formatting')}<span class="sep"></span>
      ${btn('link', 'link', 'Insert link')}${btn('image', 'image', 'Insert image')}<span class="sep"></span>
      ${btn('foreColor', 'textColor', 'Text color')}${btn('hiliteColor', 'highlight', 'Background color')}
      <input type="file" accept="image/*" hidden class="img-in">`;
    tb.onmousedown = (e) => {
      if (e.target.closest('button')) e.preventDefault(); // keep the selection in the editor
    };
    tb.onclick = (e) => {
      const b = e.target.closest('[data-cmd]');
      if (b) this.command(b.dataset.cmd, b);
    };
    tb.onchange = (e) => {
      const s = e.target.closest('[data-sel]');
      if (!s) return;
      this.editor.focus();
      this.restoreSelection();
      if (s.dataset.sel === 'block') document.execCommand('formatBlock', false, s.value);
      if (s.dataset.sel === 'font') document.execCommand('fontName', false, s.value);
      if (s.dataset.sel === 'size') this.setFontSize(s.value);
      this.markDirty();
    };
    $('select', tb) && $$('select', tb).forEach((s) => s.addEventListener('mousedown', () => this.saveSelection()));
    $('.img-in', tb).addEventListener('change', (e) => {
      [...e.target.files].forEach((f) => this.insertImage(f));
      e.target.value = '';
    });
  }

  saveSelection() {
    const sel = window.getSelection();
    if (sel.rangeCount && this.editor.contains(sel.anchorNode)) this.range = sel.getRangeAt(0).cloneRange();
  }

  restoreSelection() {
    if (!this.range) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(this.range);
  }

  setFontSize(size) {
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7');
    $$('font[size="7"]', this.editor).forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = size;
      span.append(...f.childNodes);
      f.replaceWith(span);
    });
    document.execCommand('styleWithCSS', false, true);
  }

  command(cmd, anchor) {
    this.editor.focus();
    if (cmd === 'link') {
      this.saveSelection();
      const text = window.getSelection().toString();
      dialog({
        title: 'Insert link',
        body: `<label class="field"><span>URL</span><input class="input" value="https://"></label>${text ? '' : '<label class="field"><span>Text</span><input class="input link-text"></label>'}`,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Insert', primary: true, value: (el) => ({ url: $('input', el).value.trim(), text: $('.link-text', el)?.value }) }],
      }).then((r) => {
        if (!r || !/^(https?:|mailto:)/i.test(r.url)) return;
        this.editor.focus();
        this.restoreSelection();
        if (text) document.execCommand('createLink', false, r.url);
        else document.execCommand('insertHTML', false, `<a href="${esc(r.url)}">${esc(r.text || r.url)}</a>`);
        this.markDirty();
      });
      return;
    }
    if (cmd === 'image') {
      this.saveSelection();
      $('.img-in', this.el).click();
      return;
    }
    if (cmd === 'foreColor' || cmd === 'hiliteColor') {
      this.saveSelection();
      showMenu(anchor, [{
        html: `<div class="color-grid">${COLORS.map((c) => `<button type="button" style="background:${c}" data-color="${c}" title="${c}"></button>`).join('')}</div><button type="button" class="link" data-color="">${cmd === 'foreColor' ? 'Automatic' : 'No color'}</button>`,
        onMount: (node) => node.addEventListener('click', (e) => {
          const b = e.target.closest('[data-color]');
          if (!b) return;
          this.editor.focus();
          this.restoreSelection();
          const color = b.dataset.color || (cmd === 'foreColor' ? 'inherit' : 'transparent');
          document.execCommand(cmd, false, color);
          this.markDirty();
          import('./util.js').then((u) => u.closeMenu());
        }),
      }]);
      return;
    }
    document.execCommand(cmd, false, null);
    this.markDirty();
  }

  insertImage(file) {
    if (file.size > 5 * 1024 * 1024) return toast('Images inside the text can be up to 5 MB. Attach larger files instead.', { type: 'error' });
    const r = new FileReader();
    r.onload = () => {
      this.editor.focus();
      this.restoreSelection();
      document.execCommand('insertHTML', false, `<img src="${r.result}" alt="${esc(file.name)}" style="max-width:100%">`);
      this.markDirty();
    };
    r.readAsDataURL(file);
  }

  onPaste(e) {
    const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
    if (files.length) {
      e.preventDefault();
      files.forEach((f) => this.insertImage(f));
    }
  }

  switchFormat() {
    if (this.format === 'html') {
      const text = this.editor.innerText;
      this.format = 'text';
      this.renderEditor(null, text);
    } else {
      const text = this.editor.value;
      this.format = 'html';
      this.renderEditor(textToHtml(text), null);
    }
    this.markDirty();
  }

  // --- attachments --------------------------------------------------------

  addFiles(files) {
    for (const f of files) this.attachments.push({ kind: 'file', file: f, filename: f.name, size: f.size, mimeType: f.type });
    const total = this.attachments.reduce((n, a) => n + (a.size || 0), 0);
    if (total > 25 * 1024 * 1024) toast('Attachments add up to more than 25 MB. Many mail servers will refuse a message this big.', { type: 'error', timeout: 8000 });
    this.renderAttachments();
    this.markDirty();
  }

  renderAttachments() {
    const box = $('.c-attachments', this.el);
    box.innerHTML = this.attachments
      .map((a, i) => `<span class="att"><span class="thumb">${esc((a.filename.split('.').pop() || '').slice(0, 4).toUpperCase())}</span><span class="meta"><span class="fname">${esc(a.filename)}</span><span class="fsize">${formatSize(a.size || 0)}</span></span><button type="button" class="icon-btn small rm" data-rm="${i}" title="Remove">${icon('x')}</button></span>`)
      .join('');
    box.onclick = (e) => {
      const b = e.target.closest('[data-rm]');
      if (!b) return;
      this.attachments.splice(+b.dataset.rm, 1);
      this.renderAttachments();
      this.markDirty();
    };
  }

  // --- state --------------------------------------------------------------

  markDirty() {
    this.dirty = true;
    this.renderStatus();
  }

  updateTitle() {
    $('.compose-head .title', this.el).textContent = this.title();
  }

  renderStatus(text, err) {
    const s = $('.c-foot .status', this.el);
    if (!s) return;
    s.classList.toggle('err', !!err);
    if (text !== undefined) s.textContent = text;
    else s.textContent = this.savedAt && !this.dirty ? `Saved ${relativeTime(this.savedAt).replace('just now', 'a few seconds ago')}` : '';
  }

  collect() {
    for (const t of Object.values(this.tokens)) t.commit();
    const replyTo = parseAddressList($('.c-replyto', this.el).value)[0];
    const meta = {
      from: this.from,
      to: this.tokens.to.get(),
      cc: this.tokens.cc.get(),
      bcc: this.tokens.bcc.get(),
      replyTo: replyTo && isEmail(replyTo.email) ? replyTo : null,
      subject: $('.c-subject:not(.c-replyto)', this.el).value.trim(),
      isPlain: this.format === 'text',
      priority: this.priority || null,
      readReceipt: !!this.readReceipt,
      inReplyTo: this.o.inReplyTo || null,
      references: this.o.references || null,
      source: this.o.source || null,
      // A draft kept on another account (the From address changed) is
      // removed from there after saving, not replaced in place.
      draftUid: this.draftAcct === this.account ? this.draftUid : null,
      keep: this.attachments.filter((a) => a.kind === 'keep').map((a) => ({ acct: a.acct || '', folder: a.folder, uid: a.uid, index: a.index })),
    };
    if (this.format === 'text') meta.text = this.editor.value;
    else meta.html = this.editor.innerHTML;
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    for (const a of this.attachments) if (a.kind === 'file') form.append('file', a.file, a.filename);
    return { meta, form };
  }

  async saveDraft(auto = false) {
    if (this.busy) return;
    this.busy = true;
    this.renderStatus('Saving…');
    try {
      const { form } = this.collect();
      const acct = this.account;
      const r = await api('draft', { method: 'POST', form, acct });
      if (this.draftUid && this.draftAcct !== acct) await this.deleteDraft();
      this.draftUid = r.uid;
      this.draftAcct = acct;
      // Uploaded files now live in the draft; refer to them there.
      this.attachments = r.uid
        ? r.attachments.map((a) => ({ kind: 'keep', acct, folder: r.folder, uid: r.uid, index: a.index, filename: a.filename, size: a.size, mimeType: a.mimeType }))
        : this.attachments;
      this.dirty = false;
      this.savedAt = Date.now();
      this.renderAttachments();
      this.renderStatus();
      if (appApi.currentFolder()?.specialUse === 'drafts') appApi.reloadList({ keep: true });
      return true;
    } catch (e) {
      this.renderStatus(auto ? 'Draft not saved' : e.message, true);
      if (!auto) toast(e.message, { type: 'error' });
      return false;
    } finally {
      this.busy = false;
    }
  }

  async send() {
    if (this.busy) return;
    const { meta, form } = this.collect();
    const bad = [...meta.to, ...meta.cc, ...meta.bcc].filter((a) => !isEmail(a.email));
    if (bad.length) return toast(`Please check this address: ${bad[0].email}`, { type: 'error' });
    if (!meta.to.length && !meta.cc.length && !meta.bcc.length) {
      toast('Please add at least one recipient', { type: 'error' });
      return this.tokens.to.focus();
    }
    if (!meta.subject) {
      const ok = await dialog({ title: 'No subject', body: '<p>This email has no subject. Send it anyway?</p>', buttons: [{ label: 'Cancel', value: false }, { label: 'Send', value: true, primary: true }] });
      if (!ok) return;
    }
    this.busy = true;
    const btn = $('[data-c="send"]', this.el);
    btn.disabled = true;
    btn.textContent = 'Sending…';
    this.renderStatus('');
    try {
      const r = await api('send', { method: 'POST', form, acct: this.account });
      // The old draft was replaced on this account; one left on another
      // account (From changed) is removed separately.
      if (this.draftUid && this.draftAcct !== this.account) await this.deleteDraft();
      rememberContacts([...meta.to, ...meta.cc, ...meta.bcc]);
      this.destroy();
      toast('Your email has been sent', { timeout: 3000 });
      for (const w of r.warnings || []) toast(w, { type: 'error', timeout: 8000 });
      appApi.refreshFolders();
      const f = appApi.currentFolder();
      if (f && (f.specialUse === 'sent' || f.specialUse === 'drafts')) appApi.reloadList({ keep: true });
    } catch (e) {
      this.busy = false;
      btn.disabled = false;
      btn.textContent = 'Send';
      this.renderStatus('Not sent', true);
      toast(e.message, { type: 'error', timeout: 10000 });
    }
  }

  async close() {
    const empty = !this.tokens.to.get().length && !$('.c-subject:not(.c-replyto)', this.el).value.trim() && !(this.format === 'text' ? this.editor.value.trim() : this.editor.innerText.trim()) && !this.attachments.length;
    if (!this.dirty || empty) {
      if (empty && this.draftUid && this.o.mode !== 'draft') await this.deleteDraft();
      return this.destroy();
    }
    this.maximize(false);
    const choice = await dialog({
      title: 'Save changes?',
      body: '<p>Do you want to keep this email as a draft?</p>',
      buttons: [
        { label: 'Cancel', value: null, left: true },
        { label: 'Discard', value: 'discard' },
        { label: 'Save as draft', value: 'save', primary: true },
      ],
    });
    if (choice === 'save') {
      if (await this.saveDraft()) {
        toast('Saved to Drafts', { timeout: 2500 });
        this.destroy();
      }
    } else if (choice === 'discard') {
      if (this.draftUid && this.o.mode !== 'draft') await this.deleteDraft();
      this.destroy();
    }
  }

  async deleteDraft() {
    const drafts = folderByUse('drafts', this.draftAcct);
    if (!drafts || !this.draftUid) return;
    try {
      await api('delete', { method: 'POST', body: { folder: drafts.path, uids: [this.draftUid], permanent: true }, acct: this.draftAcct });
    } catch {}
  }

  destroy() {
    clearInterval(this.autosave);
    windows.delete(this);
    this.el.remove();
  }

  minimize(force) {
    const on = force ?? !this.el.classList.contains('minimized');
    this.el.classList.toggle('minimized', on);
    if (on) this.el.classList.remove('maximized');
    $('[data-c="minimize"]', this.el).innerHTML = icon(on ? 'popout' : 'minimize');
    $('[data-c="minimize"]', this.el).title = on ? 'Restore' : 'Minimize';
  }

  maximize(on) {
    on = on ?? !this.el.classList.contains('maximized');
    this.el.classList.toggle('maximized', on);
    if (on) {
      this.el.classList.remove('minimized');
      for (const w of windows) if (w !== this) w.maximize(false);
    }
    $('[data-c="maximize"]', this.el).innerHTML = icon(on ? 'restore' : 'maximize');
  }

  action(name, b) {
    switch (name) {
      case 'minimize':
        this.minimize();
        break;
      case 'maximize':
        this.maximize();
        break;
      case 'close':
        this.close();
        break;
      case 'send':
        this.send();
        break;
      case 'attach':
        $('.file-in', this.el).click();
        break;
      case 'format':
        this.switchFormat();
        break;
      case 'more':
        showMenu(b, [
          { label: 'Save as draft', icon: 'draft', action: () => this.saveDraft().then((ok) => ok && toast('Saved to Drafts', { timeout: 2000 })) },
          '-',
          { header: 'Priority' },
          { label: 'High', radio: this.priority === 'high', action: () => { this.priority = 'high'; this.markDirty(); } },
          { label: 'Normal', radio: !this.priority, action: () => { this.priority = null; this.markDirty(); } },
          { label: 'Low', radio: this.priority === 'low', action: () => { this.priority = 'low'; this.markDirty(); } },
          '-',
          { label: 'Request read receipt', checked: !!this.readReceipt, action: () => { this.readReceipt = !this.readReceipt; } },
          { label: this.format === 'html' ? 'Switch to plain text' : 'Switch to formatted text', icon: 'text', action: () => this.switchFormat() },
          '-',
          { label: 'Discard', icon: 'trash', danger: true, action: async () => { if (this.draftUid && this.o.mode !== 'draft') await this.deleteDraft(); this.destroy(); } },
        ]);
        break;
    }
  }

  focusFirst() {
    setTimeout(() => {
      if (this.o.mode === 'reply' || this.o.mode === 'replyAll' || this.o.mode === 'draft') {
        this.editor.focus();
        if (this.format === 'text') this.editor.setSelectionRange(0, 0);
        else {
          const r = document.createRange();
          r.setStart(this.editor, 0);
          r.collapse(true);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
        this.editor.scrollTop = 0;
      } else this.tokens.to.focus();
    }, 30);
  }
}

// ---------------------------------------------------------------------------
// Recipient token input with suggestions

function knownContacts() {
  const map = new Map();
  const add = (c) => {
    if (c?.email && !map.has(c.email.toLowerCase())) map.set(c.email.toLowerCase(), c);
  };
  [...state.prefs.contacts].reverse().forEach(add);
  for (const m of state.list.messages) {
    (m.from || []).forEach(add);
    (m.to || []).forEach(add);
  }
  return [...map.values()];
}

class TokenInput {
  constructor(container, initial, onChange) {
    this.box = container;
    this.onChange = onChange;
    this.items = [];
    this.box.innerHTML = '<input type="text" autocomplete="off" spellcheck="false" aria-label="Recipients">';
    this.input = $('input', this.box);
    initial.forEach((a) => this.add(a, true));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('input', () => this.suggest());
    this.input.addEventListener('blur', () => setTimeout(() => {
      this.commit();
      this.hideSuggest();
    }, 150));
    this.input.addEventListener('paste', (e) => {
      const text = e.clipboardData.getData('text');
      if (/[,;\n]/.test(text)) {
        e.preventDefault();
        parseAddressList(text.replace(/\n/g, ',')).forEach((a) => this.add(a));
      }
    });
    this.box.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        this.items.splice(+rm.dataset.rm, 1);
        this.render();
        this.onChange();
      }
      this.input.focus();
    });
  }

  get() {
    return this.items.map((a) => ({ name: a.name, email: a.email }));
  }

  focus() {
    this.input.focus();
  }

  add(a, silent) {
    if (!a?.email) return;
    if (this.items.some((x) => x.email.toLowerCase() === a.email.toLowerCase())) return;
    this.items.push({ name: a.name || '', email: a.email.trim() });
    this.render();
    if (!silent) this.onChange();
  }

  commit() {
    const v = this.input.value.trim();
    if (!v) return;
    parseAddressList(v).forEach((a) => this.add(a));
    this.input.value = '';
  }

  render() {
    $$('.token', this.box).forEach((t) => t.remove());
    this.items.forEach((a, i) => {
      const t = h(`<span class="token ${isEmail(a.email) ? '' : 'invalid'}" title="${esc(a.email)}"><span>${esc(a.name || a.email)}</span><button type="button" data-rm="${i}" aria-label="Remove">${icon('x')}</button></span>`);
      this.box.insertBefore(t, this.input);
    });
  }

  onKey(e) {
    const s = this.suggestEl;
    if (s && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const opts = $$('div', s);
      let i = opts.findIndex((o) => o.classList.contains('on'));
      opts[i]?.classList.remove('on');
      i = e.key === 'ArrowDown' ? Math.min(opts.length - 1, i + 1) : Math.max(0, i - 1);
      opts[i]?.classList.add('on');
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      const on = s && $('div.on', s);
      if (on) {
        e.preventDefault();
        this.add(this.matches[+on.dataset.i]);
        this.input.value = '';
        this.hideSuggest();
        return;
      }
      if (this.input.value.trim()) {
        if (e.key !== 'Tab') e.preventDefault();
        this.commit();
        this.hideSuggest();
      } else if (e.key === 'Enter') e.preventDefault();
    } else if (e.key === 'Backspace' && !this.input.value && this.items.length) {
      this.items.pop();
      this.render();
      this.onChange();
    } else if (e.key === 'Escape' && s) {
      e.stopPropagation();
      this.hideSuggest();
    }
  }

  suggest() {
    const q = this.input.value.trim().toLowerCase();
    if (q.length < 1) return this.hideSuggest();
    const have = new Set(this.items.map((a) => a.email.toLowerCase()));
    this.matches = knownContacts()
      .filter((c) => !have.has(c.email.toLowerCase()) && (c.email.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q)))
      .slice(0, 8);
    if (!this.matches.length) return this.hideSuggest();
    if (!this.suggestEl) {
      this.suggestEl = h('<div class="suggest"></div>');
      this.box.append(this.suggestEl);
      this.suggestEl.addEventListener('mousedown', (e) => {
        const d = e.target.closest('[data-i]');
        if (!d) return;
        e.preventDefault();
        this.add(this.matches[+d.dataset.i]);
        this.input.value = '';
        this.hideSuggest();
      });
    }
    this.suggestEl.innerHTML = this.matches.map((c, i) => `<div data-i="${i}" class="${i === 0 ? 'on' : ''}"><span>${esc(c.name || c.email)}</span>${c.name ? `<small>${esc(c.email)}</small>` : ''}</div>`).join('');
  }

  hideSuggest() {
    this.suggestEl?.remove();
    this.suggestEl = null;
  }
}

// ---------------------------------------------------------------------------

function htmlToText(html) {
  const div = document.createElement('div');
  div.innerHTML = (html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|h\d|li|tr)>/gi, '$&\n');
  div.querySelectorAll('blockquote').forEach((b) => {
    b.textContent = b.textContent.split('\n').map((l) => '> ' + l).join('\n');
  });
  return div.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

function textToHtml(text) {
  return (text || '')
    .split('\n')
    .map((l) => `<div>${l ? esc(l) : '<br>'}</div>`)
    .join('');
}
