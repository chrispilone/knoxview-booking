import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// Delivery emails, sent from HQ (Bookings → order → Send delivery). HQ super admins only.
//   context { bookingId } -> { to, phone, bcc, sms, history } defaults: the agent's email/mobile on file (else the order's)
//   preview { bookingId, templateKey, notes, smsBody } -> { html, subject, sms }   (exactly what the client will get)
//   send    { bookingId, templateKey, to, cc[], notes, markComplete, sms, smsTo, smsBody } -> { ok, provider, sms }
//   confirm { bookingId, email, sms } -> { email?: {ok,error}, sms?: {ok,error} }   booking confirmation from HQ's New order form
//           (email to the client's email on file, text to their mobile on file; logged in delivery_emails as 'confirmation')
// Subject, heading, message and button come from the template (delivery_templates, edited in HQ settings) so every
// email is consistent; the only per-order text is the optional "notes" box. Every email is BCC'd to chris@knoxview.com.
// Layout matches the Resend "Media delivered" template. Placeholders: {first_name} {client_name} {address} {city} {order_number} {link}
// The email's button opens the order's delivery page (its own page at /d/<share token>, works when forwarded). Unpaid orders (with "Require payment" on)
// get a line saying media unlocks after payment. Sent through Resend (RESEND_API_KEY) or, until that's set,
// the owner's Gmail (same as sign-in codes). Every send is logged in delivery_emails.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const RESEND_KEY = env('RESEND_API_KEY');
const MAIL_FROM = env('DELIVERY_MAIL_FROM') || 'Knox View <bookings@mail.knoxview.com>';
const REPLY_TO = env('DELIVERY_REPLY_TO') || 'chris@knoxview.com';
const PORTAL = (env('PORTAL_URL') || 'https://knoxview-booking.netlify.app').replace(/\/$/, '');
const BCC = env('DELIVERY_BCC') || 'chris@knoxview.com';
const QUO_KEY = env('QUO_API_KEY'), QUO_FROM = env('QUO_FROM_NUMBER') || '+18658555669';
const G_ID = env('GOOGLE_CLIENT_ID'), G_SECRET = env('GOOGLE_CLIENT_SECRET');

const ORIGINS = ['https://hq.knoxview.com', 'http://localhost:8888', 'http://localhost:5173'];
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-hq\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
// The delivery page is its own page: anyone with this link (forwarded email, text) can view it. No sign-in needed;
// downloads still unlock only after payment when the order requires it.
const shareLink = (b: any) => b.public_token ? `${PORTAL}/d/${b.public_token}` : `${PORTAL}/#delivery/${b.id}`;
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[a-z]{2,}$/i;

/* ---------- order + placeholders ---------- */
async function load(id: string) {
  const { data: b } = await admin.from('bookings').select('*').eq('id', id).maybeSingle();
  if (!b) throw new Bad('Order not found', 404);
  const { data: a } = b.agent_id ? await admin.from('agents').select('full_name, email, phone').eq('id', b.agent_id).maybeSingle() : { data: null };
  return { b, a };
}
function fill(s: string, b: any, a: any) {
  const name = String(a?.full_name || b.client_name || '').trim();
  const v: Record<string, string> = { first_name: name.split(/\s+/)[0] || 'there', client_name: name || 'there', address: b.address || 'your listing',
    city: b.city || '', order_number: b.order_no || (b.number ? String(b.number) : ''), link: shareLink(b) };
  return String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m);
}
function e164(p: string) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}
async function sendSms(to: string, content: string) {
  if (!QUO_KEY) throw new Error('Texting is not set up (add QUO_API_KEY).');
  const r = await fetch('https://api.openphone.com/v1/messages', { method: 'POST', headers: { Authorization: QUO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: QUO_FROM, to: [to], content }) });
  if (!r.ok) { const t = await r.text(); console.error('quo send failed', r.status, t); throw new Error(`Text failed (${r.status}).`); }
}

