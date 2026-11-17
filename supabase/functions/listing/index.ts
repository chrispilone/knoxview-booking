import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { sign, verify, galleryEntries, galleryAddress, parseVimeo, vimeoEmbed, vimeoInfo } from './lib.ts';

// Single property websites: listing.knoxview.com/<slug> (branded) and /<slug>/mls (unbranded, MLS-safe).
// The pages themselves are drawn by the Netlify edge function in the booking portal site (netlify/edge-functions/listing.ts);
// this function gives it the data and lets clients and HQ edit the editable fields.
//   page    { slug, mls?, preview? }        -> everything the page shows (public). Off / unpaid / not completed -> { off: true }
//   track   { slug, mls, event, v, device, ref } -> counts a view (returns the total) or an action (photo_open, video_play, call…) for stats
//   contact { slug, name, email, phone, message, company } -> emails the agent (branded page's contact form; `company` is a bot trap)
//   editor  { bookingId }                   -> the editable fields + links + a preview token (the order's client, or HQ staff)
//   save    { bookingId, site }             -> saves title / subtitle / description / facts (the order's client, or HQ staff)
//   enable  { bookingId, enabled }          -> turns the order's property websites on/off (HQ only; same switch as the Media Library)
// bookings.site = { title, subtitle, description, facts: [{ k, icon, label, value, show }], template }
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const RESEND_KEY = env('RESEND_API_KEY'), MAIL_FROM = env('DELIVERY_MAIL_FROM') || 'Knox View <bookings@mail.knoxview.com>';
const SITE_BASE = 'https://listing.knoxview.com';
const ORIGINS = ['https://listing.knoxview.com', 'https://hq.knoxview.com', 'https://test.knoxview.com', 'https://book.knoxview.com', 'https://knoxview-booking.netlify.app', 'http://localhost:8888', 'http://localhost:5173'];
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-(booking|hq)\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }
const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const FACT_ICONS = ['price', 'bed', 'bath', 'size', 'lot', 'year', 'garage', 'home', 'pool', 'view', 'star'];
function defaults(b: any) {
  const line = galleryAddress(b);
  const sub = [b.city, [b.state, b.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return {
    title: line, subtitle: sub, description: '', template: 'signature',
    facts: [
      { k: 'price', icon: 'price', label: 'Price', value: '', show: true },
      { k: 'beds', icon: 'bed', label: 'Beds', value: '', show: true },
      { k: 'baths', icon: 'bath', label: 'Baths', value: '', show: true },
      { k: 'size', icon: 'size', label: 'Size', value: b.sqft ? `${Number(b.sqft).toLocaleString('en-US')} sq ft` : '', show: true },
      { k: 'lot', icon: 'lot', label: 'Lot', value: '', show: true },
    ],
  };
}
const siteOf = (b: any) => { const d = defaults(b), s = (b.site && typeof b.site === 'object') ? b.site : {};
  return { ...d, ...s, facts: Array.isArray(s.facts) && s.facts.length ? s.facts : d.facts }; };
function sanitize(input: any, b: any) {
  const d = defaults(b);
  const facts = (Array.isArray(input?.facts) ? input.facts : d.facts).slice(0, 12).map((f: any, i: number) => ({
    k: clean(f?.k, 24) || `f${i}`, icon: FACT_ICONS.includes(f?.icon) ? f.icon : 'star', label: clean(f?.label, 40), value: clean(f?.value, 60), show: f?.show !== false }));
  return { title: clean(input?.title, 140) || d.title, subtitle: clean(input?.subtitle, 160), description: clean(input?.description, 6000),
    template: ['signature'].includes(input?.template) ? input.template : 'signature', facts };
}
// Price "450000" -> "$450,000"; anything with words stays as typed
const money = (v: string) => /^\$?\s*[\d,]+(\.\d{1,2})?$/.test(v.trim()) ? '$' + Number(v.replace(/[^\d.]/g, '')).toLocaleString('en-US', { maximumFractionDigits: 0 }) : v;

// Links stay the same for a week at a time, so the CDN and browsers can cache the photos.
const WEEK = 7 * 86400;
const stableExp = () => (Math.ceil(Date.now() / 1000 / WEEK) + 1) * WEEK;

async function whoCanEdit(req: Request, b: any) {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
  if (!u?.user) throw new Bad('Please sign in again.', 401);
  const { data: me } = await admin.from('team_members').select('id, role, active, permissions').eq('id', u.user.id).maybeSingle();
  if (me?.active) return { staff: true, admin: me.role === 'owner' || me.permissions?.super_admin === true };
  const { data: agent } = await admin.from('agents').select('id').eq('auth_user_id', u.user.id).maybeSingle();
  if (agent && b.agent_id === agent.id) return { staff: false, admin: false };
  throw new Bad('Listing not found', 404);
}
const previewToken = (slug: string) => sign({ src: 'url', url: 'site-preview:' + slug }, 72);
async function previewOk(slug: string, tok: string) {
  try { const u = new URL(tok); const r = await verify(u.searchParams.get('d') || '', u.searchParams.get('s') || ''); return r?.url === 'site-preview:' + slug; } catch { return false; }
}
const live = (b: any) => b.status === 'completed' && b.websites_enabled !== false && (b.paid || b.require_payment === false);

async function page(b: any, mls: boolean) {
  const s = siteOf(b), exp = stableExp();
  const photos = await Promise.all(galleryEntries(b).map(async f => f.kind === 'dbx'
    ? { u: await sign({ src: 'dbxp', path: f.path, v: 'high', name: f.name, pub: 1 }, 0, exp) }
    : { u: await sign({ src: 'url', url: f.url!, v: 'high', name: f.name, pub: 1 }, 0, exp) }));
  // videos: the MLS page shows unbranded cuts (and never one labelled branded); the branded page prefers branded cuts
  const all = ((b.videos as any[]) ?? []).filter(v => v?.url);
  const isUnb = (v: any) => /unbrand|mls|non.?brand/i.test(v.label || '');
  const isBr = (v: any) => !isUnb(v) && /brand/i.test(v.label || '');
  let vids = mls ? all.filter(v => !isBr(v)) : all.filter(v => !isUnb(v));
  if (!vids.length && !mls) vids = all;
  const videos = [];
  for (const v of vids) {
    const vm = parseVimeo(v.url); if (!vm) continue;
    const info = await vimeoInfo(vm.id).catch(() => null);
    videos.push({ embed: vimeoEmbed(vm), title: (v.label || info?.name || 'Video').replace(/\b(un)?branded\b|\bmls\b/ig, '').replace(/\s*[-–·]\s*$/, '').trim() || 'Video',
      poster: info?.pictures?.base_link ? info.pictures.base_link + '_1920x1080' : null, portrait: info ? (info.height || 0) > (info.width || 0) : false });
  }
  const plans: any[] = [];
  for (const f of ((b.floorplan_files as any[]) ?? []).filter(f => f?.path)) plans.push({ name: f.name, pdf: /\.pdf$/i.test(f.name), u: await sign({ src: 'dbxp', path: f.path, v: 'high', name: f.name, pub: 1 }, 0, exp) });
  for (const f of ((b.media_files as any[]) ?? []).filter(f => f?.kind === 'floorplan' && /^https:/.test(f.url || ''))) plans.push({ name: f.name || 'Floor plan', pdf: /\.pdf$/i.test(f.name || f.url), u: await sign({ src: 'url', url: f.url, v: 'high', name: f.name || 'floor-plan', pub: 1 }, 0, exp) });
  let agent = null;
  if (!mls && b.agent_id) {
    const { data: a } = await admin.from('agents').select('full_name, first_name, last_name, email, phone, brokerage, team_name, photo_url, brand_logo_url, logo_url, website_url, company_id').eq('id', b.agent_id).maybeSingle();
    const { data: co } = a?.company_id ? await admin.from('companies').select('name, brokerage, team_name, logo_url, website_url').eq('id', a.company_id).maybeSingle() : { data: null };
    if (a) agent = { name: a.full_name || [a.first_name, a.last_name].filter(Boolean).join(' '), email: a.email, phone: a.phone,
      brokerage: co?.brokerage || co?.name || a.brokerage || null, team: co?.team_name || a.team_name || null,
      photo: a.photo_url || null, logo: a.brand_logo_url || co?.logo_url || a.logo_url || null, website: a.website_url || co?.website_url || null };
  }
  const facts = s.facts.filter((f: any) => f.show !== false && f.value).map((f: any) => ({ icon: f.icon, label: f.label, value: f.k === 'price' || f.icon === 'price' ? money(f.value) : f.value }));
  return {
    slug: b.site_slug, mls, template: s.template, title: s.title, subtitle: s.subtitle, description: s.description, facts,
    address: { line: galleryAddress(b), city: b.city || '', state: b.state || '', zip: b.zip || '', full: [galleryAddress(b), b.city, [b.state, b.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') },
    photos, videos, tour: b.tour_url || null, floorplans: plans, agent, views: b.site_views || 0,
    links: { branded: `${SITE_BASE}/${b.site_slug}`, mls: `${SITE_BASE}/${b.site_slug}/mls` },
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'page') {
      const slug = clean(body.slug, 120).toLowerCase();
      const { data: b } = slug ? await admin.from('bookings').select('*').eq('site_slug', slug).maybeSingle() : { data: null };
      if (!b) return json(req, { missing: true }, 404);
      const pv = body.preview ? await previewOk(slug, String(body.preview)) : false;
      if (!live(b) && !pv) return json(req, { off: true, title: galleryAddress(b) });
      return json(req, { ...(await page(b, !!body.mls)), preview: pv && !live(b) });
    }

    if (action === 'track') {
      const EVENTS = ['view', 'photo_open', 'video_play', 'tour_open', 'plan_open', 'share', 'call', 'text', 'email', 'website', 'directions', 'contact_sent'];
      const ev = String(body.event || '');
      if (!EVENTS.includes(ev)) return json(req, { ok: false });
      let ref = ''; try { ref = body.ref ? new URL(String(body.ref)).hostname.replace(/^www\./, '') : ''; } catch (_) { /* no referrer */ }
      if (ref === 'listing.knoxview.com') ref = '';
      const { data, error } = await admin.rpc('track_site_event', { p_slug: clean(body.slug, 120).toLowerCase(), p_mls: !!body.mls, p_event: ev,
        p_visitor: clean(body.v, 64) || null, p_device: ['phone', 'tablet', 'desktop'].includes(body.device) ? body.device : null, p_referrer: ref || null });
      if (error) console.error('track', error.message);
      return json(req, { ok: !error, views: data ?? null });
    }
    if (action === 'contact') {
      if (body.company) return json(req, { ok: true }); // bot
      const slug = clean(body.slug, 120).toLowerCase();
      const { data: b } = await admin.from('bookings').select('id, address, unit, city, agent_id, site_slug, status, websites_enabled, paid, require_payment').eq('site_slug', slug).maybeSingle();
      if (!b || !live(b) || !b.agent_id) throw new Bad('This listing is not taking messages right now.', 404);
      const name = clean(body.name, 120), email = clean(body.email, 160).toLowerCase(), phone = clean(body.phone, 40), message = clean(body.message, 3000);
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !message) throw new Bad('Add your name, email and a message.');
      const { data: a } = await admin.from('agents').select('email, full_name').eq('id', b.agent_id).maybeSingle();
      if (!a?.email) throw new Bad('This listing is not taking messages right now.', 404);
      const addr = galleryAddress(b);
      await admin.from('site_leads').insert({ booking_id: b.id, agent_id: b.agent_id, name, email, phone: phone || null, message });
      if (!RESEND_KEY) throw new Bad('Messages are not set up yet. Please call or text the agent.', 503);
      const lines = [`New message from your property website for ${addr}`, '', `Name: ${name}`, `Email: ${email}`, phone ? `Phone: ${phone}` : '', '', message, '', `${SITE_BASE}/${b.site_slug}`].filter((l, i, arr) => l || arr[i - 1]);
      const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:22px;color:#1d3250">${lines.map(l => l ? esc(l) : '&nbsp;').join('<br>')}</div>`;
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: MAIL_FROM, to: [a.email], reply_to: email, subject: `${name} asked about ${addr}`, html, text: lines.join('\n') }) });
      if (!r.ok) { console.error('resend', r.status, (await r.text()).slice(0, 300)); throw new Bad('Your message could not be sent. Please call or text the agent.', 502); }
      await admin.rpc('track_site_event', { p_slug: slug, p_mls: false, p_event: 'contact_sent', p_visitor: clean(body.v, 64) || null, p_device: null, p_referrer: null });
      return json(req, { ok: true });
    }

    const { data: b } = await admin.from('bookings').select('*').eq('id', String(body.bookingId || '')).maybeSingle();
    if (!b) throw new Bad('Listing not found', 404);
    const who = await whoCanEdit(req, b);

    if (action === 'editor') {
      return json(req, { site: siteOf(b), slug: b.site_slug, icons: FACT_ICONS, enabled: b.websites_enabled !== false, live: live(b),
        completed: b.status === 'completed', locked: !(b.paid || b.require_payment === false),
        links: b.site_slug ? { branded: `${SITE_BASE}/${b.site_slug}`, mls: `${SITE_BASE}/${b.site_slug}/mls` } : null,
        preview: b.site_slug ? await previewToken(b.site_slug) : null, canToggle: who.staff, views: b.site_views || 0 });
    }
    if (action === 'save') {
      const site = sanitize(body.site, b);
      const now = new Date().toISOString();
      const { error } = await admin.from('bookings').update({ site, site_updated_at: now, updated_at: now }).eq('id', b.id);
      if (error) throw new Error(error.message);
      return json(req, { ok: true, site });
    }
    if (action === 'enable') {
      if (!who.staff) throw new Bad('Only Knox View can turn property websites on or off.', 403);
      const { error } = await admin.from('bookings').update({ websites_enabled: !!body.enabled, updated_at: new Date().toISOString() }).eq('id', b.id);
      if (error) throw new Error(error.message);
      return json(req, { ok: true, enabled: !!body.enabled });
    }
    throw new Bad('Unknown action');
  } catch (e) {
    const status = e instanceof Bad ? e.status : 500;
    if (!(e instanceof Bad)) console.error('listing fn error', String((e as Error)?.message || e));
    return json(req, { error: e instanceof Bad ? e.message : 'Something went wrong.' }, status);
  }
});
