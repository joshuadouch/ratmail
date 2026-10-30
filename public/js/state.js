// App state and user preferences.
// Preferences are cached in localStorage for instant start-up and synced to the
// server (D1 "prefs" table) so they follow the user between devices.

import { api, debounce } from './util.js';

export const DEFAULT_PREFS = {
  accent: '#2c4a86',
  theme: 'white',
  layout: 'vertical', // vertical | horizontal | list
  listStyle: 'avatars', // avatars | checkboxes | simple
  markRead: 'immediate', // immediate | delay | never
  images: 'ask', // ask | always
  trusted: [], // senders whose images always show
  displayName: '',
  identities: [], // extra From addresses [{name,email}]
  signature: '',
  signatureOnReply: true,
  composeFormat: 'html', // html | text
  fontSize: '11pt',
  notifications: false,
  refreshMinutes: 1,
  confirmDelete: false,
  contacts: [], // recently used recipients [{name,email}]
  sidebarCollapsed: false,
  listWidth: 250,
  listHeight: 40,
  folderOpen: { _account: true, _mine: true },
};

export const state = {
  config: null,
  session: null,
  prefs: { ...DEFAULT_PREFS },
  folders: [],
  folder: 'INBOX',
  list: { messages: [], total: 0, loading: false, done: false, search: null, error: null },
  selection: new Set(),
  cursor: null,
  anchor: null,
  open: null, // { uid, folder, data }
  lastUpdated: 0,
  notifications: [],
  knownInboxUids: null,
};

const LS_KEY = 'ratmail.prefs';

export function loadCachedPrefs() {
  try {
    Object.assign(state.prefs, JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
  } catch {}
}

export function applyServerPrefs(serverPrefs) {
  state.prefs = { ...DEFAULT_PREFS, ...(serverPrefs || {}) };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state.prefs));
  } catch {}
}

const pushPrefs = debounce(() => {
  api('prefs', { method: 'PUT', body: state.prefs }).catch(() => {});
}, 800);

const listeners = new Set();
export function onPrefsChange(fn) {
  listeners.add(fn);
}

export function setPrefs(patch) {
  Object.assign(state.prefs, patch);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state.prefs));
  } catch {}
  pushPrefs();
  for (const fn of listeners) fn(patch);
}

export function rememberContacts(list) {
  const map = new Map(state.prefs.contacts.map((c) => [c.email.toLowerCase(), c]));
  for (const c of list) {
    if (!c?.email) continue;
    const k = c.email.toLowerCase();
    const prev = map.get(k);
    map.delete(k);
    map.set(k, { name: c.name || prev?.name || '', email: c.email });
  }
  setPrefs({ contacts: [...map.values()].slice(-300) });
}

export function folderByUse(use) {
  return state.folders.find((f) => f.specialUse === use);
}

export function identities() {
  const main = { name: state.prefs.displayName || '', email: state.session.email };
  const extra = (state.prefs.identities || []).filter((i) => i.email && i.email.toLowerCase() !== main.email.toLowerCase());
  return [main, ...extra];
}

export function myAddresses() {
  return new Set(identities().map((i) => i.email.toLowerCase()));
}

// Themes ---------------------------------------------------------------------

export const ACCENTS = ['#e0575b', '#e8805b', '#f0b54f', '#7fbf73', '#6fc0b5', '#6fa0d8', '#2c4a86', '#8a63d2', '#c86ad6', '#e0679a', '#9c9a92', '#8b8fa3'];

export const BACKGROUNDS = {
  Default: [
    ['white', 'White', '#ffffff'],
    ['smoke', 'Smoke Gray', '#ececec'],
    ['solarized', 'Solarized', '#ece6d6'],
    ['dark', 'Dark', '#111214'],
  ],
  Sunsets: [
    ['bg-blue-sunset', 'Blue Sunset', 'radial-gradient(ellipse at 50% 85%, #f0725a 0%, #b0477e 30%, #4a4d9a 62%, #2a3779 100%)'],
    ['bg-pink-sunset', 'Pink Sunset', 'radial-gradient(ellipse at 50% 85%, #ff9d5c 0%, #f2304e 32%, #e8236d 60%, #c21b6b 100%)'],
    ['bg-orange-glow', 'Orange Glow', 'radial-gradient(ellipse at 50% 85%, #ffe26a 0%, #ffa832 30%, #f7922a 65%, #ef7d22 100%)'],
    ['bg-sunset', 'Sunset', 'linear-gradient(180deg, #c9ccd4 0%, #e3cfb2 55%, #f4c38a 100%)'],
  ],
  Unicolor: [
    ['bg-red', 'Red', '#e8312c'],
    ['bg-orange', 'Orange', '#e9622a'],
    ['bg-yellow', 'Yellow', '#f4a62a'],
    ['bg-green', 'Green', '#5fa257'],
    ['bg-petrol', 'Petrol', '#4aa79d'],
    ['bg-blue', 'Blue', '#3f77c0'],
    ['bg-navy', 'Navy', '#3354a8'],
    ['bg-purple', 'Purple', '#6c41b5'],
    ['bg-magenta', 'Magenta', '#b23bc4'],
    ['bg-pink', 'Pink', '#d93a7d'],
    ['bg-taupe', 'Taupe', '#8a837c'],
    ['bg-slate', 'Slate', '#6b6e80'],
  ],
};

export function applyTheme() {
  const root = document.documentElement;
  const theme = state.prefs.theme || 'white';
  if (theme === 'white') delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.style.setProperty('--accent', state.prefs.accent || DEFAULT_PREFS.accent);
}
