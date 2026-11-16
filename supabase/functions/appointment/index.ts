import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// Client self-service for a booked shoot (portal → Listings → Reschedule, Order page → Cancel appointment).
//   rules  { number }           → { canChange, canCancel, reason }
//   slots  { number, from }     → open times for this shoot's length (same rules + calendar as new bookings)
//   reschedule { number, start } → moves the shoot, updates the Google Calendar event, emails Chris
//   ics_link { number }          → { url } a signed link to this shoot's calendar file (works without signing in; safe to email/text)
//   GET ?ics=<id>.<sig>           → the .ics file (always the current time; same UID so re-adding updates it)
//   cancel { number, reason }    → cancels (unpaid only; any credit used goes back to the client), removes the calendar event, emails Chris
// Online changes close at 5:00 PM (business time zone) the day before the shoot; after that the client calls or texts.
// A reason is required to reschedule or cancel online; it goes in the order notes and the email to Chris.
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const CUTOFF_TIME = '17:00'; // the day before the shoot
const PHONE = '865-855-5669';
const OWNER_EMAIL = env('DELIVERY_BCC') || 'chris@knoxview.com';
const RESEND_KEY = env('RESEND_API_KEY'), MAIL_FROM = env('DELIVERY_MAIL_FROM') || 'Knox View <bookings@mail.knoxview.com>';
const G_ID = env('GOOGLE_CLIENT_ID'), G_SECRET = env('GOOGLE_CLIENT_SECRET');
const ORIGINS = ['https://test.knoxview.com', 'https://book.knoxview.com', 'https://knoxview-booking.netlify.app', 'http://localhost:8888', 'http://localhost:5173'];
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-booking\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class UserError extends Error { constructor(m: string, public status = 400) { super(m); } }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/* ---------- time + availability (same rules as new bookings in the booking function) ---------- */
function tzOffsetMin(tz: string, at: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at.getTime()) / 60000;
}
function zoned(date: string, time: string, tz: string) {
  const [y, m, d] = date.split('-').map(Number); const [hh, mm] = time.split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  return new Date(guess.getTime() - tzOffsetMin(tz, guess) * 60000);
}
const localDate = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const weekday = (date: string) => new Date(date + 'T12:00:00Z').getUTCDay();
// Online changes for a shoot on `date` (YYYY-MM-DD, local) close at 5 PM the day before
const cutoffFor = (date: string, tz: string) => zoned(new Date(Date.parse(date + 'T12:00:00Z') - 86400_000).toISOString().slice(0, 10), CUTOFF_TIME, tz).getTime();
const when = (iso: string, tz: string) => new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function ownerGoogleToken() {
  if (!G_ID || !G_SECRET) return null;
  const { data: owner } = await admin.from('team_members').select('id').eq('role', 'owner').eq('active', true).order('created_at').limit(1).maybeSingle();
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
async function busy(from: Date, to: Date, skipBooking: string, skipEvent: string | null) {
  const out: { s: number; e: number }[] = [];
  const holdSince = new Date(Date.now() - 30 * 60000).toISOString();
  const { data: bk } = await admin.from('bookings').select('id, shoot_start, shoot_end, status, created_at, gcal_event_id')
    .lt('shoot_start', to.toISOString()).gt('shoot_end', from.toISOString()).in('status', ['requested', 'scheduled']);
  const own = new Set<string>(skipEvent ? [skipEvent] : []);
  for (const b of bk ?? []) {
    if (b.id === skipBooking) continue;
    if (b.status === 'requested' && b.created_at < holdSince) continue;
    out.push({ s: Date.parse(b.shoot_start), e: Date.parse(b.shoot_end) });
    if (b.gcal_event_id) own.add(b.gcal_event_id);
  }
  try {
    const tok = await ownerGoogleToken();
    if (tok) {
      const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', maxResults: '2500' });
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { Authorization: `Bearer ${tok}` } });
      if (r.ok) for (const ev of (await r.json()).items ?? []) {
        if (ev.status === 'cancelled' || ev.transparency === 'transparent' || own.has(ev.id) || !ev.start?.dateTime) continue;
        out.push({ s: Date.parse(ev.start.dateTime), e: Date.parse(ev.end.dateTime) });
      }
    }
  } catch (_) { /* bookings only */ }
  return out;
}
async function slots(st: any, minutes: number, b: any, fromDate?: string, days = 14) {
  const tz = st.timezone || 'America/New_York';
  const earliest = Date.now() + st.min_notice_hours * 3600_000;
  const start = fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate) ? fromDate : localDate(new Date(), tz);
  const horizonEnd = Date.now() + st.horizon_days * 86400_000;
  const dates: string[] = [];
  for (let i = 0; dates.length < Math.min(days, 31) && i < 62; i++) {
    const d = new Date(Date.parse(start + 'T12:00:00Z') + i * 86400_000).toISOString().slice(0, 10);
    if (zoned(d, '00:00', tz).getTime() > horizonEnd) break;
    dates.push(d);
  }
  if (!dates.length) return { tz, days: [] };
  const intervals = await busy(zoned(dates[0], '00:00', tz), zoned(dates[dates.length - 1], '23:59', tz), b.id, b.gcal_event_id);
  const buf = st.buffer_min * 60000, dur = minutes * 60000, step = st.slot_step * 60000;
  return { tz, days: dates.map(date => {
    const open = (st.work_days as number[]).includes(weekday(date)) && Date.now() < cutoffFor(date, tz), times: { start: string; label: string }[] = [];
    if (open) {
      const dayEnd = zoned(date, String(st.day_end).slice(0, 5), tz).getTime();
      for (let t = zoned(date, String(st.day_start).slice(0, 5), tz).getTime(); t + dur <= dayEnd; t += step) {
        if (t < earliest || intervals.some(x => t < x.e + buf && t + dur > x.s - buf)) continue;
        times.push({ start: new Date(t).toISOString(), label: new Date(t).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }) });
      }
    }
    return { date, open, times };
  }) };
}

