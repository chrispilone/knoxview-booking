import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sign, dropboxFiles, dropboxZip, dropboxConfigured, parseVimeo, vimeoEmbed, vimeoInfo, vimeoConfigured, cleanDropboxLink } from './lib.ts';

// Knox View client booking portal API (test.knoxview.com → book.knoxview.com).
// Public actions: config, slots, quote, create, confirm.  Signed-in client actions: link, portal, pay, profile, delivery.
// Stripe webhooks arrive at this same URL. Stripe mode: LIVE only for requests from book.knoxview.com (and only
// if live keys are set); everything else uses TEST keys.
// Prices are always computed here from booking_services; the browser's totals are never trusted.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const KEYS = {
  test: { sk: env('STRIPE_SECRET_KEY'), pk: env('STRIPE_PUBLISHABLE_KEY'), wh: env('STRIPE_WEBHOOK_SECRET') },
  live: { sk: env('STRIPE_LIVE_SECRET_KEY'), pk: env('STRIPE_LIVE_PUBLISHABLE_KEY'), wh: env('STRIPE_LIVE_WEBHOOK_SECRET') },
};
const LIVE_ORIGINS = ['https://book.knoxview.com'];
const reqMode = new AsyncLocalStorage<{ live: boolean }>(); // per-request Stripe mode
const isLive = () => reqMode.getStore()?.live ?? false;
const G_ID = (Deno.env.get('GOOGLE_CLIENT_ID') ?? '').trim();
const G_SECRET = (Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '').trim();
const ORIGINS = ['https://test.knoxview.com', 'https://book.knoxview.com', 'https://knoxview-booking.netlify.app', 'http://localhost:8888', 'http://localhost:5173'];

const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-booking\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class UserError extends Error { constructor(m: string, public status = 400) { super(m); } }

// Files the client uploaded with the order (e.g. a tax map for land), already in the private order-files bucket
const cleanFiles = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, 5)
  .filter((f: any) => f && /^land\/[0-9a-f-]{36}\/[^/]{1,140}$/.test(String(f.path)))
  .map((f: any) => ({ path: String(f.path), name: String(f.name || '').slice(0, 140), size: Number(f.size) || null, type: String(f.type || '').slice(0, 80) }));

