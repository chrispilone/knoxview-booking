// Knox View Media Library on Cloudflare R2 (plan: claude/media-library-hosting-plan.md in the HQ project).
// The Media Library is the source of truth for what the client sees; Dropbox is the full archive.
// Only orders with bookings.media_store = 'r2' use it (the test order until Chris approves).
//
// Called by HQ (owner / super admins, with their sign-in) or internally (header x-hq-hook = app_secrets.library_hook).
//   list { bookingId }                 -> items with preview links, jobs, zips, Dropbox folder
//   import_dropbox { bookingId }       -> job: finals (+ floor plans) from Dropbox in three sizes. Re-import adds only new photos,
//                                         updates a photo whose Dropbox file was replaced under the same name, never brings back
//                                         photos removed in HQ and never touches photos added in HQ.
//   spiro_import { bookingId, spiroOrderId? } -> job: mirror what the client sees in Spiro (web quality only) + match report
//   upload_urls { bookingId, files: [{ name, type, size }] } -> new items + presigned PUT links (full, web, thumb; HQ makes the sizes)
//   upload_done { bookingId, ids }     -> checks the files arrived, then a job archives them to Dropbox (<order>/Added in HQ)
//   remove / restore { bookingId, ids } -> hide from the client (Dropbox is never touched) / show again
//   reorder { bookingId, ids }         -> Media Library order (= download names 123-Main-St-01.jpg ...)
//   build_zips { bookingId }           -> job: prebuilt Download All zips (Full Resolution + Web Size) in R2
//   job { jobId }                      -> progress / result
//   delivery_preview { bookingId, locked? } -> exactly what the client download page would get (for checking)
//   enable { bookingId, on }           -> switch an order to the R2 Media Library (owner only)
//   selftest / cors                    -> R2 connection check / set the bucket's browser access rules (owner or hook)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { dbxApi, dropboxPathStream, dropboxUpload, dropboxConfigured } from './lib.ts';
import * as R2 from './r2.ts';
import { r2Delivery, visible, photoName, fullExt, addrSlug } from './delivery.ts';