/* ---------- rules ---------- */
function rules(b: any, tz: string) {
  const hrs = b.shoot_start ? (Date.parse(b.shoot_start) - Date.now()) / 3600_000 : -1;
  const closed = b.shoot_start ? Date.now() >= cutoffFor(localDate(new Date(b.shoot_start), tz), tz) : true;
  if (b.status === 'cancelled') return { canChange: false, canCancel: false, reason: 'This appointment is cancelled.' };
  if (!['scheduled', 'requested'].includes(b.status) || b.delivered_at || hrs < 0) return { canChange: false, canCancel: false, reason: 'This shoot already happened.' };
  if (closed) return { canChange: false, canCancel: false, reason: `Rescheduling online is unavailable at this time. Please call or text ${PHONE}.`, callText: true };
  return { canChange: true, canCancel: !b.paid, reason: b.paid ? `This order is paid, so to cancel it please call or text ${PHONE} and we'll take care of your refund.` : '' };
}

/* ---------- email to Chris ---------- */
async function ownerGmailToken() {
  const tok = await ownerGoogleToken(); if (!tok) return null;
  return tok;
}
const b64 = (str: string) => { const u = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
async function notifyChris(subject: string, lines: string[]) {
  const text = lines.join('\n'), html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:22px;color:#1d3250">${lines.map(l => l ? esc(l) : '&nbsp;').join('<br>')}</div>`;
  try {
    if (RESEND_KEY) {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: MAIL_FROM, to: [OWNER_EMAIL], subject, html, text }) });
      if (r.ok) return;
    }
    const tok = await ownerGmailToken(); if (!tok) return;
    const raw = [`To: ${OWNER_EMAIL}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(text)].join('\r\n');
    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: b64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }) });
  } catch (e) { console.error('notify', String(e)); }
}

/* ---------- calendar file (.ics) ---------- */
const SIGN_KEY = env('MEDIA_SIGNING_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
async function sig(id: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SIGN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('ics:' + id)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}
const icsUrl = async (id: string) => `${env('SUPABASE_URL')}/functions/v1/appointment?ics=${id}.${await sig(id)}`;
const icsEsc = (t: string) => String(t).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsFold = (line: string) => { const out: string[] = []; let l = line; while (l.length > 74) { out.push(l.slice(0, 74)); l = ' ' + l.slice(74); } out.push(l); return out.join('\r\n'); };
const z = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
async function icsFile(req: Request) {
  const [id, s2] = String(new URL(req.url).searchParams.get('ics') || '').split('.');
  if (!/^[0-9a-f-]{36}$/.test(id || '') || !s2 || s2 !== await sig(id)) return new Response('Not found', { status: 404 });
  const { data: b } = await admin.from('bookings').select('id, number, status, address, unit, city, state, zip, shoot_start, shoot_end, duration_min, updated_at').eq('id', id).maybeSingle();
  if (!b || !b.shoot_start) return new Response('Not found', { status: 404 });
  const start = new Date(b.shoot_start), end = b.shoot_end ? new Date(b.shoot_end) : new Date(+start + (b.duration_min || 90) * 60000);
  const where = [b.address + (b.unit ? ', ' + b.unit : ''), b.city, [b.state, b.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const portal = (env('PORTAL_URL') || 'https://knoxview-booking.netlify.app').replace(/\/$/, '');
  const title = `Your Knox View shoot at ${where}`;
  const desc = `Knox View Real Estate Media photo shoot (order #${b.number}).\nView, reschedule or cancel: ${portal}/#invoices/${b.number}\nQuestions? Call or text ${PHONE}.`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Knox View Real Estate Media//Booking Portal//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:order-${b.id}@knoxview.com`, `SEQUENCE:${Math.floor(Date.parse(b.updated_at || b.shoot_start) / 1000)}`, `DTSTAMP:${z(new Date())}`,
    `DTSTART:${z(start)}`, `DTEND:${z(end)}`, `SUMMARY:${icsEsc(title)}`, `LOCATION:${icsEsc(where)}`, `DESCRIPTION:${icsEsc(desc)}`, `URL:${portal}/#invoices/${b.number}`,
    `STATUS:${b.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(title)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'];
  const name = String(b.address || 'Knox View shoot').replace(/[^\w ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'Knox_View_shoot';
  return new Response(lines.map(icsFold).join('\r\n') + '\r\n', { headers: { 'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}.ics"`, 'Cache-Control': 'no-store' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method === 'GET') return icsFile(req);
  try {
    const body = await req.json().catch(() => ({}));
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const user = jwt.split('.').length === 3 ? (await admin.auth.getUser(jwt)).data?.user : null;
    if (!user) throw new UserError('Please sign in.', 401);
    const { data: agent } = await admin.from('agents').select('id, full_name, email, phone').eq('auth_user_id', user.id).maybeSingle();
    if (!agent) throw new UserError('Order not found', 404);
    const { data: b } = await admin.from('bookings').select('*').eq('agent_id', agent.id).eq('number', Number(body.number) || -1).maybeSingle();
    if (!b) throw new UserError('Order not found', 404);
    const { data: st } = await admin.from('booking_settings').select('*').eq('id', 1).single();
    const tz = st?.timezone || 'America/New_York', minutes = b.duration_min || Math.round((Date.parse(b.shoot_end) - Date.parse(b.shoot_start)) / 60000) || 60;
    const r = rules(b, tz), action = String(body.action || '');
    const where = [b.address, b.city].filter(Boolean).join(', ');

    if (action === 'rules') return json(req, { ...r, start: b.shoot_start, minutes });
    if (action === 'ics_link') return json(req, { url: await icsUrl(b.id) });

    if (action === 'slots') {
      if (!r.canChange) throw new UserError(r.reason);
      return json(req, { minutes, current: b.shoot_start, ...(await slots(st, minutes, b, body.from, Math.min(Number(body.days) || 14, 21))) });
    }

    if (action === 'reschedule') {
      if (!r.canChange) throw new UserError(r.reason);
      const why = String(body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (why.length < 3) throw new UserError('Please add a reason for rescheduling.');
      const start = new Date(String(body.start || ''));
      if (isNaN(+start)) throw new UserError('Pick a new time.');
      const day = localDate(start, tz), avail = await slots(st, minutes, b, day, 1);
      if (!avail.days[0]?.times.some(t => t.start === start.toISOString())) throw new UserError('That time was just taken. Please pick another.', 409);
      const end = new Date(+start + minutes * 60000);
      const { error } = await admin.from('bookings').update({ shoot_start: start.toISOString(), shoot_end: end.toISOString(), updated_at: new Date().toISOString(),
        notes: [b.notes, `Rescheduled by client in portal (${when(b.shoot_start, tz)} → ${when(start.toISOString(), tz)}): ${why}`].filter(Boolean).join('\n') }).eq('id', b.id);
      if (error) throw error;
      if (b.gcal_event_id) {
        const tok = await ownerGoogleToken();
        if (tok) await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(b.gcal_event_id)}`, { method: 'PATCH',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ start: { dateTime: start.toISOString(), timeZone: tz }, end: { dateTime: end.toISOString(), timeZone: tz } }) }).catch(e => console.error('gcal', String(e)));
      }
      await notifyChris(`Rescheduled: #${b.number} ${b.address}`, [`${agent.full_name || b.client_name} rescheduled their shoot in the portal.`, '', `Order #${b.number} · ${where}`,
        `Was: ${when(b.shoot_start, tz)}`, `Now: ${when(start.toISOString(), tz)}`, `Reason: ${why}`, b.gcal_event_id ? 'Your Google Calendar event was moved.' : 'This order has no Google Calendar event.', '', `HQ: https://hq.knoxview.com/#/bookings/${b.id}`]);
      return json(req, { start: start.toISOString(), label: when(start.toISOString(), tz) });
    }

    if (action === 'cancel') {
      if (!r.canCancel) throw new UserError(r.reason || "This appointment can't be cancelled online.");
      const reason = String(body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (reason.length < 3) throw new UserError('Please add a reason for cancelling.');
      const credit = +(b.credit_applied || 0);
      if (credit > 0) await admin.from('client_credits').insert({ agent_id: agent.id, amount: credit, kind: 'returned', booking_id: b.id, note: `Returned: order #${b.number} cancelled` });
      const { error } = await admin.from('bookings').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), credit_applied: 0, gcal_event_id: null,
        notes: [b.notes, `Cancelled by client in portal${reason ? ': ' + reason : ''}`].filter(Boolean).join('\n'), updated_at: new Date().toISOString() }).eq('id', b.id);
      if (error) throw error;
      if (b.gcal_event_id) {
        const tok = await ownerGoogleToken();
        if (tok) await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(b.gcal_event_id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } }).catch(e => console.error('gcal', String(e)));
      }
      await notifyChris(`Cancelled: #${b.number} ${b.address}`, [`${agent.full_name || b.client_name} cancelled their shoot in the portal.`, '', `Order #${b.number} · ${where}`, `Was: ${when(b.shoot_start, tz)}`,
        reason ? `Reason: ${reason}` : 'No reason given.', credit ? `$${credit.toFixed(2)} of account credit went back to their account.` : '', b.gcal_event_id ? 'Removed from your Google Calendar.' : '', '', `HQ: https://hq.knoxview.com/#/bookings/${b.id}`]);
      return json(req, { cancelled: true, creditReturned: credit });
    }

    return json(req, { error: 'Unknown action' }, 400);
  } catch (e) {
    const status = e instanceof UserError ? e.status : 500;
    if (status >= 500) console.error('appointment error:', String((e as Error)?.message || e));
    return json(req, { error: e instanceof UserError ? e.message : `Something went wrong. Please call or text ${PHONE}.` }, status);
  }
});
