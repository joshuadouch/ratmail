// ratmail web app: shell, folder tree, message list and reading pane.

import { api, $, $$, h, esc, showMenu, dialog, confirmDialog, prompt, toast, initials, displayName, shortDate, fullDate, relativeTime, formatSize, countLabel, setSignedOutHandler } from './util.js';
import { icon } from './icons.js';
import { state, loadCachedPrefs, applyServerPrefs, setPrefs, onPrefsChange, applyTheme, folderByUse, myAddresses } from './state.js';
import { renderLogin } from './login.js';
import { brandHtml } from './brand.js';
import { openCompose, composeFromMessage, hasOpenCompose } from './compose.js';
import { openSettings, settingsMenu } from './settings.js';

const root = document.getElementById('app');
const PAGE = 50;

// ===========================================================================
// Boot

async function boot(message) {
  loadCachedPrefs();
  applyTheme();
  try {
    state.config = await api('config');
  } catch (e) {
    root.innerHTML = `<div class="boot"><p>${esc(e.message)}</p></div>`;
    return;
  }
  try {
    state.session = await api('session');
  } catch {
    state.session = null;
  }
  if (!state.session) {
    renderLogin(root, state.config, { message, onSignedIn: () => boot() });
    return;
  }
  applyServerPrefs(state.session.prefs);
  applyTheme();
  renderShell();
  await refreshFolders();
  const want = decodeURIComponent((location.hash.match(/^#folder=([^&]+)/) || [])[1] || '') || 'INBOX';
  selectFolder(state.folders.some((f) => f.path === want) ? want : 'INBOX');
  startTimers();
}

setSignedOutHandler((msg) => {
  if (!state.session) return; // already on the sign-in page
  stopTimers();
  state.session = null;
  boot(msg || 'Your session has ended. Please sign in again.');
});

// ===========================================================================
// Shell

function renderShell() {
  const brand = state.config.brand || {};
  document.title = brand.title || 'Mail';
  const me = state.prefs.displayName || state.session.email;
  root.innerHTML = `
  <div class="app">
    <header class="topbar">
      <div class="topbar-left">
        ${brandHtml(brand)}
        <button class="icon-btn" data-act="toggle-side" title="Toggle folder view">${icon('menu')}</button>
        <button class="icon-btn" data-act="go-inbox" title="Mail">${icon('mail')}<span class="badge-dot hidden"></span></button>
      </div>
      <div class="search" role="search">
        ${icon('search')}
        <input type="search" placeholder="Search email" aria-label="Search email" spellcheck="false">
        <button class="icon-btn clear-search hidden" title="Cancel search">${icon('x')}</button>
        <button class="icon-btn search-opts" title="Search options">${icon('chevronDown')}</button>
      </div>
      <div class="topbar-right">
        <button class="icon-btn" data-act="notifications" title="Notifications">${icon('bell')}<span class="badge-dot notif-dot hidden"></span></button>
        <button class="icon-btn" data-act="refresh" title="Refresh">${icon('refresh')}</button>
        <button class="icon-btn" data-act="help" title="Help">${icon('help')}</button>
        <button class="icon-btn" data-act="settings" title="Settings">${icon('settings')}</button>
        <button class="avatar-btn" data-act="account" title="${esc(me)}">${esc(initials({ name: state.prefs.displayName, email: state.session.email }))}</button>
      </div>
    </header>
    <div class="main">
      <aside class="sidebar">
        <div class="new-mail">
          <button class="main-act" data-act="compose">New email</button>
          <button class="drop" data-act="compose-menu" title="More">${icon('chevronDown')}</button>
        </div>
        <nav class="folders" aria-label="Folders"></nav>
        <div class="side-foot">
          <button class="icon-btn small" data-act="toggle-side" title="Hide folders">${icon('sidebar')}</button>
          <button class="icon-btn small" data-act="help" title="Help">${icon('help')}</button>
        </div>
      </aside>
      <section class="content">
        <div class="list-pane">
          <div class="list-toolbar"></div>
          <div class="list-head">
            <div class="titles"><h1 class="list-title">Inbox</h1><div class="sub list-count"></div></div>
            <button class="icon-btn small" data-act="list-menu" title="More options">${icon('more')}</button>
          </div>
          <div class="list-scroll" tabindex="0" aria-label="Messages"></div>
          <div class="list-foot"></div>
          <div class="splitter"></div>
        </div>
        <div class="reader-pane"></div>
      </section>
    </div>
    <div class="compose-dock"></div>
  </div>`;
  applyLayout();
  renderReader();
  bindShell();
}

function app() {
  return $('.app');
}

export function applyLayout() {
  const a = app();
  if (!a) return;
  const { layout, listStyle, sidebarCollapsed, listWidth, listHeight } = state.prefs;
  a.classList.remove('layout-vertical', 'layout-horizontal', 'layout-list', 'list-avatars', 'list-checkboxes', 'list-simple');
  a.classList.add(`layout-${layout}`, `list-${listStyle}`);
  a.classList.toggle('side-collapsed', !!sidebarCollapsed);
  a.style.setProperty('--list-w', `${listWidth || 250}px`);
  a.style.setProperty('--list-h', `${listHeight || 40}%`);
  const split = $('.list-pane .splitter');
  split.className = `splitter ${layout === 'vertical' ? 'split-v' : layout === 'horizontal' ? 'split-h' : 'hidden'}`;
  renderListToolbar();
  renderReaderToolbar();
  if (layout !== 'list') a.classList.remove('reading');
}

onPrefsChange((patch) => {
  if ('theme' in patch || 'accent' in patch) applyTheme();
  if (['layout', 'listStyle', 'sidebarCollapsed'].some((k) => k in patch)) {
    applyLayout();
    renderList();
    renderReader();
  }
  if ('displayName' in patch) {
    const b = $('.avatar-btn');
    if (b) b.textContent = initials({ name: state.prefs.displayName, email: state.session.email });
  }
});

function bindShell() {
  const a = app();
  a.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const fn = shellActions[act];
    if (fn) {
      e.preventDefault();
      fn(b, e);
    }
  });

  // Search
  const search = $('.search');
  const input = $('input', search);
  input.addEventListener('focus', () => search.classList.add('active'));
  input.addEventListener('blur', () => search.classList.remove('active'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch(input.value.trim());
    if (e.key === 'Escape') cancelSearch();
  });
  input.addEventListener('search', () => {
    if (!input.value) cancelSearch();
  });
  $('.clear-search', search).addEventListener('click', cancelSearch);
  $('.search-opts', search).addEventListener('click', (e) => searchOptions(e.currentTarget));

  // List
  const scroll = $('.list-scroll');
  scroll.addEventListener('click', onListClick);
  scroll.addEventListener('dblclick', onListDblClick);
  scroll.addEventListener('keydown', onListKey);
  scroll.addEventListener('scroll', () => {
    if (scroll.scrollTop + scroll.clientHeight > scroll.scrollHeight - 300) loadMore();
  });
  scroll.addEventListener('dragstart', onDragStart);
  scroll.addEventListener('contextmenu', onListContext);

  // Splitter
  const split = $('.list-pane .splitter');
  split.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const content = $('.content').getBoundingClientRect();
    const vertical = state.prefs.layout === 'vertical';
    const move = (ev) => {
      if (vertical) {
        const w = Math.max(220, Math.min(ev.clientX - content.left, content.width - 320));
        app().style.setProperty('--list-w', `${w}px`);
      } else {
        const p = Math.max(15, Math.min(((ev.clientY - content.top) / content.height) * 100, 85));
        app().style.setProperty('--list-h', `${p}%`);
      }
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      const s = getComputedStyle(app());
      setPrefs(vertical ? { listWidth: parseInt(s.getPropertyValue('--list-w'), 10) } : { listHeight: parseFloat(s.getPropertyValue('--list-h')) });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  document.addEventListener('keydown', onGlobalKey);
  window.addEventListener('hashchange', () => {
    const want = decodeURIComponent((location.hash.match(/^#folder=([^&]+)/) || [])[1] || '');
    if (want && want !== state.folder && state.folders.some((f) => f.path === want)) selectFolder(want);
  });
}

const shellActions = {
  'toggle-side': () => {
    if (window.innerWidth <= 860) app().classList.toggle('side-open');
    else setPrefs({ sidebarCollapsed: !state.prefs.sidebarCollapsed });
  },
  'go-inbox': () => {
    $('.topbar [data-act="go-inbox"] .badge-dot').classList.add('hidden');
    cancelSearch(true);
    selectFolder('INBOX');
  },
  compose: () => openCompose({ mode: 'new' }),
  'compose-menu': (b) =>
    showMenu(b, [
      { label: 'New email', icon: 'edit', action: () => openCompose({ mode: 'new' }) },
      { label: 'New email in plain text', icon: 'text', action: () => openCompose({ mode: 'new', format: 'text' }) },
    ]),
  refresh: () => refreshAll(true),
  help: () => showHelp(),
  settings: (b) => settingsMenu(b, { openAll: () => openSettings() }),
  account: (b) =>
    showMenu(
      b,
      [
        { header: `${state.prefs.displayName || ''}${state.prefs.displayName ? ' · ' : ''}${state.session.email}` },
        { label: 'Settings', icon: 'settings', action: () => openSettings() },
        { label: 'Accounts', icon: 'account', action: () => openSettings('accounts') },
        '-',
        { label: 'Sign out', icon: 'logout', action: signOut },
      ],
      { align: 'right' },
    ),
  notifications: (b) => showNotifications(b),
  'list-menu': (b) => listMenu(b),
};

async function signOut() {
  if (hasOpenCompose() && !(await confirmDialog('Sign out', 'You have unsent messages open. Sign out anyway?', { ok: 'Sign out' }))) return;
  stopTimers();
  await api('logout', { method: 'POST' }).catch(() => {});
  state.session = null;
  location.hash = '';
  boot();
}

// ===========================================================================
// Folders

const FOLDER_ORDER = ['inbox', 'drafts', 'sent', 'junk', 'trash', 'archive'];
const FOLDER_LABEL = { inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', junk: 'Spam', trash: 'Trash', archive: 'Archive' };
const FOLDER_ICON = { inbox: 'inbox', drafts: 'draft', sent: 'send', junk: 'spam', trash: 'trash', archive: 'archive' };

export function folderLabel(f) {
  if (!f) return '';
  if (f.specialUse && FOLDER_LABEL[f.specialUse] && !f.path.includes(f.delimiter)) return FOLDER_LABEL[f.specialUse];
  if (f.specialUse && FOLDER_LABEL[f.specialUse]) return FOLDER_LABEL[f.specialUse];
  return f.name.split(f.delimiter).pop();
}

export async function refreshFolders() {
  try {
    const { folders } = await api('folders');
    state.folders = folders;
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
  renderFolders();
  checkNewMail();
}

function folderChildren(parentPath) {
  return state.folders
    .filter((f) => {
      const d = f.delimiter;
      const idx = f.path.lastIndexOf(d);
      const parent = idx < 0 ? '' : f.path.slice(0, idx);
      return parent === parentPath;
    })
    .sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)));
}

function renderFolders() {
  const nav = $('.folders');
  if (!nav) return;
  const open = state.prefs.folderOpen || {};
  const special = FOLDER_ORDER.map((u) => state.folders.find((f) => f.specialUse === u && (u !== 'archive' || true))).filter(Boolean);
  const specialPaths = new Set(special.map((f) => f.path));
  const mine = state.folders.filter((f) => {
    if (specialPaths.has(f.path)) return false;
    const idx = f.path.lastIndexOf(f.delimiter);
    const parent = idx < 0 ? '' : f.path.slice(0, idx);
    return parent === '' || specialPaths.has(parent);
  });
  const account = state.session.email.split('@')[1] || state.session.email;
  const mineUnread = state.folders.filter((f) => !specialPaths.has(f.path)).reduce((n, f) => n + (f.unread || 0), 0);

  const row = (f, depth) => {
    const kids = folderChildren(f.path).filter((k) => !specialPaths.has(k.path));
    const isOpen = open[f.path];
    const use = f.specialUse && FOLDER_ICON[f.specialUse] ? f.specialUse : null;
    const count = f.specialUse === 'drafts' ? f.total : f.specialUse === 'trash' || f.specialUse === 'junk' ? f.unread || f.total : f.unread;
    const muted = f.specialUse === 'trash' || f.specialUse === 'junk' || f.specialUse === 'drafts' ? '' : '';
    let html = `<div class="folder ${state.folder === f.path && !state.list.search ? 'selected' : ''}" style="--depth:${depth}" data-path="${esc(f.path)}" ${f.selectable ? '' : 'data-noselect="1"'} title="${esc(folderLabel(f))}">
      ${kids.length ? `<span class="twisty" data-twisty="${esc(f.path)}">${icon(isOpen ? 'chevronDown' : 'chevronRight')}</span>` : ''}
      ${icon(use ? FOLDER_ICON[use] : 'folder')}
      <span class="name">${esc(folderLabel(f))}</span>
      ${count ? `<span class="count ${muted}">${countLabel(count)}</span>` : ''}
      <button class="icon-btn small folder-menu" data-folder-menu="${esc(f.path)}" title="Folder actions">${icon('more')}</button>
    </div>`;
    if (kids.length && isOpen) html += kids.map((k) => row(k, depth + 1)).join('');
    return html;
  };

  nav.innerHTML = `
    <div class="tree-head" data-toggle="_account">${icon(open._account !== false ? 'chevronDown' : 'chevronRight')}<span>${esc(account)}</span></div>
    ${open._account !== false ? special.map((f) => row(f, 1)).join('') : ''}
    <div class="folders-gap"></div>
    <div class="folder" style="--depth:0" data-toggle="_mine">
      <span class="twisty">${icon(open._mine ? 'chevronDown' : 'chevronRight')}</span>
      ${icon('folder')}<span class="name">My folders</span>
      ${!open._mine && mineUnread ? `<span class="count">${countLabel(mineUnread)}</span>` : ''}
      <button class="icon-btn small add" data-act-folder="create" title="Add new folder">${icon('plus')}</button>
    </div>
    ${open._mine ? mine.map((f) => row(f, 1)).join('') || '<div class="folder muted" style="--depth:1;cursor:default">No folders</div>' : ''}`;

  if (!nav.dataset.bound) {
    nav.dataset.bound = '1';
    nav.addEventListener('click', onFolderClick);
    nav.addEventListener('dragover', (e) => {
      const f = e.target.closest('.folder[data-path]');
      if (!f || !e.dataTransfer.types.includes('application/x-ratmail-uids')) return;
      e.preventDefault();
      $$('.folder.drop-target').forEach((x) => x.classList.remove('drop-target'));
      f.classList.add('drop-target');
    });
    nav.addEventListener('dragleave', (e) => e.target.closest?.('.folder')?.classList.remove('drop-target'));
    nav.addEventListener('drop', (e) => {
      const f = e.target.closest('.folder[data-path]');
      $$('.folder.drop-target').forEach((x) => x.classList.remove('drop-target'));
      if (!f) return;
      e.preventDefault();
      try {
        const { folder, uids } = JSON.parse(e.dataTransfer.getData('application/x-ratmail-uids'));
        if (folder !== f.dataset.path) moveMessages(uids, f.dataset.path, folder);
      } catch {}
    });
  }
  updateUnreadBadge();
}

function onFolderClick(e) {
  const tw = e.target.closest('[data-twisty]');
  const toggle = e.target.closest('[data-toggle]');
  const menuBtn = e.target.closest('[data-folder-menu]');
  const create = e.target.closest('[data-act-folder="create"]');
  const open = { ...(state.prefs.folderOpen || {}) };
  if (create) {
    e.stopPropagation();
    return createFolder('');
  }
  if (menuBtn) {
    e.stopPropagation();
    return folderMenu(menuBtn, menuBtn.dataset.folderMenu);
  }
  if (tw) {
    e.stopPropagation();
    open[tw.dataset.twisty] = !open[tw.dataset.twisty];
    setPrefs({ folderOpen: open });
    return renderFolders();
  }
  if (toggle) {
    const k = toggle.dataset.toggle;
    open[k] = k === '_account' ? open[k] === false : !open[k];
    setPrefs({ folderOpen: open });
    return renderFolders();
  }
  const f = e.target.closest('.folder[data-path]');
  if (f && !f.dataset.noselect) {
    cancelSearch(true);
    selectFolder(f.dataset.path);
    app().classList.remove('side-open');
  }
}

function folderMenu(anchor, path) {
  const f = state.folders.find((x) => x.path === path);
  const special = !!f?.specialUse;
  const items = [
    { label: 'Mark all messages as read', icon: 'markRead', action: () => folderAction('markRead', path) },
  ];
  if (f?.specialUse === 'trash' || f?.specialUse === 'junk') items.push({ label: 'Empty folder', icon: 'trash', danger: true, action: () => emptyFolder(path) });
  items.push('-', { label: 'Add new folder', icon: 'plus', action: () => createFolder(path) });
  if (!special) {
    items.push({ label: 'Rename', icon: 'edit', action: () => renameFolder(path) });
    items.push({ label: 'Delete', icon: 'trash', danger: true, action: () => deleteFolder(path) });
  }
  showMenu(anchor, items);
}

async function folderAction(action, path, extra = {}) {
  try {
    await api('folders', { method: 'POST', body: { action, path, ...extra } });
    await refreshFolders();
    if (state.folder === path) reloadList();
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

async function emptyFolder(path) {
  const f = state.folders.find((x) => x.path === path);
  if (await confirmDialog('Empty folder', `Do you really want to permanently delete all messages in "${folderLabel(f)}"?`, { ok: 'Empty folder', danger: true })) folderAction('empty', path);
}

async function createFolder(parent) {
  const name = await prompt('Add new folder', { label: 'Folder name', ok: 'Add' });
  if (!name) return;
  const delim = state.folders[0]?.delimiter || '/';
  const path = parent ? parent + delim + name : name;
  try {
    await api('folders', { method: 'POST', body: { action: 'create', path } });
    const open = { ...(state.prefs.folderOpen || {}), _mine: true };
    if (parent) open[parent] = true;
    setPrefs({ folderOpen: open });
    await refreshFolders();
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

async function renameFolder(path) {
  const f = state.folders.find((x) => x.path === path);
  const name = await prompt('Rename folder', { label: 'Folder name', value: folderLabel(f), ok: 'Rename' });
  if (!name || name === folderLabel(f)) return;
  const idx = path.lastIndexOf(f.delimiter);
  const to = (idx < 0 ? '' : path.slice(0, idx + 1)) + name;
  await folderAction('rename', path, { to });
  if (state.folder === path) selectFolder(to);
}

async function deleteFolder(path) {
  const f = state.folders.find((x) => x.path === path);
  if (!(await confirmDialog('Delete folder', `Do you really want to delete "${folderLabel(f)}" and all messages in it?`, { ok: 'Delete', danger: true }))) return;
  await folderAction('delete', path);
  if (state.folder === path) selectFolder('INBOX');
}

function updateUnreadBadge() {
  const inbox = state.folders.find((f) => f.specialUse === 'inbox');
  const n = inbox?.unread || 0;
  document.title = `${n ? `(${n}) ` : ''}${state.config.brand?.title || 'Mail'}`;
}

/** Shows a folder picker dialog and resolves with a path (or null). */
export function pickFolder(title, { exclude } = {}) {
  let chosen = null;
  const list = h('<div class="folder-picker"></div>');
  const all = [...state.folders].filter((f) => f.selectable && f.path !== exclude).sort((a, b) => {
    const ai = FOLDER_ORDER.indexOf(a.specialUse);
    const bi = FOLDER_ORDER.indexOf(b.specialUse);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.path.localeCompare(b.path);
  });
  list.innerHTML = all.map((f) => `<div class="folder" data-path="${esc(f.path)}" style="--depth:${f.specialUse ? 0 : f.path.split(f.delimiter).length - 1}">${icon(FOLDER_ICON[f.specialUse] || 'folder')}<span class="name">${esc(folderLabel(f))}</span></div>`).join('');
  list.addEventListener('click', (e) => {
    const f = e.target.closest('.folder');
    if (!f) return;
    $$('.folder', list).forEach((x) => x.classList.toggle('selected', x === f));
    chosen = f.dataset.path;
  });
  list.addEventListener('dblclick', (e) => {
    if (e.target.closest('.folder')) $('.modal .btn-primary').click();
  });
  return dialog({ title, body: list, buttons: [{ label: 'Cancel', value: null }, { label: 'Move', primary: true, value: () => chosen || undefined }] });
}

// ===========================================================================
// Message list

export function selectFolder(path) {
  state.folder = path;
  state.selection.clear();
  state.cursor = state.anchor = null;
  state.open = null;
  app()?.classList.remove('reading');
  if (location.hash !== `#folder=${encodeURIComponent(path)}`) history.replaceState(null, '', `#folder=${encodeURIComponent(path)}`);
  renderFolders();
  renderReader();
  reloadList();
}

function currentFolder() {
  return state.folders.find((f) => f.path === state.folder);
}

let listToken = 0;

export async function reloadList({ keep = false } = {}) {
  const token = ++listToken;
  const l = state.list;
  const count = keep ? Math.max(PAGE, Math.min(l.messages.length, 200)) : PAGE;
  l.loading = true;
  l.error = null;
  if (!keep) {
    l.messages = [];
    l.done = false;
    renderList();
  }
  try {
    let res;
    if (l.search) res = await api('search', { query: { folder: state.folder, ...l.search } });
    else res = await api('messages', { query: { folder: state.folder, offset: 0, limit: count } });
    if (token !== listToken) return;
    l.messages = res.messages;
    l.total = res.total;
    l.done = l.search ? true : res.messages.length >= res.total;
    // drop selections that no longer exist
    const uids = new Set(l.messages.map((m) => m.uid));
    for (const u of [...state.selection]) if (!uids.has(u)) state.selection.delete(u);
    if (state.open && !uids.has(state.open.uid) && state.open.folder === state.folder && !keep) state.open = null;
    state.lastUpdated = Date.now();
  } catch (e) {
    if (token !== listToken) return;
    l.error = e.message;
  } finally {
    if (token === listToken) {
      l.loading = false;
      renderList();
      renderListHead();
    }
  }
}

async function loadMore() {
  const l = state.list;
  if (l.loading || l.done || l.search) return;
  const token = listToken;
  l.loading = true;
  try {
    const res = await api('messages', { query: { folder: state.folder, offset: l.messages.length, limit: PAGE } });
    if (token !== listToken) return;
    const have = new Set(l.messages.map((m) => m.uid));
    l.messages.push(...res.messages.filter((m) => !have.has(m.uid)));
    l.total = res.total;
    l.done = !res.messages.length || l.messages.length >= res.total;
  } catch (e) {
    toast(e.message, { type: 'error' });
  } finally {
    l.loading = false;
    if (token === listToken) renderList();
  }
}

function renderListHead() {
  const f = currentFolder();
  const l = state.list;
  $('.list-title').textContent = l.search ? 'Search results' : folderLabel(f) || state.folder;
  const n = l.total || 0;
  $('.list-count').textContent = l.search ? `${n.toLocaleString()} ${n === 1 ? 'message' : 'messages'} in ${folderLabel(f)}` : `${n.toLocaleString()} ${n === 1 ? 'message' : 'messages'}`;
  $('.folders .folder.selected')?.classList.toggle('selected', !l.search);
}

function sentLike() {
  const f = currentFolder();
  return f && (f.specialUse === 'sent' || f.specialUse === 'drafts');
}

function msgHtml(m) {
  const people = sentLike() ? m.to.concat(m.cc) : m.from;
  const who = people[0] || { name: '', email: '' };
  const label = sentLike() ? people.map(displayName).join(', ') || '(no recipient)' : displayName(who) || '(unknown sender)';
  const selected = state.selection.has(m.uid);
  const style = state.prefs.listStyle;
  const marks = [
    m.priority === 'high' ? '<span class="prio" title="High priority">!</span>' : '',
    m.attachment ? `<span title="Has attachments">${icon('paperclip')}</span>` : '',
    m.flagged ? `<span class="flagged" title="Flagged">${icon('flagFilled')}</span>` : '',
    m.answered ? `<span title="Answered">${icon('reply')}</span>` : m.forwarded ? `<span title="Forwarded">${icon('forward')}</span>` : '',
  ].join('');
  const lead = style === 'checkboxes' ? `<input type="checkbox" class="select-box" ${selected ? 'checked' : ''} tabindex="-1" aria-label="Select">` : `<div class="avatar">${esc(initials(who))}</div>`;
  return `<div class="msg ${m.seen ? '' : 'unread'} ${selected ? 'selected' : ''} ${state.cursor === m.uid ? 'cursor' : ''}" data-uid="${m.uid}" draggable="true" role="option" aria-selected="${selected}">
    <span class="unread-dot" title="${m.seen ? '' : 'Unread'}"></span>
    ${lead}
    <div class="line1"><span class="from">${esc(label)}</span><span class="date">${esc(shortDate(m.date))}</span></div>
    <div class="line2"><span class="subject-wrap"><span class="subject">${esc(m.subject || '(no subject)')}</span><span class="preview hidden-v">${esc(m.preview || '')}</span></span><span class="marks">${marks}</span></div>
    <div class="preview">${esc(m.preview || '')}</div>
  </div>`;
}

export function renderList() {
  const scroll = $('.list-scroll');
  if (!scroll) return;
  const l = state.list;
  const top = scroll.scrollTop;
  const single = state.prefs.layout !== 'vertical';
  let html;
  if (l.error && !l.messages.length) html = `<div class="list-empty">${esc(l.error)}<br><br><button class="btn" data-retry>Try again</button></div>`;
  else if (!l.messages.length && l.loading) html = '<div class="list-empty"><div class="spinner" style="margin:auto"></div></div>';
  else if (!l.messages.length) html = `<div class="list-empty">${l.search ? 'No messages match your search' : 'This folder is empty'}</div>`;
  else {
    html = l.messages.map(msgHtml).join('');
    if (!l.done) html += `<div class="list-more">${l.loading ? '<div class="spinner small" style="margin:auto"></div>' : ''}</div>`;
  }
  scroll.innerHTML = html;
  // single-line layouts show the preview inline after the subject
  $$('.msg .preview.hidden-v', scroll).forEach((p) => p.classList.toggle('hidden', !single));
  $$('.msg > .preview', scroll).forEach((p) => p.classList.toggle('hidden', single));
  scroll.scrollTop = top;
  $('[data-retry]', scroll)?.addEventListener('click', () => reloadList());
  renderListFoot();
  // fill the pane if the first page doesn't overflow
  if (!l.loading && !l.done && scroll.scrollHeight <= scroll.clientHeight + 50) loadMore();
}

function renderListFoot() {
  const foot = $('.list-foot');
  if (foot) foot.textContent = state.lastUpdated ? `Updated ${relativeTime(state.lastUpdated)}` : '';
}

function findMsg(uid) {
  return state.list.messages.find((m) => m.uid === uid);
}

function onListClick(e) {
  const row = e.target.closest('.msg');
  if (!row) return;
  const uid = +row.dataset.uid;
  const box = e.target.closest('.select-box');
  if (box || e.ctrlKey || e.metaKey) {
    if (state.selection.has(uid)) state.selection.delete(uid);
    else state.selection.add(uid);
    state.cursor = state.anchor = uid;
  } else if (e.shiftKey && state.anchor) {
    const ids = state.list.messages.map((m) => m.uid);
    const a = ids.indexOf(state.anchor);
    const b = ids.indexOf(uid);
    state.selection = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    state.cursor = uid;
  } else {
    state.selection = new Set([uid]);
    state.cursor = state.anchor = uid;
  }
  afterSelection();
}

function onListDblClick(e) {
  const row = e.target.closest('.msg');
  if (!row) return;
  const m = findMsg(+row.dataset.uid);
  if (currentFolder()?.specialUse === 'drafts' && m) editDraft(m.uid);
}

function afterSelection() {
  renderList();
  if (state.selection.size === 1) {
    const uid = [...state.selection][0];
    if (state.open?.uid !== uid || state.open?.folder !== state.folder) openMessage(uid);
    else renderReader();
    if (state.prefs.layout === 'list' || window.innerWidth <= 860) app().classList.add('reading');
  } else {
    state.open = null;
    renderReader();
  }
  $('.list-scroll .msg.cursor')?.scrollIntoView({ block: 'nearest' });
}

function onListKey(e) {
  const ids = state.list.messages.map((m) => m.uid);
  if (!ids.length) return;
  let i = ids.indexOf(state.cursor);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    i = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
    const uid = ids[i];
    if (e.shiftKey && state.anchor) {
      const a = ids.indexOf(state.anchor);
      state.selection = new Set(ids.slice(Math.min(a, i), Math.max(a, i) + 1));
    } else {
      state.selection = new Set([uid]);
      state.anchor = uid;
    }
    state.cursor = uid;
    afterSelection();
    if (i > ids.length - 10) loadMore();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    state.selection = new Set(ids);
    afterSelection();
  } else if (e.key === 'Enter' && state.cursor) {
    if (currentFolder()?.specialUse === 'drafts') editDraft(state.cursor);
    else openMessage(state.cursor);
  }
}

function onGlobalKey(e) {
  if (e.defaultPrevented || $('.modal-back') || e.target.closest?.('input, textarea, select, [contenteditable], .compose')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const m = state.open?.data;
  switch (e.key) {
    case 'n':
    case 'c':
      openCompose({ mode: 'new' });
      break;
    case 'r':
      if (m) composeFromMessage('reply', m);
      break;
    case 'R':
      if (m) composeFromMessage('replyAll', m);
      break;
    case 'f':
      if (m) composeFromMessage('forward', m);
      break;
    case '/':
      e.preventDefault();
      $('.search input').focus();
      break;
    case 'Delete':
      deleteSelected();
      break;
    case 'Escape':
      if (app().classList.contains('reading')) {
        app().classList.remove('reading');
        $('.list-scroll').focus();
      }
      break;
    default:
      return;
  }
}

function onDragStart(e) {
  const row = e.target.closest('.msg');
  if (!row) return;
  const uid = +row.dataset.uid;
  if (!state.selection.has(uid)) {
    state.selection = new Set([uid]);
    state.cursor = state.anchor = uid;
    renderList();
  }
  const uids = [...state.selection];
  e.dataTransfer.setData('application/x-ratmail-uids', JSON.stringify({ folder: state.folder, uids }));
  e.dataTransfer.effectAllowed = 'move';
  const ghost = h(`<div style="position:fixed;top:-100px;padding:6px 12px;background:var(--accent);color:#fff;border-radius:4px;font:600 12px var(--font)">${uids.length} ${uids.length === 1 ? 'message' : 'messages'}</div>`);
  document.body.append(ghost);
  e.dataTransfer.setDragImage(ghost, -10, -10);
  setTimeout(() => ghost.remove());
}

function onListContext(e) {
  const row = e.target.closest('.msg');
  if (!row) return;
  e.preventDefault();
  const uid = +row.dataset.uid;
  if (!state.selection.has(uid)) {
    state.selection = new Set([uid]);
    state.cursor = state.anchor = uid;
    afterSelection();
  }
  showMenu(null, messageMenuItems(), { x: e.clientX, y: e.clientY });
}

function listMenu(anchor) {
  const ids = state.list.messages.map((m) => m.uid);
  showMenu(anchor, [
    { label: 'Select all', icon: 'check', action: () => { state.selection = new Set(ids); afterSelection(); } },
    { label: 'Mark all messages as read', icon: 'markRead', action: () => folderAction('markRead', state.folder) },
    '-',
    { header: 'Layout' },
    { label: 'Vertical', radio: state.prefs.layout === 'vertical', action: () => setPrefs({ layout: 'vertical' }) },
    { label: 'Horizontal', radio: state.prefs.layout === 'horizontal', action: () => setPrefs({ layout: 'horizontal' }) },
    { label: 'List', radio: state.prefs.layout === 'list', action: () => setPrefs({ layout: 'list' }) },
    '-',
    { label: 'Refresh', icon: 'refresh', action: () => refreshAll(true) },
  ], { align: 'right' });
}

// ===========================================================================
// Search

function runSearch(q) {
  if (!q) return cancelSearch();
  const opts = state.searchOpts || {};
  state.list.search = { q, scope: opts.scope || 'all', unread: opts.unread ? '1' : '', flagged: opts.flagged ? '1' : '', attachment: opts.attachment ? '1' : '' };
  $('.clear-search').classList.remove('hidden');
  state.selection.clear();
  state.open = null;
  renderReader();
  reloadList();
}

function cancelSearch(silent) {
  const input = $('.search input');
  if (!state.list.search && !input?.value) return;
  if (input) input.value = '';
  $('.clear-search')?.classList.add('hidden');
  const had = !!state.list.search;
  state.list.search = null;
  state.searchOpts = state.searchOpts || {};
  if (had && silent !== true) reloadList();
}

function searchOptions(anchor) {
  const o = (state.searchOpts = state.searchOpts || { scope: 'all' });
  const set = (patch) => {
    Object.assign(o, patch);
    const q = $('.search input').value.trim();
    if (q) runSearch(q);
  };
  showMenu(anchor, [
    { header: `Search in ${folderLabel(currentFolder())}` },
    { label: 'Everything', radio: (o.scope || 'all') === 'all', action: () => set({ scope: 'all' }) },
    { label: 'From', radio: o.scope === 'from', action: () => set({ scope: 'from' }) },
    { label: 'To / Cc', radio: o.scope === 'to', action: () => set({ scope: 'to' }) },
    { label: 'Subject', radio: o.scope === 'subject', action: () => set({ scope: 'subject' }) },
    { label: 'Message text', radio: o.scope === 'body', action: () => set({ scope: 'body' }) },
    '-',
    { label: 'Unread only', checked: !!o.unread, action: () => set({ unread: !o.unread }) },
    { label: 'Flagged only', checked: !!o.flagged, action: () => set({ flagged: !o.flagged }) },
    { label: 'With attachments', checked: !!o.attachment, action: () => set({ attachment: !o.attachment }) },
  ], { align: 'right' });
}

// ===========================================================================
// Reading pane

let readerToken = 0;

async function openMessage(uid, { images } = {}) {
  const token = ++readerToken;
  const folder = state.folder;
  const m = findMsg(uid);
  state.open = { uid, folder, data: null, loading: true };
  renderReader();
  const sender = (m?.from?.[0]?.email || '').toLowerCase();
  const showImages = images ?? (state.prefs.images === 'always' || state.prefs.trusted.includes(sender));
  const markSeen = state.prefs.markRead === 'immediate';
  try {
    const data = await api('message', { query: { folder, uid, images: showImages ? '1' : '', seen: markSeen ? '' : '0' } });
    if (token !== readerToken) return;
    data.imagesShown = showImages;
    state.open = { uid, folder, data };
    if (m && markSeen && !m.seen) {
      m.seen = true;
      adjustUnread(folder, -1);
      renderList();
    }
    if (m && state.prefs.markRead === 'delay' && !m.seen) {
      setTimeout(() => {
        if (state.open?.uid === uid && !m.seen) setSeen([uid], true);
      }, 3000);
    }
  } catch (e) {
    if (token !== readerToken) return;
    state.open = { uid, folder, error: e.message };
  }
  renderReader();
}

function adjustUnread(path, delta) {
  const f = state.folders.find((x) => x.path === path);
  if (!f) return;
  f.unread = Math.max(0, (f.unread || 0) + delta);
  renderFolders();
}

function toolbarButtons(where) {
  const sel = state.selection.size;
  const one = state.open?.data;
  const dis = sel ? '' : 'disabled';
  const disOne = one ? '' : 'disabled';
  const flagged = one ? one.flagged : sel && [...state.selection].every((u) => findMsg(u)?.flagged);
  const isDraft = currentFolder()?.specialUse === 'drafts';
  return `
    ${where === 'reader' ? `<button class="icon-btn back-btn" data-msg="back" title="Back to list">${icon('arrowLeft')}</button>` : ''}
    ${isDraft && one ? `<button class="icon-btn" data-msg="edit" title="Edit draft">${icon('edit')}</button>` : ''}
    <button class="icon-btn" data-msg="delete" title="Delete" ${dis}>${icon('trash')}</button>
    <button class="icon-btn" data-msg="archive" title="Archive" ${dis}>${icon('archive')}</button>
    <button class="icon-btn" data-msg="reply" title="Reply" ${disOne}>${icon('reply')}</button>
    <button class="icon-btn" data-msg="replyAll" title="Reply all" ${disOne}>${icon('replyAll')}</button>
    <button class="icon-btn" data-msg="forward" title="Forward" ${disOne}>${icon('forward')}</button>
    <button class="icon-btn ${flagged ? 'active' : ''}" data-msg="flag" title="${flagged ? 'Unflag' : 'Flag'}" ${dis}>${icon(flagged ? 'flagFilled' : 'flag')}</button>
    <button class="icon-btn" data-msg="move" title="Move" ${dis}>${icon('move')}</button>
    <button class="icon-btn" data-msg="more" title="More actions" ${dis}>${icon('more')}</button>`;
}

function renderListToolbar() {
  const t = $('.list-toolbar');
  if (!t) return;
  t.innerHTML = toolbarButtons('list');
  if (!t.dataset.bound) {
    t.dataset.bound = '1';
    t.addEventListener('click', onMsgAction);
  }
}

function renderReaderToolbar() {
  const t = $('.reader-toolbar');
  if (t) t.innerHTML = toolbarButtons('reader');
  renderListToolbar();
}

const ENVELOPES = `<svg viewBox="0 0 120 52" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M4 12h30v28H4z" transform="rotate(-8 19 26)"/><path d="m4 12 15 13 15-13" transform="rotate(-8 19 26)"/><path d="M86 12h30v28H86z" transform="rotate(8 101 26)"/><path d="m86 12 15 13 15-13" transform="rotate(8 101 26)"/><path d="M38 6h44v36H38z" fill="var(--panel)"/><path d="m38 6 22 18L82 6"/></svg>`;

export function renderReader() {
  const pane = $('.reader-pane');
  if (!pane) return;
  const o = state.open;
  const sel = state.selection.size;
  pane.innerHTML = `<div class="reader-toolbar"></div><div class="reader-body" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;
  const body = $('.reader-body', pane);
  renderReaderToolbar();
  $('.reader-toolbar', pane).addEventListener('click', onMsgAction);

  if (sel > 1) {
    body.innerHTML = `<div class="multi-sel"><div><div class="count">${sel} messages selected</div>
      <div class="acts">
        <button class="btn" data-msg="delete">Delete</button><button class="btn" data-msg="move">Move</button>
        <button class="btn" data-msg="seen">Mark as read</button><button class="btn" data-msg="unseen">Mark as unread</button>
        <button class="btn" data-msg="archive">Archive</button></div></div></div>`;
    body.addEventListener('click', onMsgAction);
    return;
  }
  if (!o) {
    body.innerHTML = `<div class="reader-empty"><div>${ENVELOPES}<div>No message selected</div></div></div>`;
    return;
  }
  if (o.error) {
    body.innerHTML = `<div class="reader-error">${esc(o.error)}</div>`;
    return;
  }
  if (!o.data) {
    body.innerHTML = `<div class="reader-loading"><div class="spinner"></div></div>`;
    return;
  }
  const m = o.data;
  const from = m.from[0] || { name: '', email: '' };
  const list = (arr) => arr.map((a) => `<span class="person" data-email="${esc(a.address || a.email || '')}" data-name="${esc(a.name || '')}" title="${esc(a.address || a.email || '')}">${esc(a.name || a.address || a.email || '')}</span>`).join(', ');
  const norm = (arr) => (arr || []).flatMap((a) => (a.group ? a.group : [a]));
  const to = norm(m.to);
  const cc = norm(m.cc);
  const replyTo = norm(m.replyTo).filter((r) => (r.address || '').toLowerCase() !== (from.address || '').toLowerCase());
  const visibleAtts = m.attachments.filter((a) => !a.inline);
  const showBar = m.external && !m.imagesShown && !o.barClosed;
  const senderAddr = from.address || from.email || '';

  body.innerHTML = `
    <div class="reader-scroll">
      <div class="reader-subject">${esc(m.subject || '(no subject)')}</div>
      <div class="mail-card">
        <div class="mail-head">
          <span class="sel"></span>
          <div class="avatar lg">${esc(initials({ name: from.name, email: senderAddr }))}</div>
          <div class="who">
            <div class="line"><span class="name person" data-email="${esc(senderAddr)}" data-name="${esc(from.name || '')}">${esc(from.name || senderAddr)}</span> ${from.name ? `<span class="addr">&lt;${esc(senderAddr)}&gt;</span>` : ''}</div>
            <div class="line">${esc(m.subject || '')}</div>
            ${to.length ? `<div class="line"><b>To</b> ${list(to)}${replyTo.length ? ` &nbsp;<b>Reply To</b> ${list(replyTo)}` : ''}</div>` : ''}
            ${cc.length ? `<div class="line"><b>Copy</b> ${list(cc)}</div>` : ''}
          </div>
          <div class="meta">
            <div>${m.priority === 'high' ? '<span class="prio" title="High priority">!</span>' : ''}<span title="${esc(fullDate(m.date))}">${esc(shortDate(m.date))}</span></div>
            <div class="acts">
              <button class="icon-btn small" data-msg="delete" title="Delete">${icon('trash')}</button>
              <button class="icon-btn small" data-msg="reply" title="Reply">${icon('reply')}</button>
              <button class="icon-btn small ${m.flagged ? 'active' : ''}" data-msg="flag" title="Flag">${icon(m.flagged ? 'flagFilled' : 'flag')}</button>
              <button class="icon-btn small" data-msg="more" title="More actions">${icon('more')}</button>
            </div>
          </div>
        </div>
        ${showBar ? `<div class="ext-bar">${icon('image')}<div class="txt"><b>External images are not shown to avoid potential tracking</b>
            <div class="acts"><button class="link" data-msg="show-images">Show images</button>${senderAddr ? `<button class="link" data-msg="trust-sender">Always show images from ${esc(senderAddr)}</button>` : ''}<button class="link" data-msg="images-menu" title="More">…</button></div></div>
            <button class="icon-btn small" data-msg="close-bar" title="Close">${icon('x')}</button></div>` : ''}
        ${visibleAtts.length ? `<div class="attachments">${visibleAtts.map(attHtml).join('')}${visibleAtts.length > 1 ? '' : ''}</div>` : ''}
        <div class="mail-body"></div>
      </div>
    </div>`;
  body.addEventListener('click', onMsgAction);
  body.addEventListener('click', (e) => {
    const p = e.target.closest('.person');
    if (p) personMenu(p, { name: p.dataset.name, email: p.dataset.email });
  });
  mountMailFrame($('.mail-body', body), m.html, { allowImages: m.imagesShown, plain: m.isPlain });
}

function attHtml(a) {
  const ext = (a.filename.split('.').pop() || '').slice(0, 4).toUpperCase();
  const isImg = /^image\/(png|jpe?g|gif|webp)$/i.test(a.mimeType);
  return `<a class="att" href="${esc(a.url)}&download=1" title="${esc(a.filename)} (${formatSize(a.size)})" download>
    <span class="thumb">${isImg ? `<img src="${esc(a.url)}" alt="" loading="lazy">` : esc(ext || 'FILE')}</span>
    <span class="meta"><span class="fname">${esc(a.filename)}</span><span class="fsize">${formatSize(a.size)}</span></span>
    ${icon('download')}</a>`;
}

/** Renders sanitized email HTML inside a sandboxed iframe that sizes itself. */
export function mountMailFrame(container, html, { allowImages = false, plain = false } = {}) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:${allowImages ? ' https: http:' : ''}; font-src data:${allowImages ? ' https:' : ''}; media-src 'self'`;
  const base = `<style>
    html,body{margin:0;padding:0;background:#fff;color:#222}
    body{padding:14px 16px 18px;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;overflow-wrap:break-word;word-break:break-word}
    img{max-width:100%;height:auto} table{max-width:100%}
    img[data-blocked-src]{display:inline-block;min-width:32px;min-height:32px;background:repeating-linear-gradient(-45deg,#e8e8e8,#e8e8e8 10px,#f6f6f6 10px,#f6f6f6 20px);outline:1px solid #ddd}
    blockquote[type=cite]{margin:8px 0;padding-left:12px;border-left:2px solid #ccc;color:#555}
    .plain-text{font:13px/1.5 ui-monospace,Consolas,"DejaVu Sans Mono",monospace;white-space:pre-wrap}
    .plain-text br{content:""} pre{white-space:pre-wrap}
    a{color:#2a62c9}
  </style>`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">${base}</head><body>${html}</body></html>`;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = 'Message';
  frame.srcdoc = doc;
  container.replaceChildren(frame);
  const fit = () => {
    try {
      const d = frame.contentDocument;
      if (!d?.documentElement) return;
      frame.style.height = Math.max(60, d.documentElement.scrollHeight) + 'px';
    } catch {}
  };
  frame.addEventListener('load', () => {
    fit();
    try {
      const d = frame.contentDocument;
      new ResizeObserver(fit).observe(d.body);
      d.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
      // Plain text uses <br> inside pre-wrap; avoid doubled line breaks.
      if (plain) d.querySelectorAll('.plain-text br').forEach((br) => br.replaceWith('\n'));
      // Keyboard shortcuts keep working while the frame has focus.
      d.addEventListener('keydown', (e) => document.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey })));
    } catch {}
  });
  return frame;
}

function personMenu(anchor, p) {
  if (!p.email) return;
  showMenu(anchor, [
    { header: p.name ? `${p.name} · ${p.email}` : p.email },
    { label: 'Send email', icon: 'edit', action: () => openCompose({ mode: 'new', to: [{ name: p.name, email: p.email }] }) },
    { label: 'Copy address', icon: 'mail', action: () => navigator.clipboard?.writeText(p.email) },
    { label: 'Search messages from this sender', icon: 'search', action: () => { $('.search input').value = p.email; state.searchOpts = { scope: 'from' }; runSearch(p.email); } },
  ]);
}

// ===========================================================================
// Message actions

function selectedUids() {
  if (state.selection.size) return [...state.selection];
  if (state.open) return [state.open.uid];
  return [];
}

function onMsgAction(e) {
  const b = e.target.closest('[data-msg]');
  if (!b || b.disabled) return;
  e.preventDefault();
  e.stopPropagation();
  const act = b.dataset.msg;
  const m = state.open?.data;
  switch (act) {
    case 'back':
      app().classList.remove('reading');
      $('.list-scroll').focus();
      break;
    case 'delete':
      deleteSelected();
      break;
    case 'archive':
      moveSpecial(selectedUids(), 'archive');
      break;
    case 'reply':
    case 'replyAll':
    case 'forward':
      if (m) composeFromMessage(act, m);
      break;
    case 'edit':
      if (m) editDraft(m.uid);
      break;
    case 'flag': {
      const uids = selectedUids();
      const flagged = m ? m.flagged : uids.every((u) => findMsg(u)?.flagged);
      setFlag(uids, '\\Flagged', !flagged);
      break;
    }
    case 'move':
      moveDialog(selectedUids());
      break;
    case 'more':
      showMenu(b, messageMenuItems(), { align: 'right' });
      break;
    case 'seen':
      setSeen(selectedUids(), true);
      break;
    case 'unseen':
      setSeen(selectedUids(), false);
      break;
    case 'show-images':
      openMessage(state.open.uid, { images: true });
      break;
    case 'trust-sender': {
      const addr = (m.from[0]?.address || m.from[0]?.email || '').toLowerCase();
      if (addr) setPrefs({ trusted: [...new Set([...state.prefs.trusted, addr])] });
      openMessage(state.open.uid, { images: true });
      break;
    }
    case 'images-menu':
      showMenu(b, [
        { label: 'Always show external images', action: () => { setPrefs({ images: 'always' }); openMessage(state.open.uid, { images: true }); } },
        { label: 'Settings…', action: () => openSettings('mail') },
      ]);
      break;
    case 'close-bar':
      state.open.barClosed = true;
      b.closest('.ext-bar').remove();
      break;
  }
}

function messageMenuItems() {
  const uids = selectedUids();
  const msgs = uids.map(findMsg).filter(Boolean);
  const anyUnread = msgs.some((x) => !x.seen);
  const f = currentFolder();
  const one = state.open?.data && uids.length <= 1 ? state.open.data : null;
  const items = [
    anyUnread ? { label: 'Mark as read', icon: 'markRead', action: () => setSeen(uids, true) } : { label: 'Mark as unread', icon: 'mail', action: () => setSeen(uids, false) },
    f?.specialUse === 'junk'
      ? { label: 'Not spam', icon: 'inbox', action: () => moveSpecial(uids, 'inbox', { notJunk: true }) }
      : { label: 'Mark as spam', icon: 'spam', action: () => moveSpecial(uids, 'junk') },
    { label: 'Move', icon: 'move', action: () => moveDialog(uids) },
    { label: 'Copy to…', icon: 'folder', disabled: true, hint: '' },
  ].filter((x) => !x.disabled);
  if (one) {
    items.push('-');
    items.push({ label: 'Print', icon: 'print', action: () => printMessage(one) });
    items.push({ label: 'Show source', icon: 'source', action: () => window.open(`/api/source?folder=${encodeURIComponent(one.folder)}&uid=${one.uid}`, '_blank', 'noopener') });
    items.push({ label: 'Save as file', icon: 'download', action: () => (location.href = `/api/source?folder=${encodeURIComponent(one.folder)}&uid=${one.uid}&download=1`) });
    items.push({ label: 'Send as new email', icon: 'edit', action: () => composeFromMessage('editCopy', one) });
  }
  items.push('-', { label: 'Delete', icon: 'trash', danger: true, action: () => deleteSelected() });
  return items;
}

function printMessage(m) {
  const frame = $('.mail-body iframe');
  const w = window.open('', '_blank', 'noopener=no');
  if (!w) return;
  const from = m.from[0] || {};
  w.document.write(`<!doctype html><title>${esc(m.subject)}</title><body style="font:13px system-ui;margin:24px">
    <h2 style="margin:0 0 8px">${esc(m.subject)}</h2>
    <div><b>From:</b> ${esc(from.name || '')} &lt;${esc(from.address || '')}&gt;</div>
    <div><b>Date:</b> ${esc(fullDate(m.date))}</div>
    <div><b>To:</b> ${esc((m.to || []).map((t) => t.name || t.address).join(', '))}</div><hr>
    ${frame?.contentDocument?.body?.innerHTML || ''}</body>`);
  w.document.close();
  w.focus();
  w.print();
}

async function editDraft(uid) {
  try {
    const data = state.open?.uid === uid && state.open.data?.imagesShown ? state.open.data : await api('message', { query: { folder: state.folder, uid, images: '1', seen: '0' } });
    composeFromMessage('draft', data);
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

function removeFromList(uids) {
  const set = new Set(uids);
  const idx = state.list.messages.findIndex((m) => set.has(m.uid));
  const unread = state.list.messages.filter((m) => set.has(m.uid) && !m.seen).length;
  state.list.messages = state.list.messages.filter((m) => !set.has(m.uid));
  state.list.total = Math.max(0, state.list.total - uids.length);
  if (unread) adjustUnread(state.folder, -unread);
  for (const u of uids) state.selection.delete(u);
  // select the next message, like OX does
  if (state.open && set.has(state.open.uid)) {
    state.open = null;
    const next = state.list.messages[Math.min(Math.max(idx, 0), state.list.messages.length - 1)];
    if (next && state.prefs.layout !== 'list' && window.innerWidth > 860) {
      state.selection = new Set([next.uid]);
      state.cursor = state.anchor = next.uid;
      renderList();
      renderListHead();
      openMessage(next.uid);
      return;
    }
    app().classList.remove('reading');
  }
  renderList();
  renderListHead();
  renderReader();
}

async function deleteSelected() {
  const uids = selectedUids();
  if (!uids.length) return;
  const f = currentFolder();
  const permanent = f?.specialUse === 'trash' || !folderByUse('trash');
  if ((permanent || state.prefs.confirmDelete) && !(await confirmDialog('Delete', permanent ? `Do you really want to permanently delete ${uids.length === 1 ? 'this message' : `these ${uids.length} messages`}?` : `Delete ${uids.length === 1 ? 'this message' : `${uids.length} messages`}?`, { ok: 'Delete', danger: permanent }))) return;
  const folder = state.folder;
  removeFromList(uids);
  try {
    await api('delete', { method: 'POST', body: { folder, uids } });
  } catch (e) {
    toast(e.message, { type: 'error' });
    reloadList({ keep: true });
  }
  refreshFolders();
}

async function moveMessages(uids, to, from = state.folder) {
  if (!uids.length) return;
  if (from === state.folder) removeFromList(uids);
  try {
    await api('move', { method: 'POST', body: { folder: from, uids, to } });
    const f = state.folders.find((x) => x.path === to);
    toast(`${uids.length === 1 ? 'Message' : `${uids.length} messages`} moved to ${folderLabel(f) || to}`, { timeout: 2500 });
  } catch (e) {
    toast(e.message, { type: 'error' });
    reloadList({ keep: true });
  }
  refreshFolders();
}

async function moveSpecial(uids, toSpecial, extra = {}) {
  if (!uids.length) return;
  removeFromList(uids);
  try {
    const r = await api('move', { method: 'POST', body: { folder: state.folder, uids, toSpecial, ...extra } });
    const label = { archive: 'Archive', junk: 'Spam', inbox: 'Inbox', trash: 'Trash' }[toSpecial];
    toast(`${uids.length === 1 ? 'Message' : `${uids.length} messages`} moved to ${label || r.to}`, { timeout: 2500 });
  } catch (e) {
    toast(e.message, { type: 'error' });
    reloadList({ keep: true });
  }
  refreshFolders();
}

async function moveDialog(uids) {
  if (!uids.length) return;
  const to = await pickFolder(uids.length === 1 ? 'Move message' : `Move ${uids.length} messages`, { exclude: state.folder });
  if (to) moveMessages(uids, to);
}

async function setFlag(uids, flag, on) {
  for (const u of uids) {
    const m = findMsg(u);
    if (m && flag === '\\Flagged') m.flagged = on;
  }
  if (state.open?.data && uids.includes(state.open.uid) && flag === '\\Flagged') state.open.data.flagged = on;
  renderList();
  renderReader();
  try {
    await api('flags', { method: 'POST', body: { folder: state.folder, uids, [on ? 'add' : 'remove']: [flag] } });
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

async function setSeen(uids, seen) {
  let delta = 0;
  for (const u of uids) {
    const m = findMsg(u);
    if (m && m.seen !== seen) {
      m.seen = seen;
      delta += seen ? -1 : 1;
    }
  }
  if (delta) adjustUnread(state.folder, delta);
  renderList();
  try {
    await api('flags', { method: 'POST', body: { folder: state.folder, uids, [seen ? 'add' : 'remove']: ['\\Seen'] } });
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

// ===========================================================================
// Refresh, new mail, notifications

let timers = [];
function startTimers() {
  stopTimers();
  const mins = Math.max(1, +state.prefs.refreshMinutes || 1);
  timers.push(setInterval(() => refreshAll(false), mins * 60000));
  timers.push(setInterval(renderListFoot, 30000));
  document.addEventListener('visibilitychange', onVisible);
}
function stopTimers() {
  timers.forEach(clearInterval);
  timers = [];
  document.removeEventListener('visibilitychange', onVisible);
}
function onVisible() {
  if (document.visibilityState === 'visible' && Date.now() - state.lastUpdated > 60000) refreshAll(false);
}
onPrefsChange((p) => {
  if ('refreshMinutes' in p && state.session) startTimers();
});

let refreshing = false;
export async function refreshAll(manual) {
  if (refreshing || !state.session) return;
  refreshing = true;
  const btn = $('[data-act="refresh"] .icon');
  btn?.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 700, iterations: manual ? 2 : 1 });
  try {
    await refreshFolders();
    if (!state.list.search) await reloadList({ keep: true });
  } finally {
    refreshing = false;
  }
}

async function checkNewMail() {
  const inbox = state.folders.find((f) => f.specialUse === 'inbox');
  if (!inbox) return;
  const prev = state.knownInbox;
  state.knownInbox = { total: inbox.total, unread: inbox.unread };
  if (!prev || inbox.total <= prev.total || inbox.unread <= prev.unread) return;
  // Fetch the newest few messages to describe them.
  try {
    const n = Math.min(inbox.total - prev.total, 5);
    const res = await api('messages', { query: { folder: inbox.path, offset: 0, limit: n } });
    const fresh = res.messages.filter((m) => !m.seen);
    if (!fresh.length) return;
    for (const m of fresh) state.notifications.unshift({ uid: m.uid, from: displayName(m.from[0]), subject: m.subject, at: Date.now() });
    state.notifications = state.notifications.slice(0, 20);
    $('.notif-dot')?.classList.remove('hidden');
    $('[data-act="go-inbox"] .badge-dot')?.classList.remove('hidden');
    if (state.prefs.notifications && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      const m = fresh[0];
      const note = new Notification(fresh.length > 1 ? `${fresh.length} new messages` : displayName(m.from[0]) || 'New message', { body: m.subject, tag: 'ratmail', icon: '/favicon.svg' });
      note.onclick = () => {
        window.focus();
        selectFolder(inbox.path);
      };
    }
  } catch {}
}

function showNotifications(anchor) {
  $('.notif-dot')?.classList.add('hidden');
  const list = state.notifications;
  showMenu(anchor, list.length
    ? [{ header: 'New messages' }, ...list.slice(0, 10).map((n) => ({ label: `${n.from}: ${n.subject || '(no subject)'}`, icon: 'mail', action: () => { cancelSearch(true); selectFolder('INBOX'); setTimeout(() => { state.selection = new Set([n.uid]); state.cursor = n.uid; afterSelection(); }, 600); } })), '-', { label: 'Clear notifications', action: () => (state.notifications = []) }]
    : [{ header: 'No new notifications' }, ...(state.prefs.notifications ? [] : ['-', { label: 'Turn on desktop notifications', icon: 'bell', action: () => openSettings('notifications') }])], { align: 'right', className: 'notif-list' });
}

function showHelp() {
  dialog({
    title: 'Keyboard shortcuts',
    body: `<table class="shortcuts">
      <tr><td><kbd>N</kbd> or <kbd>C</kbd></td><td>New email</td></tr>
      <tr><td><kbd>R</kbd></td><td>Reply</td></tr>
      <tr><td><kbd>Shift</kbd>+<kbd>R</kbd></td><td>Reply all</td></tr>
      <tr><td><kbd>F</kbd></td><td>Forward</td></tr>
      <tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>Previous / next message</td></tr>
      <tr><td><kbd>Delete</kbd></td><td>Delete selected messages</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>A</kbd></td><td>Select all (in the list)</td></tr>
      <tr><td><kbd>/</kbd></td><td>Search</td></tr>
      <tr><td><kbd>Ctrl</kbd>+<kbd>Enter</kbd></td><td>Send (in compose)</td></tr>
      </table><p class="muted" style="margin-top:14px">Signed in as ${esc(state.session.email)} on ${esc(state.session.server?.name || '')}.</p>`,
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

// Exposed to compose/settings modules
export const appApi = { refreshAll, refreshFolders, reloadList, selectFolder, currentFolder: () => currentFolder(), applyLayout };

boot();
