// Settings: the quick menu under the gear icon and the full settings dialog.

import { api, $, $$, h, esc, showMenu, closeMenu, toast, confirmDialog, fullDate, dialog, isEmail } from './util.js';
import { icon } from './icons.js';
import { state, setPrefs, ACCENTS, BACKGROUNDS, accountById } from './state.js';

const QUICK_THEMES = [
  ['white', '#ffffff'],
  ['ratlan', BACKGROUNDS.RatLAN[0][2]],
  ['ratlan-dark', BACKGROUNDS.RatLAN[1][2]],
  ['dark', '#111214'],
  ['bg-blue-sunset', BACKGROUNDS.Sunsets[0][2]],
  ['bg-pink-sunset', BACKGROUNDS.Sunsets[1][2]],
  ['bg-orange-glow', BACKGROUNDS.Sunsets[2][2]],
  ['bg-blue', '#3f77c0'],
];

function layoutPic(kind) {
  const bar = (x, y, w) => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:3px;background:var(--border-strong);border-radius:2px"></div>`;
  const dot = (x, y) => `<div style="position:absolute;left:${x}px;top:${y - 1}px;width:5px;height:5px;border-radius:50%;background:color-mix(in srgb,var(--accent) 55%,white)"></div>`;
  let inner = '';
  if (kind === 'vertical') {
    for (let i = 0; i < 4; i++) inner += dot(4, 8 + i * 11) + bar(12, 8 + i * 11, 14);
    inner += '<div style="position:absolute;left:30px;top:0;bottom:0;border-left:1px solid var(--border-strong)"></div>';
    for (let i = 0; i < 5; i++) inner += bar(35, 6 + i * 6, 30);
  } else if (kind === 'horizontal') {
    for (let i = 0; i < 3; i++) inner += dot(4, 6 + i * 7) + bar(12, 6 + i * 7, 18) + bar(34, 6 + i * 7, 32);
    inner += '<div style="position:absolute;left:0;right:0;top:26px;border-top:1px solid var(--border-strong)"></div>';
    for (let i = 0; i < 4; i++) inner += bar(5, 31 + i * 6, i === 0 ? 20 : 56);
  } else {
    for (let i = 0; i < 7; i++) inner += dot(4, 5 + i * 7) + bar(12, 5 + i * 7, 18) + bar(34, 5 + i * 7, 32);
  }
  return `<div class="layout-pic">${inner}</div>`;
}

/** Menu under the gear icon, like OX's quick settings. */
export function settingsMenu(anchor, { openAll }) {
  const p = state.prefs;
  showMenu(anchor, [
    { label: 'All settings …', action: openAll },
    '-',
    {
      html: `<div class="menu-header" style="padding:2px 0 8px">Themes</div><div class="theme-grid">${QUICK_THEMES.map(([id, bg]) => `<button type="button" class="theme-swatch ${p.theme === id ? 'on' : ''}" data-theme-id="${id}" style="background:${bg}" title="${id}"></button>`).join('')}</div>
        <button type="button" class="link" data-more-themes style="margin-top:8px;color:var(--text)">View more …</button>`,
      onMount: (node) => node.addEventListener('click', (e) => {
        const t = e.target.closest('[data-theme-id]');
        if (t) {
          setPrefs({ theme: t.dataset.themeId });
          $$('.theme-swatch', node).forEach((x) => x.classList.toggle('on', x === t));
        }
        if (e.target.closest('[data-more-themes]')) {
          closeMenu();
          openSettings('general');
        }
      }),
    },
    '-',
    {
      html: `<div class="menu-header" style="padding:2px 0 6px">Layout</div>${['vertical', 'horizontal', 'list'].map((l) => `<button type="button" class="layout-opt" data-layout="${l}"><span class="opt-radio ${p.layout === l ? 'on' : ''}"></span><span class="label">${l[0].toUpperCase() + l.slice(1)}</span>${layoutPic(l)}</button>`).join('')}`,
      onMount: (node) => node.addEventListener('click', (e) => {
        const b = e.target.closest('[data-layout]');
        if (!b) return;
        setPrefs({ layout: b.dataset.layout });
        $$('[data-layout] .opt-radio', node).forEach((r) => r.classList.toggle('on', r.parentElement === b));
      }),
    },
    '-',
    {
      html: `<div class="menu-header" style="padding:2px 0 6px">List options</div>${[['avatars', 'Contact pictures'], ['checkboxes', 'Checkboxes'], ['simple', 'Simple']].map(([v, l]) => `<button type="button" class="layout-opt" data-liststyle="${v}"><span class="opt-radio ${p.listStyle === v ? 'on' : ''}"></span><span class="label">${l}</span></button>`).join('')}`,
      onMount: (node) => node.addEventListener('click', (e) => {
        const b = e.target.closest('[data-liststyle]');
        if (!b) return;
        setPrefs({ listStyle: b.dataset.liststyle });
        $$('[data-liststyle] .opt-radio', node).forEach((r) => r.classList.toggle('on', r.parentElement === b));
      }),
    },
    '-',
    { label: 'Install as an app …', action: installHelp },
  ], { align: 'right', className: 'settings-menu' });
}

