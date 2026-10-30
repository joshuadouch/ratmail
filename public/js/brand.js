import { esc } from './util.js';

/**
 * The logo in the top-left corner. brand.logo "ratlan.net" renders as a
 * terminal glyph, "ratlan" bold, ".net" light and a block cursor.
 * brand.logoUrl, when set, shows an image instead.
 */
export function brandHtml(brand = {}) {
  if (brand.logoUrl) return `<a class="brand" href="/"><img src="${esc(brand.logoUrl)}" alt="${esc(brand.title || '')}" style="height:24px"></a>`;
  const text = brand.logo || brand.title || 'mail';
  const dot = text.indexOf('.');
  const name = dot > 0 ? text.slice(0, dot) : text;
  const tld = dot > 0 ? text.slice(dot) : '';
  return `<a class="brand" href="/" aria-label="${esc(text)}"><span class="term">&gt;_</span><span>${esc(name)}<span class="tld">${esc(tld)}</span></span><span class="cursor"></span></a>`;
}
