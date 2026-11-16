import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// One-time sign-in codes for the Knox View client portal.
//   send   { channel: 'email', email } | { channel: 'sms', phone } -> sends a one-time code, returns { ref, to }
//   signup { first_name, last_name (or name), phone, email, company } -> emails a code to confirm the email; same reply as send
//   test_session (HQ super admins only) -> a session for the portal's TEST client account, for previewing the portal
//   verify { ref, code }  -> checks the code and returns a Supabase session for the browser (setSession).
//                            For a sign-up, the client record (agents) is created or filled in here, once the email is proven.
// A phone number only works if it matches a client record; the code is texted to that number on file
// by Twilio Verify (Twilio creates and checks the code), or by Quo if Twilio isn't set up.
// The client's email is never sent back to the browser for phone sign-ins.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const anon = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const TW_SID = env('TWILIO_ACCOUNT_SID'), TW_TOKEN = env('TWILIO_AUTH_TOKEN'), TW_VERIFY = env('TWILIO_VERIFY_SERVICE_SID');
const TWILIO = !!(TW_SID && TW_TOKEN && TW_VERIFY); // texts go through Twilio Verify when set; Quo is the fallback
const QUO_KEY = env('QUO_API_KEY');
const QUO_FROM = env('QUO_FROM_NUMBER') || '+18658555669';
const RESEND_KEY = env('RESEND_API_KEY');
const MAIL_FROM = env('AUTH_MAIL_FROM') || 'Knox View Media <noreply@mail.knoxview.com>';
const G_ID = env('GOOGLE_CLIENT_ID'), G_SECRET = env('GOOGLE_CLIENT_SECRET');

const TEST_CLIENT_EMAIL = 'chris+test@knoxview.com'; // the only account test_session can open
const ORIGINS = ['https://hq.knoxview.com', 'https://test.knoxview.com', 'https://book.knoxview.com', 'https://knoxview-booking.netlify.app', 'http://localhost:8888', 'http://localhost:5173'];
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

