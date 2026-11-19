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
    // short, structured answers: thinking off (it would use up the token budget before any text)
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens + 400, thinking: { type: 'disabled' }, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `${r.status} ${j?.error?.message || ''}`.trim() };
  const text = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('').trim();
  return text ? { text } : { error: `empty reply (stop: ${j.stop_reason}, blocks: ${(j.content ?? []).map((c: any) => c.type).join(',') || 'none'})` };
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


// ---- Quo sync: calls and texts → touches, call log and notes ----
// Main line only (Knox View Media - Primary). Nothing is ever sent from here.
const QUO_LINE = () => env('QUO_LINE_ID') || 'PNlVTpIVEG';
const e164 = (p: string | null | undefined) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : null; };
const etDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const NOTE_RULES = 'Never include lockbox, gate or alarm codes, door codes, passwords, or any prices, fees or dollar amounts.';
async function aiNote(callId: string, client: any) {
  const [sum, tr] = await Promise.all([quo('/call-summaries/' + callId).catch(() => null), quo('/call-transcripts/' + callId).catch(() => null)]);
  const lines = (tr?.data?.dialogue ?? []).map((d: any) => `${e164(d.identifier) === e164(client.phone) || e164(d.identifier) === e164(client.call_phone) ? 'Client' : 'Chris'}: ${d.content}`).join('\n').slice(0, 9000);
  const qs = [...(sum?.data?.summary ?? []), ...(sum?.data?.nextSteps ?? []).map((x: string) => 'Next step: ' + x)].join('\n').slice(0, 3000);
  if (!lines && !qs) return null;
  const today = etDate(), dow = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const prompt = `You write call notes for Chris Pilone, owner of Knox View Media (real estate photography and video). This call was with ${client.name}${client.company ? ` (${client.company})` : ''}, a real estate agent client.
Today is ${dow}, ${today}.

Quo's summary:
${qs || '(none)'}

Transcript:
${lines || '(none)'}

Return only JSON, no other text:
{"note": "1-2 short sentences for Chris, calling him 'you': what you talked about and any follow-up", "scheduling_only": true if the call was only about logistics (arrival time, directions, access, rescheduling) with no relationship conversation, "test": true if it is a test call, "followup": null, or {"date": "YYYY-MM-DD", "about": "a few words", "quote": "the client's or Chris's exact words that set the timing"} only when the client asked to be contacted again later or Chris promised to call back at a set time. Turn timing into a date: "after Thanksgiving" = the Monday after Thanksgiving, "after the holidays" = the first Monday in January, weekends move to Monday. Do not set a follow-up for booking a shoot, sending photos, or "talk soon".}
${NOTE_RULES}`;
  const r = await claude(prompt, 800);
  if (!r.text) return { error: r.error };
  const t = r.text, a = t.indexOf('{'), b = t.lastIndexOf('}');
  try { const j = JSON.parse(t.slice(a, b + 1)); return { note: String(j.note || '').slice(0, 500), scheduling: !!j.scheduling_only, test: !!j.test, followup: j.followup && /^\d{4}-\d\d-\d\d$/.test(j.followup.date || '') ? j.followup : null }; }
  catch (_) { // cut-off or loose JSON: keep just the note text
    const m = t.match(/"note"\s*:\s*"((?:[^"\\]|\\.)*)/); const note = m ? m[1].replace(/\\"/g, '"') : t.replace(/[{}]/g, '').slice(0, 400);
    return { note: note.slice(0, 500), scheduling: /"scheduling_only"\s*:\s*true/.test(t), test: /"test"\s*:\s*true/.test(t), followup: null }; }
}
async function quoSync(set: any) {
  const care = set.care || {};
  const started = new Date().toISOString();
  const since = care.quoSyncedAt || new Date(Date.now() - 14 * 864e5).toISOString();
  const { data: clients } = await admin.from('cc_clients').select('*').eq('hidden', false);
  const byPhone = new Map<string, any>();
  for (const c of clients ?? []) for (const p of [c.phone, c.call_phone, ...(c.alt_phones || [])]) { const k = e164(p); if (k && !byPhone.has(k)) byPhone.set(k, c); }
  const line = QUO_LINE(), report: any = { conversations: 0, calls: 0, logged: 0, attached: 0, notes: 0, texts: 0, suggestions: 0, unknown: 0, errors: [] as string[] };
  const unknown: any[] = (care.unknown || []).filter((u: any) => !u.dismissed);
  let aiLeft = 25, token: string | null = null;
  for (let page = 0; page < 20; page++) {
    const j = await quo(`/conversations?phoneNumbers[]=${line}&updatedAfter=${encodeURIComponent(since)}&maxResults=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
    for (const cv of j?.data ?? []) {
      if ((cv.participants ?? []).length !== 1) continue;
      const num = e164(cv.participants[0]); if (!num) continue;
      report.conversations++;
      const c = byPhone.get(num);
      try {
        const calls = (await quo(`/calls?phoneNumberId=${line}&participants[]=${encodeURIComponent(num)}&createdAfter=${encodeURIComponent(since)}&maxResults=50`))?.data ?? [];
        const mine = calls.filter((x: any) => (x.participants ?? []).some((p: string) => e164(p) === num) && x.status === 'completed');
        if (!c) { // a number that isn't a client: list longer calls so they can be linked in HQ
          for (const x of mine.filter((x: any) => (x.duration || 0) >= 60)) if (!unknown.some(u => u.call === x.id)) { unknown.push({ call: x.id, number: num, at: x.createdAt, duration: x.duration, direction: x.direction }); report.unknown++; }
          continue;
        }
        const msgs = (await quo(`/messages?phoneNumberId=${line}&participants[]=${encodeURIComponent(num)}&createdAfter=${encodeURIComponent(since)}&maxResults=50`))?.data ?? [];
        const lastText = msgs.map((m: any) => m.createdAt).sort().pop();
        const upd: any = {};
        if (lastText && (!c.last_text_at || lastText > c.last_text_at)) { upd.last_text_at = lastText; report.texts++; }
        for (const x of mine.sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt))) {
          report.calls++;
          const { data: have } = await admin.from('cc_calls').select('id').eq('quo_call_id', x.id).maybeSingle(); if (have) continue;
          const talked = !!x.answeredAt && (x.duration || 0) >= 15;
          const outcome = talked ? 'talked' : x.direction === 'outgoing' && (x.duration || 0) >= 8 ? 'voicemail' : 'no_answer';
          if (outcome === 'no_answer' && x.direction === 'incoming') continue;
          // a call already marked Done in HQ that day (within 12 hours) gets this Quo call attached
          const lo = new Date(new Date(x.createdAt).getTime() - 12 * 36e5).toISOString(), hi = new Date(new Date(x.createdAt).getTime() + 12 * 36e5).toISOString();
          const { data: hq } = await admin.from('cc_calls').select('id, note').eq('client_id', c.id).eq('source', 'hq').is('quo_call_id', null).gte('at', lo).lte('at', hi).order('at').limit(1).maybeSingle();
          let ai: any = null;
          if (talked && (x.duration || 0) >= 45 && aiLeft > 0 && env('ANTHROPIC_API_KEY')) { aiLeft--; ai = await aiNote(x.id, c); if (ai?.error) { report.errors.push(`note ${c.name}: ${ai.error}`); ai = null; } }
          if (ai?.test) continue;
          const note = ai?.note || null;
          if (hq) {
            await admin.from('cc_calls').update({ quo_call_id: x.id, duration: x.duration, ...(note && !hq.note ? { note, ai_note: true } : {}), scheduling: !!ai?.scheduling }).eq('id', hq.id);
            if (note && !hq.note) upd.last_call_note = note;
            report.attached++;
          } else {
            await admin.from('cc_calls').insert({ client_id: c.id, at: x.createdAt, kind: 'other', outcome, note, ai_note: !!note, scheduling: !!ai?.scheduling, source: 'quo', quo_call_id: x.id, duration: x.duration });
            if (note) upd.last_call_note = note;
            report.logged++;
          }
          if (note) report.notes++;
          if (!c.last_call_at || x.createdAt > c.last_call_at) upd.last_call_at = c.last_call_at = x.createdAt;
          if (ai?.followup && !c.followup_on && ai.followup.date > etDate()) { upd.suggest = { ...ai.followup, call_id: x.id, at: x.createdAt }; report.suggestions++; }
        }
        if (Object.keys(upd).length) await admin.from('cc_clients').update(upd).eq('id', c.id);
      } catch (e) { report.errors.push(`${c?.name || num}: ${(e as Error).message}`.slice(0, 200)); }
    }
    token = j?.nextPageToken || null; if (!token) break;
  }
  const { data: cur } = await admin.from('booking_settings').select('care').eq('id', 1).single();
  await admin.from('booking_settings').update({ care: { ...(cur?.care || care), quoSyncedAt: started, unknown: unknown.slice(-40), lastQuo: { at: started, ...report, errors: report.errors.slice(0, 10) } } }).eq('id', 1);
  return report;
}
// Voicemail → a short follow-up text in Chris's voice (never sent; HQ shows it to copy into Quo)
async function vmText(clientId: string) {
  const { data: c } = await admin.from('cc_clients').select('*').eq('id', clientId).maybeSingle(); if (!c) throw new Bad('Client not found.', 404);
  const num = e164(c.call_phone || c.phone); if (!num) throw new Bad('No phone number for this client.');
  const line = QUO_LINE();
  const calls = (await quo(`/calls?phoneNumberId=${line}&participants[]=${encodeURIComponent(num)}&createdAfter=${encodeURIComponent(new Date(Date.now() - 6 * 36e5).toISOString())}&maxResults=10`))?.data ?? [];
  const last = calls.filter((x: any) => x.direction === 'outgoing' && (x.participants ?? []).some((p: string) => e164(p) === num)).sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt))[0];
  let said = '';
  if (last) { const tr = await quo('/call-transcripts/' + last.id).catch(() => null); said = (tr?.data?.dialogue ?? []).filter((d: any) => e164(d.identifier) !== num).map((d: any) => d.content).join(' ').slice(0, 2000); }
  // his texting style: recent texts he sent from the business line
  const sent = ((await quo(`/messages?phoneNumberId=${line}&participants[]=${encodeURIComponent(num)}&maxResults=20`))?.data ?? []).filter((m: any) => m.direction === 'outgoing' && m.text).slice(0, 6).map((m: any) => m.text);
  if (last && !said && Date.now() - new Date(last.createdAt).getTime() < 10 * 6e4) return { pending: true };
  const prompt = `Write a short follow-up text from Chris Pilone (Knox View Media, real estate photography) to ${c.call_name || c.name}, an agent client, after Chris just left them a voicemail.
${said ? `What Chris said in the voicemail: "${said}"` : 'There is no voicemail transcript; keep it to a friendly check-in.'}
Recent texts Chris has sent this person (match this voice):
${sent.map(t => '- ' + t).join('\n') || '- (none)'}
Rules: casual and friendly, 2 to 3 sentences, mention what he said in the voicemail, no em dashes, no hashtags, sound like Chris. ${NOTE_RULES}
Return only the text message.`;
  const r = await claude(prompt, 200);
  if (!r.text) throw new Bad('Could not draft a text: ' + (r.error || 'no reply'), 502);
  return { text: r.text.replace(/—/g, ',').replace(/^"|"$/g, ''), fromVoicemail: !!said };
}


// A short call guide for one client on today's list: how to open, 2-3 talking points, questions, and how to wrap up.
async function brief(clientId: string, section: string, reason: string, questions: string[]) {
  const { data: c } = await admin.from('cc_clients').select('*').eq('id', clientId).maybeSingle(); if (!c) throw new Bad('Client not found.', 404);
  const { data: calls } = await admin.from('cc_calls').select('at, kind, outcome, note, scheduling').eq('client_id', c.id).not('note', 'is', null).order('at', { ascending: false }).limit(5);
  let listing = '';
  if (c.last_order_hq) { const { data: b } = await admin.from('bookings').select('listing_status, listed_on, listing_dom, listing_notes').eq('id', c.last_order_hq).maybeSingle();
    if (b?.listing_status) listing = `Last listing status: ${b.listing_status}${b.listed_on ? `, listed ${b.listed_on}` : ''}${b.listing_dom != null ? `, ${b.listing_dom} days on market` : ''}. ${(b.listing_notes?.bullets || []).filter((x: string) => !/\$/.test(x)).join(' ')}`; }
  const kind = { first: 'a first-time client follow-up (their first shoot with Knox View was just delivered)', feedback: 'a quick feedback call after a recent shoot', follow: 'a follow-up call the client asked for', care: 'a relationship care call (no specific business reason)' }[section] || 'a relationship care call';
  const prompt = `Chris Pilone owns Knox View Media (real estate photography, video, drone, floor plans, 3D tours, property websites) near Knoxville, TN. He is about to make ${kind} to ${c.call_name || c.name}${c.company ? `, an agent at ${c.company}` : ', a real estate agent'}${c.call_name ? ` (calling for ${c.name})` : ''}.
Why they're on today's list: ${reason}
Client: tier ${c.tier} of 4 (1 = best), ${c.shoots_12m} shoots in the last 12 months, ${c.shoots_all} total, client since ${c.first_order || 'unknown'}.
Last shoot: ${c.last_shoot || 'unknown'} at ${c.last_order_address || 'unknown'}${c.last_order_pkg ? ` (${c.last_order_pkg})` : ''}. ${listing}
${section === 'first' ? `First order: ${c.first_media || ''}${c.first_photographer ? `, shot by ${c.first_photographer}` : ''}.` : ''}
Recent call notes (newest first):
${(calls ?? []).map(k => `- ${String(k.at).slice(0, 10)}${k.scheduling ? ' (logistics)' : ''}: ${k.note}`).join('\n') || '- none'}
Chris's usual questions: ${questions.join(' | ')}

Write a short call guide he can glance at while driving. Return only JSON:
{"opener": "one natural opening line, specific to this person", "points": ["2-3 short talking points drawn from the facts above"], "questions": ["2-3 questions to ask on this call, specific to them"], "close": "one line on how to wrap up or where to leave the call (a clear next step)"}
Keep every item under 20 words, warm and casual, no em dashes. Only use facts given above; do not invent listings, people or events. ${NOTE_RULES}`;
  const r = await claude(prompt, 600);
  if (!r.text) throw new Bad('Could not write the call guide: ' + (r.error || 'no reply'), 502);
  const t = r.text, a = t.indexOf('{'), b = t.lastIndexOf('}');
  try { const j = JSON.parse(t.slice(a, b + 1)); const arr = (x: any) => (Array.isArray(x) ? x : []).map(String).filter(Boolean).slice(0, 3);
    return { opener: String(j.opener || ''), points: arr(j.points), questions: arr(j.questions), close: String(j.close || ''), at: new Date().toISOString() }; }
  catch (_) { console.error('brief unreadable', t.slice(0, 600)); throw new Bad('The call guide came back unreadable. Try again. (' + t.slice(0, 160) + ')', 502); }
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
      const r = body.action === 'refresh' ? await refresh(set) : body.action === 'quo_sync' ? await quoSync(set) : { ignored: true };
      console.log('care', body.action, JSON.stringify(r));
      return json(req, { ok: true, ...r });
    }
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
    const { data: me } = u?.user ? await admin.from('team_members').select('id, role, active, permissions').eq('id', u.user.id).maybeSingle() : { data: null };
    if (!me?.active || !(me.role === 'owner' || me.permissions?.super_admin === true)) throw new Bad('Only HQ super admins can use Client Care.', 403);
    if (body.action === 'refresh') return json(req, { ok: true, ...(await refresh(set)) });
    if (body.action === 'quo_sync') return json(req, { ok: true, ...(await quoSync(set)) });
    if (body.action === 'vmtext') return json(req, await vmText(String(body.clientId || '')));
    if (body.action === 'brief') { const { data: st } = await admin.from('booking_settings').select('care').eq('id', 1).single();
      return json(req, await brief(String(body.clientId || ''), String(body.section || 'care'), String(body.reason || '').slice(0, 300), (st?.care?.questions || []).slice(0, 6))); }
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
