// Settings: the quick menu under the gear icon and the full settings dialog.

import { api, $, $$, h, esc, showMenu, closeMenu, toast, confirmDialog, fullDate } from './util.js';
import { icon } from './icons.js';
import { state, setPrefs, ACCENTS, BACKGROUNDS } from './state.js';

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

export function openSettings(page = 'general') {
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
}

const SEARCH_WORDS = {
  general: 'theme accent color background dark layout refresh',
  notifications: 'desktop alert new mail',
  security: 'sessions devices sign out password',
  accounts: 'name identity alias from address',
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
