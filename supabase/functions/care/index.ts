import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// Client Care: keeps the roster (cc_clients) in step with Spiro and HQ orders. HQ builds each day's call list itself.
//   refresh  (nightly from pg_cron with header x-hq-hook = app_secrets 'care_hook', or an HQ super admin)
//     - every delivered Spiro order (Spiro's API, read-only) + every completed HQ order that didn't come from Spiro
//     - grouped by client: shoots in the last 12 months, last shoot (date, address, package), first order (date,
//       delivery date, address, media, photographer), phone and email (Spiro's agent list, else HQ's client record)
//     - tier from booking_settings.care.tiers ([10,4,2] = Tier 1 is 10+, Tier 2 4-9, Tier 3 2-3, Tier 4 the rest);
//       pinned clients stay Tier 1. Calls, push-to-later, follow-up dates and team-account numbers set in HQ are kept.
// Never writes to Spiro. Needs SPIRO_API_KEY.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const ORIGINS = ['https://hq.knoxview.com', 'http://localhost:8888', 'http://localhost:5173'];
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-hq\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hq-hook', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }

// ---- Spiro (read-only; rate-limited per key, so one call at a time with a pause on 429) ----
async function spiro(path: string, tries = 4): Promise<any> {
  const key = env('SPIRO_API_KEY'); if (!key) throw new Bad('SPIRO_API_KEY is missing.', 409);
  for (let t = 0; t < tries; t++) {
    const r = await fetch('https://api.spiro.media/api/v1' + path, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 15000 * (t + 1))); continue; }
    const txt = await r.text();
    if (!r.ok) throw new Bad(`Spiro said ${r.status}: ${txt.split(key).join('[key]').slice(0, 160)}`, 502);
    return txt ? JSON.parse(txt) : null;
  }
  throw new Bad('Spiro is rate-limiting us. Try again in a minute.', 429);
}
async function spiroAll(path: string) {
  const out: any[] = [];
  for (let page = 1; page < 200; page++) {
    const j = await spiro(`${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=100`);
    out.push(...(j?.data ?? [])); if (!j?.meta?.hasNextPage) break;
  }
  return out;
}


// ---- Quo (read-only here) and Claude ----
async function quo(path: string): Promise<any> {
  const key = env('QUO_API_KEY'); if (!key) throw new Bad('QUO_API_KEY is missing.', 409);
  for (let t = 0; t < 3; t++) {
    const r = await fetch('https://api.openphone.com/v1' + path, { headers: { Authorization: key, Accept: 'application/json' } });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 1500 * (t + 1))); continue; }
    if (r.status === 404) return null;
    const txt = await r.text();
    if (!r.ok) throw new Bad(`Quo said ${r.status} for ${path.split('?')[0]}: ${txt.split(key).join('[key]').slice(0, 200)}`, 502);
    return txt ? JSON.parse(txt) : null;
  }
  throw new Bad('Quo is rate-limiting us.', 429);
}
const CLAUDE_MODEL = 'claude-haiku-5-5';
async function claude(prompt: string, maxTokens = 400, system?: string): Promise<{ text?: string; error?: string }> {
  const key = env('ANTHROPIC_API_KEY'); if (!key) return { error: 'ANTHROPIC_API_KEY is missing' };
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `${r.status} ${j?.error?.message || ''}`.trim() };
  return { text: (j.content ?? []).map((c: any) => c.text || '').join('').trim() };
}

const fmtPhone = (p: string) => { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : (p || null); };
const dayOf = (s: string | null | undefined) => s ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(s)) : null;
const mediaOf = (m: any) => [m?.photoCount && `${m.photoCount} photos`, m?.videoCount && `${m.videoCount} video${m.videoCount === 1 ? '' : 's'}`, m?.floorPlanCount && 'floor plan', m?.virtualTourCount && '3D tour'].filter(Boolean).join(', ');

