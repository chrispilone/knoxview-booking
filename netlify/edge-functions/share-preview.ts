// Link previews for delivery share links (/d/<token>): when the link is texted, emailed or posted, the preview shows
// the listing's address and cover photo instead of the generic "Book Real Estate Media" card.
// Only the address and cover come back (booking function, action share-meta). Any problem: the normal page is served.
const SB = 'https://sqlkswwwpkzadrrbhqip.supabase.co';
const KEY = 'sb_publishable_X-Pafdzgf9cDIdtGO8RofA_YBwlvktq'; // public key (same as config.js)
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export default async (req: Request, ctx: { next: () => Promise<Response> }) => {
  const res = await ctx.next();
  try {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
    if (!m || !(res.headers.get('content-type') || '').includes('text/html')) return res;
    const r = await fetch(`${SB}/functions/v1/booking`, { method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ action: 'share-meta', token: m[1] }) });
    if (!r.ok) return res;
    const meta = await r.json();
    if (!meta?.address) return res;
    const title = esc(`${meta.address}${meta.city ? ', ' + meta.city : ''}`);
    const desc = 'Photos, video and downloads · Knox View Real Estate Media';
    const img = esc(meta.cover || `${url.origin}/img/og-book.jpg`);
    let html = await res.text();
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace(/(<meta name="description" content=")[^"]*/, `$1${desc}`)
      .replace(/(<meta property="og:title" content=")[^"]*/, `$1${title}`)
      .replace(/(<meta property="og:description" content=")[^"]*/, `$1${desc}`)
      .replace(/(<meta property="og:image" content=")[^"]*/, `$1${img}`)
      .replace(/(<meta name="twitter:title" content=")[^"]*/, `$1${title}`)
      .replace(/(<meta name="twitter:image" content=")[^"]*/, `$1${img}`)
      .replace(/(<meta property="og:image:alt" content=")[^"]*/, `$1${title}`)
      .replace('<meta property="og:type" content="website">', `<meta property="og:type" content="website">\n<meta property="og:url" content="${esc(url.origin + url.pathname)}">`);
    if (meta.cover) html = html.replace(/<meta property="og:image:(width|height)"[^>]*>\n?/g, '');
    const h = new Headers(res.headers); h.delete('content-length');
    return new Response(html, { status: res.status, headers: h });
  } catch (e) {
    console.error('share-preview', String(e));
    return res;
  }
};

export const config = { path: '/d/*' };
