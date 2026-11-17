// Knox View delivery files. Serves photos and videos for the client delivery page from Dropbox and Vimeo.
// Every link is signed by the `booking` function (only for orders the client may download) and expires.
//   GET ?d=<payload>&s=<signature>
//     src dbx:   v=thumb (640px JPEG), web (2048px JPEG), high (original file)
//     src vimeo: phone-friendly MP4 (H.264, up to 1080p) — saves to the iPhone camera roll / Android gallery
//     src dbxp:  a file by its path in the connected Dropbox (thumb/preview/web/high), or a folder as a zip (v=zip)
//     src url:   any direct file link
//     src zipb:  every photo of an order (bid) in the Media Library order, as one zip with numbered names (001-003-<address>.jpg)
// The browser can fetch these (CORS open) to hand files to the share sheet ("Save Video" / "Save Images").
import { verify, dropboxStream, dropboxPathStream, dropboxFiles, cleanDropboxLink, vimeoInfo, pickPhoneMp4, safeName, galleryEntries, galleryName, galleryAddress } from './lib.ts';
import { Image, TextLayout } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';

// Before payment, photos are served with the PREVIEW watermark burned in (can't be removed by saving the image).
const WM_URL = (Deno.env.get('WATERMARK_URL') ?? '').trim() || 'https://knoxview-booking.netlify.app/watermark.png';
let WM: any = null;
const SB_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, ''), SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
async function watermark(bytes: Uint8Array) {
  let img: any = await Image.decode(bytes);
  if (img.width > 1400) img = img.resize(1400, Image.RESIZE_AUTO); // previews never need more
  if (!WM) WM = await Image.decode(new Uint8Array(await (await fetch(WM_URL)).arrayBuffer()));
  const tile = WM.clone().resize(img.width, Image.RESIZE_AUTO);
  for (let y = 0; y < img.height; y += tile.height) img.composite(tile, 0, y);
  return await img.encodeJPEG(80);
}

