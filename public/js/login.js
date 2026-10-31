// Sign-in page: pick a mail server, enter the mailbox login.

import { api, esc, $ } from './util.js';
import { loginLogoHtml } from './brand.js';

export function renderLogin(root, config, { message, onSignedIn }) {
  const servers = config.servers || [];
  const brand = config.brand || {};
  let lastServer = '';
  try {
    lastServer = localStorage.getItem('ratmail.server') || '';
  } catch {}
  if (!servers.some((s) => s.id === lastServer)) lastServer = servers[0]?.id || '';

  document.title = `Sign in - ${brand.title || 'ratmail'}`;
  const host = (s) => s?.host || s?.domain || s?.name || '';
  const footLinks = `${brand.privacyUrl ? `<a href="${esc(brand.privacyUrl)}">Privacy Policy</a>` : ''}${brand.imprintUrl ? `<a href="${esc(brand.imprintUrl)}">Imprint</a>` : ''}`;
  root.innerHTML = `
    <div class="login">
      <div class="cable" aria-hidden="true"></div>
      <main class="login-main">
        <div class="login-col">
          ${loginLogoHtml(brand)}
          <p class="login-prompt"><b>$</b> login <i class="login-host"></i></p>
          <div class="login-card">
            <form novalidate>
              <h1>Sign in</h1>
              <div class="login-error ${message ? '' : 'hidden'}" role="alert">${esc(message || '')}</div>
              <label class="field ${servers.length > 1 ? '' : 'hidden'}"><span>Mail server</span>
                <select class="input" name="server">${servers.map((s) => `<option value="${esc(s.id)}" ${s.id === lastServer ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
              </label>
              <label class="field"><span>Username</span><input class="input" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
              <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
              <label class="checkbox"><input type="checkbox" name="remember" checked> Stay signed in</label>
              ${config.turnstile ? '<div class="turnstile"></div>' : ''}
              <button class="btn btn-primary" type="submit">Sign in</button>
            </form>
          </div>
        </div>
      </main>
      <footer class="login-foot"><span>${esc(brand.footer || '')}</span>${footLinks ? `<span>${footLinks}</span>` : ''}</footer>
    </div>`;

  const form = $('form', root);
  const hostEl = $('.login-host', root);
  const showHost = () => { hostEl.textContent = host(servers.find((s) => s.id === form.server.value)); };
  showHost();
  form.server.addEventListener('change', showHost);
  const err = $('.login-error', root);
  const btn = $('button[type=submit]', root);
  const user = form.username;
  try {
    user.value = localStorage.getItem('ratmail.user') || '';
  } catch {}
  (user.value ? form.password : user).focus();

  // Cloudflare Turnstile, when the server has it switched on.
  let tsWidget = null;
  let tsToken = '';
  if (config.turnstile) {
    loadTurnstile().then((turnstile) => {
      tsWidget = turnstile.render($('.turnstile', root), {
        sitekey: config.turnstile,
        theme: ['dark', 'light'].includes(document.documentElement.dataset.theme) ? document.documentElement.dataset.theme : 'auto',
        callback: (t) => { tsToken = t; },
        'expired-callback': () => { tsToken = ''; },
        'error-callback': () => { tsToken = ''; },
      });
    }).catch(() => {
      err.textContent = 'The security check could not load. Check your connection and reload the page.';
      err.classList.remove('hidden');
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!user.value.trim() || !form.password.value) {
      err.textContent = 'Please enter your username and password.';
      err.classList.remove('hidden');
      return;
    }
    if (config.turnstile && !tsToken) {
      err.textContent = 'Please complete the security check.';
      err.classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    err.classList.add('hidden');
    try {
      await api('login', {
        method: 'POST',
        body: { server: form.server.value, username: user.value.trim(), password: form.password.value, remember: form.remember.checked, turnstile: tsToken || undefined },
      });
      try {
        localStorage.setItem('ratmail.server', form.server.value);
        localStorage.setItem('ratmail.user', user.value.trim());
      } catch {}
      onSignedIn();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Sign in';
      form.password.select();
      // A Turnstile token works once, so get a fresh one for the next try.
      if (tsWidget !== null && window.turnstile) {
        tsToken = '';
        window.turnstile.reset(tsWidget);
      }
    }
  });
}

let turnstilePromise = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!turnstilePromise) {
    turnstilePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')));
      s.onerror = () => { turnstilePromise = null; reject(new Error('turnstile')); };
      document.head.appendChild(s);
    });
  }
  return turnstilePromise;
}