function installHelp() {
  import('./util.js').then(({ dialog }) =>
    dialog({
      title: 'Install as an app',
      body: '<p>In Chrome or Edge, open the browser menu and choose <b>Install page as app</b> (or click the install icon in the address bar). On iPhone or iPad, tap Share and then <b>Add to Home Screen</b>.</p>',
      buttons: [{ label: 'Close', value: true, primary: true }],
    }),
  );
}

// ---------------------------------------------------------------------------
// Full settings dialog

const PAGES = [
  ['general', 'General', 'gear'],
  ['notifications', 'Notifications', 'bell'],
  ['security', 'Security', 'shield'],
  ['accounts', 'Accounts', 'account'],
  ['mail', 'Mail', 'mail'],
  ['compose', 'Compose', 'edit'],
];

// opts.add opens the "Add mail account" form; opts.edit = account id.
export function openSettings(page = 'general', opts = {}) {
  $('.modal-back.settings-back')?.remove();
  const back = h(`<div class="modal-back settings-back"><div class="modal settings" role="dialog" aria-modal="true" aria-label="Settings">
    <div class="settings-nav">
      <h2>Settings</h2>
      <div class="search">${icon('search')}<input type="search" placeholder="Search" aria-label="Search settings"></div>
      <div class="nav-items">${PAGES.map(([id, label, ic]) => `<button type="button" data-page="${id}">${icon(ic)}<span>${label}</span></button>`).join('')}</div>
    </div>
    <div class="settings-main">
      <div class="settings-main-head"><h2></h2>
        <button class="icon-btn" data-close title="Close">${icon('x')}</button></div>
      <div class="settings-body"></div>
    </div></div></div>`);
  document.body.append(back);
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !$('.menu')) {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) close();
  });
  $('[data-close]', back).onclick = close;
  $('.nav-items', back).onclick = (e) => {
    const b = e.target.closest('[data-page]');
    if (b) show(b.dataset.page);
  };
  $('.settings-nav input', back).addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('.nav-items button', back).forEach((b) => {
      const page = b.dataset.page;
      const words = (SEARCH_WORDS[page] || '') + ' ' + b.textContent;
      b.classList.toggle('hidden', !!q && !words.toLowerCase().includes(q));
    });
  });

  function show(id) {
    $$('.nav-items button', back).forEach((b) => b.classList.toggle('on', b.dataset.page === id));
    $('.settings-main-head h2', back).textContent = PAGES.find((p) => p[0] === id)[1];
    const body = $('.settings-body', back);
    body.innerHTML = '';
    RENDER[id](body);
  }
  show(page);
  if (page === 'accounts' && (opts.add || opts.edit)) accountDialog(opts.edit ? accountById(opts.edit) : null, $('.settings-body', back));
}

const SEARCH_WORDS = {
  general: 'theme accent color background dark layout refresh',
  notifications: 'desktop alert new mail',
  security: 'sessions devices sign out password',
  accounts: 'name identity alias from address add mail account gmail outlook yahoo icloud imap smtp',
  mail: 'images read layout list delete trusted',
  compose: 'signature format plain html font',
};

function card(title, desc, inner) {
  return `<div class="s-card"><div class="s-card-head"><h3>${esc(title)}</h3>${desc ? `<p>${esc(desc)}</p>` : ''}</div><div class="s-card-body">${inner}</div></div>`;
}