/* ---------------- Stripe ---------------- */
function stripeMode(live = isLive()) {
  const k = live ? KEYS.live.sk : KEYS.test.sk;
  if (!k) return 'missing';
  if (!live && /^(sk|rk)_test_/.test(k)) return 'test';
  if (live && /^(sk|rk)_live_/.test(k)) return 'live';
  return 'invalid'; // e.g. a live key saved in the test slot
}
function form(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === 'object' ? form(x as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x)));
    else if (typeof v === 'object') form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(path: string, body?: Record<string, unknown>, method = body ? 'POST' : 'GET', idem?: string, live = isLive()) {
  const mode = stripeMode(live);
  if (mode === 'missing') throw new UserError('Online payments are not switched on yet. Please call 865-855-5669 to book.', 503);
  if (mode === 'invalid') throw new UserError(`The ${live ? 'live' : 'test'} Stripe key is the wrong kind of key.`, 503);
  const r = await fetch('https://api.stripe.com/v1' + path, {
    method, headers: { Authorization: `Bearer ${live ? KEYS.live.sk : KEYS.test.sk}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idem ? { 'Idempotency-Key': idem } : {}) },
    body: body && method !== 'GET' ? form(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `Stripe error ${r.status}`);
  return d;
}

/* ---------------- Time helpers ---------------- */
function tzOffsetMin(tz: string, at: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUtc - at.getTime()) / 60000;
}
function zoned(date: string, time: string, tz: string) { // local wall time → UTC Date
  const [y, m, d] = date.split('-').map(Number); const [hh, mm] = time.split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  return new Date(guess.getTime() - tzOffsetMin(tz, guess) * 60000);
}
const localDate = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const weekday = (date: string) => new Date(date + 'T12:00:00Z').getUTCDay();

/* ---------------- Catalog + pricing ---------------- */
async function loadCatalog(pageId: string | null = null) {
  const [{ data: services }, { data: settings }] = await Promise.all([
    pageId ? Promise.resolve({ data: await pageServices(pageId) }) : admin.from('booking_services').select('*').eq('active', true).eq('public', true),
    admin.from('booking_settings').select('*').eq('id', 1).single(),
  ]);
  return { services: services ?? [], settings: settings! };
}
// Custom order pages (built in HQ → Order Pages, assigned to agents). A page lists its own services: default ones at
// their normal price or a custom price, plus services made only for that page (not bookable on the default page).
async function pageServices(pageId: string) {
  const { data: items } = await admin.from('custom_order_page_items').select('service_id, price, sort_order').eq('page_id', pageId);
  const ids = (items ?? []).map(i => i.service_id);
  if (!ids.length) return [];
  const { data: svcs } = await admin.from('booking_services').select('*').in('id', ids).eq('active', true);
  const by = new Map((items ?? []).map(i => [i.service_id, i]));
  return (svcs ?? []).map(s => { const it = by.get(s.id)!; return { ...s, price: it.price ?? s.price, list_price: s.price, sort_order: it.sort_order ?? s.sort_order }; });
}
async function myPage(req: Request) { // the signed-in client's custom order page, if they have one
  const user = await userFrom(req); if (!user) return null;
  const { data: agent } = await admin.from('agents').select('custom_order_page_id').eq('auth_user_id', user.id).maybeSingle();
  if (!agent?.custom_order_page_id) return null;
  const { data: page } = await admin.from('custom_order_pages').select('id, title, cover_url, show_default').eq('id', agent.custom_order_page_id).eq('active', true).maybeSingle();
  return page ?? null;
}
// Catalog for this request: the default one, or the client's custom page (only if it's really assigned to them)
async function catalogFor(req: Request, body: any) {
  const pageId = body?.pageId ? String(body.pageId) : null;
  if (!pageId) return { cat: await loadCatalog(), pageId: null };
  const page = await myPage(req);
  if (!page || page.id !== pageId) throw new UserError('This order page is not available on your account. Please sign in again or call 865-855-5669.', 403);
  return { cat: await loadCatalog(pageId), pageId };
}
const PHOTO_LARGE_FEE = 25; // à la carte Photography: $225 → $250 over 3,500 sq ft
type Sel = { packageId?: string | null; serviceIds?: string[]; sqftLabel?: string; adu?: boolean };
function price(cat: Awaited<ReturnType<typeof loadCatalog>>, sel: Sel) {
  const byId = new Map<string, any>(cat.services.map(s => [s.id, s]));
  const pkg = sel.packageId ? byId.get(sel.packageId) : null;
  if (sel.packageId && (!pkg || pkg.kind !== 'package')) throw new UserError('That package is no longer available.');
  const covered = new Set<string>(pkg?.covers ?? []);
  const items: { id: string; name: string; kind: string; price: number; minutes: number; includes?: string[] }[] = [];
  if (pkg) items.push({ id: pkg.id, name: pkg.name, kind: 'package', price: +pkg.price, minutes: pkg.duration_min, includes: pkg.includes });
  for (const id of [...new Set(sel.serviceIds ?? [])]) {
    const s = byId.get(id);
    if (!s || s.kind !== 'addon') throw new UserError('One of the selected services is no longer available.');
    if (covered.has(id)) continue; // already in the package
    items.push({ id: s.id, name: s.name, kind: 'service', price: +s.price, minutes: s.duration_min });
  }
  if (!items.length) throw new UserError('Choose a package or at least one service.');
  const opt = (cat.settings.sqft_options as { label: string; max: number | null }[]).find(o => o.label === sel.sqftLabel);
  const large = !!sel.adu || (opt ? (opt.max === null || opt.max >= cat.settings.large_sqft) : false);
  // Homes over 3,500 sq ft: packages add the large-home fee ($75); photos-only orders (à la carte Photography, no package) add $25.
  if (large && pkg && +cat.settings.large_fee > 0) items.push({ id: 'large', name: cat.settings.large_label, kind: 'fee', price: +cat.settings.large_fee, minutes: cat.settings.large_minutes });
  else if (large && !pkg) { const ph = items.find(i => i.kind === 'service' && /^photography$/i.test(i.name)); if (ph) { ph.price += PHOTO_LARGE_FEE; ph.minutes += 15; } }
  const subtotal = items.reduce((a, i) => a + i.price, 0);
  const minutes = items.reduce((a, i) => a + (i.minutes || 0), 0);
  const twilight = items.some(i => /twilight photos/i.test(i.name)) || (pkg && (pkg.covers ?? []).some((c: string) => /twilight photos/i.test(byId.get(c)?.name ?? '')));
  return { items, subtotal, tax: 0, total: subtotal, minutes: Math.max(minutes, 30), large, sqft: opt?.max ?? null, twilight: !!twilight };
}

/* ---------------- Availability ---------------- */
async function ownerGoogleToken() {
  if (!G_ID || !G_SECRET) return null;
  const { data: owner } = await admin.from('team_members').select('id').eq('role', 'owner').eq('active', true).limit(1).maybeSingle();
  if (!owner) return null;
  const { data: acct } = await admin.from('google_accounts').select('*').eq('member_id', owner.id).maybeSingle();
  if (!acct) return null;
  if (acct.access_token && acct.access_expires_at && new Date(acct.access_expires_at).getTime() > Date.now() + 60_000) return acct.access_token as string;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: G_ID, client_secret: G_SECRET, grant_type: 'refresh_token', refresh_token: acct.refresh_token }) });
  const t = await r.json(); if (!r.ok) return null;
  await admin.from('google_accounts').update({ access_token: t.access_token, access_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('member_id', owner.id);
  return t.access_token as string;
}
async function busy(from: Date, to: Date) {
  const out: { s: number; e: number }[] = [];
  const holdSince = new Date(Date.now() - 30 * 60000).toISOString();
  const { data: bk } = await admin.from('bookings').select('shoot_start, shoot_end, status, created_at, gcal_event_id')
    .lt('shoot_start', to.toISOString()).gt('shoot_end', from.toISOString()).in('status', ['requested', 'scheduled']);
  const ownEvents = new Set<string>();
  for (const b of bk ?? []) {
    if (b.status === 'requested' && b.created_at < holdSince) continue; // abandoned checkout
    out.push({ s: Date.parse(b.shoot_start), e: Date.parse(b.shoot_end) });
    if (b.gcal_event_id) ownEvents.add(b.gcal_event_id);
  }
  let calendar = false;
  try {
    const tok = await ownerGoogleToken();
    if (tok) {
      const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', maxResults: '2500' });
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { Authorization: `Bearer ${tok}` } });
      if (r.ok) {
        calendar = true;
        for (const ev of (await r.json()).items ?? []) {
          if (ev.status === 'cancelled' || ev.transparency === 'transparent' || ownEvents.has(ev.id)) continue;
          if (!ev.start?.dateTime) continue; // all-day events (reminders, holidays) don't block shoots
          out.push({ s: Date.parse(ev.start.dateTime), e: Date.parse(ev.end.dateTime) });
        }
      }
    }
  } catch (_) { /* fall back to bookings only */ }
  return { intervals: out, calendar };
}
async function slots(cat: Awaited<ReturnType<typeof loadCatalog>>, minutes: number, fromDate?: string, days = 14) {
  const st = cat.settings, tz = st.timezone || 'America/New_York';
  const earliest = Date.now() + st.min_notice_hours * 3600_000;
  const start = fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate) ? fromDate : localDate(new Date(), tz);
  const horizonEnd = Date.now() + st.horizon_days * 86400_000;
  const dates: string[] = [];
  for (let i = 0; dates.length < Math.min(days, 31) && i < 62; i++) {
    const d = new Date(Date.parse(start + 'T12:00:00Z') + i * 86400_000).toISOString().slice(0, 10);
    if (zoned(d, '00:00', tz).getTime() > horizonEnd) break;
    dates.push(d);
  }
  if (!dates.length) return { tz, calendar: false, days: [] };
  const { intervals, calendar } = await busy(zoned(dates[0], '00:00', tz), zoned(dates[dates.length - 1], '23:59', tz));
  const buf = st.buffer_min * 60000, dur = minutes * 60000, step = st.slot_step * 60000;
  const out = dates.map(date => {
    const open = (st.work_days as number[]).includes(weekday(date));
    const times: { start: string; label: string }[] = [];
    if (open) {
      const dayEnd = zoned(date, String(st.day_end).slice(0, 5), tz).getTime();
      for (let t = zoned(date, String(st.day_start).slice(0, 5), tz).getTime(); t + dur <= dayEnd; t += step) {
        if (t < earliest) continue;
        if (intervals.some(b => t < b.e + buf && t + dur > b.s - buf)) continue;
        times.push({ start: new Date(t).toISOString(), label: new Date(t).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }) });
      }
    }
    return { date, open, times };
  });
  return { tz, calendar, days: out };
}

/* ---------------- Finalize (shared with webhook) ---------------- */
async function finalize(bookingId: string) {
  const { data: b } = await admin.from('bookings').select('*').eq('id', bookingId).single();
  if (!b) throw new UserError('Booking not found', 404);
  const live = !!b.stripe_livemode;
  let paymentStatus = b.payment_status, pm = b.stripe_payment_method_id;
  if (b.stripe_payment_intent_id) {
    const pi = await stripe(`/payment_intents/${b.stripe_payment_intent_id}`, undefined, 'GET', undefined, live);
    paymentStatus = pi.status === 'succeeded' ? 'paid' : pi.status === 'processing' ? 'processing' : pi.status === 'requires_payment_method' && pi.last_payment_error ? 'failed' : paymentStatus;
    pm = pi.payment_method ?? pm;
  } else if (b.stripe_setup_intent_id) {
    const si = await stripe(`/setup_intents/${b.stripe_setup_intent_id}`, undefined, 'GET', undefined, live);
    if (si.status === 'succeeded') paymentStatus = 'card_saved';
    pm = si.payment_method ?? pm;
  }
  const ready = ['paid', 'card_saved', 'processing'].includes(paymentStatus);
  const patch: Record<string, unknown> = { payment_status: paymentStatus, stripe_payment_method_id: pm, updated_at: new Date().toISOString() };
  if (paymentStatus === 'paid' && !b.paid) { patch.paid = true; patch.paid_at = new Date().toISOString(); }
  if (ready && b.status === 'requested') patch.status = 'scheduled';
  if (pm && b.stripe_customer_id && paymentStatus === 'card_saved') {
    await stripe(`/customers/${b.stripe_customer_id}`, { invoice_settings: { default_payment_method: pm } }, 'POST', undefined, live).catch(() => {});
  }
  const { data: updated } = await admin.from('bookings').update(patch).eq('id', b.id).select('*').single();
  if (ready && !b.gcal_event_id && updated) await addToCalendar(updated).catch(e => console.error('calendar', String(e)));
  return updated;
}
async function addToCalendar(b: Record<string, any>) {
  const tok = await ownerGoogleToken(); if (!tok) return;
  const items = (b.items as { name: string; kind: string }[]).map(i => i.name).join(', ');
  const ev = {
    summary: `${b.stripe_livemode ? '' : 'TEST '}📸 #${b.number} ${b.address}`,
    location: [b.address, b.unit, b.city, b.state, b.zip].filter(Boolean).join(', '),
    description: `Booked online${b.stripe_livemode ? '' : ' (TEST booking, no real payment)'}\n\nClient: ${b.client_name} · ${b.client_phone} · ${b.client_email}\nServices: ${items}\nSize: ${b.sqft_label ?? ''}${b.large_property ? ' (large property)' : ''}\nOccupancy: ${b.occupancy ?? ''}\nAccess: ${b.access_notes ?? ''}\nNotes: ${b.notes ?? ''}${(b.client_files ?? []).length ? `\nFiles: ${b.client_files.length} attached (open the order in HQ)` : ''}\nTotal: $${b.total} · ${b.payment_status}`,
    start: { dateTime: b.shoot_start }, end: { dateTime: b.shoot_end },
    extendedProperties: { private: { kv_booking: b.id } },
  };
  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
  if (r.ok) { const d = await r.json(); await admin.from('bookings').update({ gcal_event_id: d.id }).eq('id', b.id); }
}

/* ---------------- Clients ---------------- */
async function userFrom(req: Request) {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt.split('.').length !== 3) return null;
  const { data } = await admin.auth.getUser(jwt);
  return data?.user ?? null;
}
async function agentFor(email: string, name: string, phone: string, brokerage: string, userId?: string | null) {
  const em = email.trim().toLowerCase();
  let { data: agent } = await admin.from('agents').select('*').ilike('email', em).order('created_at').limit(1).maybeSingle();
  if (!agent) {
    const { data } = await admin.from('agents').insert({ full_name: name, email: em, phone, brokerage: brokerage || null, preferences: 'Created by online booking' }).select('*').single();
    agent = data;
  } else {
    const fill: Record<string, unknown> = {};
    if (!agent.phone && phone) fill.phone = phone;
    if (!agent.brokerage && brokerage) fill.brokerage = brokerage;
    if (Object.keys(fill).length) await admin.from('agents').update(fill).eq('id', agent.id);
  }
  if (userId && !agent.auth_user_id) await admin.from('agents').update({ auth_user_id: userId }).eq('id', agent.id);
  return agent;
}

/* ---------------- Stripe webhook (same endpoint, signed) ---------------- */
async function verifyStripe(raw: string, header: string) {
  const secrets = [KEYS.test.wh, KEYS.live.wh].filter(Boolean);
  if (!secrets.length) throw new UserError('Webhook secret not set', 503);
  const t = header.split(',').find(x => x.startsWith('t='))?.slice(2) ?? '';
  const sigs = header.split(',').filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new UserError('Bad signature', 400);
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
    const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
    if (sigs.some(s => s.length === hex.length && s.split('').every((c, i) => c === hex[i]))) return;
  }
  throw new UserError('Bad signature', 400);
}
async function webhook(req: Request) {
  const raw = await req.text();
  try { await verifyStripe(raw, req.headers.get('stripe-signature') ?? ''); }
  catch (e) { return new Response(String((e as Error).message), { status: 400 }); }
  const ev = JSON.parse(raw);
  const obj = ev.data?.object ?? {};
  const bookingId = obj.metadata?.booking_id ?? null;
  const { error: dup } = await admin.from('stripe_events').insert({ id: ev.id, type: ev.type, booking_id: bookingId });
  if (dup) return new Response('duplicate', { status: 200 });
  if (bookingId && /^(payment_intent|setup_intent)\./.test(ev.type)) {
    try { await finalize(bookingId); } catch (e) { console.error('webhook finalize', String(e)); await admin.from('stripe_events').delete().eq('id', ev.id); return new Response('retry', { status: 500 }); }
  }
  return new Response('ok', { status: 200 });
}