async function refresh(set: any) {
  const care = set.care || {};
  const [t1, t2, t3] = (care.tiers || [10, 4, 2]).map(Number);
  const yearAgo = Date.now() - 365 * 864e5;
  type Ord = { at: string; day: string | null; address: string; pkg: string; delivered: string | null; media: string; photographer: string | null; hq: string | null };
  const groups = new Map<string, { spiro: string | null; agent: string | null; name: string; company: string; orders: Ord[] }>();
  const keyFor = (spiroId: string | null, agentId: string | null) => spiroId ? 's:' + spiroId : 'a:' + agentId;

  // HQ clients (to link Spiro agents to HQ client records and fill contact details)
  const { data: agents } = await admin.from('agents').select('id, full_name, email, phone, brokerage, spiro_agent_id').limit(5000);
  const agentBySpiro = new Map((agents ?? []).filter(a => a.spiro_agent_id).map(a => [a.spiro_agent_id, a]));
  const agentById = new Map((agents ?? []).map(a => [a.id, a]));

  // 1. Spiro: delivered orders + agent contacts
  const sOrders = await spiroAll('/orders?filter[status][eq]=delivered&filter[dateSubmitted][gte]=2015-01-01');
  const sAgents = await spiroAll('/agents');
  const contact = new Map(sAgents.map((a: any) => [a.identity?.agentId, a]));
  const { data: imported } = await admin.from('bookings').select('id, spiro_order_id').not('spiro_order_id', 'is', null).limit(5000);
  const hqOf = new Map((imported ?? []).map(b => [b.spiro_order_id, b.id]));
  for (const o of sOrders) {
    const sid = o.client?.agentId; if (!sid) continue;
    const k = keyFor(sid, null);
    const g = groups.get(k) || { spiro: sid, agent: agentBySpiro.get(sid)?.id ?? null, name: o.client?.agentName || 'Unknown', company: o.client?.companyName || '', orders: [] };
    const at = o.primaryAppointment?.arrivalWindowStart || o.dateSubmitted;
    g.orders.push({ at, day: dayOf(at), address: o.property?.address?.fullAddress || o.mediaTitle || '', pkg: o.bundle?.name || '', delivered: o.website?.deliveredAt || null,
      media: mediaOf(o.media), photographer: o.primaryAppointment?.photographer?.name || null, hq: hqOf.get(o.orderId) ?? null });
    groups.set(k, g);
  }
  // 2. HQ orders that didn't come from Spiro
  const { data: hqb } = await admin.from('bookings').select('id, agent_id, client_name, address, city, state, shoot_start, created_at, delivered_at, items, source, status')
    .eq('status', 'completed').or('source.is.null,source.neq.spiro').not('agent_id', 'is', null).limit(5000);
  for (const b of hqb ?? []) {
    const a = agentById.get(b.agent_id);
    const k = a?.spiro_agent_id ? keyFor(a.spiro_agent_id, null) : keyFor(null, b.agent_id);
    const g = groups.get(k) || { spiro: a?.spiro_agent_id ?? null, agent: b.agent_id, name: a?.full_name || b.client_name || 'Unknown', company: a?.brokerage || '', orders: [] };
    if (!g.agent) g.agent = b.agent_id;
    const at = b.shoot_start || b.created_at;
    const pkg = ((b.items as any[]) ?? []).find(i => i.kind === 'package')?.name || ((b.items as any[]) ?? [])[0]?.name || '';
    g.orders.push({ at, day: dayOf(at), address: [b.address, b.city, b.state].filter(Boolean).join(', '), pkg, delivered: b.delivered_at, media: ((b.items as any[]) ?? []).map(i => i.name).filter(Boolean).slice(0, 4).join(', '), photographer: null, hq: b.id });
    groups.set(k, g);
  }

  // 3. upsert, keeping everything set in HQ
  const { data: existing } = await admin.from('cc_clients').select('id, spiro_agent_id, agent_id, tier_pinned');
  const exBySpiro = new Map((existing ?? []).filter(x => x.spiro_agent_id).map(x => [x.spiro_agent_id, x]));
  const exByAgent = new Map((existing ?? []).filter(x => x.agent_id).map(x => [x.agent_id, x]));
  const pinned = new Set(((care.pinned as string[]) ?? []));
  const now = new Date().toISOString();
  let added = 0, updated = 0;
  const rows: any[] = [];
  for (const g of groups.values()) {
    const os = g.orders.sort((x, y) => String(x.at).localeCompare(String(y.at)));
    const first = os[0], last = os[os.length - 1];
    const n12 = os.filter(o => new Date(o.at).getTime() >= yearAgo).length;
    const ex = (g.spiro && exBySpiro.get(g.spiro)) || (g.agent && exByAgent.get(g.agent)) || null;
    const c = g.spiro ? contact.get(g.spiro) : null, a = g.agent ? agentById.get(g.agent) : null;
    const isPinned = ex?.tier_pinned || (ex && pinned.has(ex.id));
    const tier = isPinned ? 1 : n12 >= t1 ? 1 : n12 >= t2 ? 2 : n12 >= t3 ? 3 : 4;
    const row: any = {
      spiro_agent_id: g.spiro, agent_id: g.agent, name: c ? `${c.identity?.firstName ?? ''} ${c.identity?.lastName ?? ''}`.trim() || g.name : g.name,
      company: c?.company?.companyName || g.company || a?.brokerage || null,
      phone: fmtPhone(c?.contact?.phoneNumber || a?.phone || ''), email: (c?.contact?.emailAddress || a?.email || '').toLowerCase() || null,
      shoots_12m: n12, shoots_all: os.length, tier,
      last_shoot: last.day, last_order_address: last.address, last_order_pkg: last.pkg, last_order_hq: last.hq, last_order_at: last.at,
      first_order: first.day, first_delivered: dayOf(first.delivered), first_address: first.address, first_media: [first.pkg, first.media].filter(Boolean).join(' · '), first_photographer: first.photographer,
      refreshed_at: now,
    };
    if (ex) { row.id = ex.id; updated++; } else added++;
    rows.push(row);
  }
  // write in batches; new rows first (no id), then updates by id
  const fresh = rows.filter(r => !r.id), upd = rows.filter(r => r.id);
  for (let i = 0; i < fresh.length; i += 200) { const { error } = await admin.from('cc_clients').insert(fresh.slice(i, i + 200)); if (error) throw new Error('insert: ' + error.message); }
  for (const r of upd) { const { id, ...rest } = r; const { error } = await admin.from('cc_clients').update(rest).eq('id', id); if (error) throw new Error('update: ' + error.message); }
  const tiers = [1, 2, 3, 4].map(t => rows.filter(r => r.tier === t).length);
  await admin.from('booking_settings').update({ care: { ...care, syncedAt: now, lastSync: { at: now, added, updated, spiroOrders: sOrders.length, hqOrders: (hqb ?? []).length, tiers } } }).eq('id', 1);
  return { added, updated, clients: rows.length, tiers, spiroOrders: sOrders.length, hqOrders: (hqb ?? []).length };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const body = await req.json().catch(() => ({} as any));
    const { data: set } = await admin.from('booking_settings').select('care').eq('id', 1).single();
    const hook = req.headers.get('x-hq-hook');
    if (hook) {
      const { data } = await admin.from('app_secrets').select('value').eq('key', 'care_hook').maybeSingle();
      if (!data?.value || data.value !== hook) return new Response('forbidden', { status: 403 });
      const r = body.action === 'refresh' ? await refresh(set) : { ignored: true };
      console.log('care', body.action, JSON.stringify(r));
      return json(req, { ok: true, ...r });
    }
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
    const { data: me } = u?.user ? await admin.from('team_members').select('id, role, active, permissions').eq('id', u.user.id).maybeSingle() : { data: null };
    if (!me?.active || !(me.role === 'owner' || me.permissions?.super_admin === true)) throw new Bad('Only HQ super admins can use Client Care.', 403);
    if (body.action === 'refresh') return json(req, { ok: true, ...(await refresh(set)) });
    if (body.action === 'status') { // which keys work (no secrets returned)
      const out: any = { quo: !!env('QUO_API_KEY'), anthropic: !!env('ANTHROPIC_API_KEY') };
      if (out.anthropic) { const r = await claude('Reply with the single word: ok', 5); out.anthropicOk = /ok/i.test(r.text || ''); out.anthropicErr = r.error || null; }
      if (out.quo) { const r = await quo('/phone-numbers'); out.quoOk = !!r?.data; out.quoNumbers = (r?.data ?? []).map((n: any) => ({ id: n.id, number: n.number, name: n.name })); }
      return json(req, out);
    }
    if (body.action === 'quo_raw') { const p = String(body.path || ''); if (!/^\/[a-z0-9\-\/?&=%_.\[\]:+,]*$/i.test(p)) throw new Bad('Bad path.'); return json(req, await quo(p)); }
    throw new Bad('Unknown action.');
  } catch (e) {
    const err = e as Bad; console.error('care', err.message);
    return json(req, { error: err.message || 'Something went wrong' }, err.status || 500);
  }
});
