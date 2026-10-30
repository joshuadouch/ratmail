// Shared helpers: API calls, DOM, formatting, menus, dialogs, toasts.

import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------------------------------------------------------------------------
// API

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onSignedOut = () => {};
export function setSignedOutHandler(fn) {
  onSignedOut = fn;
}

export async function api(path, { method = 'GET', body, form, query } = {}) {
  let url = '/api/' + path;
  if (query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    url += '?' + q;
  }
  const headers = { 'x-ratmail': '1' };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError('You appear to be offline', 0);
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && data?.signedOut && path !== 'login') onSignedOut(data.error);
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Formatting

export function initials(person) {
  const name = (person?.name || '').replace(/["'()]/g, '').trim();
  if (name) {
    const parts = name.split(/[\s.,_-]+/).filter((p) => /\p{L}|\d/u.test(p));
    if (parts.length >= 2) return (first(parts[0]) + first(parts[parts.length - 1])).toUpperCase();
    if (parts.length === 1) return first(parts[0]).toUpperCase();
  }
  const email = person?.email || '?';
  return first(email).toUpperCase();
}
function first(s) {
  return [...s][0] || '';
}

export function displayName(p) {
  if (!p) return '';
  return p.name || p.email || '';
}

export function formatAddress(p) {
  return p.name ? `${p.name} <${p.email}>` : p.email;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'numeric', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Short date for the list: time today, weekday this week, else the date. */
export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  const diff = (now - d) / 86400000;
  if (diff < 6 && diff > 0) return `${weekdayFmt.format(d)} ${timeFmt.format(d)}`;
  return dayFmt.format(d);
}

export function fullDate(iso) {
  return iso ? fullFmt.format(new Date(iso)) : '';
}

export function relativeTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const hr = Math.round(m / 60);
  return hr === 1 ? '1 hour ago' : `${hr} hours ago`;
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function countLabel(n) {
  return n > 999 ? '999+' : String(n);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Parses "Name <a@b>, c@d" into [{name,email}] */
export function parseAddressList(text) {
  const out = [];
  const parts = text.match(/("[^"]*"|[^,;])+/g) || [];
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    const m = /^(.*?)<([^>]+)>$/.exec(p);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() });
    else out.push({ name: '', email: p.replace(/^"|"$/g, '') });
  }
  return out;
}

export const isEmail = (s) => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(s);

// ---------------------------------------------------------------------------
// Popup menus

let openMenu = null;

export function closeMenu() {
  if (openMenu) {
    openMenu.el.remove();
    openMenu.anchor?.classList.remove('open');
    openMenu = null;
  }
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor?.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenu) {
    closeMenu();
    e.stopPropagation();
  }
});
window.addEventListener('resize', closeMenu);

/**
 * Shows a menu under `anchor`. items: [{ label, icon, action, checked, radio,
 * disabled, danger }] or '-' for a divider, or { header: 'Title' },
 * or { html, onMount } for custom content.
 */
export function showMenu(anchor, items, { align = 'left', className = '', x, y } = {}) {
  const wasOpen = openMenu?.anchor === anchor && anchor;
  closeMenu();
  if (wasOpen) return;
  const el = h(`<div class="menu ${className}" role="menu"></div>`);
  for (const it of items) {
    if (it === '-') {
      el.append(h('<div class="menu-divider"></div>'));
    } else if (it.header) {
      el.append(h(`<div class="menu-header">${esc(it.header)}</div>`));
    } else if (it.html) {
      const node = h(`<div class="menu-custom">${it.html}</div>`);
      el.append(node);
      it.onMount?.(node);
    } else {
      const mark = it.radio !== undefined ? `<span class="radio ${it.radio ? 'on' : ''}"></span>` : it.checked !== undefined ? `<span class="check">${it.checked ? icon('check') : ''}</span>` : it.icon ? icon(it.icon) : '';
      const b = h(`<button type="button" class="menu-item ${it.danger ? 'danger' : ''}" role="menuitem" ${it.disabled ? 'disabled' : ''}>${mark}<span class="label">${esc(it.label)}</span>${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}</button>`);
      b.addEventListener('click', () => {
        if (!it.keepOpen) closeMenu();
        it.action?.();
      });
      el.append(b);
    }
  }
  document.body.append(el);
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, bottom: y, top: y };
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  let top = r.bottom + 4;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  if (top + mh > window.innerHeight - 8) top = Math.max(8, (anchor ? r.top : y) - mh - 4);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  anchor?.classList.add('open');
  openMenu = { el, anchor };
  return el;
}

// ---------------------------------------------------------------------------
// Dialogs

/**
 * Modal dialog. buttons: [{ label, value, primary, danger }]. Resolves with the
 * clicked button's value (or null on cancel/Escape).
 */
export function dialog({ title, body = '', buttons = [{ label: 'OK', value: true, primary: true }], className = '', onMount, wide = false }) {
  return new Promise((resolve) => {
    const back = h(`<div class="modal-back"><div class="modal ${wide ? 'wide' : ''} ${className}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2></div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div></div></div>`);
    const bodyEl = $('.modal-body', back);
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else bodyEl.append(body);
    if (!body) bodyEl.remove();
    const foot = $('.modal-foot', back);
    const done = (v) => {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    buttons.forEach((b) => {
      const btn = h(`<button type="button" class="btn ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''} ${b.left ? 'left' : ''}">${esc(b.label)}</button>`);
      btn.addEventListener('click', () => {
        const v = typeof b.value === 'function' ? b.value(back) : b.value;
        if (v !== undefined) done(v);
      });
      foot.append(btn);
    });
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        $('.btn-primary', foot)?.click();
      }
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => {
      if (e.target === back) done(null);
    });
    document.body.append(back);
    onMount?.(back);
    ($('input,select,textarea', bodyEl) || $('.btn-primary', foot))?.focus();
  });
}

export async function prompt(title, { label = '', value = '', ok = 'Save' } = {}) {
  const v = await dialog({
    title,
    body: `<label class="field"><span>${esc(label)}</span><input type="text" class="input" value="${esc(value)}"></label>`,
    buttons: [
      { label: 'Cancel', value: null },
      { label: ok, primary: true, value: (el) => $('input', el).value.trim() || undefined },
    ],
  });
  return v;
}

export function confirmDialog(title, text, { ok = 'OK', danger = false } = {}) {
  return dialog({
    title,
    body: `<p>${esc(text)}</p>`,
    buttons: [
      { label: 'Cancel', value: false },
      { label: ok, value: true, primary: !danger, danger },
    ],
  });
}

// ---------------------------------------------------------------------------
// Toasts

export function toast(message, { type = 'info', timeout = 4000, action } = {}) {
  let wrap = $('.toasts');
  if (!wrap) {
    wrap = h('<div class="toasts" aria-live="polite"></div>');
    document.body.append(wrap);
  }
  const el = h(`<div class="toast ${type}"><span>${esc(message)}</span></div>`);
  if (action) {
    const b = h(`<button type="button" class="link">${esc(action.label)}</button>`);
    b.onclick = () => {
      action.run();
      el.remove();
    };
    el.append(b);
  }
  const x = h(`<button type="button" class="icon-btn small" aria-label="Close">${icon('x')}</button>`);
  x.onclick = () => el.remove();
  el.append(x);
  wrap.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
