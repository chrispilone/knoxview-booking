import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// One-time sign-in codes for the Knox View client portal.
//   options { email }           -> which ways we can send a code (email always; text if a mobile is on file)
//   send    { email, channel }  -> sends a Supabase email OTP by email (Resend, Gmail fallback) or by text (Quo)
// The browser then calls supabase.auth.verifyOtp({ email, token, type: 'email' }) to sign in.
// Texts only ever go to the phone number already on the client's record, never one typed in at sign-in.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const QUO_KEY = env('QUO_API_KEY');
const QUO_FROM = env('QUO_FROM_NUMBER') || '+18658555669';
const RESEND_KEY = env('RESEND_API_KEY');
const MAIL_FROM = env('AUTH_MAIL_FROM') || 'Knox View Media <noreply@mail.knoxview.com>';
const G_ID = env('GOOGLE_CLIENT_ID'), G_SECRET = env('GOOGLE_CLIENT_SECRET');

const ORIGINS = ['https://test.knoxview.com', 'https://book.knoxview.com', 'https://knoxview-booking.netlify.app', 'http://localhost:8888', 'http://localhost:5173'];
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-booking\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[a-z]{2,}$/i;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
async function sha(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
function e164(raw: string | null | undefined) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}
const maskPhone = (p: string) => `(•••) •••-${p.slice(-4)}`;
const maskEmail = (e: string) => { const [u, d] = e.split('@'); return `${u.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(u.length - 1, 6)))}@${d}`; };

async function phoneOnFile(email: string) {
  const { data } = await admin.from('agents').select('phone').ilike('email', email).not('phone', 'is', null).order('created_at').limit(1).maybeSingle();
  return e164(data?.phone);
}

/* ---------- code ---------- */
async function makeCode(email: string) {
  let r = await admin.auth.admin.generateLink({ type: 'magiclink', email, options: { data: { portal: 'client' } } });
  if (r.error) { // no login yet for this email: create one, then try again
    const c = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { portal: 'client' } });
    if (c.error && !/already/i.test(c.error.message)) throw c.error;
    r = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  }
  if (r.error) throw r.error;
  const code = r.data.properties?.email_otp;
  if (!code) throw new Error('No code returned');
  return code;
}

/* ---------- senders ---------- */
async function sendSms(to: string, code: string) {
  if (!QUO_KEY) throw new Bad('Text codes are not switched on yet. Choose email instead.', 503);
  const r = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST', headers: { Authorization: QUO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: QUO_FROM, to: [to], content: `${code} is your Knox View sign-in code. It expires in 1 hour. Don't share it with anyone.` }),
  });
  if (!r.ok) { console.error('quo send failed', r.status, await r.text()); throw new Bad("We couldn't send a text right now. Choose email instead.", 502); }
}
function emailParts(code: string) {
  const subject = `${code} is your Knox View sign-in code`;
  const text = `Your Knox View sign-in code is ${code}\n\nEnter it on the sign-in page. It expires in 1 hour.\nIf you didn't ask for this, you can ignore this email.\n\nKnox View Media · 865-855-5669`;
  const html = `<!doctype html><html><body style="margin:0;background:#eef2f7;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:14px">
<tr><td style="padding:28px;color:#1d3250;font-size:15px;line-height:1.6">
<p style="margin:0 0 6px;font-weight:bold;font-size:18px">Knox View Media</p>
<p style="margin:0 0 18px">Here's your sign-in code:</p>
<p style="margin:0 0 18px;font-size:34px;letter-spacing:8px;font-weight:bold;color:#1d3250">${esc(code)}</p>
<p style="margin:0 0 6px">Enter it on the sign-in page. It expires in 1 hour.</p>
<p style="margin:0;color:#6b7c93;font-size:13px">If you didn't ask for this, you can ignore this email.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
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
async function sendEmail(to: string, code: string) {
  const { subject, text, html } = emailParts(code);
  if (RESEND_KEY) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }) });
    if (r.ok) return;
    console.error('resend failed', r.status, await r.text());
  }
  const tok = await ownerGmailToken(); // fallback: send from the owner's Gmail
  if (tok) {
    const boundary = 'kvcode_' + crypto.randomUUID().replace(/-/g, '');
    const raw = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(text),
      `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(html), `--${boundary}--`, ''].join('\r\n');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: b64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }) });
    if (r.ok) return;
    console.error('gmail failed', r.status, await r.text());
  }
  throw new Bad("We couldn't send the email right now. Please try again or call 865-855-5669.", 502);
}

/* ---------- limits ---------- */
async function checkLimits(email: string, ipHash: string | null) {
  const since = (min: number) => new Date(Date.now() - min * 60000).toISOString();
  const { count: recent } = await admin.from('auth_code_sends').select('id', { count: 'exact', head: true }).ilike('email', email).gte('created_at', since(1));
  if ((recent ?? 0) >= 1) throw new Bad('A code was just sent. Wait a minute before asking for another.', 429);
  const { count: hour } = await admin.from('auth_code_sends').select('id', { count: 'exact', head: true }).ilike('email', email).gte('created_at', since(60));
  if ((hour ?? 0) >= 5) throw new Bad('Too many codes requested. Try again in an hour or call 865-855-5669.', 429);
  if (ipHash) {
    const { count: ipHour } = await admin.from('auth_code_sends').select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).gte('created_at', since(60));
    if ((ipHour ?? 0) >= 15) throw new Bad('Too many codes requested. Try again later.', 429);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const b = await req.json().catch(() => ({}));
    const email = String(b.email ?? '').trim().toLowerCase().slice(0, 200);
    if (!EMAIL_RE.test(email)) throw new Bad('Enter a valid email.');

    if (b.action === 'options') {
      const phone = await phoneOnFile(email);
      return json(req, { email: maskEmail(email), sms: phone && QUO_KEY ? maskPhone(phone) : null });
    }

    if (b.action === 'send') {
      const channel = b.channel === 'sms' ? 'sms' : 'email';
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
      const ipHash = ip ? await sha('kv-auth:' + ip) : null;
      await checkLimits(email, ipHash);
      const phone = channel === 'sms' ? await phoneOnFile(email) : null;
      if (channel === 'sms' && !phone) throw new Bad("There's no mobile number on file for this email. Choose email instead.");
      const code = await makeCode(email);
      let ok = false;
      try {
        if (channel === 'sms') await sendSms(phone!, code); else await sendEmail(email, code);
        ok = true;
      } finally {
        await admin.from('auth_code_sends').insert({ email, channel, ip_hash: ipHash, ok });
      }
      return json(req, { sent: true, channel, to: channel === 'sms' ? maskPhone(phone!) : maskEmail(email) });
    }

    throw new Bad('Unknown action');
  } catch (e) {
    const status = e instanceof Bad ? e.status : 500;
    if (status >= 500 && !(e instanceof Bad)) console.error('auth-code error', String((e as Error)?.message || e));
    return json(req, { error: e instanceof Bad ? e.message : 'Something went wrong. Please try again or call 865-855-5669.' }, status);
  }
});
