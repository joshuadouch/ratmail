import { esc } from './util.js';

// The ratmail mark: an envelope whose flap is the orange title bar of the
// ratlan.net terminal icon, with a ">_" prompt inside.
const MAIL_ICON = `<svg class="term-svg" width="24" height="18" viewBox="0 0 24 18" aria-hidden="true"><rect width="24" height="18" rx="3" fill="#f3f3f3"/><path d="M0 3a3 3 0 0 1 3-3h18a3 3 0 0 1 3 3L12 9.5z" fill="#e86f1e"/><path d="M5.5 11.8l2.3 1.7-2.3 1.7" fill="none" stroke="#222" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="9.5" y="14.5" width="5" height="1.5" fill="#222"/></svg>`;

/**
 * The logo in the top-left corner, in the ratlan.net terminal style:
 * icon, bold word, light word, orange block cursor.
 * brand.logo is either { bold, light, icon: "mail" | "term" } or a string
 * like "ratlan.net" (split at the first dot). brand.logoUrl shows an image.
 */
export function brandHtml(brand = {}) {
  if (brand.logoUrl) return `<a class="brand" href="/"><img src="${esc(brand.logoUrl)}" alt="${esc(brand.title || '')}" style="height:24px"></a>`;
  let bold;
  let light;
  let iconKind = 'term';
  if (brand.logo && typeof brand.logo === 'object') {
    bold = brand.logo.bold || '';
    light = brand.logo.light || '';
    iconKind = brand.logo.icon || 'mail';
  } else {
    const text = brand.logo || brand.title || 'mail';
    const dot = text.indexOf('.');
    bold = dot > 0 ? text.slice(0, dot) : text;
    light = dot > 0 ? text.slice(dot) : '';
  }
  const iconHtml = iconKind === 'mail' ? MAIL_ICON : '<span class="term">&gt;_</span>';
  return `<a class="brand" href="/" aria-label="${esc(bold + light)}">${iconHtml}<span>${esc(bold)}<span class="tld">${esc(light)}</span></span><span class="cursor"></span></a>`;
}
