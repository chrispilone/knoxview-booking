import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// List price on each order (RentCast). Built to stay inside a monthly request budget:
//   run    (weekly, from pg_cron with header x-hq-hook = app_secrets 'listprice_hook'; or an HQ super admin)
//            1. free: orders whose agent typed a price into their property website take that price
//            2. one request per city: new listings in that city (last 60 days), matched to delivered orders still
//               missing a price (delivered in the last 45 days)
//            3. optional backfill (Settings): in the last week of a billing cycle, leftover requests look up older
//               orders one address at a time, newest first (keeps 5 requests in reserve for "Check now")
//   check  { bookingId, allowOver? }  -> one address lookup: list price + 2-3 dated notes. Over budget it answers
//            { needsOk } until HQ confirms going over.
//   manual { bookingId, price }       -> price typed in HQ
//   status                            -> budget this cycle, pending orders, which keys are set (RentCast, Quo)
//   settings { cap?, backfill?, extra? } -> monthly cap, backfill on/off, extra requests allowed this cycle
// Budget: every RentCast request is a row in rentcast_calls. The cycle starts on booking_settings.rentcast_cycle_day
// (RentCast bills from the day the plan was turned on). HQ gets a notification at 10 left and when the cap is hit;
// automatic checks stop at the cap; "Check now" asks before going over. Needs secret RENTCAST_API_KEY.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const RC = 'https://api.rentcast.io/v1';
const ORIGINS = ['https://hq.knoxview.com', 'http://localhost:8888', 'http://localhost:5173'];
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-hq\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hq-hook', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }

const TZ = 'America/New_York';
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // 2026-11-19
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const day = (s: string | null | undefined) => s ? new Date(s).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }) : '';

// ---- budget ----
function cycleStart(set: any, now = new Date()) {
  const d = Math.min(Math.max(+set.rentcast_cycle_day || 1, 1), 28);
  const [y, m, dd] = ymd(now).split('-').map(Number);
  let yy = y, mm = m;
  if (dd < d) { mm -= 1; if (mm < 1) { mm = 12; yy -= 1; } }
  return `${yy}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function cycleEnd(start: string) { const [y, m, d] = start.split('-').map(Number); const n = new Date(Date.UTC(y, m, d)); return n.toISOString().slice(0, 10); }
async function budget(set: any) {
  const start = cycleStart(set);
  // cycle starts at midnight Eastern on the cycle day
  const startTs = new Date(`${start}T05:00:00Z`).toISOString();
  const { count } = await admin.from('rentcast_calls').select('id', { count: 'exact', head: true }).gte('at', startTs);
  const extra = set.rentcast_extra_cycle === start ? (+set.rentcast_extra || 0) : 0;
  const allowed = (+set.rentcast_cap || 0) + extra;
  return { start, end: cycleEnd(start), used: count ?? 0, cap: +set.rentcast_cap || 0, extra, allowed, left: Math.max(0, allowed - (count ?? 0)) };
}
async function notifyOwner(title: string, body: string) {
  const { data: owners } = await admin.from('team_members').select('id').eq('role', 'owner').eq('active', true);
  if (owners?.length) await admin.from('notifications').insert(owners.map(o => ({ member_id: o.id, kind: 'rentcast', title, body })));
}
// after each request: warn at 10 left, and once when the cap is reached (each once per cycle)
async function budgetAlerts(set: any) {
  const b = await budget(set);
  if (b.left === 0 && set.rentcast_capped_cycle !== b.start) {
    await admin.from('booking_settings').update({ rentcast_capped_cycle: b.start }).eq('id', 1); set.rentcast_capped_cycle = b.start;
    await notifyOwner('RentCast budget reached', `All ${b.allowed} list-price lookups for this billing month are used. Automatic checks are paused until ${day(b.end)}. To allow more (each one past RentCast's free 50 is $0.20), go to Settings → Integrations → List prices.`);
  } else if (b.left <= 10 && b.left > 0 && set.rentcast_warned_cycle !== b.start) {
    await admin.from('booking_settings').update({ rentcast_warned_cycle: b.start }).eq('id', 1); set.rentcast_warned_cycle = b.start;
    await notifyOwner('RentCast: 10 lookups left', `${b.used} of ${b.allowed} list-price lookups used this billing month (resets ${day(b.end)}).`);
  }
  return b;
}

