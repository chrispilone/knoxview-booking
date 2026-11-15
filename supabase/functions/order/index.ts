import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// "Submit Order" (payment upon delivery): books the shoot with no card. The client pays from their portal when the
// media is delivered (downloads stay locked until paid). Price and the open time slot come from the `booking`
// function itself, so this can never disagree with checkout; this function only saves the order and adds it to the calendar.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const G_ID = env('GOOGLE_CLIENT_ID'), G_SECRET = env('GOOGLE_CLIENT_SECRET');
const LIVE_ORIGINS = ['https://book.knoxview.com'];
const ORIGINS = ['https://test.knoxview.com', 'https://book.knoxview.com', 'https://knoxview-booking.netlify.app', 'http://localhost:8888', 'http://localhost:5173'];
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-booking\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }
const localDate = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function booking(req: Request, payload: Record<string, unknown>) { // ask the booking function (same pricing + availability rules)
  const r = await fetch(`${env('SUPABASE_URL')}/functions/v1/booking`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env('SUPABASE_ANON_KEY'), Authorization: `Bearer ${env('SUPABASE_ANON_KEY')}`, Origin: req.headers.get('origin') ?? ORIGINS[0] },
    body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Bad(d.error || 'Something went wrong. Please try again or call 865-855-5669.', r.status);
  return d;
}
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
async function addToCalendar(b: Record<string, any>) {
  const tok = await ownerGoogleToken(); if (!tok) return;
  const items = (b.items as { name: string }[]).map(i => i.name).join(', ');
  const ev = {
    summary: `${b.stripe_livemode ? '' : 'TEST '}📸 #${b.number} ${b.address}`,
    location: [b.address, b.unit, b.city, b.state, b.zip].filter(Boolean).join(', '),
    description: `Booked online${b.stripe_livemode ? '' : ' (TEST booking)'} · PAY ON DELIVERY\n\nClient: ${b.client_name} · ${b.client_phone} · ${b.client_email}\nServices: ${items}\nSize: ${b.sqft_label ?? ''}${b.large_property ? ' (large property)' : ''}\nOccupancy: ${b.occupancy ?? ''}\nAccess: ${b.access_notes ?? ''}\nNotes: ${b.notes ?? ''}\nTotal: $${b.total} · due on delivery`,
    start: { dateTime: b.shoot_start }, end: { dateTime: b.shoot_end },
    extendedProperties: { private: { kv_booking: b.id } },
  };
  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
  if (r.ok) { const d = await r.json(); await admin.from('bookings').update({ gcal_event_id: d.id }).eq('id', b.id); }
  else console.error('calendar', r.status, await r.text());
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const sel = { packageId: body.packageId ?? null, serviceIds: Array.isArray(body.serviceIds) ? body.serviceIds : [], sqftLabel: body.sqftLabel, adu: !!body.adu };
    const a = body.address ?? {}, c = body.contact ?? {};
    const need = (v: unknown, label: string) => { if (!String(v ?? '').trim()) throw new Bad(`${label} is required.`); return String(v).trim().slice(0, 300); };
    const street = need(a.street, 'Street address'), city = need(a.city, 'City'), state = need(a.state, 'State'), zip = need(a.zip, 'ZIP');
    if (!/^\d{5}$/.test(zip)) throw new Bad('ZIP must be 5 digits.');
    const first = need(c.first, 'First name'), last = need(c.last, 'Last name'), email = need(c.email, 'Email'), phone = need(c.phone, 'Phone');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Bad('Enter a valid email.');
    if (phone.replace(/\D/g, '').length < 10) throw new Bad('Enter a 10-digit phone number.');
    const start = new Date(String(body.start || ''));
    if (isNaN(+start)) throw new Bad('Pick an appointment time.');

    const { data: st } = await admin.from('booking_settings').select('payment_options, timezone').eq('id', 1).single();
    if (!(st?.payment_options as string[] ?? []).includes('pay_later')) throw new Bad('Pay on delivery is not available. Please choose Pay Now.');
    const q = await booking(req, { action: 'quote', ...sel }); // server price
    const avail = await booking(req, { action: 'slots', ...sel, from: localDate(start, st.timezone || 'America/New_York'), days: 1 });
    if (!avail.days?.[0]?.times?.some((t: { start: string }) => t.start === start.toISOString())) throw new Bad('That time was just taken. Please pick another.', 409);

    const user = await userFrom(req);
    const verifiedUser = user && user.email && user.email.toLowerCase() === email.toLowerCase() ? user.id : null;
    const agent = await agentFor(email, `${first} ${last}`, phone, String(c.brokerage || ''), verifiedUser);
    const live = LIVE_ORIGINS.includes(req.headers.get('origin') ?? '');

    const { data: b, error } = await admin.from('bookings').insert({
      status: 'scheduled', source: 'public', agent_id: agent.id,
      client_name: `${first} ${last}`, client_email: email.toLowerCase(), client_phone: phone,
      address: street, unit: a.unit ? String(a.unit).slice(0, 60) : null, city, state, zip,
      sqft: q.sqft, sqft_label: a.sqftLabel ?? null, large_property: q.large,
      occupancy: a.occupancy || null, access_notes: a.access ? String(a.access).slice(0, 2000) : null, notes: c.notes ? String(c.notes).slice(0, 2000) : null,
      items: q.items, subtotal: q.subtotal, tax: q.tax, total: q.total,
      shoot_start: start.toISOString(), shoot_end: new Date(+start + q.minutes * 60000).toISOString(), duration_min: q.minutes,
      payment_option: 'pay_later', stripe_livemode: live,
    }).select('*').single();
    if (error) throw error;
    await addToCalendar(b).catch(e => console.error('calendar', String(e)));
    return json(req, { number: b.number, status: b.status, paymentStatus: b.payment_status, start: b.shoot_start, total: b.total, id: b.id, token: b.public_token });
  } catch (e) {
    const status = e instanceof Bad ? e.status : 500;
    if (status >= 500) console.error('order error:', String((e as Error)?.message || e));
    return json(req, { error: e instanceof Bad ? e.message : 'Something went wrong. Please try again or call 865-855-5669.' }, status);
  }
});
