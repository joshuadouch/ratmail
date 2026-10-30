// Makes email HTML safe to show. The page also renders it in a sandboxed
// iframe (no scripts) with a strict CSP, so this is the first of two layers.
//
// External images (and CSS backgrounds) are blocked unless allowed, to avoid
// tracking pixels. Blocked images keep their URL in data-blocked-src so the
// reader can tell that something was hidden.

const DROP = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'link', 'meta', 'noscript', 'template', 'portal'];
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href', 'background', 'poster', 'srcset', 'data', 'lowsrc', 'dynsrc'];

const EXTERNAL = /^\s*(https?:)?\/\//i;
const DANGEROUS = /^\s*(javascript|vbscript|data:text\/html|data:image\/svg|livescript)/i;

function blockCssUrls(css, allowExternal, state) {
  css = css.replace(/@import[^;]+;?/gi, '');
  css = css.replace(/expression\s*\(/gi, 'blocked(');
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, url) => {
    if (DANGEROUS.test(url)) return 'none';
    if (EXTERNAL.test(url)) {
      state.external = true;
      return allowExternal ? m : 'none';
    }
    if (/^\s*cid:/i.test(url)) return `url("${state.cid(url)}")`;
    return m;
  });
}

/**
 * @param html raw HTML of the message
 * @param opts { allowExternal, cidUrl(cid) => url or null }
 * @returns { html, external }
 */
export async function sanitizeHtml(html, { allowExternal = false, cidUrl = () => null } = {}) {
  const state = {
    external: false,
    cid: (v) => cidUrl(v.trim().replace(/^cid:/i, '').replace(/^<|>$/g, '')) || '',
  };

  let styleBuf = '';
  const rewriter = new HTMLRewriter()
    .on(DROP.join(','), {
      element(el) {
        el.remove();
      },
    })
    .on('form', {
      element(el) {
        el.removeAndKeepContent();
      },
    })
    .on('style', {
      text(t) {
        styleBuf += t.text;
        if (t.lastInTextNode) {
          t.replace(blockCssUrls(styleBuf, allowExternal, state), { html: true });
          styleBuf = '';
        } else {
          t.remove();
        }
      },
    })
    .on('*', {
      element(el) {
        for (const [name, value] of [...el.attributes]) {
          const n = name.toLowerCase();
          if (n.startsWith('on') || n === 'formaction' || n === 'srcdoc' || n === 'ping') {
            el.removeAttribute(name);
            continue;
          }
          if (n === 'style') {
            el.setAttribute('style', blockCssUrls(value, allowExternal, state));
            continue;
          }
          if (URL_ATTRS.includes(n) && DANGEROUS.test(value)) {
            el.removeAttribute(name);
            continue;
          }
          if (n === 'background' && EXTERNAL.test(value)) {
            state.external = true;
            if (!allowExternal) el.removeAttribute(name);
          }
        }
      },
    })
    .on('img, image, video, audio, source, input', {
      element(el) {
        const src = el.getAttribute('src');
        if (src && /^\s*cid:/i.test(src)) {
          const url = state.cid(src);
          if (url) el.setAttribute('src', url);
          else el.removeAttribute('src');
        } else if (src && EXTERNAL.test(src)) {
          state.external = true;
          if (!allowExternal) {
            el.setAttribute('data-blocked-src', src);
            el.removeAttribute('src');
          }
        }
        const srcset = el.getAttribute('srcset');
        if (srcset && EXTERNAL.test(srcset)) {
          state.external = true;
          if (!allowExternal) el.removeAttribute('srcset');
        }
      },
    })
    .on('a, area', {
      element(el) {
        const href = el.getAttribute('href') || '';
        if (href && !href.startsWith('#')) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      },
    });

  const out = await rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })).text();
  return { html: out, external: state.external };
}

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => escapeMap[c]);
}

/** Plain text body -> simple HTML with links and quoted lines. */
export function textToHtml(text) {
  const lines = escapeHtml(text || '').split(/\r?\n/);
  let html = '';
  let depth = 0;
  for (const raw of lines) {
    const m = /^((?:&gt;\s?)+)/.exec(raw);
    const d = m ? (m[1].match(/&gt;/g) || []).length : 0;
    while (depth < d) { html += '<blockquote type="cite">'; depth++; }
    while (depth > d) { html += '</blockquote>'; depth--; }
    const line = m ? raw.slice(m[1].length) : raw;
    html += line.replace(/\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`) + '<br>';
  }
  while (depth-- > 0) html += '</blockquote>';
  return `<div class="plain-text">${html}</div>`;
}