function radios(name, value, options) {
  return `<div class="opt-list">${options.map(([v, l]) => `<label class="opt"><input type="radio" name="${name}" value="${esc(v)}" ${String(value) === String(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>`;
}

function bindRadios(body, name, key, cast = (v) => v) {
  $$(`input[name="${name}"]`, body).forEach((r) => r.addEventListener('change', () => setPrefs({ [key]: cast(r.value) })));
}

const RENDER = {
  general(body) {
    const p = state.prefs;
    const bgGroup = (title, list) => `<h5>${title}</h5><div class="bg-row">${list.map(([id, label, bg]) => `<button type="button" class="bg-opt ${p.theme === id ? 'on' : ''}" data-bg="${id}"><span class="sw" style="background:${bg}"></span><span class="lbl">${label}</span></button>`).join('')}</div>`;
    body.innerHTML =
      card('Theme', 'Personalize the general appearance', `
        <h4>Accent colors</h4>
        <div class="accent-row">${ACCENTS.map((c) => `<button type="button" class="accent-dot ${p.accent === c ? 'on' : ''}" data-accent="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>
        <h4 style="margin-top:20px">Backgrounds</h4>
        ${Object.entries(BACKGROUNDS).map(([k, v]) => bgGroup(k, v)).join('')}`) +
      card('Layout', 'How the message list and reading pane are arranged', `
        ${radios('layout', p.layout, [['vertical', 'Vertical: list on the left, message on the right'], ['horizontal', 'Horizontal: list on top, message below'], ['list', 'List: full-width list, open a message to read it']])}
        <h4 style="margin-top:18px">List options</h4>
        ${radios('listStyle', p.listStyle, [['avatars', 'Contact pictures'], ['checkboxes', 'Checkboxes'], ['simple', 'Simple']])}`) +
      card('Refresh', 'How often to check the mail server for new mail', radios('refresh', p.refreshMinutes, [[1, 'Every minute'], [5, 'Every 5 minutes'], [15, 'Every 15 minutes']]));
    body.addEventListener('click', (e) => {
      const a = e.target.closest('[data-accent]');
      if (a) {
        setPrefs({ accent: a.dataset.accent });
        $$('.accent-dot', body).forEach((x) => x.classList.toggle('on', x === a));
      }
      const b = e.target.closest('[data-bg]');
      if (b) {
        setPrefs({ theme: b.dataset.bg });
        $$('.bg-opt', body).forEach((x) => x.classList.toggle('on', x === b));
      }
    });
    bindRadios(body, 'layout', 'layout');
    bindRadios(body, 'listStyle', 'listStyle');
    bindRadios(body, 'refresh', 'refreshMinutes', Number);
  },

  notifications(body) {
    const supported = 'Notification' in window;
    const perm = supported ? Notification.permission : 'unsupported';
    body.innerHTML = card('Desktop notifications', 'Show a notification when new mail arrives while this tab is in the background', `
      <label class="opt"><input type="checkbox" class="notif-on" ${state.prefs.notifications ? 'checked' : ''} ${supported ? '' : 'disabled'}> Show desktop notifications for new mail</label>
      <p class="muted" style="margin:12px 0 0">${perm === 'denied' ? 'Your browser is blocking notifications for this site. Allow them in the browser\'s site settings.' : perm === 'unsupported' ? 'This browser does not support notifications.' : 'New mail is checked while ratmail is open in a tab.'}</p>`);
    $('.notif-on', body)?.addEventListener('change', async (e) => {
      if (e.target.checked && Notification.permission !== 'granted') {
        const r = await Notification.requestPermission();
        if (r !== 'granted') {
          e.target.checked = false;
          toast('Notifications were not allowed', { type: 'error' });
          return;
        }
      }
      setPrefs({ notifications: e.target.checked });
    });
  },

  async security(body) {
    body.innerHTML = card('Signed-in devices', 'Every browser where you are signed in. Your password is stored encrypted, and the key exists only in that browser.', '<div class="spinner small"></div>');
    try {
      const { sessions } = await api('sessions');
      const rows = sessions.map((s) => `<tr><td>${esc(describeAgent(s.agent))}${s.current ? ' <b>(this browser)</b>' : ''}</td><td>${esc(fullDate(new Date(s.created * 1000).toISOString()))}</td><td>${esc(fullDate(new Date(s.lastSeen * 1000).toISOString()))}</td><td>${s.remember ? 'Stay signed in' : 'Until browser closes'}</td></tr>`).join('');
      $('.s-card-body', body).innerHTML = `<table class="sessions-table"><tr><th>Device</th><th>Signed in</th><th>Last active</th><th>Type</th></tr>${rows}</table>
        ${sessions.length > 1 ? '<button class="btn" style="margin-top:14px" data-revoke>Sign out all other devices</button>' : ''}`;
      $('[data-revoke]', body)?.addEventListener('click', async () => {
        if (!(await confirmDialog('Sign out other devices', 'Sign out everywhere except this browser?', { ok: 'Sign out others' }))) return;
        await api('sessions/revoke-others', { method: 'POST' });
        toast('Other devices have been signed out');
        RENDER.security(body);
      });
    } catch (e) {
      $('.s-card-body', body).textContent = e.message;
    }
    body.insertAdjacentHTML('beforeend', card('Password', '', `<p class="muted" style="margin:0">ratmail signs in with your mail server's password. To change it, use your mail server's own settings page (for Mailcow: the Mailcow user interface).</p>`));
  },

  accounts(body) {
    const p = state.prefs;
    const s = state.session;
    body.innerHTML =
      card('Mail account', '', `
        <div class="s-row"><label>Server</label><div>${esc(s.server?.name || '')}</div></div>
        <div class="s-row"><label>Username</label><div>${esc(s.username)}</div></div>
        <div class="s-row"><label for="dn">Your name</label><input id="dn" class="input" value="${esc(p.displayName)}" placeholder="Shown as the sender name"></div>`) +
      card('Send from other addresses', 'Aliases your mail server lets you send from', `
        <div class="ids"></div><button class="btn" data-add-id>${'Add address'}</button>`);
    $('#dn', body).addEventListener('change', (e) => setPrefs({ displayName: e.target.value.trim() }));
    const ids = $('.ids', body);
    const render = () => {
      ids.innerHTML = (state.prefs.identities || []).map((i, n) => `<div class="identity-row" data-n="${n}"><input class="input" data-k="name" placeholder="Name" value="${esc(i.name)}"><input class="input" data-k="email" placeholder="Email address" value="${esc(i.email)}"><button class="icon-btn" data-rm title="Remove">${icon('trash')}</button></div>`).join('');
    };
    render();
    ids.addEventListener('change', (e) => {
      const row = e.target.closest('[data-n]');
      const list = [...(state.prefs.identities || [])];
      list[+row.dataset.n] = { ...list[+row.dataset.n], [e.target.dataset.k]: e.target.value.trim() };
      setPrefs({ identities: list });
    });
    ids.addEventListener('click', (e) => {
      if (!e.target.closest('[data-rm]')) return;
      const list = [...(state.prefs.identities || [])];
      list.splice(+e.target.closest('[data-n]').dataset.n, 1);
      setPrefs({ identities: list });
      render();
    });
    $('[data-add-id]', body).onclick = () => {
      setPrefs({ identities: [...(state.prefs.identities || []), { name: state.prefs.displayName, email: '' }] });
      render();
      $$('.identity-row input[data-k="email"]', body).pop()?.focus();
    };
    renderOtherAccounts(body);
  },

  mail(body) {
    const p = state.prefs;
    body.innerHTML =
      card('Reading', '', `
        <h4>Mark as read</h4>
        ${radios('markRead', p.markRead, [['immediate', 'Immediately when opened'], ['delay', 'After 3 seconds'], ['never', 'Never (mark manually)']])}
        <h4 style="margin-top:18px">External images</h4>
        ${radios('images', p.images, [['ask', 'Block and ask (recommended, stops tracking pixels)'], ['always', 'Always show']])}`) +
      card('Trusted senders', 'Images from these senders always show', `
        <div class="trusted">${p.trusted.length ? p.trusted.map((t, i) => `<div class="identity-row" style="grid-template-columns:1fr 32px"><span style="align-self:center">${esc(t)}</span><button class="icon-btn" data-untrust="${i}" title="Remove">${icon('trash')}</button></div>`).join('') : '<span class="muted">None yet. Use "Always show images from…" on a message.</span>'}</div>`) +
      card('Deleting', '', `<label class="opt"><input type="checkbox" class="confirm-del" ${p.confirmDelete ? 'checked' : ''}> Ask before moving messages to Trash</label>`);
    bindRadios(body, 'markRead', 'markRead');
    bindRadios(body, 'images', 'images');
    $('.confirm-del', body).addEventListener('change', (e) => setPrefs({ confirmDelete: e.target.checked }));
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-untrust]');
      if (!b) return;
      const list = [...state.prefs.trusted];
      list.splice(+b.dataset.untrust, 1);
      setPrefs({ trusted: list });
      RENDER.mail(body);
    });
  },

  compose(body) {
    const p = state.prefs;
    body.innerHTML =
      card('Format', '', `
        ${radios('composeFormat', p.composeFormat, [['html', 'Formatted text (HTML)'], ['text', 'Plain text']])}
        <div class="s-row" style="margin-top:16px"><label>Default font size</label><select class="input font-size" style="max-width:120px">${['9pt', '10pt', '11pt', '12pt', '14pt'].map((s) => `<option ${s === p.fontSize ? 'selected' : ''}>${s}</option>`).join('')}</select></div>`) +
      card('Signature', 'Added to new emails', `
        <textarea class="input sig" rows="5" placeholder="Your signature">${esc(p.signature)}</textarea>
        <label class="opt" style="margin-top:12px"><input type="checkbox" class="sig-reply" ${p.signatureOnReply ? 'checked' : ''}> Also add it to replies and forwards</label>`);
    bindRadios(body, 'composeFormat', 'composeFormat');
    $('.font-size', body).addEventListener('change', (e) => setPrefs({ fontSize: e.target.value }));
    $('.sig', body).addEventListener('change', (e) => setPrefs({ signature: e.target.value }));
    $('.sig-reply', body).addEventListener('change', (e) => setPrefs({ signatureOnReply: e.target.checked }));
  },
};