// ---- RentCast ----
async function rc(path: string, kind: 'city' | 'address', bookingIds: string[], by: string | null, over = false) {
  const key = env('RENTCAST_API_KEY');
  if (!key) throw new Bad("RentCast isn't connected (RENTCAST_API_KEY is missing).", 409);
  const r = await fetch(RC + path, { headers: { 'X-Api-Key': key, Accept: 'application/json' } });
  const t = await r.text();
  let j: any = null; try { j = t ? JSON.parse(t) : null; } catch (_) { j = null; }
  const rows = Array.isArray(j) ? j : j && j.id ? [j] : [];
  await admin.from('rentcast_calls').insert({ kind, query: path.split('?')[1]?.slice(0, 300) ?? path, booking_ids: bookingIds, results: rows.length, http: r.status, ok: r.ok || r.status === 404, by_member: by, over_budget: over });
  if (!r.ok && r.status !== 404) throw new Bad(`RentCast said ${r.status}: ${(j?.message || t).toString().split(key).join('[key]').slice(0, 160)}`, 502);
  return rows;
}

// ---- matching ----
const ABBR: Record<string, string> = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', circle: 'cir', court: 'ct', boulevard: 'blvd', place: 'pl', trail: 'trl',
  parkway: 'pkwy', highway: 'hwy', terrace: 'ter', cove: 'cv', point: 'pt', way: 'way', north: 'n', south: 's', east: 'e', west: 'w', northwest: 'nw', northeast: 'ne', southwest: 'sw', southeast: 'se', mount: 'mt' };