const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const SB_URL = env('SUPABASE_URL').replace(/\/$/, '');
const admin = createClient(SB_URL, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const SELF = `${SB_URL}/functions/v1/library`;
const ORIGINS = ['https://hq.knoxview.com', 'https://knoxview-hq.netlify.app', 'http://localhost:8888', 'http://localhost:5173'];
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-hq\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hq-hook', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }
const now = () => new Date().toISOString();
const lc = (s: any) => String(s ?? '').toLowerCase();
const clean = (s: string) => String(s ?? '').replace(/[\\:*?"<>|]+/g, '').replace(/[\r\n\t]+/g, ' ').trim().replace(/[. ]+$/, '');
const IMG = /\.(jpe?g|png|heic|webp|tiff?)$/i, PLAN = /\.(jpe?g|png|webp|pdf)$/i;
const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', pdf: 'application/pdf' };
const typeOf = (n: string) => TYPES[(String(n).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()] || 'application/octet-stream';
const keyFor = (bid: string, id: string, size: 'full' | 'web' | 'thumb', ext = 'jpg') => `orders/${bid}/${id}/${size}.${ext}`;
const BUDGET_MS = 90_000; // work per invocation before handing over to the next one

// JPEG / PNG pixel size from the header (no decoding)
function pixelSize(b: Uint8Array): { w: number; h: number } | null {
  if (b[0] === 0x89 && b[1] === 0x50) { const v = new DataView(b.buffer, b.byteOffset); return { w: v.getUint32(16), h: v.getUint32(20) }; }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  return null;
}
async function fetchBytes(r: Response, what: string) {
  if (!r.ok) throw new Error(`${what}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return new Uint8Array(await r.arrayBuffer());
}

/* ---------- auth ---------- */
let HOOK: string | null = null;
async function hookSecret() {
  if (HOOK !== null) return HOOK;
  const { data } = await admin.from('app_secrets').select('value').eq('key', 'library_hook').maybeSingle();
  return (HOOK = data?.value || '');
}
async function caller(req: Request) {
  const hook = req.headers.get('x-hq-hook') || '';
  if (hook && hook === (await hookSecret())) return { internal: true, id: null as string | null, owner: true };
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
  const { data: me } = u?.user ? await admin.from('team_members').select('id, role, active, permissions').eq('id', u.user.id).maybeSingle() : { data: null };
  if (!me?.active || !(me.role === 'owner' || me.permissions?.super_admin === true)) throw new Bad('Only HQ super admins can change the Media Library.', 403);
  return { internal: false, id: me.id as string, owner: me.role === 'owner' };
}

/* ---------- data ---------- */
const BCOLS = 'id, number, status, address, unit, city, state, paid, require_payment, invoice, dropbox_path, dropbox_photos_dir, dropbox_plans_dir, spiro_order_id, media_store, videos, tour_url, public_token, agent_id';
async function booking(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new Bad('Which order?');
  const { data } = await admin.from('bookings').select(BCOLS).eq('id', id).maybeSingle();
  if (!data) throw new Bad('Order not found.', 404);
  return data;
}
async function itemsOf(bid: string) {
  const { data, error } = await admin.from('media_items').select('*').eq('booking_id', bid).order('kind').order('position').order('created_at');
  if (error) throw new Error(error.message);
  return data ?? [];
}
const needR2 = (b: any) => { if (b.media_store !== 'r2') throw new Bad('This order is not on the new Media Library yet.', 409); };
const locked = (b: any) => !b.paid && b.require_payment !== false;

/* ---------- jobs (run in the background, one slice per invocation, handing over to the next) ---------- */
function kick(jobId: string) {
  const p = hookSecret().then(h => fetch(SELF, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hq-hook': h }, body: JSON.stringify({ action: 'run', jobId }) }))
    .then(r => r.body?.cancel()).catch(e => console.error('kick', String(e)));
  // @ts-ignore EdgeRuntime is provided by Supabase
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p);
  return p;
}
async function newJob(bid: string, kind: string, state: any, total: number, by: string | null) {
  const { data, error } = await admin.from('media_jobs').insert({ booking_id: bid, kind, state, total, created_by: by }).select('id').single();
  if (error) throw new Error(error.message);
  kick(data.id);
  return data.id as string;
}
async function saveJob(id: string, patch: any) { await admin.from('media_jobs').update({ ...patch, updated_at: now() }).eq('id', id); }
// zips: one queued/running job per order is enough (it re-checks the fingerprint when it finishes)
async function queueZips(bid: string, by: string | null = null) {
  const { data: open } = await admin.from('media_jobs').select('id, status, state').eq('booking_id', bid).eq('kind', 'zip').in('status', ['queued', 'running']).limit(1);
  if (open?.length) { await saveJob(open[0].id, { state: { ...open[0].state, again: true } }); return open[0].id; }
  return newJob(bid, 'zip', {}, 0, by);
}

async function runJob(jobId: string) {
  const { data: job } = await admin.from('media_jobs').select('*').eq('id', jobId).maybeSingle();
  if (!job || job.status === 'done' || job.status === 'failed') return;
  // a slice already running (two kicks) — let it be
  if (job.status === 'running' && Date.now() - new Date(job.updated_at).getTime() < 150_000 && !job.state?.handover) return;
  await saveJob(jobId, { status: 'running', state: { ...job.state, handover: false } });
  const t0 = Date.now(), more = () => Date.now() - t0 < BUDGET_MS;
  try {
    const b = await booking(job.booking_id);
    let finished = false;
    if (job.kind === 'dropbox_import') finished = await stepDropbox(job, b, more);
    else if (job.kind === 'spiro_import') finished = await stepSpiro(job, b, more);
    else if (job.kind === 'archive') finished = await stepArchive(job, b, more);
    else if (job.kind === 'zip') finished = await stepZip(job, b, more);
    if (finished) {
      await saveJob(jobId, { status: 'done', done: job.total || job.done, state: job.state, report: job.report ?? null });
      if (job.kind !== 'zip') await queueZips(b.id);
      else if (job.state?.again) await queueZips(b.id);
    } else { await saveJob(jobId, { done: job.done, state: { ...job.state, handover: true }, report: job.report ?? null }); await kick(jobId); } // kick returns as soon as the next slice has started
  } catch (e) {
    console.error('job', job.kind, jobId, String((e as Error)?.stack || e));
    await saveJob(jobId, { status: 'failed', error: String((e as Error)?.message || e).slice(0, 500), state: job.state, done: job.done });
  }
}

/* ---------- Dropbox import ---------- */
async function dbxList(path: string) {
  let r = await dbxApi('files/list_folder', { path, limit: 2000 });
  if (r.status === 409) { await r.body?.cancel(); return null; }
  const out: { name: string; path: string; size: number; hash: string }[] = [];
  for (let g = 0; g < 20; g++) {
    if (!r.ok) throw new Error('Dropbox list failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    for (const e of j.entries) if (e['.tag'] === 'file') out.push({ name: e.name, path: e.path_display, size: e.size, hash: e.content_hash });
    if (!j.has_more) break;
    r = await dbxApi('files/list_folder/continue', { cursor: j.cursor });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}
async function planDropbox(b: any) {
  if (!dropboxConfigured()) throw new Bad("Dropbox isn't connected.", 409);
  if (!b.dropbox_path) throw new Bad("This order doesn't have a Dropbox folder yet.");
  const { data: set } = await admin.from('booking_settings').select('dropbox_final_photos, dropbox_final_floorplans').eq('id', 1).single();
  const photoDir = `${b.dropbox_path}/${b.dropbox_photos_dir || clean(set?.dropbox_final_photos || '04-Final-Photos')}`;
  const planDir = `${b.dropbox_path}/${b.dropbox_plans_dir || clean(set?.dropbox_final_floorplans || '06-Final-FloorPlan')}`;
  const finals = await dbxList(photoDir);
  if (finals === null) throw new Bad(`There's no final photo folder (${photoDir.split('/').pop()}) in this order's Dropbox folder yet.`, 404);
  const plans = (await dbxList(planDir)) ?? [];
  const have = await itemsOf(b.id);
  const mine = new Map(have.filter(i => i.source === 'dropbox').map(i => [`${i.kind}:${lc(i.name)}`, i]));
  const work: any[] = [], counts = { new: 0, replaced: 0, unchanged: 0, removedInHq: 0, goneFromDropbox: 0 };
  const consider = (f: any, kind: string) => {
    const it = mine.get(`${kind}:${lc(f.name)}`);
    if (!it) { counts.new++; work.push({ kind, name: f.name, path: f.path, size: f.size, hash: f.hash }); return; }
    if (it.hidden) { counts.removedInHq++; return; }               // removed in HQ: never comes back
    if (it.dropbox_rev && it.dropbox_rev !== f.hash) { counts.replaced++; work.push({ kind, name: f.name, path: f.path, size: f.size, hash: f.hash, id: it.id }); return; }
    counts.unchanged++;
  };
  finals.filter(f => IMG.test(f.name)).forEach(f => consider(f, 'photo'));
  plans.filter(f => PLAN.test(f.name)).forEach(f => consider(f, /\.pdf$/i.test(f.name) ? 'file' : 'floorplan'));
  const inDbx = new Set([...finals, ...plans].map(f => lc(f.name)));
  counts.goneFromDropbox = have.filter(i => i.source === 'dropbox' && !i.hidden && !inDbx.has(lc(i.name))).length; // kept in HQ
  return { work, counts, photoDir, planDir };
}
async function stepDropbox(job: any, b: any, more: () => boolean) {
  const st = job.state; st.i ??= 0;
  const have = await itemsOf(b.id);
  const maxPos: Record<string, number> = {};
  for (const i of have) maxPos[i.kind] = Math.max(maxPos[i.kind] ?? -1, i.position);
  const one = async (w: any, pos: number | null) => {
    const id = w.id || crypto.randomUUID(), ext = fullExt(w);
    const full = await fetchBytes(await dropboxPathStream(w.path, 'high'), 'Dropbox download ' + w.name);
    const row: any = { id, booking_id: b.id, kind: w.kind, name: w.name, source: 'dropbox', dropbox_path: w.path, dropbox_rev: w.hash,
      key_full: keyFor(b.id, id, 'full', ext), size_full: full.length, crc_full: R2.crc32(full), type_full: typeOf(w.name), updated_at: now() };
    // Dropbox makes the web size and the preview (free, no resizing here); fetched while the original uploads
    const webP = w.kind === 'photo' ? dropboxPathStream(w.path, 'web').then(r => fetchBytes(r, 'Dropbox web size ' + w.name)) : null;
    const thP = w.kind !== 'file' ? dropboxPathStream(w.path, 'thumb').then(r => fetchBytes(r, 'Dropbox preview ' + w.name)) : null;
    const px = w.kind !== 'file' ? pixelSize(full) : null; if (px) { row.width = px.w; row.height = px.h; }
    await R2.put(row.key_full, full, row.type_full);
    if (webP) { const web = await webP; row.key_web = keyFor(b.id, id, 'web'); row.size_web = web.length; row.crc_web = R2.crc32(web); await R2.put(row.key_web, web, 'image/jpeg'); }
    if (thP) { const th = await thP; row.key_thumb = keyFor(b.id, id, 'thumb'); row.size_thumb = th.length; await R2.put(row.key_thumb, th, 'image/jpeg'); }
    if (pos !== null) row.position = pos;
    const { error } = await admin.from('media_items').upsert(row);
    if (error) throw new Error(error.message);
  };
  const PAR = 4; // photos at a time
  while (st.i < st.work.length && more()) {
    const batch = st.work.slice(st.i, st.i + PAR);
    await Promise.all(batch.map((w: any) => one(w, w.id ? null : (maxPos[w.kind] = (maxPos[w.kind] ?? -1) + 1))));
    st.i += batch.length; job.done = st.i;
    await saveJob(job.id, { done: st.i }); // progress for HQ
  }
  return st.i >= st.work.length;
}

/* ---------- HQ uploads: archive to Dropbox (<order>/Added in HQ), record checksums for the zips ---------- */
async function stepArchive(job: any, b: any, more: () => boolean) {
  const st = job.state; st.i ??= 0;
  while (st.i < st.ids.length && more()) {
    const { data: it } = await admin.from('media_items').select('*').eq('id', st.ids[st.i]).maybeSingle();
    st.i++; job.done = st.i;
    if (!it) continue;
    const patch: any = { updated_at: now() };
    try {
      const full = await fetchBytes(await R2.get(it.key_full), 'R2 read');
      patch.size_full = full.length; patch.crc_full = R2.crc32(full);
      const px = pixelSize(full); if (px) { patch.width = px.w; patch.height = px.h; }
      if (it.key_web) { const web = await fetchBytes(await R2.get(it.key_web), 'R2 read web'); patch.size_web = web.length; patch.crc_web = R2.crc32(web); }
      if (!b.dropbox_path) { patch.archive_status = 'failed'; patch.archive_error = "The order has no Dropbox folder yet."; }
      else {
        const sub = it.edit_type === 'Virtual Staging' ? 'Virtual Staging' : it.edit_type === 'Virtual Twilight' ? 'Virtual Twilight' : it.edit_type ? 'Other Edits' : 'Added in HQ';
        const path = `${b.dropbox_path}/${sub}/${clean(it.name)}`;
        const up = await dropboxUpload(path, full);
        if (up.ok) { const j = await up.json(); patch.archive_status = 'archived'; patch.archive_error = null; patch.dropbox_path = j.path_display || path; }
        else { patch.archive_status = 'failed'; patch.archive_error = `Dropbox ${up.status}: ${(await up.text()).slice(0, 160)}`; }
      }
    } catch (e) { patch.archive_status = 'failed'; patch.archive_error = String((e as Error)?.message || e).slice(0, 300); }
    await admin.from('media_items').update(patch).eq('id', it.id);
  }
  return st.i >= st.ids.length;
}

/* ---------- Spiro mirror (web quality only) ---------- */
const SPIRO_API = 'https://api.spiro.media/api/v1';
async function spiro(path: string): Promise<any> {
  const key = env('SPIRO_API_KEY'); if (!key) throw new Bad("Spiro isn't connected (SPIRO_API_KEY is missing).", 409);
  for (let t = 0; t < 3; t++) {
    const r = await fetch(SPIRO_API + path, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
    if (r.status === 429) { await r.body?.cancel(); await new Promise(res => setTimeout(res, 15000 * (t + 1))); continue; }
    if (r.status === 404) { await r.body?.cancel(); return null; }
    const txt = await r.text();
    if (!r.ok) throw new Error(`Spiro said ${r.status} for ${path.split('?')[0]}: ${txt.split(key).join('[key]').slice(0, 160)}`);
    return txt ? JSON.parse(txt) : null;
  }
  throw new Error('Spiro is rate-limiting us. Try again in a minute.');
}
async function spiroAll(path: string) {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const j = await spiro(`${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=100`);
    out.push(...(j?.data ?? []));
    if (!j?.meta?.hasNextPage) break;
  }
  return out;
}
async function planSpiro(b: any, spiroId: string) {
  const base = `/orders/${spiroId}`;
  const o = (await spiro(base))?.data; if (!o) throw new Bad('That order is not in Spiro.', 404);
  const photos = (await spiroAll(base + '/media/photos')).sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
  const plans = ((await spiro(base + '/media/floor-plans'))?.data ?? []).sort((x: any, y: any) => (x.position ?? 0) - (y.position ?? 0));
  const files = ((await spiro(base + '/media/downloadable-files'))?.data ?? []).sort((x: any, y: any) => (x.position ?? 0) - (y.position ?? 0));
  const videos = (await spiro(base + '/media/videos'))?.data ?? [];
  const tours = (await spiro(base + '/media/virtual-tours'))?.data ?? [];
  const have = new Set((await itemsOf(b.id)).filter(i => i.spiro_media_id).map(i => `${i.kind}:${i.spiro_media_id}`));
  const work: any[] = [];
  photos.forEach((p: any, i: number) => { const web = p.image?.webUrl || p.image?.defaultUrl; if (web && !have.has(`photo:${p.mediaId}`)) work.push({ kind: 'photo', sid: String(p.mediaId), name: p.name, pos: i, hidden: p.displayPageActive === false, web, thumb: p.image?.thumbnailUrl || null }); });
  plans.forEach((p: any, i: number) => { if (p.downloadUrl && !have.has(`floorplan:${p.mediaId}`)) work.push({ kind: 'floorplan', sid: String(p.mediaId), name: p.name, pos: i, hidden: p.displayPageActive === false, full: p.downloadUrl }); });
  files.forEach((p: any, i: number) => { if (p.downloadUrl && !have.has(`file:${p.mediaId}`)) work.push({ kind: 'file', sid: String(p.mediaId), name: p.name, pos: i, hidden: p.displayPageActive === false, full: p.downloadUrl }); });
  const vids = videos.filter((v: any) => v.displayPageActive !== false);
  const tourUrls = tours.map((t: any) => t.url || t.brandedUrl || t.tourUrl || t.unbrandedUrl).filter(Boolean);
  const spiroCounts = {
    photos: photos.length, photosShown: photos.filter((p: any) => p.displayPageActive !== false).length, photosHidden: photos.filter((p: any) => p.displayPageActive === false).length,
    floorplans: plans.filter((p: any) => p.displayPageActive !== false).length, files: files.filter((p: any) => p.displayPageActive !== false).length,
    videos: vids.length, tours: tourUrls.length, fullResolutionLinks: photos.filter((p: any) => p.image?.highResolutionUrl).length,
  };
  return { work, spiroCounts, vids, tourUrls, code: o.trackingCode || null };
}
async function stepSpiro(job: any, b: any, more: () => boolean) {
  const st = job.state; st.i ??= 0; st.px ??= [];
  while (st.i < st.work.length && more()) {
    const w = st.work[st.i], id = crypto.randomUUID();
    const row: any = { id, booking_id: b.id, kind: w.kind, name: w.name, source: 'spiro', spiro_media_id: w.sid, position: w.pos, hidden: !!w.hidden, updated_at: now() };
    if (w.kind === 'photo') {
      const web = await fetchBytes(await fetch(w.web), 'Spiro web photo ' + w.name);
      row.key_web = keyFor(b.id, id, 'web'); row.size_web = web.length; row.crc_web = R2.crc32(web);
      const px = pixelSize(web); if (px) { row.width = px.w; row.height = px.h; st.px.push([px.w, px.h, web.length]); }
      await R2.put(row.key_web, web, 'image/jpeg');
      if (w.thumb) { const th = await fetchBytes(await fetch(w.thumb), 'Spiro thumbnail ' + w.name); row.key_thumb = keyFor(b.id, id, 'thumb'); row.size_thumb = th.length; await R2.put(row.key_thumb, th, 'image/jpeg'); }
    } else {
      const ext = fullExt(w), full = await fetchBytes(await fetch(w.full), 'Spiro file ' + w.name);
      row.key_full = keyFor(b.id, id, 'full', ext); row.size_full = full.length; row.crc_full = R2.crc32(full); row.type_full = typeOf(w.name);
      const px = pixelSize(full); if (px) { row.width = px.w; row.height = px.h; }
      await R2.put(row.key_full, full, row.type_full);
    }
    const { error } = await admin.from('media_items').upsert(row);
    if (error) throw new Error(error.message);
    st.i++; job.done = st.i;
  }
  if (st.i < st.work.length) return false;
  // videos and tour: links only (videos stay on Vimeo, tours where they're hosted). Filled in only if the order has none yet.
  const patch: any = {};
  // same shape as the Spiro order import in the dropbox function: a Branded and an Unbranded link per video
  const vim = (u: string) => u.split('?')[0].replace('player.vimeo.com/video/', 'vimeo.com/');
  const spiroVids = (st.vids ?? []).flatMap((v: any) => [v.brandedUrl && { url: vim(v.brandedUrl), label: 'Branded' }, v.unbrandedUrl && { url: vim(v.unbrandedUrl), label: 'Unbranded' }]).filter(Boolean);
  if (!((b.videos as any[]) ?? []).length && spiroVids.length) patch.videos = spiroVids;
  if (!b.tour_url && st.tourUrls?.length) patch.tour_url = st.tourUrls[0];
  if (Object.keys(patch).length) { await admin.from('bookings').update({ ...patch, updated_at: now() }).eq('id', b.id); Object.assign(b, patch); }
  // match report: Spiro vs HQ
  const items = (await itemsOf(b.id)).filter(i => i.source === 'spiro');
  const hq = {
    photos: items.filter(i => i.kind === 'photo').length, photosShown: items.filter(i => i.kind === 'photo' && !i.hidden).length, photosHidden: items.filter(i => i.kind === 'photo' && i.hidden).length,
    floorplans: items.filter(i => i.kind === 'floorplan' && !i.hidden).length, files: items.filter(i => i.kind === 'file' && !i.hidden).length,
    // videos: each Spiro video whose link is on the order (branded, or unbranded when that's all it has)
    videos: (st.vids ?? []).filter((v: any) => ((b.videos as any[]) ?? []).some((x: any) => x?.url && [v.brandedUrl, v.unbrandedUrl].filter(Boolean).map(vim).includes(x.url))).length,
    tours: b.tour_url ? 1 : 0,
  };
  const sp = st.spiroCounts, keys = ['photos', 'photosShown', 'photosHidden', 'floorplans', 'files', 'videos', 'tours'];
  const px = st.px as number[][], avg = (a: number[]) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  job.report = { spiroOrder: st.code, rows: keys.map(k => ({ what: k, spiro: sp[k], hq: (hq as any)[k], match: sp[k] === (hq as any)[k] })),
    exact: keys.every(k => sp[k] === (hq as any)[k]), spiroFullResolutionLinks: sp.fullResolutionLinks,
    webPhotos: px.length ? { longSideMin: Math.min(...px.map(p => Math.max(p[0], p[1]))), longSideMax: Math.max(...px.map(p => Math.max(p[0], p[1]))),
      avgKB: Math.round((avg(px.map(p => p[2])) ?? 0) / 1024), maxKB: Math.round(Math.max(...px.map(p => p[2])) / 1024) } : null };
  st.px = px.length > 200 ? px.slice(0, 200) : px;
  return true;
}

/* ---------- Download All zips (prebuilt in R2; stored, not compressed: photos don't shrink) ---------- */
async function zipSig(b: any, items: any[], v: 'full' | 'web') {
  const ph = visible(items, 'photo');
  if (!ph.length) return null;
  const k = (it: any) => v === 'full' ? it.key_full : it.key_web;
  if (v === 'full' && !ph.some(it => it.key_full)) return null; // e.g. Spiro mirror: Web Size only
  const parts = ph.map(it => `${it.id}:${k(it) || it.key_web}:${v === 'full' && it.key_full ? it.crc_full : it.crc_web}`);
  const s = JSON.stringify([v, addrSlug(b), parts]);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].slice(0, 10).map(x => x.toString(16).padStart(2, '0')).join('');
}
function zipEntries(b: any, items: any[], v: 'full' | 'web') {
  const ph = visible(items, 'photo');
  return ph.map((it, i) => { const full = v === 'full' && it.key_full;
    return { name: photoName(b, i, ph.length, full ? fullExt(it) : 'jpg'), key: full ? it.key_full : it.key_web, size: full ? it.size_full : it.size_web, crc: full ? it.crc_full : it.crc_web }; });
}
const PART = 8 * 1024 * 1024;
async function stepZip(job: any, b: any, more: () => boolean) {
  const st = job.state;
  const items = await itemsOf(b.id);
  if (!st.v) { // pick the next variant that's out of date
    const { data: zs } = await admin.from('media_zips').select('*').eq('booking_id', b.id);
    st.todo = [];
    for (const v of ['full', 'web'] as const) {
      const sig = await zipSig(b, items, v); const row = (zs ?? []).find(z => z.variant === v);
      if (!sig) { if (row) { await R2.del(row.key); await admin.from('media_zips').delete().eq('booking_id', b.id).eq('variant', v); } continue; }
      if (row?.sig !== sig) st.todo.push({ v, sig });
    }
    if (!st.todo.length) return true;
    const t = st.todo.shift(); st.v = t.v; st.sig = t.sig;
    st.entries = zipEntries(b, items, st.v);
    if (st.entries.some((e: any) => e.size == null || e.crc == null || !e.key)) { st.v = null; st.wait = (st.wait || 0) + 1; return st.wait > 20; } // uploads still being checked
    st.key = `orders/${b.id}/zips/${st.v}-${st.sig}.zip`; st.uploadId = await R2.mpStart(st.key); st.etags = []; st.i = 0; st.offset = 0; st.central = [];
    job.total = st.entries.length * 2; job.done = 0;
  }
  const enc = new TextEncoder(), d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let buf: Uint8Array[] = [], bufLen = 0;
  const push = (x: Uint8Array) => { buf.push(x); bufLen += x.length; st.offset += x.length; };
  const flush = async (force = false) => {
    while (bufLen >= PART || (force && bufLen > 0)) {
      const all = new Uint8Array(bufLen); let o = 0; for (const x of buf) { all.set(x, o); o += x.length; }
      const n = force ? all.length : PART, part = all.subarray(0, n);
      st.etags.push(await R2.mpPart(st.key, st.uploadId, st.etags.length + 1, part));
      buf = n < all.length ? [all.slice(n)] : []; bufLen = all.length - n;
    }
  };
  try {
    // keep going until the time is up AND the buffer has been flushed (parts must be >= 5 MB, except the last)
    while (st.i < st.entries.length && (more() || bufLen > 0)) {
      const e = st.entries[st.i], name = enc.encode(e.name), start = st.offset;
      if (start + 30 + name.length + e.size > 0xfffffff0) throw new Error('This order is over 4 GB, too big for one zip.');
      const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, e.crc, true); lv.setUint32(18, e.size, true); lv.setUint32(22, e.size, true);
      lv.setUint16(26, name.length, true); lh.set(name, 30);
      push(lh);
      const data = await fetchBytes(await R2.get(e.key), 'R2 read ' + e.name);
      if (data.length !== e.size) throw new Error(`Size changed for ${e.name}; run the zip again.`);
      push(data);
      st.central.push({ n: e.name, crc: e.crc, size: e.size, off: start });
      st.i++; job.done = st.i;
      await flush();
      if (!more() && bufLen >= 5 * 1024 * 1024) await flush(true);
    }
    if (st.i < st.entries.length) { if (bufLen) await flush(true); return false; }
    // central directory + end record, then the last part
    const cdStart = st.offset;
    for (const c of st.central) {
      const name = enc.encode(c.n), h = new Uint8Array(46 + name.length), v = new DataView(h.buffer);
      v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x0800, true); v.setUint16(10, 0, true);
      v.setUint16(12, time, true); v.setUint16(14, date, true); v.setUint32(16, c.crc, true); v.setUint32(20, c.size, true); v.setUint32(24, c.size, true);
      v.setUint16(28, name.length, true); v.setUint32(42, c.off, true); h.set(name, 46); push(h);
    }
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, st.central.length, true); ev.setUint16(10, st.central.length, true);
    ev.setUint32(12, st.offset - cdStart, true); ev.setUint32(16, cdStart, true); push(end);
    await flush(true);
    await R2.mpDone(st.key, st.uploadId, st.etags);
  } catch (e) { if (st.uploadId) await R2.mpAbort(st.key, st.uploadId).catch(() => {}); st.v = null; throw e; }
  const { data: old } = await admin.from('media_zips').select('key').eq('booking_id', b.id).eq('variant', st.v).maybeSingle();
  await admin.from('media_zips').upsert({ booking_id: b.id, variant: st.v, sig: st.sig, key: st.key, size: st.offset, count: st.central.length, built_at: now() });
  if (old?.key && old.key !== st.key) await R2.del(old.key);
  st.v = null; st.entries = null; st.central = null; st.etags = null; st.uploadId = null;
  return false; // next variant (or done) on the next slice
}

/* ---------- HQ view ---------- */
async function listFor(b: any) {
  const items = await itemsOf(b.id);
  const s = 3 * 3600;
  const out = await Promise.all(items.map(async it => ({
    id: it.id, kind: it.kind, position: it.position, name: it.name, source: it.source, hidden: it.hidden, edit_type: it.edit_type,
    width: it.width, height: it.height, size_full: it.size_full, size_web: it.size_web, archive: it.archive_status, archive_error: it.archive_error, dropbox_path: it.dropbox_path,
    thumb: it.key_thumb || it.key_web ? await R2.presign('GET', it.key_thumb || it.key_web, s) : null,
    web: it.key_web ? await R2.presign('GET', it.key_web, s) : null,
    full: it.key_full ? await R2.presign('GET', it.key_full, s) : null,
  })));
  const { data: jobs } = await admin.from('media_jobs').select('id, kind, status, total, done, error, report, created_at, updated_at').eq('booking_id', b.id).order('created_at', { ascending: false }).limit(10);
  const { data: zips } = await admin.from('media_zips').select('variant, size, count, built_at, sig').eq('booking_id', b.id);
  const cur = { full: await zipSig(b, items, 'full'), web: await zipSig(b, items, 'web') };
  return { items: out, jobs, zips: (zips ?? []).map(z => ({ ...z, current: z.sig === (cur as any)[z.variant] })), media_store: b.media_store, dropbox_path: b.dropbox_path, locked: locked(b) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    if (!R2.r2Configured()) throw new Bad('R2 is not set up (R2_* secrets are missing).', 503);
    const body = await req.json().catch(() => ({}));
    const me = await caller(req);
    const a = String(body.action || '');

    if (a === 'run') { // answer at once and work in the background, so slices never wait on each other
      if (!me.internal) throw new Bad('Internal only.', 403);
      const p = runJob(String(body.jobId));
      // @ts-ignore EdgeRuntime is provided by Supabase
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p); else await p;
      return json(req, { ok: true });
    }
    if (a === 'selftest') {
      const key = `selftest/${crypto.randomUUID()}.txt`, txt = 'knox view r2 ' + now();
      await R2.put(key, new TextEncoder().encode(txt), 'text/plain');
      const back = await (await R2.get(key)).text();
      const signed = await fetch(await R2.presign('GET', key, 60)); const signedText = await signed.text();
      const unsigned = await fetch(`https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/${env('R2_BUCKET')}/${key}`); await unsigned.body?.cancel();
      const dl = await fetch(await R2.downloadUrl(key, '123-Main-St-01.txt', 60)); await dl.body?.cancel();
      // multipart round trip with two parts (5 MB + small) to prove zips can be built
      const mk = `selftest/${crypto.randomUUID()}.bin`, up = await R2.mpStart(mk, 'application/octet-stream');
      const e1 = await R2.mpPart(mk, up, 1, new Uint8Array(5 * 1024 * 1024)), e2 = await R2.mpPart(mk, up, 2, new Uint8Array(10));
      await R2.mpDone(mk, up, [e1, e2]); const mh = await R2.head(mk);
      await R2.del(key); await R2.del(mk);
      const gone = await R2.head(key);
      return json(req, { writeRead: back === txt, signedGet: signed.ok && signedText === txt, unsignedBlocked: !unsigned.ok, unsignedStatus: unsigned.status,
        downloadName: dl.headers.get('content-disposition'), multipartSize: mh?.size, deleted: !gone, cors: await R2.getCors() });
    }
    if (a === 'dbx_list' || a === 'dbx_copy') { // internal test helpers: list a Dropbox folder / copy files into a test order's folders
      if (!me.internal) throw new Bad('Internal only.', 403);
      if (a === 'dbx_list') return json(req, { files: await dbxList(String(body.path || '')) });
      const dirs = ((body.dirs as string[]) ?? []).map(String);
      if (dirs.length) { const r = await dbxApi('files/create_folder_batch', { paths: dirs, autorename: false, force_async: false }); await r.body?.cancel(); }
      const entries = ((body.copies as any[]) ?? []).map(c => ({ from_path: String(c.from), to_path: String(c.to) }));
      if (!entries.length) return json(req, { ok: true });
      const r = await dbxApi('files/copy_batch_v2', { entries, autorename: false });
      return json(req, await r.json());
    }
    if (a === 'cors') { if (!me.owner) throw new Bad('Owner only.', 403); return json(req, { set: await R2.setCors(ORIGINS.filter(o => o.startsWith('https'))), now: await R2.getCors() }); }
    if (a === 'job') {
      const { data } = await admin.from('media_jobs').select('id, booking_id, kind, status, total, done, error, report, created_at, updated_at').eq('id', String(body.jobId || '')).maybeSingle();
      if (!data) throw new Bad('Job not found.', 404);
      return json(req, data);
    }

    const b = await booking(body.bookingId);
    if (a === 'enable') {
      if (!me.owner) throw new Bad('Only the owner can switch an order to the new Media Library.', 403);
      await admin.from('bookings').update({ media_store: body.on === false ? null : 'r2', updated_at: now() }).eq('id', b.id);
      return json(req, { ok: true, media_store: body.on === false ? null : 'r2' });
    }
    needR2(b);
    if (a === 'list') return json(req, await listFor(b));
    if (a === 'import_dropbox') {
      const p = await planDropbox(b);
      if (!p.work.length) return json(req, { jobId: null, counts: p.counts, message: 'Nothing new in Dropbox.' });
      const jobId = await newJob(b.id, 'dropbox_import', { work: p.work, counts: p.counts }, p.work.length, me.id);
      return json(req, { jobId, counts: p.counts, folder: p.photoDir });
    }
    if (a === 'spiro_import') {
      const sid = String(body.spiroOrderId || b.spiro_order_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(sid)) throw new Bad('This order did not come from Spiro.');
      const p = await planSpiro(b, sid);
      const jobId = await newJob(b.id, 'spiro_import', { work: p.work, spiroCounts: p.spiroCounts, vids: p.vids, tourUrls: p.tourUrls, code: p.code }, p.work.length, me.id);
      return json(req, { jobId, toCopy: p.work.length, spiro: p.spiroCounts });
    }
    if (a === 'upload_urls') {
      const files = ((body.files as any[]) ?? []).slice(0, 200);
      if (!files.length) throw new Bad('No files.');
      const items = await itemsOf(b.id);
      let pos = Math.max(-1, ...items.filter(i => i.kind === 'photo').map(i => i.position));
      const out: any[] = [];
      for (const f of files) {
        const name = clean(String(f.name || 'photo.jpg')).slice(0, 140) || 'photo.jpg';
        const kind = /\.pdf$/i.test(name) ? 'file' : f.kind === 'floorplan' ? 'floorplan' : 'photo';
        const id = crypto.randomUUID(), ext = fullExt({ name });
        const row: any = { id, booking_id: b.id, kind, name, source: f.edit_type ? 'hq_edit' : 'hq_upload', edit_type: f.edit_type || null, edit_label: f.edit_label || null,
          parent_id: f.parent_id || null, position: kind === 'photo' ? ++pos : 0, key_full: keyFor(b.id, id, 'full', ext), type_full: typeOf(name), hidden: true, archive_status: 'pending' };
        if (kind !== 'file') { row.key_web = keyFor(b.id, id, 'web'); row.key_thumb = keyFor(b.id, id, 'thumb'); }
        const { error } = await admin.from('media_items').insert(row); if (error) throw new Error(error.message);
        out.push({ id, name, put: { full: await R2.presign('PUT', row.key_full, 3600), web: row.key_web ? await R2.presign('PUT', row.key_web, 3600) : null, thumb: row.key_thumb ? await R2.presign('PUT', row.key_thumb, 3600) : null }, type: row.type_full });
      }
      return json(req, { files: out, note: 'PUT the original to full, a 2048px JPEG to web and a 640px JPEG to thumb, then call upload_done.' });
    }
    if (a === 'upload_done') {
      const ids = ((body.ids as string[]) ?? []).filter(x => /^[0-9a-f-]{36}$/i.test(x));
      const { data: rows } = await admin.from('media_items').select('*').eq('booking_id', b.id).in('id', ids);
      const ok: string[] = [], missing: string[] = [];
      for (const it of rows ?? []) {
        const hs = await Promise.all([it.key_full, it.key_web, it.key_thumb].filter(Boolean).map(k => R2.head(k)));
        if (hs.every(Boolean)) { ok.push(it.id); await admin.from('media_items').update({ hidden: false, size_full: hs[0]!.size, size_web: hs[1]?.size ?? null, size_thumb: hs[2]?.size ?? null, updated_at: now() }).eq('id', it.id); }
        else missing.push(it.name);
      }
      const jobId = ok.length ? await newJob(b.id, 'archive', { ids: ok }, ok.length, me.id) : null;
      return json(req, { added: ok.length, missing, jobId });
    }
    if (a === 'remove' || a === 'restore') {
      const ids = ((body.ids as string[]) ?? []).filter(x => /^[0-9a-f-]{36}$/i.test(x));
      await admin.from('media_items').update({ hidden: a === 'remove', updated_at: now() }).eq('booking_id', b.id).in('id', ids);
      await queueZips(b.id, me.id);
      return json(req, { ok: true });
    }
    if (a === 'reorder') {
      const ids = ((body.ids as string[]) ?? []).filter(x => /^[0-9a-f-]{36}$/i.test(x));
      for (const [i, id] of ids.entries()) await admin.from('media_items').update({ position: i, updated_at: now() }).eq('booking_id', b.id).eq('id', id);
      await queueZips(b.id, me.id);
      return json(req, { ok: true });
    }
    if (a === 'zip_check') { // reads each Download All zip back and checks every file's checksum
      const { data: zs } = await admin.from('media_zips').select('*').eq('booking_id', b.id);
      const out: any[] = [];
      for (const z of zs ?? []) {
        const bytes = await fetchBytes(await R2.get(z.key), 'zip'), v = new DataView(bytes.buffer, bytes.byteOffset);
        const eo = bytes.length - 22; if (v.getUint32(eo, true) !== 0x06054b50) { out.push({ variant: z.variant, ok: false, why: 'no end record' }); continue; }
        const n = v.getUint16(eo + 10, true); let p = v.getUint32(eo + 16, true); const names: string[] = []; let bad = 0;
        for (let k = 0; k < n; k++) {
          const crc = v.getUint32(p + 16, true), size = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), off = v.getUint32(p + 42, true);
          const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nl)); names.push(name);
          const lnl = v.getUint16(off + 26, true), data = bytes.subarray(off + 30 + lnl, off + 30 + lnl + size);
          if (v.getUint32(off, true) !== 0x04034b50 || R2.crc32(data) !== crc) bad++;
          p += 46 + nl;
        }
        out.push({ variant: z.variant, ok: bad === 0, files: n, bad, bytes: bytes.length, first: names[0], last: names[names.length - 1] });
      }
      return json(req, { zips: out });
    }
    if (a === 'build_zips') return json(req, { jobId: await queueZips(b.id, me.id) });
    if (a === 'delivery_preview') {
      const items = await itemsOf(b.id);
      const { data: zips } = await admin.from('media_zips').select('*').eq('booking_id', b.id);
      const lk = body.locked === undefined ? locked(b) : !!body.locked;
      return json(req, { locked: lk, ...(await r2Delivery(b, items, zips ?? [], lk, v => zipSig(b, items, v))) });
    }
    throw new Bad('Unknown action');
  } catch (e) {
    const status = e instanceof Bad ? e.status : 500;
    if (!(e instanceof Bad)) console.error('library error', String((e as Error)?.stack || e));
    return json(req, { error: e instanceof Bad ? e.message : String((e as Error)?.message || 'Something went wrong.') }, status);
  }
});
