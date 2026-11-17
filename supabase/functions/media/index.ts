// Knox View delivery files. Serves photos and videos for the client delivery page from Dropbox and Vimeo.
// Every link is signed by the `booking` function (only for orders the client may download) and expires.
//   GET ?d=<payload>&s=<signature>
//     src dbx:   v=thumb (640px JPEG), web (2048px JPEG), high (original file)
//     src vimeo: phone-friendly MP4 (H.264, up to 1080p) — saves to the iPhone camera roll / Android gallery
//     src dbxp:  a file by its path in the connected Dropbox (thumb/preview/web/high), or a folder as a zip (v=zip)
//     src url:   any direct file link
//     src zipb:  every photo of an order (bid) in the Media Library order, as one zip with numbered names (001-003-<address>.jpg)
// The browser can fetch these (CORS open) to hand files to the share sheet ("Save Video" / "Save Images").
import { verify, dropboxStream, dropboxPathStream, vimeoInfo, pickPhoneMp4, safeName, galleryEntries, galleryName, galleryAddress } from './lib.ts';
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET' && req.method !== 'HEAD') return err('Method not allowed', 405);
  const u = new URL(req.url);
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