function describeAgent(ua = '') {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// ---------------------------------------------------------------------------
// Other mail accounts (Gmail, Outlook, Yahoo, any IMAP server)

const PROVIDER_ICON_TEXT = { gmail: 'G', outlook: 'O', yahoo: 'Y!', icloud: '', aol: 'Aol', fastmail: 'F', zoho: 'Z', gmx: 'GMX' };

function renderOtherAccounts(body) {
  $('.s-card.other-accounts', body)?.remove();
  const list = state.accounts;
  const noVault = state.session.vault === false;
  const rows = list
    .map((a) => `<div class="acct-row" data-id="${esc(a.id)}">
      <span class="acct-badge">${icon('mail')}</span>
      <div class="acct-info"><b>${esc(a.label || a.email)}</b><span class="muted">${esc(a.label ? a.email : '')}${a.label ? ' · ' : ''}${esc(a.imap.host)}</span>
        ${a.locked ? `<span class="acct-warn">${icon('alert')} Needs its password again</span>` : ''}</div>
      <button class="btn small" data-edit>${a.locked ? 'Enter password' : 'Edit'}</button>
      <button class="icon-btn" data-remove title="Remove account">${icon('trash')}</button>
    </div>`)
    .join('');
  const node = h(card('Other mail accounts', 'Add Gmail, Outlook, Yahoo, iCloud or any other IMAP mailbox. They appear in the folder list on the left, and you can send from them.', `
    ${noVault ? '<p class="acct-warn" style="margin:0 0 12px">Sign out and sign in again to add or use other accounts on this device.</p>' : ''}
    <div class="acct-list">${rows || '<p class="muted" style="margin:0 0 12px">No other accounts yet.</p>'}</div>
    <button class="btn" data-add-acct ${noVault ? 'disabled' : ''}>${icon('plus')} Add mail account</button>
    <p class="muted" style="margin:14px 0 0;font-size:12px">Passwords are stored encrypted. They can only be unlocked with your ${esc(state.session.server?.name || 'mail')} password or a signed-in browser.</p>`));
  node.classList.add('other-accounts');
  body.append(node);
  node.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add-acct]')) return accountDialog(null, body);
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const a = accountById(row.dataset.id);
    if (e.target.closest('[data-edit]')) return accountDialog(a, body);
    if (e.target.closest('[data-remove]')) {
      if (!(await confirmDialog('Remove account', `Remove ${a.email} from ratmail? Nothing is deleted from the mailbox itself.`, { ok: 'Remove', danger: true }))) return;
      try {
        await api('accounts/delete', { method: 'POST', body: { id: a.id }, acct: '' });
        await accountsUpdated(body);
        toast(`${a.email} was removed`);
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    }
  });
}

