import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// Delivery emails, sent from HQ (Bookings → order → Send delivery). HQ super admins only.
//   context { bookingId } -> { to, phone, bcc, sms } defaults: the agent's email/mobile on file (else the order's)
//   preview { bookingId, subject, heading, body, button } -> { html }   (what the client will see)
//   send    { bookingId, templateKey, to, cc[], subject, heading, body, button, markComplete, sms, smsTo, smsBody }
//           -> { ok, provider, sms }   Every email is BCC'd to DELIVERY_BCC (chris@knoxview.com).
// Placeholders in any field: {first_name} {client_name} {address} {city} {order_number} {link}
// The email's button opens the client's delivery page in the portal. Unpaid orders (with "Require payment" on)
// get a line saying media unlocks after payment. Sent through Resend (RESEND_API_KEY) or, until that's set,
// the owner's Gmail (same as sign-in codes). Every send is logged in delivery_emails.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const RESEND_KEY = env('RESEND_API_KEY');
const MAIL_FROM = env('DELIVERY_MAIL_FROM') || 'Knox View Media <delivery@mail.knoxview.com>';
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
    city: b.city || '', order_number: b.number ? String(b.number) : '', link: `${PORTAL}/#delivery/${b.id}` };
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
function render(b: any, t: { heading: string; body: string; button: string }) {
  const link = `${PORTAL}/#delivery/${b.id}`;
  const locked = !b.paid && b.require_payment !== false;
  const paras = String(t.body || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, '<br>')}</p>`);
  // the button goes after the first two paragraphs (before the sign-off)
  const cut = Math.min(2, paras.length);
  const cover = b.cover_url && /^https:\/\//.test(b.cover_url) ? `<tr><td><img src="${esc(b.cover_url)}" width="560" alt="" style="display:block;width:100%;max-width:560px;height:auto;border:0"></td></tr>` : '';
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;background:#f5f4f0;font-family:Helvetica,Arial,sans-serif;color:#1d3250">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f0;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#1d3250;padding:22px 28px;text-align:center">
  <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;letter-spacing:3px;color:#ffffff">KNOX VIEW</div>
  <div style="font-size:10px;letter-spacing:4px;color:#bccadc;margin-top:4px">REAL ESTATE MEDIA</div></td></tr>
${cover}
<tr><td style="padding:28px 28px 8px;font-size:15px;line-height:1.6;color:#44546b">
  <h1 style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:26px;color:#1d3250">${esc(t.heading)}</h1>
  <p style="margin:0 0 20px;font-size:13px;color:#5f7389">${esc([b.address, b.city].filter(Boolean).join(', '))}${b.number ? ` · Order #${b.number}` : ''}</p>
  ${paras.slice(0, cut).join('')}
  ${locked ? `<p style="margin:0 0 16px;padding:12px 14px;background:#fff3dd;border-radius:8px;color:#6b4600">You can preview everything now. Your downloads unlock as soon as payment is made, right from your delivery page.</p>` : ''}
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 22px"><tr><td style="background:#1d3250;border-radius:8px">
    <a href="${esc(link)}" style="display:inline-block;padding:14px 26px;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px">${esc(t.button || 'View & download')}</a></td></tr></table>
  ${paras.slice(cut).join('')}
</td></tr>
<tr><td style="padding:16px 28px 24px;font-size:12px;line-height:1.5;color:#8a97a8;border-top:1px solid #eef1f5">
  Button not working? Copy this link: <a href="${esc(link)}" style="color:#5f7389">${esc(link)}</a><br>
  You'll sign in with your email or mobile number. Knox View Real Estate Media · Knoxville &amp; the Smokies · 865-855-5669</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${t.heading}\n${[b.address, b.city].filter(Boolean).join(', ')}\n\n${String(t.body || '').trim()}\n\n${locked ? 'You can preview everything now. Your downloads unlock as soon as payment is made.\n\n' : ''}${t.button || 'View & download'}: ${link}\n`;
  return { html, text, link };
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
    const t = { heading: fill(String(b0.heading || ''), b, a).slice(0, 200), body: fill(String(b0.body || ''), b, a).slice(0, 8000), button: String(b0.button || 'View & download').slice(0, 80) };
    const subject = fill(String(b0.subject || ''), b, a).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);

    if (b0.action === 'context') {
      const { data: hist } = await admin.from('delivery_emails').select('created_at, template_key, to_email, cc, subject, ok, error, sms_to, sms_ok, sms_error, marked_complete').eq('booking_id', b.id).order('created_at', { ascending: false }).limit(20);
      return json(req, { to: (a?.email || b.client_email || '').toLowerCase(), phone: a?.phone || b.client_phone || '', bcc: BCC, sms: !!QUO_KEY, link: `${PORTAL}/#delivery/${b.id}`, history: hist || [] });
    }
    if (b0.action === 'preview') return json(req, { html: render(b, t).html, subject, sms: fill(String(b0.smsBody || ''), b, a) });

    if (b0.action === 'send') {
      const to = String(b0.to || a?.email || b.client_email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(to)) throw new Bad('Enter the client email to send to.');
      const ccIn: string[] = (Array.isArray(b0.cc) ? b0.cc : String(b0.cc || '').split(/[\s,;]+/)).map((x: string) => String(x).trim().toLowerCase()).filter(Boolean);
      const badCc = ccIn.find(x => !EMAIL_RE.test(x)); if (badCc) throw new Bad(`"${badCc}" isn't a valid email.`);
      const cc = [...new Set(ccIn)].filter(x => x !== to).slice(0, 10);
      if (!subject || !t.heading || !t.body) throw new Bad('Subject, heading and message are all needed.');
      let smsTo: string | null = null;
      if (b0.sms) { smsTo = e164(String(b0.smsTo || a?.phone || b.client_phone || '')); if (!smsTo) throw new Bad('Enter a valid mobile number for the text.'); }
      const smsBody = b0.sms ? fill(String(b0.smsBody || 'Your media for {address} is ready: {link}'), b, a).slice(0, 640) : '';

      const { html, text } = render(b, t);
      let provider: string | null = null, error: string | null = null;
      try { provider = await sendEmail(to, cc, subject, html, text); } catch (e) { error = (e as Error).message; }
      let smsOk: boolean | null = null, smsError: string | null = null;
      if (smsTo && provider) { try { await sendSms(smsTo, smsBody); smsOk = true; } catch (e) { smsOk = false; smsError = (e as Error).message; } }
      const markComplete = !!b0.markComplete && !!provider;
      await admin.from('delivery_emails').insert({ booking_id: b.id, template_key: String(b0.templateKey || '') || null, to_email: to, cc, bcc: BCC || null, subject, provider, ok: !!provider, error,
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
