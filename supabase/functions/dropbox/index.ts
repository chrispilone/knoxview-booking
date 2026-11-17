import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { sign, dbxApi, dropboxFolderImages, dropboxConfigured, dropboxToken, forgetDropboxToken, dropboxPathStream, parseVimeo, vimeoConfigured, vimeoInfo, pickPhoneMp4, galleryAddress, dropboxUpload } from './lib.ts';

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
// CubiCasa (floor plans). Called by the cubicasa function (order created / cancelled / CubiCasa webhook) or by HQ:
//   cubicasa_info                  -> the CubiCasa company + its webhook settings
//   cubicasa_webhook               -> adds HQ's webhook URL to CubiCasa (keeps every URL already there, e.g. Spiro's)
//   cubicasa_draft { bookingId }   -> makes a CubiCasa draft for an order with photography (not land); skips orders that have one
//   cubicasa_cancel { orderId }    -> deletes a CubiCasa draft (only while it's still a draft) when an order is cancelled or deleted
//   cubicasa_event { orderId }     -> re-reads the CubiCasa order; on Ready, imports the measured floor plan (+ 3D floor plan)
//                                     into <dropbox_path>/<final floor plans> and the Media Library
//   cubicasa_link { bookingId, orderId } -> ties an existing CubiCasa order to an HQ order (then imports it if it's Ready)
// Needs secret CUBICASA_API_KEY (CubiCasa → Settings → Company → Developer).
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

// Read the order's Dropbox final photos + floor plans into the Media Library (see `sync` above)
async function syncOrder(set: any, b: any) {
  if (!b.dropbox_path) throw new Bad("This order doesn't have a Dropbox folder yet. Mark it completed (or tap Create folders) first.");
  const photosDir = b.dropbox_photos_dir || clean(set.dropbox_final_photos || 'Final Photos');
  const dir = `${b.dropbox_path}/${photosDir}`;
  const files = await dropboxFolderImages(dir);
  if (files === null) throw new Bad(`There's no "${photosDir}" folder in ${b.dropbox_path} yet.`, 404);
  const lc = (n: any) => String(n ?? '').toLowerCase();
  const prev = ((b.photo_files as any[]) ?? []).filter(f => f?.name);
  const hidden = new Set(((b.photo_hidden as any[]) ?? []).map(lc));
  const byName = new Map(files.map(f => [lc(f.name), f]));
  const prevNames = new Set(prev.map(f => lc(f.name)));
  const kept = prev.filter(f => f.src === 'upload' || byName.has(lc(f.name))).map(f => f.src === 'upload' ? f : byName.get(lc(f.name))!);
  const added = files.filter(f => !prevNames.has(lc(f.name)) && !hidden.has(lc(f.name)));
  const photo_files = [...kept, ...added];
  const removed = prev.filter(f => f.src !== 'upload').length - kept.filter(f => f.src !== 'upload').length;
  const planDir = b.dropbox_plans_dir ? `${b.dropbox_path}/${b.dropbox_plans_dir}` : set.dropbox_final_floorplans ? `${b.dropbox_path}/${clean(set.dropbox_final_floorplans)}` : null;
  const planHidden = new Set(((b.floorplan_hidden as any[]) ?? []).map(lc));
  const floorplan_files = planDir ? ((await folderFiles(planDir, PLAN_RE)) ?? []).filter(f => !planHidden.has(lc(f.name))) : ((b.floorplan_files as any[]) ?? []);
  const now = new Date().toISOString();
  await admin.from('bookings').update({ photo_files, floorplan_files, photos_synced_at: now, updated_at: now }).eq('id', b.id);
  const cover_url = await setCover(b, photo_files).catch(e => { console.error('cover', String(e)); return b.cover_url; });
  return { dir, planDir, files, added, removed, photo_files, floorplan_files, cover_url, now };
}

// ---- Spiro import ----
// One Spiro order -> one HQ order: client + company, services and price, shoot date, status, Spiro invoices (paid state),
// Vimeo videos, 3D tour, and the Dropbox order folder. Only the photos Spiro delivered are shown (other Dropbox photos are
// hidden, not deleted), in Spiro's order; Spiro's floor plans are copied into the folder when it has none.
// No Spiro property website and no CubiCasa draft. Re-running it updates the same HQ order (matched on the Spiro order id).
const SPIRO_ROOT = '/Chris Pilone/CCREP (Spiro Uploads)';
const STATUS: Record<string, string> = { delivered: 'completed', editing: 'completed', appointmentCompleted: 'completed', inProgress: 'scheduled',
  confirmed: 'scheduled', rescheduled: 'scheduled', pending: 'requested', awaitingConfirmation: 'requested', cancelled: 'cancelled' };