/* ---------------- Handler ---------------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.headers.get('stripe-signature')) return webhook(req);
  return reqMode.run({ live: LIVE_ORIGINS.includes(req.headers.get('origin') ?? '') }, () => handle(req));
});

async function handle(req: Request) {
  const LIVE = isLive();
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'config') {
      const { data: s } = await admin.from('booking_settings').select('payment_options, sqft_options, large_sqft, large_fee, large_label, timezone').eq('id', 1).single();
      const mode = stripeMode(), pk = LIVE ? KEYS.live.pk : KEYS.test.pk;
      const pkOk = LIVE ? pk.startsWith('pk_live_') : pk.startsWith('pk_test_');
      const page = await myPage(req).catch(() => null);
      const customPage = page ? { ...page, services: (await pageServices(page.id)).map(x => ({ id: x.id, kind: x.kind, name: x.name, description: x.description, includes: x.includes, price: +x.price, list_price: +x.list_price,
        duration_min: x.duration_min, covers: x.covers, badge: x.badge, sort_order: x.sort_order, category: x.category })) } : null;
      return json(req, { stripe: { mode, publishableKey: (mode === 'test' || mode === 'live') && pkOk ? pk : null }, settings: s, customPage });
    }

    if (action === 'quote') {
      const { cat } = await catalogFor(req, body);
      return json(req, price(cat, body));
    }

    if (action === 'slots') {
      const { cat } = await catalogFor(req, body);
      const q = price(cat, body);
      return json(req, { minutes: q.minutes, ...(await slots(cat, q.minutes, body.from, Number(body.days) || 14)) });
    }

    if (action === 'create') {
      if (!['test', 'live'].includes(stripeMode())) throw new UserError('Online payments are not switched on yet. Please call 865-855-5669 to book.', 503);
      const { cat, pageId } = await catalogFor(req, body);
      const q = price(cat, body);
      const a = body.address ?? {}, c = body.contact ?? {};
      const need = (v: unknown, label: string) => { if (!String(v ?? '').trim()) throw new UserError(`${label} is required.`); return String(v).trim().slice(0, 300); };
      const street = need(a.street, 'Street address'), city = need(a.city, 'City'), state = need(a.state, 'State'), zip = need(a.zip, 'ZIP');
      if (!/^\d{5}$/.test(zip)) throw new UserError('ZIP must be 5 digits.');
      const first = need(c.first, 'First name'), last = need(c.last, 'Last name'), email = need(c.email, 'Email'), phone = need(c.phone, 'Phone');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError('Enter a valid email.');
      if (phone.replace(/\D/g, '').length < 10) throw new UserError('Enter a 10-digit phone number.');
      const payOpt = String(body.paymentOption || 'save_card');
      if (!(cat.settings.payment_options as string[]).includes(payOpt)) throw new UserError('That payment option is not available.');
      const start = new Date(String(body.start || ''));
      if (isNaN(+start)) throw new UserError('Pick an appointment time.');
      // re-check the slot is still open
      const avail = await slots(cat, q.minutes, localDate(start, cat.settings.timezone), 1);
      if (!avail.days[0]?.times.some(t => t.start === start.toISOString())) throw new UserError('That time was just taken. Please pick another.', 409);

      const user = await userFrom(req);
      const verifiedUser = user && user.email && user.email.toLowerCase() === email.toLowerCase() ? user.id : null;
      const agent = await agentFor(email, `${first} ${last}`, phone, String(c.brokerage || ''), verifiedUser);

      const custCol = LIVE ? 'stripe_customer_id' : 'stripe_test_customer_id';
      let customer = agent[custCol] as string | null;
      if (!customer) {
        const cu = await stripe('/customers', { email: email.toLowerCase(), name: `${first} ${last}`, phone, metadata: { agent_id: agent.id } }, 'POST', `cust-${LIVE ? 'live' : 'test'}-${agent.id}`);
        customer = cu.id;
        await admin.from('agents').update({ [custCol]: customer }).eq('id', agent.id);
      }

      const { data: b, error } = await admin.from('bookings').insert({
        status: 'requested', source: 'public', agent_id: agent.id,
        client_name: `${first} ${last}`, client_email: email.toLowerCase(), client_phone: phone,
        address: street, unit: a.unit ? String(a.unit).slice(0, 60) : null, city, state, zip,
        sqft: q.sqft, sqft_label: a.sqftLabel ?? null, large_property: q.large,
        occupancy: a.occupancy || null, access_notes: a.access ? String(a.access).slice(0, 2000) : null, notes: c.notes ? String(c.notes).slice(0, 2000) : null, client_files: cleanFiles(a.files),
        items: q.items, subtotal: q.subtotal, tax: q.tax, total: q.total,
        shoot_start: start.toISOString(), shoot_end: new Date(+start + q.minutes * 60000).toISOString(), duration_min: q.minutes,
        payment_option: payOpt, stripe_customer_id: customer, stripe_livemode: LIVE, order_page_id: pageId,
      }).select('*').single();
      if (error) throw error;

      const meta = { booking_id: b.id, booking_number: String(b.number) };
      let clientSecret: string, intentType: 'payment' | 'setup';
      if (payOpt === 'pay_now') {
        const pi = await stripe('/payment_intents', { amount: Math.round(q.total * 100), currency: 'usd', customer, setup_future_usage: 'off_session',
          automatic_payment_methods: { enabled: true }, description: `Knox View #${b.number} · ${street}`, receipt_email: email.toLowerCase(), metadata: meta }, 'POST', `pi-${b.id}`);
        await admin.from('bookings').update({ stripe_payment_intent_id: pi.id }).eq('id', b.id);
        clientSecret = pi.client_secret; intentType = 'payment';
      } else {
        const si = await stripe('/setup_intents', { customer, usage: 'off_session', automatic_payment_methods: { enabled: true }, description: `Knox View #${b.number} · ${street}`, metadata: meta }, 'POST', `si-${b.id}`);
        await admin.from('bookings').update({ stripe_setup_intent_id: si.id }).eq('id', b.id);
        clientSecret = si.client_secret; intentType = 'setup';
      }
      return json(req, { booking: { id: b.id, number: b.number, token: b.public_token, total: q.total, start: b.shoot_start }, clientSecret, intentType });
    }

    if (action === 'confirm') { // called by the browser after Stripe confirms; webhook does the same
      const { data: b } = await admin.from('bookings').select('id').eq('id', String(body.bookingId || '')).eq('public_token', String(body.token || '')).maybeSingle();
      if (!b) throw new UserError('Booking not found', 404);
      const f = await finalize(b.id);
      return json(req, { number: f.number, status: f.status, paymentStatus: f.payment_status, start: f.shoot_start, total: f.total });
    }

    /* ----- signed-in client ----- */
    const user = await userFrom(req);
    if (!user) return json(req, { error: 'Please sign in.' }, 401);

    if (action === 'link') { // first sign-in: attach this login to the matching client record by verified email
      const em = (user.email || '').toLowerCase();
      let { data: agent } = await admin.from('agents').select('id, full_name, email, phone, brokerage, auth_user_id').eq('auth_user_id', user.id).maybeSingle();
      if (!agent && em) {
        const { data: match } = await admin.from('agents').select('id, full_name, email, phone, brokerage, auth_user_id').ilike('email', em).is('auth_user_id', null).order('created_at').limit(1).maybeSingle();
        if (match) { await admin.from('agents').update({ auth_user_id: user.id }).eq('id', match.id); agent = { ...match, auth_user_id: user.id }; }
      }
      return json(req, { agent });
    }

    if (action === 'portal') {
      const { data: agent } = await admin.from('agents').select('id, full_name, email, phone, brokerage').eq('auth_user_id', user.id).maybeSingle();
      if (!agent) return json(req, { agent: null, bookings: [], listings: [] });
      const { data: bks } = await admin.from('bookings').select('id, number, status, address, unit, city, state, zip, items, total, paid, paid_at, payment_status, payment_option, shoot_start, project_ids, cover_url, created_at, photos_url, photo_files, videos, tour_url, floorplan_url, website_url, media_files, require_payment')
        .eq('agent_id', agent.id).neq('status', 'cancelled').order('shoot_start', { ascending: false }).limit(200);
      // deliveries made outside the portal (HQ / Spiro era) for this client, not tied to a portal booking
      const { data: own } = await admin.from('projects').select('id, name, address, city, media, status, dropbox_url, vimeo_url, delivered_at, created_at, parent_project_id')
        .eq('agent_id', agent.id).neq('status', 'archived').order('created_at', { ascending: false }).limit(300);
      const pids = [...new Set((bks ?? []).flatMap(b => b.project_ids ?? []))];
      const { data: linked } = pids.length ? await admin.from('projects').select('id, name, media, status, dropbox_url, vimeo_url, delivered_at').in('id', pids) : { data: [] };
      const pmap = new Map((linked ?? []).map(p => [p.id, p]));
      const bookings = (bks ?? []).filter(b => b.status !== 'requested' || b.payment_status !== 'unpaid').map(b => {
        const media = (b.project_ids ?? []).map((id: string) => pmap.get(id)).filter(Boolean).map((p: any) => {
          const delivered = p.status === 'delivered';
          return { name: p.name, media: p.media, delivered, deliveredAt: p.delivered_at,
            // must-pay: links unlock only once the order is paid
            dropbox: delivered && b.paid && p.dropbox_url ? 'delivery' : null, vimeo: delivered && b.paid && p.vimeo_url ? 'delivery' : null };
        });
        // delivery links set on the booking in HQ count as delivered media too
        // (only true/false flags reach the client here; real file links come from the delivery page's signed links)
        if (b.photos_url || ((b.photo_files as any[]) ?? []).length || ((b.media_files as any[]) ?? []).some(f => (f?.kind || 'photo') === 'photo')) media.push({ name: 'Photos', media: 'photo', delivered: true, deliveredAt: null, dropbox: b.paid || b.require_payment === false ? 'delivery' : null, vimeo: null });
        for (const v of ((b.videos as any[]) ?? []).filter(v => v?.url)) media.push({ name: v.label || 'Video', media: 'video', delivered: true, deliveredAt: null, dropbox: null, vimeo: b.paid || b.require_payment === false ? 'delivery' : null });
        const extras = !!(b.tour_url || b.floorplan_url || b.website_url);
        const out = { ...b, project_ids: undefined, photos_url: undefined, photo_files: undefined, videos: undefined, tour_url: undefined, floorplan_url: undefined, website_url: undefined, media_files: undefined, media, hasDelivery: media.some((m: any) => m.delivered) || extras };
        return { ...out, require_payment: undefined, locked: out.hasDelivery && !b.paid && b.require_payment !== false };
      });
      // group outside deliveries by address into one listing each
      const groups = new Map<string, any>();
      for (const p of (own ?? []).filter(p => !pids.includes(p.id))) {
        const key = (p.address || p.name || p.id).trim().toLowerCase();
        const g = groups.get(key) ?? { id: 'p-' + p.id, address: p.address || p.name, city: p.city, date: p.delivered_at || p.created_at, media: [] };
        const delivered = p.status === 'delivered';
        g.media.push({ name: p.name, media: p.media, delivered, deliveredAt: p.delivered_at, dropbox: delivered && p.dropbox_url ? 'delivery' : null, vimeo: delivered && p.vimeo_url ? 'delivery' : null });
        if ((p.delivered_at || p.created_at) > g.date) g.date = p.delivered_at || p.created_at;
        groups.set(key, g);
      }
      return json(req, { agent, bookings, listings: [...groups.values()] });
    }

    if (action === 'profile') { // client updates their own contact details (email is their sign-in, so it isn't changed here)
      const { data: agent } = await admin.from('agents').select('id').eq('auth_user_id', user.id).maybeSingle();
      const clean = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
      const full_name = clean(body.full_name, 120), phone = clean(body.phone, 30), brokerage = clean(body.brokerage, 160), team_name = clean(body.team_name, 160);
      if (full_name.split(' ').length < 2) throw new UserError('Enter your first and last name.');
      if (phone && phone.replace(/\D/g, '').replace(/^1(?=\d{10})/, '').length !== 10) throw new UserError('Enter a 10-digit mobile number.');
      const patch = { full_name, phone: phone || null, brokerage: brokerage || null, team_name: team_name || null };
      let saved;
      if (agent) saved = (await admin.from('agents').update(patch).eq('id', agent.id).select('id, full_name, email, phone, brokerage, team_name').single()).data;
      else saved = (await admin.from('agents').insert({ ...patch, email: (user.email || '').toLowerCase(), auth_user_id: user.id, preferences: 'Created by portal settings' }).select('id, full_name, email, phone, brokerage, team_name').single()).data;
      return json(req, { agent: saved });
    }

    if (action === 'delivery') { // one listing's delivery page: websites, 3D tour, photos, videos, floor plans, marketing
      const { data: agent } = await admin.from('agents').select('id, full_name, brokerage, team_name').eq('auth_user_id', user.id).maybeSingle();
      if (!agent) throw new UserError('Delivery not found', 404);
      const key = String(body.key || '');
      const projCols = 'id, name, address, city, media, status, dropbox_url, vimeo_url, delivered_at, created_at';
      let head: Record<string, unknown>, b: any = null, projects: any[] = [];
      if (key.startsWith('p-')) { // deliveries made in HQ outside a portal order: every project for that address
        const { data: p0 } = await admin.from('projects').select(projCols).eq('id', key.slice(2)).eq('agent_id', agent.id).maybeSingle();
        if (!p0) throw new UserError('Delivery not found', 404);
        const k = (p0.address || p0.name || '').trim().toLowerCase();
        const { data: all } = await admin.from('projects').select(projCols).eq('agent_id', agent.id).neq('status', 'archived').limit(300);
        projects = (all ?? []).filter(p => (p.address || p.name || '').trim().toLowerCase() === k);
        head = { address: p0.address || p0.name, line2: p0.city || '', date: p0.delivered_at || p0.created_at };
      } else {
        const { data } = await admin.from('bookings').select('*').eq('id', key).eq('agent_id', agent.id).maybeSingle();
        if (!data || data.status === 'cancelled') throw new UserError('Delivery not found', 404);
        b = data;
        if ((b.project_ids ?? []).length) projects = (await admin.from('projects').select(projCols).in('id', b.project_ids)).data ?? [];
        head = { address: b.address + (b.unit ? ', ' + b.unit : ''), line2: [b.city, [b.state, b.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), date: b.shoot_start, number: b.number };
      }
      const locked = !!b && !b.paid && b.require_payment !== false; // pay before download (switch per order in HQ; HQ deliveries outside the portal are paid elsewhere)
      const done = projects.filter(p => p.status === 'delivered');
      const synced: { name: string; path: string }[] = ((b?.photo_files as any[]) ?? []).filter(f => f?.path); // synced from the order's Dropbox final photos folder, in Chris's order
      const photoLinks = [synced.length ? null : b?.photos_url, ...done.filter(p => p.media === 'photo').map(p => p.dropbox_url)].filter(Boolean).map(cleanDropboxLink);
      const videoLinks: { url: string; label?: string }[] = [...((b?.videos as any[]) ?? []).filter(v => v?.url), ...done.filter(p => p.media === 'video').flatMap(p => [p.vimeo_url && { url: p.vimeo_url, label: p.name }, p.dropbox_url && { url: p.dropbox_url, label: p.name }]).filter(Boolean)];
      // Clients never see Dropbox links: everything goes through our signed `media` links. Before payment they get previews only.
      const pretty = (n: string) => n.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const direct = ((b?.media_files as any[]) ?? []).filter(f => f?.url && /^https:\/\//.test(f.url));
      // photos: Dropbox folders (needs the Dropbox connection) + directly hosted files
      const photos: any[] = [], folders: any[] = [];
      if (synced.length) {
        const wm = locked ? { wm: 1 as const } : {};
        const dir = synced[0].path.replace(/\/[^/]+$/, '');
        folders.push({ zip: locked ? null : await sign({ src: 'dbxp', path: dir, v: 'zip', name: `${head.address} photos.zip`, dl: 1 }) });
        for (const f of synced) photos.push({ name: f.name,
          thumb: await sign({ src: 'dbxp', path: f.path, v: 'thumb', name: f.name, ...wm }),
          view: await sign({ src: 'dbxp', path: f.path, v: locked ? 'preview' : 'web', name: f.name, ...wm }),
          web: locked ? null : await sign({ src: 'dbxp', path: f.path, v: 'web', name: f.name, dl: 1 }),
          high: locked ? null : await sign({ src: 'dbxp', path: f.path, v: 'high', name: f.name, dl: 1 }) });
      }
      for (const link of [...new Set(photoLinks)]) {
        if (dropboxConfigured()) folders.push({ zip: locked ? null : await sign({ src: 'dbx', link, path: '', v: 'high', name: `${head.address} photos.zip`, dl: 1 }) });
        const files = await dropboxFiles(link).catch(e => { console.error('dropbox', String(e)); return null; });
        for (const f of (files ?? []).filter(f => f.kind === 'image')) photos.push({ name: f.name,
          thumb: await sign({ src: 'dbx', link, path: f.path, v: 'thumb', name: f.name, ...(locked ? { wm: 1 as const } : {}) }),
          view: await sign({ src: 'dbx', link, path: f.path, v: locked ? 'preview' : 'web', name: f.name, ...(locked ? { wm: 1 as const } : {}) }),
          web: locked ? null : await sign({ src: 'dbx', link, path: f.path, v: 'web', name: f.name, dl: 1 }),
          high: locked ? null : await sign({ src: 'dbx', link, path: f.path, v: 'high', name: f.name, dl: 1 }) });
      }
      let n = 0;
      for (const f of direct.filter(f => (f.kind || 'photo') === 'photo')) {
        const name = f.name || `${String(++n).padStart(3, '0')} ${pretty(f.url.split('/').pop() || 'photo')}.jpg`;
        photos.push({ name, thumb: await sign({ src: 'url', url: f.preview || f.url, v: 'thumb', name, ...(locked ? { wm: 1 as const } : {}) }),
          view: await sign(locked ? { src: 'url', url: f.preview || f.url, v: 'preview', name, wm: 1 } : { src: 'url', url: f.web || f.url, v: 'preview', name }),
          web: locked || !f.web ? null : await sign({ src: 'url', url: f.web, name, dl: 1 }),
          high: locked ? null : await sign({ src: 'url', url: f.url, name, dl: 1 }) });
      }
      // videos: Vimeo (player + phone-friendly MP4) or video files in a Dropbox folder. Before payment: the player only, as a preview.
      const videos: any[] = [];
      for (const v of videoLinks) {
        const vm = parseVimeo(v.url);
        if (vm) {
          const info = await vimeoInfo(vm.id).catch(() => null);
          const title = info?.name || v.label || 'Video';
          videos.push({ title, label: v.label || '', share: locked ? null : `https://vimeo.com/${vm.id}${vm.hash ? '/' + vm.hash : ''}`, embed: vimeoEmbed(vm), preview: locked,
            poster: info?.pictures?.base_link ? info.pictures.base_link + '_960x540' : null, portrait: info ? (info.height || 0) > (info.width || 0) : !!(v as any).portrait, duration: info?.duration || null,
            download: locked || !info?.download?.length ? null : await sign({ src: 'vimeo', vid: vm.id, name: `${head.address}${videoLinks.length > 1 ? ' - ' + title : ''}.mp4`, dl: 1 }) });
        } else if (/dropbox\.com/.test(v.url)) {
          const files = await dropboxFiles(v.url).catch(() => null);
          for (const f of (files ?? []).filter(f => f.kind === 'video')) videos.push({ title: f.name.replace(/\.[^.]+$/, ''), label: v.label || '', share: null, embed: null, poster: null, preview: locked,
            file: await sign({ src: 'dbx', link: cleanDropboxLink(v.url), path: f.path, v: 'high', name: f.name }),
            download: locked ? null : await sign({ src: 'dbx', link: cleanDropboxLink(v.url), path: f.path, v: 'high', name: f.name, dl: 1 }) });
          if (!files) videos.push({ title: v.label || 'Video', share: null, embed: null, poster: null, pending: true });
        } else videos.push({ title: v.label || 'Video', share: locked ? null : v.url, embed: null, poster: null, open: locked ? null : v.url, download: null });
      }
      // floor plans: directly hosted files, or a Dropbox file/folder
      const floorplans: any[] = [];
      for (const f of direct.filter(f => f.kind === 'floorplan')) {
        const name = f.name || `Floor plan - ${head.address}.${(f.url.split('.').pop() || 'jpg').slice(0, 4)}`;
        const wm = locked ? { wm: 1 as const } : {};
        floorplans.push({ name, thumb: await sign({ src: 'url', url: f.preview || f.url, v: 'thumb', name, ...wm }), view: await sign({ src: 'url', url: f.preview && locked ? f.preview : f.url, v: 'preview', name, ...wm }),
          web: null, high: locked ? null : await sign({ src: 'url', url: f.url, name, dl: 1 }) });
      }
      if (b?.floorplan_url && /dropbox\.com/.test(b.floorplan_url)) {
        const link = cleanDropboxLink(b.floorplan_url);
        const wm = locked ? { wm: 1 as const } : {};
        for (const f of ((await dropboxFiles(link).catch(() => null)) ?? []).filter(f => f.kind !== 'other')) floorplans.push({ name: f.name,
          thumb: f.kind === 'image' ? await sign({ src: 'dbx', link, path: f.path, v: 'thumb', name: f.name, ...wm }) : null,
          view: f.kind === 'image' ? await sign({ src: 'dbx', link, path: f.path, v: 'preview', name: f.name, ...wm }) : null,
          web: null, high: locked ? null : await sign({ src: 'dbx', link, path: f.path, v: 'high', name: f.name, dl: 1 }) });
      } else if (b?.floorplan_url) floorplans.push({ name: 'Floor plan', open: locked ? null : b.floorplan_url });
      const gate = (u: string | null) => locked ? null : u || null;
      return json(req, {
        head: { ...head, brokerage: [agent.team_name, agent.brokerage].filter(Boolean).join(' - ') || agent.full_name },
        locked, bookingId: b?.id ?? null, total: b ? +b.total : null,
        websites: b && b.websites_enabled !== false ? [
          { label: 'Branded property website', url: gate(b.website_url), soon: !b.website_url },
          { label: 'Unbranded property website', url: gate(b.website_unbranded_url), soon: !b.website_unbranded_url }] : [],
        tour: b?.tour_url ? { url: gate(b.tour_url) } : null, marketing: b?.marketing_url ? { url: gate(b.marketing_url) } : null,
        photos, folders, videos, floorplans,
        setup: { dropbox: dropboxConfigured(), vimeo: vimeoConfigured() },
      });
    }

    if (action === 'pay') { // pay an unpaid booking from the portal
      const { data: agent } = await admin.from('agents').select('id').eq('auth_user_id', user.id).maybeSingle();
      const { data: b } = await admin.from('bookings').select('*').eq('id', String(body.bookingId || '')).maybeSingle();
      if (!agent || !b || b.agent_id !== agent.id) throw new UserError('Booking not found', 404);
      if (b.paid) return json(req, { alreadyPaid: true });
      const bl = !!b.stripe_livemode;
      const piId = b.stripe_payment_intent_id;
      let pi = piId ? await stripe(`/payment_intents/${piId}`, undefined, 'GET', undefined, bl) : null;
      if (!pi || ['canceled', 'succeeded'].includes(pi.status)) {
        pi = await stripe('/payment_intents', { amount: Math.round(+b.total * 100), currency: 'usd', customer: b.stripe_customer_id,
          automatic_payment_methods: { enabled: true }, description: `Knox View #${b.number} · ${b.address}`, receipt_email: b.client_email, metadata: { booking_id: b.id, booking_number: String(b.number) } }, 'POST', undefined, bl);
        await admin.from('bookings').update({ stripe_payment_intent_id: pi.id }).eq('id', b.id);
      }
      return json(req, { clientSecret: pi.client_secret, intentType: 'payment', booking: { id: b.id, token: b.public_token, total: +b.total } });
    }

    return json(req, { error: 'Unknown action' }, 400);
  } catch (e) {
    const status = e instanceof UserError ? e.status : 500;
    if (status >= 500) console.error('booking error:', String((e as Error)?.message || e));
    return json(req, { error: e instanceof UserError ? e.message : 'Something went wrong. Please try again or call 865-855-5669.' }, status);
  }
}
