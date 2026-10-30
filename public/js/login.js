// Sign-in page: pick a mail server, enter the mailbox login.

import { api, esc, $ } from './util.js';
import { brandHtml } from './brand.js';

export function renderLogin(root, config, { message, onSignedIn }) {
  const servers = config.servers || [];
  const brand = config.brand || {};
  let lastServer = '';
  try {
    lastServer = localStorage.getItem('ratmail.server') || '';
  } catch {}
  if (!servers.some((s) => s.id === lastServer)) lastServer = servers[0]?.id || '';

  document.title = `Sign in · ${brand.title || 'Mail'}`;
  root.innerHTML = `
    <div class="login">
      <div class="login-top">${brandHtml(brand)}</div>
      <div class="login-main">
        <div class="login-card">
          <h1>${esc(brand.title || 'Mail')}</h1>
          <form novalidate>
            <h2>Sign in</h2>
            <div class="login-error ${message ? '' : 'hidden'}" role="alert">${esc(message || '')}</div>
            <label class="field ${servers.length > 1 ? '' : 'hidden'}"><span>Mail server</span>
              <select class="input" name="server">${servers.map((s) => `<option value="${esc(s.id)}" ${s.id === lastServer ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
            </label>
            <label class="field"><span>Username</span><input class="input" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
            <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
            <label class="checkbox"><input type="checkbox" name="remember" checked> Stay signed in</label>
            <button class="btn btn-primary" type="submit">Sign in</button>
          </form>
        </div>
      </div>
      <div class="login-foot">${esc(brand.footer || '')}${brand.privacyUrl ? `<a href="${esc(brand.privacyUrl)}">Privacy Policy</a>` : ''}${brand.imprintUrl ? `<a href="${esc(brand.imprintUrl)}">Imprint</a>` : ''}</div>
    </div>`;

  const form = $('form', root);
  const err = $('.login-error', root);
  const btn = $('button[type=submit]', root);
  const user = form.username;
  try {
    user.value = localStorage.getItem('ratmail.user') || '';
  } catch {}
  (user.value ? form.password : user).focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!user.value.trim() || !form.password.value) {
      err.textContent = 'Please enter your username and password.';
      err.classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    err.classList.add('hidden');
    try {
      await api('login', {
        method: 'POST',
        body: { server: form.server.value, username: user.value.trim(), password: form.password.value, remember: form.remember.checked },
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
    }
  });
}
