import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { sign, dbxApi, dropboxFolderImages, dropboxConfigured, dropboxToken, forgetDropboxToken, dropboxPathStream, parseVimeo, vimeoConfigured, vimeoInfo, pickPhoneMp4, galleryAddress } from './lib.ts';

// Dropbox for HQ (super admins only). Orders get a folder structure in Dropbox when they're completed; the
// "Final Photos" folder is what the client's delivery page shows, in the order set on the order page in HQ.
//   status                         -> { configured, connected, account, settings }
//   auth_url { redirect }          -> { url }   (Connect Dropbox: sends you to Dropbox to allow access)
//   connect { code, redirect }     -> saves the connection (refresh token in app_secrets, never sent to a browser)
//   disconnect
//   create_folders { bookingId }   -> makes <root>/<folder name>/<subfolders> and saves bookings.dropbox_path
//   sync { bookingId }             -> reads <dropbox_path>/<final photos> into the order's gallery (bookings.photo_files): keeps the
//                                     order set in HQ and photos uploaded in HQ, adds new Dropbox photos at the end, skips photos
//                                     removed in HQ (bookings.photo_hidden). Also reads <dropbox_path>/<final floor plans> (images +
//                                     PDFs) into bookings.floorplan_files, minus bookings.floorplan_hidden. Refreshes the cover.
//   gallery { bookingId }          -> every gallery photo and Dropbox floor plan with thumb / view (large) / dl (original) links (expire)
//   cover { bookingId }            -> makes the order's cover (bookings.cover_url) from the first gallery photo
//   video_dl { bookingId, url }    -> a download link for a Vimeo video's phone-friendly MP4 (for "Save to Camera Roll" in HQ)
//   preview_path { bookingId }     -> the folder path this order gets (nothing is created)
// Folder name fill-ins: {year} {quarter} {photographer} {date_dots} {day_seq} {address_slug} {client_lower} + more (see HQ settings).
// Needs secrets DROPBOX_APP_KEY + DROPBOX_APP_SECRET (from the Dropbox app). The lib.ts here is a copy of booking/lib.ts.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const ORIGINS = ['https://hq.knoxview.com', 'http://localhost:8888', 'http://localhost:5173'];
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-hq\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }
const NOT_CONNECTED = "Dropbox isn't connected yet. Connect it in HQ → Bookings → Portal settings → Dropbox.";

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// strip characters Dropbox doesn't allow; keep spacing as written (Spiro folders use two spaces before the client name)
const clean = (s: string) => String(s ?? '').replace(/[\\:*?"<>|]+/g, '').replace(/[\r\n\t]+/g, ' ').trim().replace(/[. ]+$/, '');
const ABBR: Record<string, string> = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', circle: 'cir', court: 'ct', boulevard: 'blvd', place: 'pl',
  trail: 'trl', parkway: 'pkwy', highway: 'hwy', terrace: 'ter', springs: 'spgs', meadows: 'mdws', mountain: 'mountain', north: 'n', south: 's', east: 'e', west: 'w' };
// "2381 Misty Mountain Circle" -> "2381-misty-mountain-cir" (same style as the Spiro folders)
const slug = (s: string) => String(s ?? '').toLowerCase().replace(/[#.,']/g, ' ').split(/[^a-z0-9]+/).filter(Boolean).map(w => ABBR[w] ?? w).join('-');
async function folderPath(set: any, b: any, agent: any) {
  const tz = set.timezone || 'America/New_York';
  const d = new Date(b.shoot_start || b.created_at || Date.now());
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t: string) => p.find(x => x.type === t)?.value || '';
  // order of this shoot among the day's shoots: 01, 02, 03…
  const dayKey = `${g('year')}-${g('month')}-${g('day')}`;
  const { data: sameDay } = await admin.from('bookings').select('id, shoot_start').neq('status', 'cancelled')
    .gte('shoot_start', new Date(d.getTime() - 36 * 3600e3).toISOString()).lte('shoot_start', new Date(d.getTime() + 36 * 3600e3).toISOString()).order('shoot_start');
  const local = (x: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(x));
  const seq = Math.max(1, (sameDay ?? []).filter(x => x.shoot_start && local(x.shoot_start) === dayKey).findIndex(x => x.id === b.id) + 1);
  let photographer = '';
  if (b.photographer_id) photographer = (await admin.from('team_members').select('full_name').eq('id', b.photographer_id).maybeSingle()).data?.full_name || '';
  if (!photographer) photographer = (await admin.from('team_members').select('full_name').eq('role', 'owner').eq('active', true).order('created_at').limit(1).maybeSingle()).data?.full_name || 'Photographer';
  const client = agent?.full_name || b.client_name || '';
  const v: Record<string, string> = { year: g('year'), month: g('month'), day: g('day'), month_name: MONTHS[+g('month') - 1] || '', date: dayKey,
    date_dots: `${g('month')}.${g('day')}.${g('year')}`, quarter: String(Math.ceil(+g('month') / 3)), day_seq: String(seq).padStart(2, '0'),
    address: b.address + (b.unit ? ' ' + b.unit : ''), address_slug: slug(b.address + (b.unit ? ' ' + b.unit : '')), city: b.city || '', zip: b.zip || '',
    order_number: String(b.order_no || b.number || ''), client_name: client, client_lower: client.toLowerCase(), brokerage: agent?.brokerage || '', photographer };
  const name = String(set.dropbox_folder_name || '{address} #{order_number}').split('/').map(seg => clean(seg.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m))).filter(Boolean).join('/');
  const root = '/' + String(set.dropbox_root || '/Knox View Media/Orders').split('/').map(clean).filter(Boolean).join('/');
  return (root === '/' ? '' : root) + '/' + name;
}
// Links for HQ's Media Library: thumb (grid), view (large, for the viewer) and dl (the original file, downloads with its own name)
async function links(f: any) {
  if (f.src === 'upload') {
    const n = f.name || 'photo.jpg';
    return { thumb: await sign({ src: 'url', url: f.preview || f.url, name: n }, 6), view: await sign({ src: 'url', url: f.web || f.url, name: n }, 6), dl: await sign({ src: 'url', url: f.url, name: n, dl: 1 }, 6) };
  }
  const pdf = /\.pdf$/i.test(f.name);
  return { thumb: pdf ? null : await sign({ src: 'dbxp', path: f.path, v: 'thumb', name: f.name }, 6), view: pdf ? null : await sign({ src: 'dbxp', path: f.path, v: 'web', name: f.name }, 6),
    dl: await sign({ src: 'dbxp', path: f.path, v: 'high', name: f.name, dl: 1 }, 6) };
}
async function gallery(b: any) {
  return Promise.all(((b.photo_files as any[]) ?? []).filter(f => f?.name).map(async f => ({ ...f, ...(await links(f)) })));
}
// Floor plans synced from <dropbox_path>/<final floor plans folder>: images get a preview thumbnail, PDFs don't.
const PLAN_RE = /\.(jpe?g|png|webp|pdf)$/i;
async function planGallery(b: any) {
  return Promise.all(((b.floorplan_files as any[]) ?? []).map(async f => ({ ...f, ...(await links(f)) })));
}
// The order's cover = the first gallery photo (640px copy in the public "covers" bucket). Skips the work when it hasn't changed.
async function setCover(b: any, photo_files: any[]) {
  const first = (photo_files ?? []).find(f => f?.name);
  const key = first ? `${first.src === 'upload' ? 'up' : 'dbx'}:${first.path || first.url}` : null;
  if (key === (b.cover_src ?? null) && (key ? !!b.cover_url : true)) return b.cover_url ?? null;
  if (!first) { await admin.from('bookings').update({ cover_url: null, cover_src: null }).eq('id', b.id); return null; }
  let bytes: Uint8Array | null = null;
  try {
    if (first.src === 'upload') {
      const { data } = await admin.storage.from('delivery').download(first.preview_path || first.path);
      if (data) bytes = new Uint8Array(await data.arrayBuffer());
    } else {
      const r = await dropboxPathStream(first.path, 'thumb');
      if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
    }
  } catch (e) { console.error('cover source', String((e as Error)?.message || e)); }
  if (!bytes) return b.cover_url ?? null;
  const path = `${b.id}/${Date.now()}.jpg`;
  const up = await admin.storage.from('covers').upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
  if (up.error) { console.error('cover upload', up.error.message); return b.cover_url ?? null; }
  const { data: old } = await admin.storage.from('covers').list(b.id);
  const stale = (old ?? []).map(o => `${b.id}/${o.name}`).filter(p => p !== path);
  if (stale.length) await admin.storage.from('covers').remove(stale);
  const cover_url = admin.storage.from('covers').getPublicUrl(path).data.publicUrl;
  await admin.from('bookings').update({ cover_url, cover_src: key }).eq('id', b.id);
  return cover_url;
}
// Files in a Dropbox folder (top level) whose names match `re`, sorted by name. null = the folder doesn't exist.
async function folderFiles(path: string, re: RegExp): Promise<{ name: string; path: string; size: number }[] | null> {
  let r = await dbxApi('files/list_folder', { path, limit: 2000 });
  if (r.status === 409) return null;
  const out: { name: string; path: string; size: number }[] = [];
  for (let guard = 0; guard < 10; guard++) {
    if (!r.ok) throw new Error('Dropbox list failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    for (const e of j.entries) if (e['.tag'] === 'file' && re.test(e.name)) out.push({ name: e.name, path: e.path_display, size: e.size });
    if (!j.has_more) break;
    r = await dbxApi('files/list_folder/continue', { cursor: j.cursor });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
    const { data: me } = u?.user ? await admin.from('team_members').select('id, role, active, permissions').eq('id', u.user.id).maybeSingle() : { data: null };
    if (!me?.active || !(me.role === 'owner' || me.permissions?.super_admin === true)) throw new Bad('Only HQ super admins can use Dropbox here.', 403);
    const body = await req.json().catch(() => ({}));
    const { data: set } = await admin.from('booking_settings').select('*').eq('id', 1).single();

    if (body.action === 'status') {
      let connected = false, account: string | null = null;
      if (dropboxConfigured()) {
        try { const r = await dbxApi('users/get_current_account', null); if (r.ok) { const j = await r.json(); connected = true; account = `${j.name?.display_name || ''} (${j.email || ''})`; } } catch (_) { /* not connected */ }
      }
      return json(req, { configured: dropboxConfigured(), connected, account, settings: { root: set.dropbox_root, name: set.dropbox_folder_name, subfolders: set.dropbox_subfolders, final: set.dropbox_final_photos, auto: set.dropbox_auto_create } });
    }
    if (body.action === 'auth_url') {
      if (!env('DROPBOX_APP_KEY')) throw new Bad('Add the DROPBOX_APP_KEY and DROPBOX_APP_SECRET secrets in Supabase first.');
      const q = new URLSearchParams({ client_id: env('DROPBOX_APP_KEY'), response_type: 'code', token_access_type: 'offline', redirect_uri: String(body.redirect || ''), state: 'dbx_' + crypto.randomUUID() });
      return json(req, { url: 'https://www.dropbox.com/oauth2/authorize?' + q });
    }
    if (body.action === 'connect') {
      const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: String(body.code || ''), grant_type: 'authorization_code', redirect_uri: String(body.redirect || ''), client_id: env('DROPBOX_APP_KEY'), client_secret: env('DROPBOX_APP_SECRET') }) });
      const j = await r.json();
      if (!r.ok || !j.refresh_token) throw new Bad('Dropbox did not finish connecting: ' + (j.error_description || j.error || r.status));
      await admin.from('app_secrets').upsert({ key: 'dropbox_refresh_token', value: j.refresh_token, meta: { account_id: j.account_id, connected_by: me.id }, updated_at: new Date().toISOString() });
      forgetDropboxToken();
      return json(req, { ok: true });
    }
    if (body.action === 'disconnect') { await admin.from('app_secrets').delete().eq('key', 'dropbox_refresh_token'); forgetDropboxToken(); return json(req, { ok: true }); }

    const { data: b } = await admin.from('bookings').select('*').eq('id', String(body.bookingId || '')).maybeSingle();
    if (!b) throw new Bad('Order not found', 404);
    const needDbx = async () => { if (!dropboxConfigured() || !(await dropboxToken().catch(() => null))) throw new Bad(NOT_CONNECTED, 409); };

    if (body.action === 'preview_path') {
      const { data: agent } = b.agent_id ? await admin.from('agents').select('full_name, brokerage').eq('id', b.agent_id).maybeSingle() : { data: null };
      return json(req, { path: b.dropbox_path || await folderPath(set, b, agent), existing: !!b.dropbox_path });
    }
    if (body.action === 'create_folders') {
      await needDbx();
      const { data: agent } = b.agent_id ? await admin.from('agents').select('full_name, brokerage').eq('id', b.agent_id).maybeSingle() : { data: null };
      const base = b.dropbox_path && !body.force ? b.dropbox_path : await folderPath(set, b, agent);
      const paths = [base, ...((set.dropbox_subfolders as string[]) ?? []).map(s => clean(s)).filter(Boolean).map(s => `${base}/${s}`)];
      const r = await dbxApi('files/create_folder_batch', { paths, autorename: false, force_async: false });
      if (!r.ok) throw new Bad('Dropbox could not make the folders: ' + (await r.text()).slice(0, 200), 502);
      const j = await r.json();
      const failed = (j.entries ?? []).filter((e: any) => e['.tag'] === 'failure' && !JSON.stringify(e).includes('conflict'));
      if (failed.length) console.error('create_folder_batch', JSON.stringify(failed).slice(0, 500));
      await admin.from('bookings').update({ dropbox_path: base, updated_at: new Date().toISOString() }).eq('id', b.id);
      return json(req, { ok: true, path: base, folders: paths.length, failed: failed.length });
    }
    if (body.action === 'sync') {
      await needDbx();
      if (!b.dropbox_path) throw new Bad("This order doesn't have a Dropbox folder yet. Mark it completed (or tap Create folders) first.");
      const dir = `${b.dropbox_path}/${clean(set.dropbox_final_photos || 'Final Photos')}`;
      const files = await dropboxFolderImages(dir);
      if (files === null) throw new Bad(`There's no "${set.dropbox_final_photos || 'Final Photos'}" folder in ${b.dropbox_path} yet.`, 404);
      // Keep HQ's order and HQ uploads; Dropbox photos deleted from the folder drop off; new ones go at the end (by name),
      // except photos removed in HQ (photo_hidden) and names an HQ upload already replaced.
      const lc = (n: any) => String(n ?? '').toLowerCase();
      const prev = ((b.photo_files as any[]) ?? []).filter(f => f?.name);
      const hidden = new Set(((b.photo_hidden as any[]) ?? []).map(lc));
      const byName = new Map(files.map(f => [lc(f.name), f]));
      const prevNames = new Set(prev.map(f => lc(f.name)));
      const kept = prev.filter(f => f.src === 'upload' || byName.has(lc(f.name))).map(f => f.src === 'upload' ? f : byName.get(lc(f.name))!);
      const added = files.filter(f => !prevNames.has(lc(f.name)) && !hidden.has(lc(f.name)));
      const photo_files = [...kept, ...added];
      const removed = prev.filter(f => f.src !== 'upload').length - kept.filter(f => f.src !== 'upload').length;
      // floor plans: everything in the final floor plans folder (images + PDFs) except ones removed in HQ; a missing folder = none yet
      const planDir = set.dropbox_final_floorplans ? `${b.dropbox_path}/${clean(set.dropbox_final_floorplans)}` : null;
      const planHidden = new Set(((b.floorplan_hidden as any[]) ?? []).map(lc));
      const floorplan_files = planDir ? ((await folderFiles(planDir, PLAN_RE)) ?? []).filter(f => !planHidden.has(lc(f.name))) : ((b.floorplan_files as any[]) ?? []);
      const now = new Date().toISOString();
      await admin.from('bookings').update({ photo_files, floorplan_files, photos_synced_at: now, updated_at: now }).eq('id', b.id);
      const cover_url = await setCover(b, photo_files).catch(e => { console.error('cover', String(e)); return b.cover_url; });
      return json(req, { ok: true, folder: dir, added: added.length, removed, photos: await gallery({ photo_files }),
        planFolder: planDir, floorplans: await planGallery({ floorplan_files }), cover_url, synced_at: now });
    }
    if (body.action === 'cover') return json(req, { cover_url: await setCover(b, (b.photo_files as any[]) ?? []) });
    if (body.action === 'video_dl') {
      const vm = parseVimeo(String(body.url || ''));
      if (!vm) throw new Bad("That isn't a Vimeo video link.");
      if (!vimeoConfigured()) throw new Bad("Vimeo isn't connected, so videos can't be saved from here yet.", 409);
      const info = await vimeoInfo(vm.id);
      if (!pickPhoneMp4(info?.download)) throw new Bad('This video has no downloadable file on Vimeo yet.', 404);
      const label = String(body.label || '').trim(), addr = galleryAddress(b);
      return json(req, { url: await sign({ src: 'vimeo', vid: vm.id, name: `${addr || 'Video'}${label ? ' - ' + label : ''}.mp4`, dl: 1 }, 6), title: info?.name || null });
    }
    if (body.action === 'gallery') return json(req, { photos: await gallery(b), floorplans: await planGallery(b), synced_at: b.photos_synced_at, path: b.dropbox_path });
    throw new Bad('Unknown action');
  } catch (e) {
    const status = e instanceof Bad ? e.status : 500;
    if (!(e instanceof Bad)) console.error('dropbox fn error', String((e as Error)?.message || e));
    return json(req, { error: e instanceof Bad ? e.message : String((e as Error)?.message || 'Something went wrong.') }, status);
  }
});