const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[#.,']/g, ' ').split(/[^a-z0-9]+/).filter(Boolean).map(w => ABBR[w] ?? w).join(' ');
const unitOf = (s: string) => norm(s).replace(/^(apt|unit|ste|suite|lot)\s+/, '');
function sameHome(b: any, L: any) {
  if (norm(b.address) !== norm(L.addressLine1 || String(L.formattedAddress || '').split(',')[0])) return false;
  if (b.unit && L.addressLine2) return unitOf(b.unit) === unitOf(L.addressLine2);
  return true;
}
const fullAddress = (b: any) => `${b.address}${b.unit ? ' ' + b.unit : ''}, ${b.city}, ${b.state} ${b.zip || ''}`.trim();

// 2-3 short, dated talking points from one listing record
function bulletsFor(L: any, b: any): string[] {
  const out: string[] = [];
  const active = String(L.status || '').toLowerCase() === 'active';
  if (active) out.push(`Listed ${day(L.listedDate)} at ${money(L.price)}${L.daysOnMarket != null ? ` · ${L.daysOnMarket} day${L.daysOnMarket === 1 ? '' : 's'} on market` : ''}`);
  else out.push(`Off the market since ${day(L.removedDate) || 'recently'}${L.daysOnMarket != null ? ` after ${L.daysOnMarket} days` : ''} (last listed at ${money(L.price)}). Likely sold or pulled, worth asking.`);
  // price changes and earlier listings, from the listing history
  const hist = Object.entries(L.history || {}).map(([d, h]: any) => ({ d, ...h })).filter(h => h.price).sort((x, y) => x.d.localeCompare(y.d));
  const thisRun = hist.filter(h => !L.listedDate || h.d >= String(L.listedDate).slice(0, 10));
  if (thisRun.length > 1) {
    const first = thisRun[0].price, last = thisRun[thisRun.length - 1].price;
    if (first !== last) out.push(`Price ${last < first ? 'cut' : 'raised'} ${money(Math.abs(first - last))} since listing (${money(first)} to ${money(last)}, ${day(thisRun[thisRun.length - 1].d)})`);
  }
  const earlier = hist.filter(h => L.listedDate && h.d < String(L.listedDate).slice(0, 10));
  if (earlier.length && out.length < 3) out.push(`Was on the market before (${day(earlier[earlier.length - 1].d)} at ${money(earlier[earlier.length - 1].price)})`);
  if (out.length < 3) {
    const bits = [L.bedrooms != null && `${L.bedrooms} bd`, L.bathrooms != null && `${L.bathrooms} ba`, L.squareFootage && `${Number(L.squareFootage).toLocaleString('en-US')} sq ft`,
      L.squareFootage && L.price && `${money(L.price / L.squareFootage)}/sq ft`, L.yearBuilt && `built ${L.yearBuilt}`].filter(Boolean);
    if (bits.length) out.push(bits.join(' · '));
  }
  if (out.length < 3) {
    const ag = L.listingAgent?.name, off = L.listingOffice?.name;
    if (ag || off) {
      const client = String(b.client_name || '').toLowerCase().split(/\s+/).pop();
      const other = ag && client && !ag.toLowerCase().includes(client);
      out.push(`Listed by ${[ag, off].filter(Boolean).join(', ')}${other ? ` (not ${b.client_name}: co-listing or a different agent?)` : ''}`);
    }
  }
  return out.slice(0, 3);
}

// save what a listing says onto the order (+ a dated row in listing_checks); fills the property website's price if empty
async function saveFound(b: any, L: any, source: 'rentcast_city' | 'rentcast_address', by: string | null) {
  const at = new Date().toISOString();
  const bullets = bulletsFor(L, b);
  const upd: any = { list_price: L.price ?? null, listing_status: L.status ?? null, listed_on: L.listedDate ? String(L.listedDate).slice(0, 10) : null,
    listing_dom: L.daysOnMarket ?? null, listing_office: L.listingOffice?.name ?? null, listing_agent: L.listingAgent?.name ?? null, listing_mls: L.mlsNumber ?? null,
    listing_source: 'rentcast', listing_checked_at: at, listing_notes: { at, source, bullets } };
  const facts = b.site?.facts;
  if (L.price && Array.isArray(facts)) {
    const f = facts.find((x: any) => x.k === 'price' || x.icon === 'price');
    if (f && !String(f.value || '').trim()) { f.value = String(Math.round(L.price)); upd.site = { ...b.site, facts }; }
  }
  await admin.from('bookings').update(upd).eq('id', b.id);
  await admin.from('listing_checks').insert({ booking_id: b.id, at, source, found: true, status: L.status ?? null, price: L.price ?? null, listed_on: upd.listed_on, dom: L.daysOnMarket ?? null, bullets, by_member: by });
  return { ...upd, bullets };
}

const SEL = 'id, number, address, unit, city, state, zip, client_name, status, delivered_at, shoot_start, created_at, list_price, listing_source, listing_checked_at, site';

async function run(set: any, by: string | null) {
  const report: any = { agentPrices: 0, cities: [], matched: 0, backfill: 0, stopped: null };
  // 1. free: agent-entered prices on property websites
  const { data: noPrice } = await admin.from('bookings').select(SEL).is('list_price', null).not('site', 'is', null).limit(1000);
  for (const b of noPrice ?? []) {
    const f = (b.site?.facts ?? []).find((x: any) => x.k === 'price' || x.icon === 'price');
    const v = Number(String(f?.value ?? '').replace(/[^0-9.]/g, ''));
    if (v > 1000) {
      const at = new Date().toISOString();
      await admin.from('bookings').update({ list_price: v, listing_source: 'agent', listing_checked_at: at }).eq('id', b.id);
      await admin.from('listing_checks').insert({ booking_id: b.id, at, source: 'agent', found: true, price: v, bullets: [`Price ${money(v)} entered by the agent on the property website`] });
      report.agentPrices++;
    }
  }
  // 2. one request per city for delivered orders (last 45 days) still missing a price
  const since = new Date(Date.now() - 45 * 864e5).toISOString();
  const { data: pend } = await admin.from('bookings').select(SEL).eq('status', 'completed').is('list_price', null).gte('delivered_at', since).limit(500);
  const byCity = new Map<string, any[]>();
  for (const b of pend ?? []) { if (!b.city || !b.state || !b.address) continue; const k = `${b.city.trim()}|${b.state.trim().toUpperCase()}`; byCity.set(k, [...(byCity.get(k) ?? []), b]); }
  for (const [k, list] of byCity) {
    const bud = await budget(set);
    if (bud.left <= 0) { report.stopped = 'budget'; await budgetAlerts(set); break; }
    const [city, state] = k.split('|');
    const rows = await rc(`/listings/sale?city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&daysOld=60&limit=500`, 'city', list.map(b => b.id), by);
    let hit = 0;
    for (const b of list) {
      const L = rows.find((r: any) => sameHome(b, r));
      if (L) { await saveFound(b, L, 'rentcast_city', by); hit++; }
      else await admin.from('bookings').update({ listing_checked_at: new Date().toISOString() }).eq('id', b.id);
    }
    report.cities.push({ city, state, orders: list.length, listings: rows.length, matched: hit }); report.matched += hit;
    await budgetAlerts(set);
  }
  // 3. backfill older orders with leftover requests, only in the last week of the cycle
  if (set.rentcast_backfill && !report.stopped) {
    const bud = await budget(set);
    const daysLeft = (new Date(`${bud.end}T05:00:00Z`).getTime() - Date.now()) / 864e5;
    let spend = daysLeft <= 7 ? bud.left - 5 : 0;
    if (spend > 0) {
      const { data: old } = await admin.from('bookings').select(SEL).eq('status', 'completed').is('list_price', null).is('listing_checked_at', null).lt('delivered_at', since)
        .order('delivered_at', { ascending: false }).limit(spend);
      for (const b of old ?? []) {
        if (spend-- <= 0) break;
        await checkOne(b, by, false);
        report.backfill++;
      }
      await budgetAlerts(set);
    }
  }
  return report;
}

async function checkOne(b: any, by: string | null, over: boolean) {
  const rows = await rc(`/listings/sale?address=${encodeURIComponent(fullAddress(b))}&limit=1`, 'address', [b.id], by, over);
  const L = rows.find((r: any) => sameHome(b, r)) || rows[0];
  if (L) return { found: true, ...(await saveFound(b, L, 'rentcast_address', by)) };
  const at = new Date().toISOString();
  const bullets = [`No listing on RentCast for this address yet`];
  await admin.from('bookings').update({ listing_checked_at: at, listing_notes: { at, source: 'rentcast_address', bullets } }).eq('id', b.id);
  await admin.from('listing_checks').insert({ booking_id: b.id, at, source: 'rentcast_address', found: false, bullets, by_member: by });
  return { found: false, listing_checked_at: at, bullets };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const body = await req.json().catch(() => ({} as any));
    const { data: set } = await admin.from('booking_settings').select('*').eq('id', 1).single();
    const hook = req.headers.get('x-hq-hook');
    if (hook) {
      const { data } = await admin.from('app_secrets').select('value').eq('key', 'listprice_hook').maybeSingle();
      if (!data?.value || data.value !== hook) return new Response('forbidden', { status: 403 });
      if (body.action !== 'run') return json(req, { ok: true, ignored: true });
      const report = await run(set, null);
      console.log('listprice run', JSON.stringify(report));
      return json(req, { ok: true, report });
    }
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
    const { data: me } = u?.user ? await admin.from('team_members').select('id, role, active, permissions').eq('id', u.user.id).maybeSingle() : { data: null };
    if (!me?.active || !(me.role === 'owner' || me.permissions?.super_admin === true)) throw new Bad('Only HQ super admins can use list prices.', 403);

    if (body.action === 'status') {
      const b = await budget(set);
      const since = new Date(Date.now() - 45 * 864e5).toISOString();
      const { count: pending } = await admin.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'completed').is('list_price', null).gte('delivered_at', since);
      const { count: older } = await admin.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'completed').is('list_price', null).is('listing_checked_at', null).lt('delivered_at', since);
      return json(req, { ...b, pending: pending ?? 0, older: older ?? 0, backfill: !!set.rentcast_backfill, rentcast: !!env('RENTCAST_API_KEY'), quo: !!env('QUO_API_KEY') });
    }
    if (body.action === 'settings') {
      const upd: any = {};
      if (body.cap != null) { const c = Math.round(+body.cap); if (!(c >= 0 && c <= 5000)) throw new Bad('Cap must be 0–5000.'); upd.rentcast_cap = c; upd.rentcast_capped_cycle = null; upd.rentcast_warned_cycle = null; }
      if (body.backfill != null) upd.rentcast_backfill = !!body.backfill;
      if (body.extra != null) { const x = Math.round(+body.extra); if (!(x >= 0 && x <= 5000)) throw new Bad('Extra must be 0–5000.'); upd.rentcast_extra = x; upd.rentcast_extra_cycle = cycleStart(set); upd.rentcast_capped_cycle = null; }
      await admin.from('booking_settings').update(upd).eq('id', 1);
      Object.assign(set, upd);
      return json(req, { ok: true, ...(await budget(set)), backfill: !!set.rentcast_backfill });
    }
    if (body.action === 'check') {
      const { data: b } = await admin.from('bookings').select(SEL).eq('id', String(body.bookingId || '')).maybeSingle();
      if (!b) throw new Bad('Order not found.', 404);
      if (!b.address || !b.city || !b.state) throw new Bad('This order needs a street, city and state first.');
      const bud = await budget(set);
      if (bud.left <= 0 && !body.allowOver) return json(req, { needsOk: true, used: bud.used, allowed: bud.allowed, resets: bud.end });
      const r = await checkOne(b, me.id, bud.left <= 0);
      const after = await budgetAlerts(set);
      return json(req, { ok: true, ...r, used: after.used, allowed: after.allowed });
    }
    if (body.action === 'manual') {
      const v = body.price == null || body.price === '' ? null : Number(String(body.price).replace(/[^0-9.]/g, ''));
      if (v != null && !(v > 0)) throw new Bad('Enter a price.');
      const at = new Date().toISOString();
      await admin.from('bookings').update({ list_price: v, listing_source: v == null ? null : 'manual', listing_checked_at: at }).eq('id', String(body.bookingId || ''));
      await admin.from('listing_checks').insert({ booking_id: String(body.bookingId), at, source: 'manual', found: v != null, price: v, bullets: [v == null ? 'List price cleared in HQ' : `List price set to ${money(v)} in HQ`], by_member: me.id });
      return json(req, { ok: true });
    }
    if (body.action === 'run') return json(req, { ok: true, report: await run(set, me.id) });
    throw new Bad('Unknown action.');
  } catch (e) {
    const err = e as Bad;
    console.error('listprice', err.message);
    return json(req, { error: err.message || 'Something went wrong' }, err.status || 500);
  }
});
