// Link previews for download pages (/d/<order share token>): iMessage, Facebook, Slack… read the page's og: tags, so the
// page is served with "Media Library · <address>" and the branded preview image (gallery's first photo + the address),
// which the Supabase `media` function renders once and keeps in storage. Anything goes wrong → the normal page.
const SB = 'https://sqlkswwwpkzadrrbhqip.supabase.co';
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export default async (req: Request, context: { next: () => Promise<Response> }) => {
  const res = await context.next();
  const token = new URL(req.url).pathname.match(/^\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i)?.[1];
  if (!token || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  let m: any = null;
  try {
    const r = await fetch(`${SB}/functions/v1/booking`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'share-meta', token }), signal: AbortSignal.timeout(2500) });
    if (r.ok) m = await r.json();
  } catch (_) { /* fall through */ }
  if (!m?.address) return res;
  const name = m.title || m.address, place = [m.city, m.state].filter(Boolean).join(', ');
  const title = `Media Library · ${name}`;
  const desc = `Photos, video and more for ${[name, place].filter(Boolean).join(', ')}. Knox View Real Estate Media.`;
  const url = new URL(req.url); url.search = '';
  let html = await res.text();
  const set = (re: RegExp, tag: string) => { html = re.test(html) ? html.replace(re, tag) : html.replace('</head>', tag + '\n</head>'); };
  set(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  set(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(desc)}">`);
  set(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${esc(title)}">`);
  set(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${esc(desc)}">`);
  set(/<meta property="og:image" [^>]*>/, `<meta property="og:image" content="${esc(m.image)}">`);
  set(/<meta property="og:image:alt"[^>]*>/, `<meta property="og:image:alt" content="${esc(`Media Library: ${name}`)}">`);
  set(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${esc(title)}">`);
  set(/<meta name="twitter:image"[^>]*>/, `<meta name="twitter:image" content="${esc(m.image)}">`);
  set(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${esc(url.toString())}">`);
  const h = new Headers(res.headers); h.delete('content-length'); h.delete('etag');
  return new Response(html, { status: res.status, headers: h });
};

export const config = { path: '/d/*' };