/* ----- streaming ZIP (stored, no compression: photos don't shrink) so big orders never sit in memory ----- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crcUp = (c: number, d: Uint8Array) => { for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8); return c; };
function zipStream(files: { name: string; open: () => Promise<Response> }[]) {
  const enc = new TextEncoder(), central: Uint8Array[] = [], d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0, i = 0;
  const used = new Set<string>();
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (i >= files.length) {
        const cdStart = offset; let cdLen = 0;
        for (const c of central) { ctrl.enqueue(c); cdLen += c.length; }
        const end = new Uint8Array(22), v = new DataView(end.buffer);
        v.setUint32(0, 0x06054b50, true); v.setUint16(8, central.length, true); v.setUint16(10, central.length, true);
        v.setUint32(12, cdLen, true); v.setUint32(16, cdStart, true);
        ctrl.enqueue(end); ctrl.close(); return;
      }
      const f = files[i++];
      let nm = f.name; for (let k = 2; used.has(nm.toLowerCase()); k++) nm = f.name.replace(/(\.[^.]+)?$/, ` (${k})$1`);
      used.add(nm.toLowerCase());
      const name = enc.encode(nm), start = offset;
      const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0808, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint16(26, name.length, true); lh.set(name, 30);
      ctrl.enqueue(lh); offset += lh.length;
      const r = await f.open();
      if (!r.ok || !r.body) throw new Error('zip source ' + r.status + ' for ' + f.name);
      let crc = 0xffffffff, size = 0;
      const rd = r.body.getReader();
      for (;;) { const { done, value } = await rd.read(); if (done) break; crc = crcUp(crc, value); size += value.length; ctrl.enqueue(value); }
      crc = (crc ^ 0xffffffff) >>> 0; offset += size;
      if (offset > 0xfffffff0) throw new Error('zip too large');
      const dd = new Uint8Array(16), dv = new DataView(dd.buffer);
      dv.setUint32(0, 0x08074b50, true); dv.setUint32(4, crc, true); dv.setUint32(8, size, true); dv.setUint32(12, size, true);
      ctrl.enqueue(dd); offset += 16;
      const c = new Uint8Array(46 + name.length), cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0808, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, start, true); c.set(name, 46);
      central.push(c);
    },
  });
}
const ownFetch = (url: string) => fetch(url, { redirect: 'follow', headers: url.startsWith(`${SB_URL}/storage/v1/object/`) ? { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY } : {} });

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Expose-Headers': 'content-length, content-disposition, content-type' };
const err = (msg: string, status = 400) => new Response(msg, { status, headers: { ...CORS, 'Content-Type': 'text/plain' } });
const EXT_TYPE: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp', pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', zip: 'application/zip' };


/* ----- link preview image (?og=<share token>) ----- */
const OG_W = 1200, OG_H = 630, OG_VER = 'og1'; // bump OG_VER to re-render every preview after a design change
const sbHeaders = { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY };
const FONTS: Record<string, Uint8Array> = {};
async function font(family: string, slug: string, weight: number) {
  const k = `${slug}-${weight}`; if (FONTS[k]) return FONTS[k];
  let r = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/latin-${weight}-normal.ttf`).catch(() => null);
  if (!r?.ok) { // Google Fonts hands TTF to clients it doesn't recognize
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`, { headers: { 'User-Agent': 'curl/8' } })).text();
    const u = css.match(/url\((https:[^)]+\.ttf)\)/)?.[1]; if (!u) throw new Error('font ' + family);
    r = await fetch(u);
  }
  return (FONTS[k] = new Uint8Array(await r!.arrayBuffer()));
}
// text rendered and cropped to its ink, so it can be placed exactly
async function text(f: Uint8Array, size: number, t: string, color: number, maxWidth = OG_W) {
  const img: any = await Image.renderText(f, size, t, color, new TextLayout({ maxWidth, wrapStyle: 'word', verticalAlign: 'left', horizontalAlign: 'top' }));
  const { width: w, height: h, bitmap: px } = img; let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : img.crop(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}
const spaced = (t: string) => t.toUpperCase().split(' ').map(w => w.split('').join(' ')).join('   ');
function cover(img: any) {
  const k = Math.max(OG_W / img.width, OG_H / img.height), w = Math.ceil(img.width * k), h = Math.ceil(img.height * k);
  return img.resize(w, h).crop(Math.floor((w - OG_W) / 2), Math.floor((h - OG_H) / 2), OG_W, OG_H);
}
let SHADE: any = null;
function shade() { // dark at the bottom and left, where the text sits; the photo stays bright at the top right
  if (SHADE) return SHADE;
  const g = new Image(OG_W, OG_H), px = g.bitmap;
  for (let y = 0; y < OG_H; y++) { const v = y / OG_H, b = v < .3 ? .12 * v / .3 : .12 + .74 * Math.pow((v - .3) / .7, 1.4);
    for (let x = 0; x < OG_W; x++) { const a = Math.min(.9, b + .22 * Math.pow(1 - x / OG_W, 2)), i = (y * OG_W + x) * 4; px[i] = 9; px[i + 1] = 13; px[i + 2] = 22; px[i + 3] = Math.round(a * 255); } }
  return (SHADE = g);
}
async function photoBytes(b: any): Promise<Uint8Array | null> {
  const g = galleryEntries(b)[0];
  let r: Response | null = null;
  if (g?.kind === 'dbx') r = await dropboxPathStream(g.path!, 'web');
  else if (g) r = await ownFetch(g.web || g.url!);
  else if (/^https:\/\//.test(b.cover_url || '')) r = await ownFetch(b.cover_url);
  else if (b.photos_url) { const link = cleanDropboxLink(b.photos_url), f = ((await dropboxFiles(link).catch(() => null)) ?? []).find(f => f.kind === 'image'); if (f) r = await dropboxStream(link, f.path, 'web'); }
  return r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}
async function renderOg(b: any) {
  const title = (b.media_title || '').trim() || String(b.address || '').trim() + (b.unit ? ', ' + b.unit : '');
  const place = [b.city, b.state].filter(Boolean).join(', ');
  const [serif, sans, sansB] = await Promise.all([font('Cormorant Garamond', 'cormorant-garamond', 600), font('Figtree', 'figtree', 500), font('Figtree', 'figtree', 700)]);
  let bg: any = null;
  const raw = await photoBytes(b).catch(e => { console.error('og photo', String(e)); return null; });
  if (raw) { try { bg = cover(await Image.decode(raw)); } catch (e) { console.error('og decode', String(e)); } }
  const img: any = bg || new Image(OG_W, OG_H).fill(0x1d3250ff);
  img.composite(shade(), 0, 0);
  const put = async (f: Uint8Array, size: number, t: string, color: number, x: number, yBottom: number, maxW?: number) => { // bottom-aligned, with a soft shadow
    const s = await text(f, size, t, 0x00000070, maxW), m = await text(f, size, t, color, maxW); if (!m) return yBottom;
    const y = yBottom - m.height; if (s) img.composite(s, x + 1, y + 3); img.composite(m, x, y); return y;
  };
  const X = 64;
  // brand, top left
  const brand = await text(serif, 34, 'KNOX VIEW', 0xffffffff), sub = await text(sansB, 12, spaced('Real Estate Media'), 0xffffffd9);
  if (brand) { const sh = await text(serif, 34, 'KNOX VIEW', 0x00000060); if (sh) img.composite(sh, X + 1, 56 + 2); img.composite(brand, X, 56); if (sub) img.composite(sub, X + 1, 56 + brand.height + 9); }
  // bottom block: MEDIA LIBRARY, the address (up to 2 lines), city
  let y = OG_H - 58;
  if (place) y = (await put(sans, 30, place, 0xffffffe0, X, y)) - 22;
  let size = title.length > 34 ? 68 : 82, probe = await text(serif, size, title, 0xffffffff, OG_W - X * 2);
  if (probe && probe.height > size * 2.3) size = 56;
  y = (await put(serif, size, title, 0xffffffff, X, y, OG_W - X * 2)) - 26;
  const eb = await text(sansB, 17, spaced('Media Library'), 0xffffffff);
  if (eb) { const rule = new Image(44, 2).fill(0xffffffcc); img.composite(rule, X, y - Math.round(eb.height / 2) - 1); img.composite(eb, X + 60, y - eb.height); }
  return await img.encodeJPEG(86);
}
async function ogResponse(token: string, head: boolean) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return err('Not found', 404);
  const q = await fetch(`${SB_URL}/rest/v1/bookings?public_token=eq.${token}&select=id,status,address,unit,city,state,media_title,cover_url,photos_url,photo_files,media_files`, { headers: sbHeaders });
  const b = (await q.json().catch(() => []))?.[0];
  if (!b || b.status === 'cancelled') return err('Not found', 404);
  const g = galleryEntries(b)[0];
  const sig = JSON.stringify([OG_VER, g?.path || g?.url || b.cover_url || b.photos_url || '', b.media_title, b.address, b.unit, b.city, b.state]);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(sig)))).slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
  const key = `${token}/${hash}.jpg`, url = `${SB_URL}/storage/v1/object/share-previews/${key}`;
  const headers = { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' };
  const hit = await fetch(url, { headers: sbHeaders });
  if (hit.ok) return new Response(head ? null : hit.body, { status: 200, headers });
  await hit.body?.cancel();
  const out = await renderOg(b);
  await fetch(url, { method: 'POST', headers: { ...sbHeaders, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }, body: out }).catch(e => console.error('og save', String(e)));
  return new Response(head ? null : out, { status: 200, headers: { ...headers, 'Content-Length': String(out.length) } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET' && req.method !== 'HEAD') return err('Method not allowed', 405);
  const u = new URL(req.url);
  if (u.searchParams.get('og')) { try { return await ogResponse(u.searchParams.get('og')!, req.method === 'HEAD'); } catch (e) { console.error('og error', String((e as Error)?.stack || e)); return err('Preview not available', 500); } }
  const ref = await verify(u.searchParams.get('d') || '', u.searchParams.get('s') || '');
  if (!ref) return err('This download link has expired. Go back to your delivery page and try again.', 403);
  try {
    let up: Response, name = safeName(ref.name || 'file'), type = '';
    if (ref.src === 'dbx') {
      up = await dropboxStream(ref.link!, ref.path || '', ref.v || 'high');
      if (ref.v === 'thumb' || ref.v === 'preview' || ref.v === 'web') { type = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + (ref.v === 'web' ? '-web' : '') + '.jpg'; }
    } else if (ref.src === 'dbxp' && ref.path) { // file (or folder zip) by path in the connected Dropbox
      up = await dropboxPathStream(ref.path, ref.v || 'high');
      if (ref.v === 'thumb' || ref.v === 'preview' || ref.v === 'web') { type = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + (ref.v === 'web' ? '-web' : '') + '.jpg'; }
      if (ref.v === 'zip') { type = 'application/zip'; if (!/\.zip$/i.test(name)) name += '.zip'; }
    } else if (ref.src === 'vimeo') {
      const info = await vimeoInfo(ref.vid!);
      const f = pickPhoneMp4(info?.download);
      if (!f) return err('This video is not available to download yet. Please call 865-855-5669.', 404);
      up = await fetch(f.link); type = 'video/mp4'; name = name.replace(/\.[^.]+$/, '') + '.mp4';
    } else if (ref.src === 'zipb' && ref.bid) { // the whole gallery, in order, with numbered names
      const q = await fetch(`${SB_URL}/rest/v1/bookings?id=eq.${encodeURIComponent(ref.bid)}&select=id,address,unit,photo_files,media_files,paid,require_payment`, { headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY } });
      const b = (await q.json().catch(() => []))?.[0];
      if (!b) return err('That order was not found.', 404);
      if (!b.paid && b.require_payment !== false) return err('Downloads unlock after payment.', 403);
      const addr = galleryAddress(b);
      const files = galleryEntries(b).map((f, i) => ({ name: galleryName(i, f.name, addr), open: () => f.kind === 'dbx' ? dropboxPathStream(f.path!, 'high') : ownFetch(f.url!) }));
      if (!files.length) return err('There are no photos on this order yet.', 404);
      const zname = /\.zip$/i.test(name) ? name : name + '.zip';
      return new Response(req.method === 'HEAD' ? null : zipStream(files), { status: 200, headers: { ...CORS, 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zname.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' } });
    } else if (ref.src === 'url' && /^https:\/\//.test(ref.url || '')) {
      // files uploaded in HQ live in the private "delivery" storage bucket: only this function can read them
      const own = ref.url!.startsWith(`${SB_URL}/storage/v1/object/`);
      up = await fetch(ref.url!, { redirect: 'follow', headers: own ? { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY } : {} });
    } else return err('Bad link');
    if (!up.ok || !up.body) { console.error('media upstream', ref.src, up.status, (await up.text().catch(() => '')).slice(0, 300)); return err('We could not get that file right now. Please try again.', 502); }
    if (ref.wm) { // watermarked preview (never the clean file)
      const out = await watermark(new Uint8Array(await up.arrayBuffer()));
      return new Response(req.method === 'HEAD' ? null : out, { status: 200, headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Content-Length': String(out.length), 'Content-Disposition': 'inline; filename="preview.jpg"', 'Cache-Control': 'private, max-age=3600' } });
    }
    const ext = (name.split('.').pop() || '').toLowerCase();
    const h = new Headers(CORS);
    h.set('Content-Type', type || EXT_TYPE[ext] || up.headers.get('content-type') || 'application/octet-stream');
    const len = up.headers.get('content-length'); if (len) h.set('Content-Length', len);
    h.set('Content-Disposition', `${ref.dl ? 'attachment' : 'inline'}; filename="${name.replace(/"/g, '')}"`);
    h.set('Cache-Control', ref.pub ? 'public, max-age=604800, immutable' : ref.v === 'thumb' || ref.v === 'preview' ? 'private, max-age=3600' : 'private, no-store');
    return new Response(req.method === 'HEAD' ? null : up.body, { status: 200, headers: h });
  } catch (e) {
    console.error('media error', String((e as Error)?.message || e));
    return err('Something went wrong getting that file. Please try again or call 865-855-5669.', 500);
  }
});