/* ---------- email ---------- */
const F = "font-family:Arial,Helvetica,sans-serif;";
const P = `margin:0 0 16px 0;${F}font-size:15px;line-height:24px;color:#44546b;`;
function render(b: any, a: any, tpl: any, notes: string) {
  const link = shareLink(b);
  const locked = !b.paid && b.require_payment !== false;
  const heading = fill(tpl.heading, b, a), button = tpl.button_label || 'Open my media';
  const paras = fill(tpl.body, b, a).split(/\n{2,}/).map((x: string) => x.trim()).filter(Boolean);
  const closing = paras.length > 2 ? paras.pop()! : '';
  const p = (x: string) => `<p style="${P}">${esc(x).replace(/\n/g, '<br />')}</p>`;
  const items = (b.items || []).map((i: any) => i.name).filter((n: string) => n && !/large property|travel|fee/i.test(n));
  const deliverables = tpl.deliverables ? fill(tpl.deliverables, b, a) : items.join(', ') || 'Your listing media';
  const payment = b.paid ? 'Paid, thank you!' : locked ? 'Due. Preview now, downloads unlock once paid' : 'Due on your invoice';
  const row = (k: string, v: string) => `<tr><td style="padding:7px 0;${F}font-size:12px;line-height:18px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#1f3c66;width:110px;vertical-align:top;">${k}</td><td style="padding:7px 0;${F}font-size:15px;line-height:22px;color:#44546b;vertical-align:top;">${v}</td></tr>`;
  // graphics: the listing's cover photo as a hero; once downloads are open, a strip of three more photos
  const pics = (b.media_files || []).filter((f: any) => f.kind === 'photo' && /^https:\/\//.test(f.preview || f.url || '')).map((f: any) => f.preview || f.url);
  const cover = /^https:\/\//.test(b.cover_url || '') ? b.cover_url : pics[0] || '';
  const strip = !locked ? pics.filter((u: string) => u !== cover).slice(0, 3) : [];
  const hero = cover ? `<a href="${esc(link)}"><img src="${esc(cover)}" width="536" alt="${esc(b.address || 'Your listing')}" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:10px;margin:0 0 22px 0;" /></a>` : '';
  const stripHtml = strip.length === 3 ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px 0;"><tr>${strip.map((u: string, i: number) => `<td width="33%" style="padding:0 ${i < 2 ? '6px' : '0'} 0 0;"><a href="${esc(link)}"><img src="${esc(u)}" width="174" alt="" style="display:block;width:100%;height:auto;border:0;border-radius:6px;" /></a></td>`).join('')}</tr></table>` : '';
  const note = String(notes || '').trim();
  const noteHtml = note ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px 0;"><tr><td style="border-left:3px solid #1d3250;background-color:#f5f4f0;border-radius:0 10px 10px 0;padding:14px 18px;">
    <p style="margin:0 0 6px 0;${F}font-size:12px;line-height:18px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#1f3c66;">A note from Chris</p>
    <p style="margin:0;${F}font-size:15px;line-height:24px;color:#44546b;">${esc(note).replace(/\n/g, '<br />')}</p></td></tr></table>` : '';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Knox View</title></head>
<body style="margin:0;padding:0;background-color:#f5f4f0;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f5f4f0;">${esc(heading)} · ${esc(b.address || '')}</div>
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f4f0" style="background-color:#f5f4f0;"><tr><td align="center" style="padding:28px 12px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td bgcolor="#0d1726" style="background-color:#0d1726;border-radius:12px 12px 0 0;padding:0;line-height:0;font-size:0;overflow:hidden;"><img src="${PORTAL}/email-header.jpg" width="600" alt="Knox View Real Estate Media" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:12px 12px 0 0;color:#ffffff;font-family:Georgia,serif;font-size:22px;line-height:1.4;" /></td></tr>
<tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:34px 32px 18px 32px;">
  <h1 style="margin:0 0 6px 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:32px;font-weight:normal;letter-spacing:1px;text-transform:uppercase;color:#1f3c66;">${esc(heading)}</h1>
  <p style="margin:0 0 20px 0;${F}font-size:13px;line-height:20px;color:#8a96a8;">${esc([b.address, b.city].filter(Boolean).join(', '))}</p>
  ${hero}${paras.map(p).join('')}
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e7edf6" style="background-color:#e7edf6;border-radius:12px;margin:4px 0 22px 0;"><tr><td style="padding:16px 20px;"><table width="100%" cellpadding="0" cellspacing="0" border="0">
    ${row('Delivered', esc(deliverables))}${b.number ? row('Order', esc(b.order_no || '#' + b.number)) : ''}${row('Payment', esc(payment))}</table></td></tr></table>
  <table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr><td bgcolor="#1d3250" style="background-color:#1d3250;border-radius:8px;">
    <a href="${esc(link)}" style="display:inline-block;padding:13px 26px;${F}font-size:13px;line-height:16px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#ffffff;text-decoration:none;">${esc(button)}</a></td></tr></table>
  ${stripHtml}${noteHtml}${closing ? p(closing) : ''}
</td></tr>
<tr><td bgcolor="#ffffff" style="background-color:#ffffff;border-radius:0 0 12px 12px;padding:0 32px 30px 32px;">
  <p style="margin:0;${F}font-size:15px;line-height:22px;color:#44546b;">Chris Pilone<br /><span style="color:#1f3c66;">Knox View Real Estate Media</span><br /><a href="tel:+18658555669" style="color:#1f3c66;text-decoration:none;">865-855-5669</a> &middot; <a href="https://knoxview.com" style="color:#1f3c66;text-decoration:none;">knoxview.com</a></p></td></tr>
<tr><td align="center" style="padding:18px 24px;"><p style="margin:0;${F}font-size:11px;line-height:17px;color:#8a96a8;">Button not working? Open <a href="${esc(link)}" style="color:#8a96a8;">${esc(link)}</a><br />Knox View Real Estate Media &middot; Knoxville, Tennessee</p></td></tr>
</table></td></tr></table></body></html>`;
  const text = `${heading}\n${[b.address, b.city].filter(Boolean).join(', ')}\n\n${paras.join('\n\n')}\n\nDelivered: ${deliverables}\n${b.number ? `Order: ${b.order_no || "#" + b.number}\n` : ''}Payment: ${payment}\n\n${button}: ${link}\n\n${note ? `A note from Chris:\n${note}\n\n` : ''}${closing ? closing + '\n\n' : ''}Chris Pilone\nKnox View Real Estate Media\n865-855-5669 · knoxview.com\n`;
  return { html, text, subject: fill(tpl.subject, b, a).replace(/[\r\n]+/g, ' ').trim().slice(0, 200) };
}
/* ---------- booking confirmation (HQ New order) ---------- */
const TZ = 'America/New_York';
const whenLong = (b: any) => { if (!b.shoot_start) return 'To be scheduled';
  const s = new Date(b.shoot_start), e = b.shoot_end ? new Date(b.shoot_end) : null;
  const day = s.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
  const t = (d: Date) => d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  return `${day} · ${t(s)}${e ? '–' + t(e) : ''}`; };
const whenShort = (b: any) => { const s = new Date(b.shoot_start);
  return `${s.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' })} at ${s.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })}`; };
function renderConfirm(b: any, a: any) {
  const name = String(a?.full_name || b.client_name || '').trim(), first = name.split(/\s+/)[0] || 'there';
  const link = b.invoice === false ? `${PORTAL}/#listings` : `${PORTAL}/#invoices/${b.number}`;
  const place = [b.address, b.city].filter(Boolean).join(', ');
  const services = (b.items || []).map((i: any) => i.name).filter((n: string) => n && !/large property|travel|fee/i.test(n)).join(', ') || 'Listing media';
  const money = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const payment = b.invoice === false ? '' : b.paid ? 'Paid, thank you!' : `${money(b.total)}, due on delivery`;
  const row = (k: string, v: string) => `<tr><td style="padding:7px 0;${F}font-size:12px;line-height:18px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#1f3c66;width:110px;vertical-align:top;">${k}</td><td style="padding:7px 0;${F}font-size:15px;line-height:22px;color:#44546b;vertical-align:top;">${v}</td></tr>`;
  const p = (x: string) => `<p style="${P}">${esc(x)}</p>`;
  const heading = 'Shoot confirmed';
  const intro = `Hi ${first}, you're all set! Here are the details for your shoot.`;
  const change = "Need to reschedule? You can change or cancel your shoot in your client portal until 5 PM the day before, or call or text us at 865-855-5669.";
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Knox View</title></head>
<body style="margin:0;padding:0;background-color:#f5f4f0;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f5f4f0;">${esc(heading)} · ${esc(whenLong(b))}</div>
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f4f0" style="background-color:#f5f4f0;"><tr><td align="center" style="padding:28px 12px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td bgcolor="#0d1726" style="background-color:#0d1726;border-radius:12px 12px 0 0;padding:0;line-height:0;font-size:0;overflow:hidden;"><img src="${PORTAL}/email-header.jpg" width="600" alt="Knox View Real Estate Media" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:12px 12px 0 0;color:#ffffff;font-family:Georgia,serif;font-size:22px;line-height:1.4;" /></td></tr>
<tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:34px 32px 18px 32px;">
  <h1 style="margin:0 0 6px 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:32px;font-weight:normal;letter-spacing:1px;text-transform:uppercase;color:#1f3c66;">${esc(heading)}</h1>
  <p style="margin:0 0 20px 0;${F}font-size:13px;line-height:20px;color:#8a96a8;">${esc(place)}</p>
  ${p(intro)}
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e7edf6" style="background-color:#e7edf6;border-radius:12px;margin:4px 0 22px 0;"><tr><td style="padding:16px 20px;"><table width="100%" cellpadding="0" cellspacing="0" border="0">
    ${row('When', esc(whenLong(b)))}${row('Where', esc(place))}${row('Services', esc(services))}${b.number ? row('Order', esc(b.order_no || '#' + b.number)) : ''}${payment ? row('Payment', esc(payment)) : ''}</table></td></tr></table>
  <table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr><td bgcolor="#1d3250" style="background-color:#1d3250;border-radius:8px;">
    <a href="${esc(link)}" style="display:inline-block;padding:13px 26px;${F}font-size:13px;line-height:16px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#ffffff;text-decoration:none;">View my order</a></td></tr></table>
  ${p(change)}
</td></tr>
<tr><td bgcolor="#ffffff" style="background-color:#ffffff;border-radius:0 0 12px 12px;padding:0 32px 30px 32px;">
  <p style="margin:0;${F}font-size:15px;line-height:22px;color:#44546b;">Chris Pilone<br /><span style="color:#1f3c66;">Knox View Real Estate Media</span><br /><a href="tel:+18658555669" style="color:#1f3c66;text-decoration:none;">865-855-5669</a> &middot; <a href="https://knoxview.com" style="color:#1f3c66;text-decoration:none;">knoxview.com</a></p></td></tr>
<tr><td align="center" style="padding:18px 24px;"><p style="margin:0;${F}font-size:11px;line-height:17px;color:#8a96a8;">Button not working? Open <a href="${esc(link)}" style="color:#8a96a8;">${esc(link)}</a><br />Knox View Real Estate Media &middot; Knoxville, Tennessee</p></td></tr>
</table></td></tr></table></body></html>`;
  const text = `${heading}\n${place}\n\n${intro}\n\nWhen: ${whenLong(b)}\nWhere: ${place}\nServices: ${services}\n${b.number ? `Order: ${b.order_no || '#' + b.number}\n` : ''}${payment ? `Payment: ${payment}\n` : ''}\nView my order: ${link}\n\n${change}\n\nChris Pilone\nKnox View Real Estate Media\n865-855-5669 · knoxview.com\n`;
  const subject = `Shoot confirmed: ${b.address || 'your listing'}${b.shoot_start ? ' on ' + whenShort(b).replace(/ at .*/, '') : ''}`.slice(0, 200);
  const sms = `Hi ${first}, your Knox View shoot at ${b.address || 'your listing'} is confirmed for ${b.shoot_start ? whenShort(b) : 'soon'}. Questions or changes? Call or text 865-855-5669. - Knox View Media`;
  return { html, text, subject, sms };
}
async function ownerGmailToken() {
  if (!G_ID || !G_SECRET) return null;
  const { data: owner } = await admin.from('team_members').select('id').eq('role', 'owner').eq('active', true).order('created_at').limit(1).maybeSingle();
  if (!owner) return null;
  const { data: acct } = await admin.from('google_accounts').select('*').eq('member_id', owner.id).maybeSingle();
  if (!acct || !String(acct.scope || '').includes('gmail')) return null;
  if (acct.access_token && acct.access_expires_at && new Date(acct.access_expires_at).getTime() > Date.now() + 60_000) return acct.access_token as string;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: G_ID, client_secret: G_SECRET, grant_type: 'refresh_token', refresh_token: acct.refresh_token }) });
  const t = await r.json(); if (!r.ok) return null;
  await admin.from('google_accounts').update({ access_token: t.access_token, access_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('member_id', owner.id);
  return t.access_token as string;
}
function b64(str: string) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const mimeWord = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
async function sendEmail(to: string, cc: string[], subject: string, html: string, text: string) {
  const bcc = BCC && BCC !== to && !cc.includes(BCC) ? [BCC] : [];
  if (RESEND_KEY) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), reply_to: REPLY_TO, subject, html, text }) });
    if (r.ok) return 'resend';
    console.error('resend failed', r.status, await r.text());
  }
  const tok = await ownerGmailToken();
  if (tok) {
    const boundary = 'kvdel_' + crypto.randomUUID().replace(/-/g, '');
    const raw = [`To: ${to}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []), ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []), `Subject: ${mimeWord(subject)}`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(text),
      `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(html), `--${boundary}--`, ''].join('\r\n');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: b64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }) });
    if (r.ok) return 'gmail';
    console.error('gmail failed', r.status, await r.text());
  }
  throw new Bad("The email couldn't be sent. Check the Resend key or reconnect Google in HQ, then try again.", 502);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
    const { data: me } = u?.user ? await admin.from('team_members').select('id, role, active, permissions').eq('id', u.user.id).maybeSingle() : { data: null };
    if (!me?.active || !(me.role === 'owner' || me.permissions?.super_admin === true)) throw new Bad('Only HQ super admins can send deliveries.', 403);

    const b0 = await req.json().catch(() => ({}));
    const { b, a } = await load(String(b0.bookingId || ''));
    if (b0.action === 'context') {
      const { data: hist } = await admin.from('delivery_emails').select('created_at, template_key, to_email, cc, subject, ok, error, sms_to, sms_ok, sms_error, marked_complete').eq('booking_id', b.id).order('created_at', { ascending: false }).limit(20);
      return json(req, { to: (a?.email || b.client_email || '').toLowerCase(), phone: a?.phone || b.client_phone || '', bcc: BCC, sms: !!QUO_KEY, link: shareLink(b), history: hist || [] });
    }
    if (b0.action === 'confirm') {
      const m = renderConfirm(b, a), out: Record<string, unknown> = {};
      const to = String(a?.email || b.client_email || '').trim().toLowerCase();
      let provider: string | null = null, error: string | null = null;
      if (b0.email) {
        if (!EMAIL_RE.test(to)) error = 'no valid email on file';
        else { try { provider = await sendEmail(to, [], m.subject, m.html, m.text); } catch (e) { error = (e as Error).message; } }
        out.email = { ok: !!provider, error };
      }
      let smsTo: string | null = null, smsOk: boolean | null = null, smsError: string | null = null;
      if (b0.sms) {
        smsTo = e164(String(a?.phone || b.client_phone || ''));
        if (!smsTo) { smsOk = false; smsError = 'no valid mobile number on file'; }
        else { try { await sendSms(smsTo, m.sms); smsOk = true; } catch (e) { smsOk = false; smsError = (e as Error).message; } }
        out.sms = { ok: smsOk, error: smsError };
      }
      if (b0.email || b0.sms) await admin.from('delivery_emails').insert({ booking_id: b.id, template_key: 'confirmation', to_email: b0.email ? to : '', cc: [], bcc: b0.email ? BCC || null : null,
        subject: b0.email ? m.subject : 'Booking confirmation (text only)', provider, ok: !!provider || smsOk === true, error, sent_by: me.id, marked_complete: false, sms_to: smsTo, sms_ok: smsOk, sms_error: smsError });
      return json(req, out);
    }
    const { data: tpl } = await admin.from('delivery_templates').select('*').eq('key', String(b0.templateKey || 'media')).maybeSingle();
    if (!tpl) throw new Bad('Pick a delivery email template.');
    const notes = String(b0.notes || '').slice(0, 4000);
    const smsBody = fill(String(b0.smsBody || tpl.sms_body || 'Hi {first_name}, your media for {address} is ready! View and download here: {link} - Knox View Media'), b, a).slice(0, 640);
    const mail = render(b, a, tpl, notes);
    if (b0.action === 'preview') return json(req, { html: mail.html, subject: mail.subject, sms: smsBody });

    if (b0.action === 'send') {
      const to = String(b0.to || a?.email || b.client_email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(to)) throw new Bad('Enter the client email to send to.');
      const ccIn: string[] = (Array.isArray(b0.cc) ? b0.cc : String(b0.cc || '').split(/[\s,;]+/)).map((x: string) => String(x).trim().toLowerCase()).filter(Boolean);
      const badCc = ccIn.find(x => !EMAIL_RE.test(x)); if (badCc) throw new Bad(`"${badCc}" isn't a valid email.`);
      const cc = [...new Set(ccIn)].filter(x => x !== to).slice(0, 10);
      let smsTo: string | null = null;
      if (b0.sms) { smsTo = e164(String(b0.smsTo || a?.phone || b.client_phone || '')); if (!smsTo) throw new Bad('Enter a valid mobile number for the text.'); }
      let provider: string | null = null, error: string | null = null;
      try { provider = await sendEmail(to, cc, mail.subject, mail.html, mail.text); } catch (e) { error = (e as Error).message; }
      let smsOk: boolean | null = null, smsError: string | null = null;
      if (smsTo && provider) { try { await sendSms(smsTo, smsBody); smsOk = true; } catch (e) { smsOk = false; smsError = (e as Error).message; } }
      const markComplete = !!b0.markComplete && !!provider;
      await admin.from('delivery_emails').insert({ booking_id: b.id, template_key: tpl.key, to_email: to, cc, bcc: BCC || null, subject: mail.subject, notes: notes || null, provider, ok: !!provider, error,
        sent_by: me.id, marked_complete: markComplete, sms_to: smsTo, sms_ok: smsOk, sms_error: smsError });
      if (error) throw new Bad(error, 502);
      if (markComplete) await admin.from('bookings').update({ status: b.status === 'cancelled' ? b.status : 'completed', delivered_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', b.id);
      return json(req, { ok: true, provider, completed: markComplete, sms: smsTo ? { ok: smsOk, error: smsError } : null });
    }
    throw new Bad('Unknown action');
  } catch (e) {
    const status = e instanceof Bad ? e.status : 500;
    if (!(e instanceof Bad)) console.error('deliver error', String((e as Error)?.message || e));
    return json(req, { error: e instanceof Bad ? e.message : 'Something went wrong. Please try again.' }, status);
  }
});