const nameKey = (s: string) => String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '');
async function listDir(path: string) {
  let r = await dbxApi('files/list_folder', { path, limit: 2000 });
  if (r.status === 409) return null;
  const out: any[] = [];
  for (let g = 0; g < 20; g++) {
    if (!r.ok) throw new Error('Dropbox list failed: ' + r.status);
    const j = await r.json(); out.push(...j.entries);
    if (!j.has_more) break;
    r = await dbxApi('files/list_folder/continue', { cursor: j.cursor });
  }
  return out;
}
// The Spiro-era folder: <root>/<year>/Q<q>/<photographer>/<MM.DD.YYYY> <nn> <address-slug>  (<client>)
async function findSpiroFolder(shoot: string | null, photographer: string, address: string) {
  const sl = slug(address);
  const tz = 'America/New_York';
  const tries: string[] = [];
  const d = shoot ? new Date(shoot) : null;
  if (d) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(d);
    const y = p.find(x => x.type === 'year')!.value, q = Math.ceil(+p.find(x => x.type === 'month')!.value / 3);
    for (const who of [photographer, 'Chris Pilone']) tries.push(`${SPIRO_ROOT}/${y}/Q${q}/${who}`);
  }
  for (const dir of [...new Set(tries)]) {
    const ents = await listDir(dir); if (!ents) continue;
    const hit = ents.filter(e => e['.tag'] === 'folder' && e.name.toLowerCase().includes(sl));
    if (hit.length) return hit.sort((a, b) => b.name.localeCompare(a.name))[0].path_display as string;
  }
  // fallback: Dropbox search by the address slug inside the Spiro uploads root
  const r = await dbxApi('files/search_v2', { query: sl, options: { path: SPIRO_ROOT, file_status: 'active', filename_only: true, max_results: 20 } });
  if (r.ok) { const j = await r.json(); const f = (j.matches ?? []).map((m: any) => m.metadata?.metadata).find((m: any) => m?.['.tag'] === 'folder' && m.name.toLowerCase().includes(sl));
    if (f) return f.path_display as string; }
  return null;
}
const fmtPhone = (p: string) => { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : (p || null); };
async function copyToStorage(url: string, path: string) {
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const up = await admin.storage.from('agent-photos').upload(path, new Uint8Array(await r.arrayBuffer()), { contentType: r.headers.get('content-type') || 'image/jpeg', upsert: true, cacheControl: '31536000' });
    if (up.error) return null;
    return admin.storage.from('agent-photos').getPublicUrl(path).data.publicUrl;
  } catch (_) { return null; }
}
async function spiroImport(set: any, p: any) {
  const o = p.order, a = o.agent, addr = o.property.address, pr = o.pricing;
  const log: string[] = [];
  // company + client
  let companyId: string | null = null;
  if (a.companyId) {
    const { data: co } = await admin.from('companies').select('id').eq('spiro_company_id', a.companyId).maybeSingle();
    if (co) companyId = co.id;
    else {
      const { data: byName } = await admin.from('companies').select('id').ilike('name', a.companyName).maybeSingle();
      const row = { name: a.companyName, spiro_company_id: a.companyId, admin_email: p.company?.adminEmail || null, admin_phone: p.company?.adminPhone || null };
      if (byName) { await admin.from('companies').update({ spiro_company_id: a.companyId }).eq('id', byName.id); companyId = byName.id; }
      else { const { data: c, error } = await admin.from('companies').insert(row).select('id').single(); if (error) throw new Error('company: ' + error.message); companyId = c.id; log.push('Added company ' + a.companyName); }
    }
  }
  let { data: ag } = await admin.from('agents').select('id, photo_url').eq('spiro_agent_id', a.agentId).maybeSingle();
  if (!ag && a.emailAddress) ({ data: ag } = await admin.from('agents').select('id, photo_url').ilike('email', a.emailAddress).maybeSingle());
  const agentRow: any = { spiro_agent_id: a.agentId, full_name: `${a.firstName} ${a.lastName}`.trim(), first_name: a.firstName, last_name: a.lastName,
    email: (a.emailAddress || '').toLowerCase() || null, phone: fmtPhone(a.phoneNumber), company_id: companyId, brokerage: a.companyName || null };
  if (ag) { const { full_name, first_name, last_name, ...keep } = agentRow; await admin.from('agents').update({ ...keep }).eq('id', ag.id); }
  else { const { data: n, error } = await admin.from('agents').insert({ ...agentRow, preferences: 'Imported from Spiro' }).select('id, photo_url').single(); if (error) throw new Error('client: ' + error.message); ag = n; log.push('Added client ' + agentRow.full_name); }
  if (!ag!.photo_url && p.agentPhoto) {
    const url = await copyToStorage(p.agentPhoto, `spiro/${a.agentId}.jpg`);
    if (url) { await admin.from('agents').update({ photo_url: url, photo_path: `spiro/${a.agentId}.jpg` }).eq('id', ag!.id); log.push('Copied profile photo'); }
  }
  // invoices: the order is paid once the invoice that bills it (company or agent, whichever pays) is paid in full
  const companyPays = !!pr.companyPaysAllInvoices;
  const inv = (p.invoices ?? []).map((i: any) => ({ id: i.invoiceId, ref: i.referenceNumber, status: i.status, payee: i.payee?.payeeType, payee_name: i.payee?.companyName || i.payee?.agentName,
    total: i.amount?.total ?? null, due: i.amount?.amountDue ?? null, created: i.dateCreated, paid_at: i.dateFullyPaid, orders: i.orderCount }));
  const billing = inv.filter((i: any) => companyPays ? i.payee === 'Company' : i.payee === 'Agent');
  const settled = billing.find((i: any) => i.status === 'Paid' && i.paid_at);
  const total = +pr.totalSalePrice || 0;
  // services: the package (with its price) and each included service
  const items = [{ kind: 'package', name: o.bundle?.name || 'Spiro order', price: total, includes: (p.services ?? []).map((s: any) => String(s.name).trim()) },
    ...(o.addOns ?? []).map((x: any) => ({ kind: 'service', name: String(x.name || '').trim(), price: 0 }))];
  const status = STATUS[p.status] || 'scheduled';
  const videos = (p.videos ?? []).flatMap((v: any) => [v.brandedUrl && { url: v.brandedUrl.split('?')[0].replace('player.vimeo.com/video/', 'vimeo.com/'), label: 'Branded' },
    v.unbrandedUrl && { url: v.unbrandedUrl.split('?')[0].replace('player.vimeo.com/video/', 'vimeo.com/'), label: 'Unbranded' }]).filter(Boolean);
  const row: any = {
    spiro_order_id: o.identity.orderId, order_no: o.identity.trackingCode, source: 'spiro', status, agent_id: ag!.id,
    client_name: agentRow.full_name, client_email: agentRow.email, client_phone: agentRow.phone,
    address: addr.streetAddress, unit: addr.unitNumber || null, city: addr.city, state: addr.stateOrProvince, zip: addr.postalCode,
    sqft: o.property.specs?.squareFeet || null, shoot_start: p.appointment?.start || null, items, subtotal: total, total,
    created_at: o.identity.dateSubmitted, delivered_at: o.website?.deliveredAt || (status === 'completed' ? o.identity.dateSubmitted : null),
    invoice: true, require_payment: false, bill_to: companyPays ? 'company' : 'agent', spiro_invoices: inv,
    paid: !!settled || total === 0, paid_at: settled?.paid_at || null, paid_method: settled ? 'spiro' : null,
    paid_note: settled ? `Paid in Spiro · invoice ${settled.ref}` : null, payment_status: settled || total === 0 ? 'paid' : 'unpaid',
    videos, tour_url: (p.tours ?? [])[0] || null, imported_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  if (p.appointment?.photographer) { const { data: tm } = await admin.from('team_members').select('id').ilike('full_name', p.appointment.photographer).maybeSingle(); if (tm) row.photographer_id = tm.id; }
  const { data: existing } = await admin.from('bookings').select('*').eq('spiro_order_id', row.spiro_order_id).maybeSingle();
  let b: any;
  if (existing) { const { created_at, ...upd } = row; const { data, error } = await admin.from('bookings').update(upd).eq('id', existing.id).select('*').single(); if (error) throw new Error(error.message); b = data; log.push('Updated order'); }
  else { const { data, error } = await admin.from('bookings').insert(row).select('*').single(); if (error) throw new Error(error.message); b = data; log.push('Created order #' + data.number); }
  // the client's own "require payment" setting is for new orders; imported orders were already delivered in Spiro
  if (b.require_payment !== false) { await admin.from('bookings').update({ require_payment: false }).eq('id', b.id); b.require_payment = false; }
  // Dropbox: the order folder, its photo / floor plan subfolders, delivered photos only, Spiro floor plans if missing
  let dropbox: any = { found: false };
  if (dropboxConfigured() && (await dropboxToken().catch(() => null))) {
    const path = b.dropbox_path || await findSpiroFolder(p.appointment?.start || o.identity.dateSubmitted, p.appointment?.photographer || 'Chris Pilone', addr.streetAddress);
    if (path) {
      const subs = ((await listDir(path)) ?? []).filter(e => e['.tag'] === 'folder').map(e => e.name as string);
      const photosDir = subs.find(n => /final.*photo/i.test(n)) || subs.find(n => /photo/i.test(n) && !/raw/i.test(n)) || null;
      const plansDir = subs.find(n => /floor/i.test(n)) || null;
      const images = photosDir ? ((await dropboxFolderImages(`${path}/${photosDir}`)) ?? []) : [];
      const want = (p.photos ?? []) as string[];
      const wantKeys = new Map(want.map((n, i) => [nameKey(n), i]));
      const photo_hidden = images.filter(f => !wantKeys.has(nameKey(f.name))).map(f => f.name.toLowerCase());
      let planDirName = plansDir;
      if (!planDirName) { planDirName = clean(set.dropbox_final_floorplans || '06-Final-FloorPlan'); await dbxApi('files/create_folder_v2', { path: `${path}/${planDirName}`, autorename: false }); }
      const plans = (await folderFiles(`${path}/${planDirName}`, PLAN_RE)) ?? [];
      let copied = 0;
      if (!plans.length) for (const f of (p.floorplans ?? [])) {
        const r = await fetch(f.url); if (!r.ok) continue;
        const nm = clean(f.name) || `Floor Plan ${copied + 1}.jpg`;
        const up = await dropboxUpload(`${path}/${planDirName}/${nm}`, new Uint8Array(await r.arrayBuffer())); if (up.ok) copied++;
      }
      await admin.from('bookings').update({ dropbox_path: path, dropbox_photos_dir: photosDir, dropbox_plans_dir: planDirName, photo_hidden, photo_files: [] }).eq('id', b.id);
      Object.assign(b, { dropbox_path: path, dropbox_photos_dir: photosDir, dropbox_plans_dir: planDirName, photo_hidden, photo_files: [] });
      let synced: any = null;
      if (photosDir) {
        synced = await syncOrder(set, b);
        // Spiro's photo order
        const ordered = [...synced.photo_files].sort((x: any, y: any) => (wantKeys.get(nameKey(x.name)) ?? 1e6) - (wantKeys.get(nameKey(y.name)) ?? 1e6));
        await admin.from('bookings').update({ photo_files: ordered }).eq('id', b.id);
        b.photo_files = ordered; b.cover_src = null;
        await setCover(b, ordered).catch(() => null);
      }
      const matched = images.length - photo_hidden.length;
      dropbox = { found: true, path, photosDir, plansDir: planDirName, inDropbox: images.length, delivered: want.length, matched, hidden: photo_hidden.length,
        missing: want.filter(n => !images.some(f => nameKey(f.name) === nameKey(n))), plansCopied: copied, floorplans: synced?.floorplan_files?.length ?? plans.length };
      log.push(`Dropbox: ${matched} of ${want.length} delivered photos found`);
    } else log.push('Dropbox folder not found');
  }
  return { ok: true, bookingId: b.id, number: b.number, order_no: b.order_no, status, paid: row.paid, billTo: row.bill_to, invoices: inv.map((i: any) => `${i.ref} (${i.payee}, ${i.status})`), dropbox, log };
}

// ---- Spiro public API (read-only; secret SPIRO_API_KEY, sent as a Bearer token) ----
// Spiro rate-limits per key: a 429 means wait about a minute, so calls go one at a time and retry after a pause.
const SPIRO_API = 'https://api.spiro.media/api/v1';
async function spiro(path: string, tries = 3): Promise<any> {
  const key = env('SPIRO_API_KEY');
  if (!key) throw new Bad("Spiro isn't connected (SPIRO_API_KEY is missing).", 409);
  for (let t = 0; t < tries; t++) {
    const r = await fetch(SPIRO_API + path, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
    if (r.status === 429) { if (t === tries - 1) throw new Bad('Spiro is rate-limiting us. Try again in a minute.', 429); await new Promise(res => setTimeout(res, 20000 * (t + 1))); continue; }
    if (r.status === 404) return null;
    const txt = await r.text();
    if (!r.ok) throw new Bad(`Spiro said ${r.status} for ${path.split('?')[0]}: ${txt.split(key).join('[key]').slice(0, 200)}`, 502);
    return txt ? JSON.parse(txt) : null;
  }
}
// every page of a list endpoint
async function spiroAll(path: string, max = 5000) {
  const out: any[] = [];
  for (let page = 1; out.length < max; page++) {
    const j = await spiro(`${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=100`);
    out.push(...(j?.data ?? []));
    if (!j?.meta?.hasNextPage) break;
  }
  return out;
}
// Spiro's order list only covers the last 30 days unless a start date is given
const SPIRO_SINCE = 'filter[dateSubmitted][gte]=2015-01-01';
// Everything spiroImport needs for one Spiro order, read from the Spiro API
async function spiroPayload(orderId: string) {
  const o = (await spiro(`/orders/${orderId}`))?.data;
  if (!o) throw new Bad('That order is not in Spiro.', 404);
  const base = `/orders/${orderId}`;
  const services = (await spiro(base + '/services'))?.data ?? [];
  const appts = ((await spiro(base + '/appointments'))?.data ?? []).filter((a: any) => !a.events?.cancelledAt && a.status !== 'Cancelled');
  const invoices = (await spiro(base + '/invoices'))?.data ?? [];
  const photos = (await spiroAll(base + '/media/photos')).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const videos = (await spiro(base + '/media/videos'))?.data ?? [];
  const plans = (await spiro(base + '/media/floor-plans'))?.data ?? [];
  const tours = (await spiro(base + '/media/virtual-tours'))?.data ?? [];
  const a = o.agent ?? {};
  let agentPhoto: string | null = null, company: any = null;
  const { data: known } = await admin.from('agents').select('photo_url').eq('spiro_agent_id', a.agentId).maybeSingle();
  if (!known?.photo_url) agentPhoto = (await spiro(`/agents/${a.agentId}`))?.data?.media?.profilePictureUrl || null;
  if (a.companyId) {
    const { data: co } = await admin.from('companies').select('id').eq('spiro_company_id', a.companyId).maybeSingle();
    if (!co) { const c = (await spiro(`/companies/${a.companyId}`))?.data; company = { adminEmail: c?.contact?.emailAddress || c?.adminEmail || null, adminPhone: c?.contact?.phoneNumber || c?.adminPhone || null }; }
  }
  const first = appts.sort((x: any, y: any) => String(x.events?.arrivalWindowStart).localeCompare(String(y.events?.arrivalWindowStart)))[0];
  const delivered = !!o.website?.deliveredAt;
  return {
    order: o, company, agentPhoto, invoices, services,
    status: o.lifecycle?.isCancelled ? 'cancelled' : delivered ? 'delivered' : 'confirmed',
    appointment: first ? { start: first.events?.arrivalWindowStart || null, photographer: first.photographer?.name || null } : null,
    photos: photos.filter((x: any) => x.displayPageActive !== false).map((x: any) => x.name),
    videos: videos.filter((v: any) => v.displayPageActive !== false),
    floorplans: plans.filter((f: any) => f.downloadUrl).map((f: any) => ({ url: f.downloadUrl, name: f.name })),
    tours: tours.map((t: any) => t.url || t.brandedUrl || t.tourUrl || t.unbrandedUrl).filter(Boolean),
  };
}

// ---- CubiCasa ----
const CC_BASE = 'https://app.cubi.casa/api/integrate/v3';
const CC_OWNER = 'chris@knoxview.com';
async function cc(method: string, path: string, body?: unknown) {
  const key = env('CUBICASA_API_KEY');
  if (!key) throw new Bad("CubiCasa isn't connected (CUBICASA_API_KEY is missing).", 409);
  const r = await fetch(CC_BASE + path, { method, headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch (_) { j = { raw: t.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, j };
}
// Which orders get a floor plan draft: any package or service whose photo type is photography ("Edit Photos"), except
// land, drone-only and community photos. New services count automatically when their photo type is photography.
const isPhotoService = (s: any) => s && s.category !== 'land' && /edit photos/i.test(s.photo_type || '') && !/lot\s*\/\s*land/i.test(s.photo_type || '') && !/drone|community/i.test(s.name || '');
const wants3D = (items: any[], svcs: any[]) => items.some(i => /3d floor plan/i.test(i.name || '')) ||
  svcs.some(s => ((s.includes as string[]) ?? []).some(x => /3d floor plan/i.test(x)));
async function needsFloorPlan(b: any) {
  const items = ((b.items as any[]) ?? []).filter(i => i?.name);
  if (!items.length) return { yes: false, plus3d: false };
  const { data: svcs } = await admin.from('booking_services').select('name, category, photo_type, includes').in('name', items.map(i => i.name));
  const hit = (svcs ?? []).filter(isPhotoService);
  return { yes: hit.length > 0, plus3d: wants3D(items, svcs ?? []) };
}
const ccStatus = (o: any) => String(o?.info?.status ?? o?.status ?? o?.order?.info?.status ?? '') || null;
// urls from an asset group: arrays of strings or of { url }
const urls = (x: any): string[] => (Array.isArray(x) ? x : x ? [x] : []).map((u: any) => typeof u === 'string' ? u : u?.url).filter((u: any) => typeof u === 'string' && /^https?:/.test(u));
async function makeFolders(set: any, b: any, force = false) {
  const { data: agent } = b.agent_id ? await admin.from('agents').select('full_name, brokerage').eq('id', b.agent_id).maybeSingle() : { data: null };
  const base = b.dropbox_path && !force ? b.dropbox_path : await folderPath(set, b, agent);
  const paths = [base, ...((set.dropbox_subfolders as string[]) ?? []).map(s => clean(s)).filter(Boolean).map(s => `${base}/${s}`)];
  const r = await dbxApi('files/create_folder_batch', { paths, autorename: false, force_async: false });
  if (!r.ok) throw new Bad('Dropbox could not make the folders: ' + (await r.text()).slice(0, 200), 502);
  const j = await r.json();
  const failed = (j.entries ?? []).filter((e: any) => e['.tag'] === 'failure' && !JSON.stringify(e).includes('conflict'));
  if (failed.length) console.error('create_folder_batch', JSON.stringify(failed).slice(0, 500));
  await admin.from('bookings').update({ dropbox_path: base, updated_at: new Date().toISOString() }).eq('id', b.id);
  b.dropbox_path = base;
  return { path: base, folders: paths.length, failed: failed.length };
}
// Ready on CubiCasa -> measured floor plan(s) (+ 3D) into the order's Dropbox floor plan folder and the Media Library
async function ccImport(set: any, b: any, o: any) {
  const a = o?.delivery_assets ?? o?.order?.delivery_assets ?? {};
  const lf = a.listing_floorplans ?? {};
  let plans = urls(lf.jpg_urls_dim);
  if (!plans.length) plans = urls(lf.png_urls_dim);
  if (!plans.length) plans = urls(lf.jpg_urls); // no measured version delivered: take the plain one rather than nothing
  const plans3d = urls(a.floorplans_3d?.jpg_urls);
  if (!plans.length && !plans3d.length) return { imported: 0, note: 'CubiCasa says Ready but sent no floor plan images yet.' };
  if (!b.dropbox_path) await makeFolders(set, b);
  const dir = `${b.dropbox_path}/${clean(set.dropbox_final_floorplans || '06-Final-FloorPlan')}`;
  const addr = clean(galleryAddress(b)) || 'Floor Plan';
  const named = [
    ...plans.map((u, i) => ({ u, name: `${addr} - Floor Plan${plans.length > 1 ? ' ' + (i + 1) : ''}.jpg` })),
    ...plans3d.map((u, i) => ({ u, name: `${addr} - 3D Floor Plan${plans3d.length > 1 ? ' ' + (i + 1) : ''}.jpg` })),
  ];
  let imported = 0;
  for (const f of named) {
    const r = await fetch(f.u);
    if (!r.ok) { console.error('cubicasa download', r.status, f.name); continue; }
    const up = await dropboxUpload(`${dir}/${f.name}`, new Uint8Array(await r.arrayBuffer()));
    if (!up.ok) { console.error('dropbox upload', up.status, (await up.text()).slice(0, 200)); continue; }
    imported++;
  }
  // refresh the Media Library's floor plans from the folder; a re-delivered plan shows again even if it was removed before
  const lc = (n: any) => String(n ?? '').toLowerCase();
  const names = new Set(named.map(f => lc(f.name)));
  const floorplan_hidden = ((b.floorplan_hidden as any[]) ?? []).filter(n => !names.has(lc(n)));
  const hidden = new Set(floorplan_hidden.map(lc));
  const floorplan_files = ((await folderFiles(dir, PLAN_RE)) ?? []).filter(f => !hidden.has(lc(f.name)));
  const now = new Date().toISOString();
  await admin.from('bookings').update({ floorplan_files, floorplan_hidden, cubicasa_ready_at: now, cubicasa_error: imported ? null : 'Floor plan download failed', updated_at: now }).eq('id', b.id);
  return { imported, folder: dir, floorplans: floorplan_files.length };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const internal = !!jwt && jwt === env('SUPABASE_SERVICE_ROLE_KEY'); // the cubicasa function
    if (!internal) {
      const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
      const { data: me } = u?.user ? await admin.from('team_members').select('id, role, active, permissions').eq('id', u.user.id).maybeSingle() : { data: null };
      if (!me?.active || !(me.role === 'owner' || me.permissions?.super_admin === true)) throw new Bad('Only HQ super admins can use Dropbox here.', 403);
    }
    const body = await req.json().catch(() => ({}));
    const { data: set } = await admin.from('booking_settings').select('*').eq('id', 1).single();

    if (body.action === 'spiro_import') {
      if (!body.payload?.order?.identity?.orderId) throw new Bad('Spiro order data is missing.');
      return json(req, await spiroImport(set, body.payload));
    }
    // Import / resync one delivered Spiro order (by Spiro order id, or the HQ order it was imported into)
    if (body.action === 'spiro_pull') {
      let id = String(body.orderId || '');
      if (!id && body.bookingId) { const { data: b } = await admin.from('bookings').select('spiro_order_id').eq('id', body.bookingId).maybeSingle(); id = b?.spiro_order_id || ''; }
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Bad('This order did not come from Spiro.');
      const p = await spiroPayload(id);
      if (p.status !== 'delivered') throw new Bad('Only delivered Spiro orders are imported (this one is not delivered yet).', 409);
      return json(req, await spiroImport(set, p));
    }
    // Every delivered Spiro order, with the HQ order it was imported into (if any)
    if (body.action === 'spiro_delivered') {
      const rows = await spiroAll(`/orders?filter[status][eq]=delivered&${SPIRO_SINCE}`);
      const ids = rows.map((r: any) => r.orderId);
      const have = new Map<string, any>();
      for (let i = 0; i < ids.length; i += 500) {
        const { data } = await admin.from('bookings').select('id, number, spiro_order_id, imported_at').in('spiro_order_id', ids.slice(i, i + 500));
        (data ?? []).forEach(b => have.set(b.spiro_order_id, b));
      }
      return json(req, { orders: rows.map((r: any) => ({ orderId: r.orderId, code: r.trackingCode, date: r.dateSubmitted, address: r.property?.address?.fullAddress || r.mediaTitle,
        agentId: r.client?.agentId, agent: r.client?.agentName, company: r.client?.companyName, total: r.totalSalePrice,
        hq: have.get(r.orderId) ? { id: have.get(r.orderId).id, number: have.get(r.orderId).number, imported_at: have.get(r.orderId).imported_at } : null })) });
    }
    if (body.action === 'spiro_raw') { // super-admin debugging: one GET against the Spiro API
      const p = String(body.path || '');
      if (!/^\/[a-z0-9\-\/{}?&=,.\[\]_%:]*$/i.test(p)) throw new Bad('Bad path.');
      return json(req, await spiro(p));
    }
    if (body.action === 'cubicasa_info') {
      const r = await cc('GET', '/companies/info');
      if (!r.ok) throw new Bad(`CubiCasa said ${r.status}: ${JSON.stringify(r.j).slice(0, 200)}`, 502);
      return json(req, r.j);
    }
    if (body.action === 'cubicasa_webhook') {
      const mine = `${env('SUPABASE_URL')}/functions/v1/cubicasa`;
      const info = await cc('GET', '/companies/info');
      if (!info.ok) throw new Bad(`CubiCasa said ${info.status}: ${JSON.stringify(info.j).slice(0, 200)}`, 502);
      const w = info.j?.configs ?? {};
      if (!Array.isArray(w.webhook_urls)) throw new Bad("Couldn't read CubiCasa's current webhook settings, so nothing was changed.", 502);
      const have: string[] = w.webhook_urls;
      const trig: string[] = w.webhook_triggers ?? [];
      const webhook_urls = [...new Set([...have, mine])];
      // only 'Ready' is added: triggers are shared with Spiro's webhook, so it keeps getting exactly what it got before
      const webhook_triggers = [...new Set([...trig, 'moved_to_ready'])];
      if (body.dry) return json(req, { before: { webhook_urls: have, webhook_triggers: trig }, after: { webhook_urls, webhook_triggers }, raw: info.j });
      const r = await cc('PATCH', '/companies/webhook', { webhook_urls, webhook_triggers });
      if (!r.ok) throw new Bad(`CubiCasa said ${r.status}: ${JSON.stringify(r.j).slice(0, 200)}`, 502);
      return json(req, { ok: true, webhook_urls, webhook_triggers, result: r.j });
    }
    if (body.action === 'cubicasa_order') { // raw CubiCasa order (for checking what CubiCasa sends)
      const r = await cc('GET', `/orders/${String(body.orderId || '')}`);
      return json(req, { status: r.status, order: r.j });
    }
    if (body.action === 'cubicasa_cancel') {
      const id = String(body.orderId || '');
      if (!id) throw new Bad('orderId is required');
      const o = await cc('GET', `/orders/${id}`);
      const st = ccStatus(o.j);
      if (o.ok && st && !/draft|new/i.test(st)) return json(req, { ok: false, kept: true, status: st }); // already scanned: keep it
      const r = await cc('DELETE', `/orders/draft/${id}`);
      await admin.from('bookings').update({ cubicasa_status: r.ok ? 'Deleted' : st }).eq('cubicasa_order_id', id);
      return json(req, { ok: r.ok, status: r.status, result: r.j });
    }
    if (body.action === 'cubicasa_event') {
      const { data: hit } = await admin.from('bookings').select('id').eq('cubicasa_order_id', String(body.orderId || '')).maybeSingle();
      if (!hit) return json(req, { ok: true, ignored: true }); // not an HQ order (Spiro's orders send these too)
      body.bookingId = hit.id;
    }

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
      return json(req, { ok: true, ...(await makeFolders(set, b, !!body.force)) });
    }
    if (body.action === 'cubicasa_draft') {
      if (b.cubicasa_order_id && !body.force) return json(req, { ok: true, skipped: 'has a CubiCasa order', id: b.cubicasa_order_id });
      if (b.status === 'cancelled') return json(req, { ok: true, skipped: 'cancelled' });
      const need = await needsFloorPlan(b);
      if (!need.yes) return json(req, { ok: true, skipped: 'no photography on this order' });
      const draft: Record<string, unknown> = { street: b.address, city: b.city, state: b.state || undefined, postalCode: b.zip || undefined,
        suite: b.unit || undefined, country: 'US', owner_email: CC_OWNER, external_id: String(b.order_no || b.number || b.id),
        // the free package (base) leaves the choice open: Plus or Plus + 3D can still be picked in CubiCasa; base can't be picked after Plus
        package_type: 'base', info: need.plus3d ? 'Client ordered a 3D floor plan: upgrade this order to Plus + 3D.' : undefined };
      if (!b.address || !b.city) throw new Bad('The order needs a street address and city for CubiCasa.');
      const r = await cc('POST', '/orders/draft', draft);
      const id = r.j?.id ?? r.j?.order?.id ?? r.j?.data?.id;
      if (!r.ok || !id) {
        const msg = `CubiCasa said ${r.status}: ${JSON.stringify(r.j).slice(0, 300)}`;
        await admin.from('bookings').update({ cubicasa_error: msg }).eq('id', b.id);
        throw new Bad(msg, 502);
      }
      await admin.from('bookings').update({ cubicasa_order_id: String(id), cubicasa_status: 'Draft', cubicasa_package: draft.package_type, cubicasa_error: null }).eq('id', b.id);
      return json(req, { ok: true, id, package_type: draft.package_type });
    }
    if (body.action === 'cubicasa_link') {
      const id = String(body.orderId || '');
      if (!id) throw new Bad('orderId is required');
      await admin.from('bookings').update({ cubicasa_order_id: id }).eq('id', b.id);
      b.cubicasa_order_id = id;
      body.action = 'cubicasa_event';
    }
    if (body.action === 'cubicasa_event') {
      const o = await cc('GET', `/orders/${b.cubicasa_order_id}`);
      if (!o.ok) throw new Bad(`CubiCasa said ${o.status}: ${JSON.stringify(o.j).slice(0, 200)}`, 502);
      const st = ccStatus(o.j);
      await admin.from('bookings').update({ cubicasa_status: st }).eq('id', b.id);
      if (!/ready/i.test(st || '')) return json(req, { ok: true, status: st });
      await needDbx();
      return json(req, { ok: true, status: st, ...(await ccImport(set, b, o.j)) });
    }
    if (body.action === 'sync') {
      await needDbx();
      const r = await syncOrder(set, b);
      return json(req, { ok: true, folder: r.dir, added: r.added.length, removed: r.removed, photos: await gallery({ photo_files: r.photo_files }),
        planFolder: r.planDir, floorplans: await planGallery({ floorplan_files: r.floorplan_files }), cover_url: r.cover_url, synced_at: r.now });
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