async function accountsUpdated(body) {
  const { accounts } = await api('accounts', { acct: '' });
  state.accounts = accounts;
  if (body?.isConnected) renderOtherAccounts(body);
  const { appApi } = await import('./main.js');
  await appApi.accountsChanged(accounts);
}

function serverFields(kind, s) {
  const ports = kind === 'imap' ? [993, 143] : [465, 587];
  return `<div class="acct-server">
    <label class="field"><span>${kind.toUpperCase()} server</span><input class="input" data-f="${kind}.host" value="${esc(s?.host || '')}" placeholder="${kind}.example.com" autocomplete="off" spellcheck="false"></label>
    <label class="field"><span>Port</span><input class="input" data-f="${kind}.port" type="number" value="${esc(s?.port || ports[0])}" list="${kind}-ports"></label>
    <label class="field"><span>Security</span><select class="input" data-f="${kind}.tls"><option value="on" ${s?.tls === 'on' || !s?.tls ? 'selected' : ''}>SSL/TLS</option><option value="starttls" ${s?.tls === 'starttls' ? 'selected' : ''}>STARTTLS</option>${s?.tls === 'off' ? '<option value="off" selected>None (local testing)</option>' : ''}</select></label>
    <datalist id="${kind}-ports">${ports.map((p) => `<option value="${p}">`).join('')}</datalist>
  </div>`;
}

