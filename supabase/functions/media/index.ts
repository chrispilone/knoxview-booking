// Knox View delivery files. Serves photos and videos for the client delivery page from Dropbox and Vimeo.
// Every link is signed by the `booking` function (only for orders the client may download) and expires.
//   GET ?d=<payload>&s=<signature>
//     src dbx:   v=thumb (640px JPEG), web (2048px JPEG), high (original file)
//     src vimeo: phone-friendly MP4 (H.264, up to 1080p) — saves to the iPhone camera roll / Android gallery
//     src url:   any direct file link
// The browser can fetch these (CORS open) to hand files to the share sheet ("Save Video" / "Save Images").
import { verify, dropboxStream, vimeoInfo, pickPhoneMp4, safeName } from './lib.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Expose-Headers': 'content-length, content-disposition, content-type' };
const err = (msg: string, status = 400) => new Response(msg, { status, headers: { ...CORS, 'Content-Type': 'text/plain' } });
const EXT_TYPE: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp', pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4' };

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
      if (ref.v === 'thumb' || ref.v === 'web') { type = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + (ref.v === 'web' ? '-web' : '') + '.jpg'; }
    } else if (ref.src === 'vimeo') {
      const info = await vimeoInfo(ref.vid!);
      const f = pickPhoneMp4(info?.download);
      if (!f) return err('This video is not available to download yet. Please call 865-855-5669.', 404);
      up = await fetch(f.link); type = 'video/mp4'; name = name.replace(/\.[^.]+$/, '') + '.mp4';
    } else if (ref.src === 'url' && /^https:\/\//.test(ref.url || '')) {
      up = await fetch(ref.url!, { redirect: 'follow' });
    } else return err('Bad link');
    if (!up.ok || !up.body) { console.error('media upstream', ref.src, up.status, (await up.text().catch(() => '')).slice(0, 300)); return err('We could not get that file right now. Please try again.', 502); }
    const ext = (name.split('.').pop() || '').toLowerCase();
    const h = new Headers(CORS);
    h.set('Content-Type', type || EXT_TYPE[ext] || up.headers.get('content-type') || 'application/octet-stream');
    const len = up.headers.get('content-length'); if (len) h.set('Content-Length', len);
    h.set('Content-Disposition', `${ref.dl || ref.v !== 'thumb' ? 'attachment' : 'inline'}; filename="${name.replace(/"/g, '')}"`);
    h.set('Cache-Control', ref.v === 'thumb' ? 'private, max-age=3600' : 'private, no-store');
    return new Response(req.method === 'HEAD' ? null : up.body, { status: 200, headers: h });
  } catch (e) {
    console.error('media error', String((e as Error)?.message || e));
    return err('Something went wrong getting that file. Please try again or call 865-855-5669.', 500);
  }
});
