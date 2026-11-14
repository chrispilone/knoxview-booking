// Shared by the `booking` (delivery page) and `media` (file proxy) functions. Keep the two copies identical:
//   supabase/functions/media/lib.ts  ==  supabase/functions/booking/lib.ts
//
// Dropbox: needs DROPBOX_APP_KEY + DROPBOX_APP_SECRET secrets. The refresh token comes from "Connect Dropbox" in HQ
// (stored in app_secrets) or a DROPBOX_REFRESH_TOKEN secret. Works with team spaces (uses the account's root namespace).
// Vimeo:   needs VIMEO_ACCESS_TOKEN (scopes: public, private, video_files) to get MP4 download files.
// Without them the delivery page still works with what it can: folder "download all" links and Vimeo embeds.

const env = (k: string) => (Deno.env.get(k) ?? '').trim();
export const SIGN_KEY = env('MEDIA_SIGNING_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
export const MEDIA_BASE = `${env('SUPABASE_URL')}/functions/v1/media`;

/* ---------- signed links (so downloads work as plain links, no sign-in token in the URL) ---------- */
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function hmac(data: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SIGN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))).slice(0, 32);
}
// v: thumb (640px), preview (1024px, for the photo viewer), web (2048px), high (original). wm: burn in the PREVIEW watermark.
// src dbxp = a file (or, with v=zip, a folder) by its path in the connected Dropbox account.
export type MediaRef = { src: 'dbx' | 'dbxp' | 'vimeo' | 'url'; link?: string; path?: string; vid?: string; url?: string; v?: 'thumb' | 'preview' | 'web' | 'high' | 'zip'; name?: string; dl?: 1; wm?: 1 };
export async function sign(ref: MediaRef, hours = 12) {
  const d = b64u(new TextEncoder().encode(JSON.stringify({ ...ref, exp: Math.floor(Date.now() / 1000) + hours * 3600 })));
  return `${MEDIA_BASE}?d=${d}&s=${await hmac(d)}`;
}
export async function verify(d: string, s: string): Promise<(MediaRef & { exp: number }) | null> {
  if (!d || !s || (await hmac(d)) !== s) return null;
  try { const r = JSON.parse(new TextDecoder().decode(fromB64u(d))); return r.exp > Date.now() / 1000 ? r : null; } catch { return null; }
}