/** Add (a = null) or edit an extra account. */
function accountDialog(a, settingsBody) {
  if (state.session.vault === false) return toast('Sign out and sign in again to add other accounts', { type: 'error' });
  const providers = state.config.providers || [];
  let provider = a?.provider || 'other';
  let detected = !!a;
  const form = h(`<div class="acct-form">
    ${a ? '' : `<div class="provider-grid">${providers.map((p) => `<button type="button" class="provider" data-provider="${p.id}"><span class="p-logo p-${p.id}">${esc(PROVIDER_ICON_TEXT[p.id] ?? p.name[0])}</span><span>${esc(p.name)}</span></button>`).join('')}<button type="button" class="provider" data-provider="other"><span class="p-logo">${icon('mail')}</span><span>Other (IMAP)</span></button></div>`}
    <label class="field"><span>Email address</span><input class="input" data-f="email" type="email" value="${esc(a?.email || '')}" autocomplete="off" spellcheck="false"></label>
    <label class="field"><span>Password</span><input class="input" data-f="password" type="password" autocomplete="new-password" placeholder="${a && !a.locked ? 'Leave empty to keep the saved password' : ''}"></label>
    <p class="acct-help muted"></p>
    <label class="field"><span>Your name</span><input class="input" data-f="name" value="${esc(a?.name ?? state.prefs.displayName ?? '')}" placeholder="Shown as the sender name"></label>
    <label class="field"><span>Name in the folder list (optional)</span><input class="input" data-f="label" value="${esc(a?.label || '')}" placeholder="For example: Personal Gmail"></label>
    <details class="acct-adv" ${a && a.provider === 'other' ? 'open' : ''}><summary>Server settings</summary>
      <label class="field"><span>Username</span><input class="input" data-f="username" value="${esc(a?.username || '')}" placeholder="Usually your email address" autocomplete="off" spellcheck="false"></label>
      ${serverFields('imap', a?.imap)}
      ${serverFields('smtp', a?.smtp)}
    </details>
    <p class="acct-error hidden"></p>
  </div>`);
  const f = (k) => $(`[data-f="${k}"]`, form);
  const setServers = (imap, smtp) => {
    for (const [kind, s] of [['imap', imap], ['smtp', smtp]]) {
      if (!s) continue;
      f(`${kind}.host`).value = s.host;
      f(`${kind}.port`).value = s.port;
      f(`${kind}.tls`).value = s.tls;
    }
  };
  const showHelp = () => {
    const p = providers.find((x) => x.id === provider);
    const help = $('.acct-help', form);
    help.innerHTML = p?.help ? `${esc(p.help)}${p.helpUrl ? ` <a href="${esc(p.helpUrl)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}` : '';
    help.classList.toggle('hidden', !p?.help);
    $$('.provider', form).forEach((b) => b.classList.toggle('on', b.dataset.provider === provider));
  };
  const pickProvider = (id) => {
    provider = id;
    const p = providers.find((x) => x.id === id);
    if (p) {
      setServers(p.imap, p.smtp);
      detected = true;
    }
    $('.acct-adv', form).open = id === 'other';
    showHelp();
    f('email').focus();
  };
  showHelp();
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-provider]');
    if (b) pickProvider(b.dataset.provider);
  });
  // Fill in server settings from the address (presets, then Thunderbird's
  // settings database and the domain's autoconfig file).
  f('email').addEventListener('change', async () => {
    const email = f('email').value.trim();
    if (!isEmail(email) || a) return;
    const domain = email.split('@')[1].toLowerCase();
    const p = providers.find((x) => (x.domains || []).includes(domain));
    try {
      const { settings } = await api('accounts/detect', { query: { email }, acct: '' });
      if (!settings) {
        if (provider === 'other' && !f('imap.host').value) $('.acct-adv', form).open = true;
        return;
      }
      if (settings.provider !== 'other') provider = settings.provider;
      else if (!p && !detected) provider = 'other';
      setServers(settings.imap, settings.smtp);
      if (!f('username').value || f('username').dataset.auto) {
        f('username').value = settings.username || email;
        f('username').dataset.auto = '1';
      }
      detected = true;
      showHelp();
    } catch {}
  });
  f('username').addEventListener('input', () => delete f('username').dataset.auto);

  const save = async (back) => {
    const err = $('.acct-error', form);
    const btn = $('.btn-primary', back);
    const payload = {
      id: a?.id,
      provider,
      email: f('email').value.trim(),
      password: f('password').value,
      name: f('name').value.trim(),
      label: f('label').value.trim(),
      username: f('username').value.trim() || f('email').value.trim(),
      imap: { host: f('imap.host').value.trim(), port: +f('imap.port').value, tls: f('imap.tls').value },
      smtp: { host: f('smtp.host').value.trim(), port: +f('smtp.port').value, tls: f('smtp.tls').value },
    };
    err.classList.add('hidden');
    if (!isEmail(payload.email)) return showError('Enter the email address');
    if (!payload.password && (!a || a.locked)) return showError('Enter the password');
    if (!payload.imap.host || !payload.smtp.host) {
      $('.acct-adv', form).open = true;
      return showError('Enter the IMAP and SMTP server names (under Server settings)');
    }
    btn.disabled = true;
    btn.textContent = 'Checking …';
    try {
      const r = await api('accounts', { method: 'POST', body: payload, acct: '' });
      back.dispatchEvent(new CustomEvent('saved', { detail: r.account }));
    } catch (e2) {
      if (e2.data?.field === 'imap' || e2.data?.field === 'smtp') $('.acct-adv', form).open = true;
      showError(e2.message);
    } finally {
      btn.disabled = false;
      btn.textContent = a ? 'Save' : 'Add account';
    }
    function showError(text) {
      err.textContent = text;
      err.classList.remove('hidden');
    }
  };

  let saved = null;
  return dialog({
    title: a ? `Edit ${a.email}` : 'Add mail account',
    body: form,
    wide: true,
    className: 'acct-dialog',
    onMount: (back) => {
      back.addEventListener('saved', (e) => {
        saved = e.detail;
        $('.modal-foot .btn:not(.btn-primary)', back).click();
      });
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: a ? 'Save' : 'Add account', primary: true, value: (back) => { save(back); return undefined; } },
    ],
  }).then(async () => {
    if (!saved) return;
    toast(a ? 'Account saved' : `${saved.email} was added`);
    await accountsUpdated(settingsBody);
  });
}