async function emailForPhone(phone: string) { // client record whose phone matches (formatting ignored)
  const last10 = phone.slice(-10);
  const { data } = await admin.from('agents').select('email, phone, created_at').not('phone', 'is', null).not('email', 'is', null).ilike('phone', `%${last10.slice(-4)}%`).order('created_at').limit(200);
  const hit = (data ?? []).find(a => e164(a.phone) === phone);
  return hit ? String(hit.email).toLowerCase() : null;
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

/* ---------- Twilio Verify ---------- */
async function twilio(path: string, params: Record<string, string>) {
  const r = await fetch(`https://verify.twilio.com/v2/Services/${TW_VERIFY}/${path}`, {
    method: 'POST', headers: { Authorization: 'Basic ' + btoa(`${TW_SID}:${TW_TOKEN}`), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}
async function twilioSend(to: string) {
  const r = await twilio('Verifications', { To: to, Channel: 'sms' });
  if (!r.ok) { console.error('twilio send failed', r.status, JSON.stringify(r.d)); throw new Bad("We couldn't send a text right now. Use your email instead.", 502); }
}
async function twilioCheck(to: string, code: string) {
  const r = await twilio('VerificationCheck', { To: to, Code: code });
  if (r.status === 404) return false; // expired, already used, or too many tries
  if (!r.ok) { console.error('twilio check failed', r.status, JSON.stringify(r.d)); throw new Bad("We couldn't check that code right now. Please try again.", 502); }
  return r.d.status === 'approved';
}
async function sessionFor(email: string) { // mint a Supabase session for a client Twilio has verified
  const code = await makeCode(email);
  const { data, error } = await anon().auth.verifyOtp({ email, token: code, type: 'email' });
  if (error || !data.session) throw error || new Error('No session');
  return data.session;
}

/* ---------- senders ---------- */
async function sendSms(to: string, code: string) {
  if (!QUO_KEY) throw new Bad('Text codes are not switched on yet. Use your email instead.', 503);
  const r = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST', headers: { Authorization: QUO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: QUO_FROM, to: [to], content: `${code} is your Knox View sign-in code. It expires in 1 hour. Don't share it with anyone.` }),
  });
  if (!r.ok) { console.error('quo send failed', r.status, await r.text()); throw new Bad("We couldn't send a text right now. Use your email instead.", 502); }
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

/* ---------- sign-up ---------- */
async function saveClient(email: string, userId: string, s: { name?: string; first?: string; last?: string; phone?: string; company?: string }) {
  const { data: agent } = await admin.from('agents').select('id, phone, brokerage, auth_user_id').ilike('email', email).order('created_at').limit(1).maybeSingle();
  if (agent) { // already a client: fill in only what's missing, never overwrite
    const fill: Record<string, unknown> = {};
    if (!agent.phone && s.phone) fill.phone = s.phone;
    if (!agent.brokerage && s.company) fill.brokerage = s.company;
    if (!agent.auth_user_id) fill.auth_user_id = userId;
    if (Object.keys(fill).length) await admin.from('agents').update(fill).eq('id', agent.id);
    return;
  }
  const { error } = await admin.from('agents').insert({ full_name: s.name || email, ...(s.first && s.last ? { first_name: s.first, last_name: s.last } : {}), email, phone: s.phone || null, brokerage: s.company || null,
    auth_user_id: userId, preferences: 'Created by portal sign-up' });
  if (error) console.error('signup insert failed', error.message);
}

/* ---------- limits ---------- */
async function checkIp(ipHash: string | null) {
  if (!ipHash) return;
  const { count } = await admin.from('auth_code_sends').select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).gte('created_at', new Date(Date.now() - 3600_000).toISOString());
  if ((count ?? 0) >= 15) throw new Bad('Too many codes requested. Try again later.', 429);
}
async function checkLimits(email: string, channel: string) {
  const since = (min: number) => new Date(Date.now() - min * 60000).toISOString();
  const { count: recent } = await admin.from('auth_code_sends').select('id', { count: 'exact', head: true }).ilike('email', email).eq('channel', channel).gte('created_at', since(1));
  if ((recent ?? 0) >= 1) throw new Bad('A code was just sent. Wait a minute before asking for another.', 429);
  const { count: hour } = await admin.from('auth_code_sends').select('id', { count: 'exact', head: true }).ilike('email', email).gte('created_at', since(60));
  if ((hour ?? 0) >= 5) throw new Bad('Too many codes requested. Try again in an hour or call 865-855-5669.', 429);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const b = await req.json().catch(() => ({}));
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const ipHash = ip ? await sha('kv-auth:' + ip) : null;

    if (b.action === 'status') { // setup check: which senders are configured (no secrets returned, nothing sent)
      let twilio: Record<string, unknown> = { configured: TWILIO };
      if (TWILIO) {
        const r = await fetch(`https://verify.twilio.com/v2/Services/${TW_VERIFY}`, { headers: { Authorization: 'Basic ' + btoa(`${TW_SID}:${TW_TOKEN}`) } });
        const d = await r.json().catch(() => ({}));
        twilio = { configured: true, ok: r.ok, status: r.status, service: r.ok ? d.friendly_name : null, error: r.ok ? null : d.message ?? null };
      }
      return json(req, { twilio, quo: !!QUO_KEY, resend: !!RESEND_KEY });
    }

    if (b.action === 'send') {
      const channel = b.channel === 'sms' ? 'sms' : 'email';
      await checkIp(ipHash);
      let email: string, phone: string | null = null;
      if (channel === 'sms') {
        phone = e164(String(b.phone ?? ''));
        if (!phone) throw new Bad('Enter a 10-digit mobile number.');
        const found = await emailForPhone(phone);
        if (!found) {
          await admin.from('auth_code_sends').insert({ email: null, channel, ip_hash: ipHash, ok: false }); // counts toward the IP limit
          throw new Bad("We couldn't find an account with that number. Try your email instead, or call 865-855-5669.", 404);
        }
        email = found;
      } else {
        email = String(b.email ?? '').trim().toLowerCase().slice(0, 200);
        if (!EMAIL_RE.test(email)) throw new Bad('Enter a valid email.');
      }
      await checkLimits(email, channel);
      const provider = channel === 'email' ? 'supabase' : TWILIO ? 'twilio' : 'quo';
      const { data: row, error: insErr } = await admin.from('auth_code_sends').insert({ email, channel, phone, provider, ip_hash: ipHash, ok: false }).select('id, ref').single();
      if (insErr) throw insErr;
      if (provider === 'twilio') await twilioSend(phone!);
      else { const code = await makeCode(email); if (channel === 'sms') await sendSms(phone!, code); else await sendEmail(email, code); }
      await admin.from('auth_code_sends').update({ ok: true }).eq('id', row.id);
      return json(req, { sent: true, channel, ref: row.ref, expiresMin: provider === 'twilio' ? 10 : 60, to: channel === 'sms' ? maskPhone(phone!) : email });
    }

    if (b.action === 'test_session') { // HQ → "Open as test client". Caller must be an active HQ super admin.
      const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
      const uid = u?.user?.id;
      const { data: me } = uid ? await admin.from('team_members').select('id, role, active, permissions').eq('id', uid).maybeSingle() : { data: null };
      if (!me?.active || !(me.role === 'owner' || me.permissions?.super_admin === true)) throw new Bad('Only HQ super admins can open the test client account.', 403);
      const session = await sessionFor(TEST_CLIENT_EMAIL);
      console.log('test_session opened by', me.id);
      return json(req, { email: TEST_CLIENT_EMAIL, session: { access_token: session.access_token, refresh_token: session.refresh_token } });
    }

    if (b.action === 'signup') {
      const clean = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
      const first = clean(b.first_name, 60), last = clean(b.last_name, 60); // sent separately by the sign-up form
      const name = first && last ? `${first} ${last}` : clean(b.name, 120), company = clean(b.company, 160);
      const email = clean(b.email, 200).toLowerCase(), phone = e164(String(b.phone ?? ''));
      if (name.split(' ').filter(Boolean).length < 2) throw new Bad('Enter your first and last name.');
      if (!phone) throw new Bad('Enter a 10-digit mobile number.');
      if (!EMAIL_RE.test(email)) throw new Bad('Enter a valid email.');
      await checkIp(ipHash);
      await checkLimits(email, 'email');
      const d = phone.slice(2), pretty = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
      const { data: row, error: insErr } = await admin.from('auth_code_sends').insert({ email, channel: 'email', provider: 'supabase', ip_hash: ipHash, ok: false,
        signup: { name, first, last, phone: pretty, company } }).select('id, ref').single();
      if (insErr) throw insErr;
      await sendEmail(email, await makeCode(email));
      await admin.from('auth_code_sends').update({ ok: true }).eq('id', row.id);
      return json(req, { sent: true, channel: 'email', ref: row.ref, expiresMin: 60, to: email });
    }

    if (b.action === 'verify') {
      const ref = String(b.ref ?? ''), code = String(b.code ?? '').replace(/\D/g, '');
      if (!/^[0-9a-f-]{36}$/i.test(ref) || code.length < 6) throw new Bad('Enter the code we sent you.');
      const { data: row } = await admin.from('auth_code_sends').select('id, email, phone, provider, ok, attempts, created_at, signup').eq('ref', ref).maybeSingle();
      if (!row || !row.ok || !row.email || Date.parse(row.created_at) < Date.now() - 3600_000) throw new Bad('That code has expired. Send a new one.');
      if (row.attempts >= 5) throw new Bad('Too many tries. Send a new code.', 429);
      await admin.from('auth_code_sends').update({ attempts: row.attempts + 1 }).eq('id', row.id);
      let session;
      if (row.provider === 'twilio') {
        if (!(await twilioCheck(row.phone, code))) throw new Bad('That code is wrong or has expired. Check it or send a new one.');
        session = await sessionFor(row.email);
      } else {
        const { data, error } = await anon().auth.verifyOtp({ email: row.email, token: code, type: 'email' });
        if (error || !data.session) throw new Bad('That code is wrong or has expired. Check it or send a new one.');
        session = data.session;
      }
      if (row.signup && session.user?.id) await saveClient(row.email, session.user.id, row.signup);
      return json(req, { session: { access_token: session.access_token, refresh_token: session.refresh_token } });
    }

    throw new Bad('Unknown action');
  } catch (e) {
    const status = e instanceof Bad ? e.status : 500;
    if (status >= 500 && !(e instanceof Bad)) console.error('auth-code error', String((e as Error)?.message || e));
    return json(req, { error: e instanceof Bad ? e.message : 'Something went wrong. Please try again or call 865-855-5669.' }, status);
  }
});