/* ---------- Dropbox ---------- */
let dbxTok: { t: string; exp: number } | null = null;
export const dropboxConfigured = () => !!(env('DROPBOX_ACCESS_TOKEN') || (env('DROPBOX_APP_KEY') && env('DROPBOX_APP_SECRET')));
async function storedRefreshToken() {
  if (env('DROPBOX_REFRESH_TOKEN')) return env('DROPBOX_REFRESH_TOKEN');
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/app_secrets?key=eq.dropbox_refresh_token&select=value`, {
    headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}` } });
  return r.ok ? ((await r.json())[0]?.value ?? null) : null;
}
export function forgetDropboxToken() { dbxTok = null; dbxRoot = undefined; }
export async function dropboxToken() {
  if (dbxTok && dbxTok.exp > Date.now() + 60_000) return dbxTok.t;
  const refresh = await storedRefreshToken();
  if (refresh && env('DROPBOX_APP_KEY') && env('DROPBOX_APP_SECRET')) {
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: env('DROPBOX_APP_KEY'), client_secret: env('DROPBOX_APP_SECRET') }) });
    const j = await r.json(); if (!r.ok) throw new Error('Dropbox sign-in failed: ' + (j.error_description || r.status));
    dbxTok = { t: j.access_token, exp: Date.now() + (j.expires_in ?? 14400) * 1000 }; return dbxTok.t;
  }
  return env('DROPBOX_ACCESS_TOKEN') || null;
}
// Team accounts keep shared folders in the team space: path calls need the account's root namespace.
let dbxRoot: string | null | undefined;
async function pathRoot(tok: string): Promise<Record<string, string>> {
  if (dbxRoot === undefined) {
    const r = await fetch('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST', headers: { Authorization: `Bearer ${tok}` } });
    const j = r.ok ? await r.json() : null;
    dbxRoot = j?.root_info && j.root_info.root_namespace_id !== j.root_info.home_namespace_id ? j.root_info.root_namespace_id : null;
  }
  return dbxRoot ? { 'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', root: dbxRoot }) } : {};
}
export async function dbxApi(endpoint: string, body: unknown) {
  const tok = await dropboxToken(); if (!tok) throw new Error('Dropbox is not connected');
  return fetch('https://api.dropboxapi.com/2/' + endpoint, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(await pathRoot(tok)) }, body: JSON.stringify(body) });
}
// Images in one folder of the connected account (by path), sorted by name.
export async function dropboxFolderImages(path: string): Promise<{ name: string; path: string; size: number }[] | null> {
  let r = await dbxApi('files/list_folder', { path, limit: 2000 });
  if (r.status === 409) return null; // folder doesn't exist (yet)
  const out: { name: string; path: string; size: number }[] = [];
  for (let guard = 0; guard < 10; guard++) {
    if (!r.ok) throw new Error('Dropbox list failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    for (const e of j.entries) if (e['.tag'] === 'file' && /\.(jpe?g|png|heic|webp|tiff?)$/i.test(e.name)) out.push({ name: e.name, path: e.path_display, size: e.size });
    if (!j.has_more) break;
    r = await dbxApi('files/list_folder/continue', { cursor: j.cursor });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}
// Stream a file by path: original, a JPEG rendition, or a whole folder as a zip.
export async function dropboxPathStream(path: string, v: 'thumb' | 'preview' | 'web' | 'high' | 'zip') {
  const tok = await dropboxToken(); if (!tok) throw new Error('Dropbox is not connected');
  const root = await pathRoot(tok), H = { Authorization: `Bearer ${tok}`, ...root };
  if (v === 'high') return fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { ...H, 'Dropbox-API-Arg': JSON.stringify({ path }) } });
  if (v === 'zip') return fetch('https://content.dropboxapi.com/2/files/download_zip', { method: 'POST', headers: { ...H, 'Dropbox-API-Arg': JSON.stringify({ path }) } });
  return fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', { method: 'POST', headers: { ...H,
    'Dropbox-API-Arg': JSON.stringify({ resource: { '.tag': 'path', path }, format: 'jpeg', size: v === 'thumb' ? 'w640h480' : v === 'preview' ? 'w1024h768' : 'w2048h1536', mode: 'bestfit' }) } });
}
export const cleanDropboxLink = (u: string) => u.replace(/([?&])dl=[01]&?/, '$1').replace(/[?&]$/, '');
export const dropboxZip = (u: string) => { const c = cleanDropboxLink(u); return c + (c.includes('?') ? '&' : '?') + 'dl=1'; };
const IMG = /\.(jpe?g|png|heic|webp|tiff?)$/i, VID = /\.(mp4|mov|m4v)$/i, DOC = /\.(pdf)$/i;
export type DbxFile = { name: string; path: string; size: number; kind: 'image' | 'video' | 'doc' | 'other' };
const kindOf = (n: string): DbxFile['kind'] => IMG.test(n) ? 'image' : VID.test(n) ? 'video' : DOC.test(n) ? 'doc' : 'other';
// Files behind a Dropbox shared link (folder or single file). Top level only; sorted by name.
export async function dropboxFiles(link: string): Promise<DbxFile[] | null> {
  const tok = await dropboxToken(); if (!tok) return null;
  const url = cleanDropboxLink(link);
  const api = (path: string, body: unknown) => fetch('https://api.dropboxapi.com/2/' + path, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const meta = await api('sharing/get_shared_link_metadata', { url });
  if (!meta.ok) { console.error('dropbox metadata', meta.status, await meta.text()); return []; }
  const m = await meta.json();
  if (m['.tag'] === 'file') return [{ name: m.name, path: '', size: m.size, kind: kindOf(m.name) }];
  const out: DbxFile[] = [];
  let r = await api('files/list_folder', { path: '', shared_link: { url }, limit: 2000 });
  for (let guard = 0; guard < 10; guard++) {
    if (!r.ok) { console.error('dropbox list', r.status, await r.text()); break; }
    const j = await r.json();
    for (const e of j.entries) if (e['.tag'] === 'file') out.push({ name: e.name, path: '/' + e.name, size: e.size, kind: kindOf(e.name) });
    if (!j.has_more) break;
    r = await api('files/list_folder/continue', { cursor: j.cursor });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}
// Stream one file (or a JPEG rendition) from a shared link.
export async function dropboxStream(link: string, path: string, v: 'thumb' | 'preview' | 'web' | 'high') {
  const tok = await dropboxToken(); if (!tok) throw new Error('Dropbox is not connected');
  const url = cleanDropboxLink(link);
  if (v === 'high') return fetch('https://content.dropboxapi.com/2/sharing/get_shared_link_file', { method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Dropbox-API-Arg': JSON.stringify(path ? { url, path } : { url }) } });
  return fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', { method: 'POST', headers: { Authorization: `Bearer ${tok}`,
    'Dropbox-API-Arg': JSON.stringify({ resource: { '.tag': 'link', url, ...(path ? { path } : {}) }, format: 'jpeg', size: v === 'thumb' ? 'w640h480' : v === 'preview' ? 'w1024h768' : 'w2048h1536', mode: 'bestfit' }) } });
}

/* ---------- Vimeo ---------- */
export const vimeoConfigured = () => !!env('VIMEO_ACCESS_TOKEN');
// vimeo.com/123, vimeo.com/123/abcdef (unlisted), player.vimeo.com/video/123?h=abcdef, vimeo.com/manage/videos/123
export function parseVimeo(u: string) {
  const m = String(u || '').match(/vimeo\.com\/(?:.*?\/)?(?:video\/|videos\/)?(\d{6,})(?:\/([0-9a-f]{6,}))?(?:.*[?&]h=([0-9a-f]+))?/i);
  return m ? { id: m[1], hash: m[2] || m[3] || null } : null;
}
export const vimeoEmbed = (v: { id: string; hash: string | null }) => `https://player.vimeo.com/video/${v.id}?${v.hash ? `h=${v.hash}&` : ''}title=0&byline=0&portrait=0&dnt=1`;
export async function vimeoInfo(id: string) {
  const tok = env('VIMEO_ACCESS_TOKEN'); if (!tok) return null;
  const r = await fetch(`https://api.vimeo.com/videos/${id}?fields=name,duration,width,height,pictures.base_link,download`, { headers: { Authorization: `bearer ${tok}`, Accept: 'application/vnd.vimeo.*+json;version=3.4' } });
  if (!r.ok) { console.error('vimeo', id, r.status); return null; }
  return await r.json();
}
// Best phone-friendly MP4: H.264 up to 1080p (plays and saves everywhere, iPhone camera roll included).
// Skips the original upload ("source", often 4K/ProRes) unless it is the only file.
export function pickPhoneMp4(dl: { quality?: string; rendition?: string; type?: string; width?: number; height?: number; link: string; size?: number }[] = []) {
  const mp4 = dl.filter(f => /mp4/i.test(f.type || 'video/mp4') && f.link);
  const ok = mp4.filter(f => f.quality !== 'source' && Math.min(f.width || 0, f.height || 0) <= 1080).sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
  return ok[0] || mp4.sort((a, b) => (a.size || 0) - (b.size || 0))[0] || null;
}
export const safeName = (s: string) => String(s || 'file').replace(/[^\w .,()&'-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
