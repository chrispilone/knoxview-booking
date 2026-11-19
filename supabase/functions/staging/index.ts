import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// Virtual Staging (HQ → Virtual Staging). Claude reads each photo and writes the prompt; an image engine renders it.
// HQ does all image resizing/JPEG work in the browser so this function never decodes big images (2s CPU limit).
//   status                         -> keys set, engine settings, spend this month, live prompt version
//   analyze { photoId }            -> Claude looks at the photo: room type guess + what must stay unchanged
//   stage   { photoId, refs?, issues?, allowOver? }
//                                  -> Claude writes the prompt (standing instructions + preset + notes + room),
//                                     the engine renders it, saved to storage. refs = staging paths of reference
//                                     images (same room from another angle, or the first room staged in the set).
//                                     issues = what QC flagged last time (for the automatic retry).
//   qc      { outputId }           -> Claude compares original vs staged (needs qc_path uploaded by HQ): pass + issues
//   settings { ...staging }        -> engine, models, size/quality, monthly cap
// Every AI call is a row in staging_calls with its cost (Claude: exact from usage; images: published per-image
// price, an estimate). Over the monthly cap, stage answers { needsOk } until HQ confirms.
// Secrets: ANTHROPIC_API_KEY (already set for Client Care), and one of GEMINI_API_KEY / OPENAI_API_KEY.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const ORIGINS = ['https://hq.knoxview.com', 'http://localhost:8888', 'http://localhost:5173'];
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-hq\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }

const DEF = { engine: 'google', google_model: 'gemini-3.1-flash-image-preview', google_size: '2K', openai_model: 'gpt-image-1.5', openai_quality: 'high', claude_model: 'claude-sonnet-5-5', cap_usd: 25 };
// Published per-image prices (Nov 2026), used as estimates: Google by output size, OpenAI by quality (non-square).
const GOOGLE_PRICE: Record<string, number> = { '1K': 0.08, '2K': 0.12, '4K': 0.16 };
const OPENAI_PRICE: Record<string, number> = { low: 0.013, medium: 0.05, high: 0.20 };
// Claude Sonnet: $3 / 1M input, $15 / 1M output
const claudeCost = (u: any) => ((u?.input_tokens || 0) * 3 + (u?.output_tokens || 0) * 15) / 1e6;

const TZ = 'America/New_York';
function monthStart() {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date()).split('-');
  return new Date(`${y}-${m}-01T05:00:00Z`).toISOString(); // midnight Eastern
}
async function spent() {
  const { data } = await admin.from('staging_calls').select('cost_usd').gte('at', monthStart());
  return Math.round((data ?? []).reduce((s, r: any) => s + Number(r.cost_usd || 0), 0) * 100) / 100;
}
async function logCall(row: any) { await admin.from('staging_calls').insert(row); }

// ---- storage (bytes only, never decoded here) ----
async function bytesOf(path: string) {
  const { data, error } = await admin.storage.from('staging').download(path);
  if (error || !data) throw new Bad(`Couldn't read ${path}: ${error?.message || 'missing'}`, 404);
  return new Uint8Array(await data.arrayBuffer());
}
function b64(bytes: Uint8Array) {
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
const unb64 = async (s: string) => new Uint8Array(await (await fetch(`data:application/octet-stream;base64,${s}`)).arrayBuffer());
const mimeOf = (bytes: Uint8Array) => bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0x52 && bytes[8] === 0x57 ? 'image/webp' : 'image/jpeg';
const extOf = (mime: string) => mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';

// ---- Claude ----
async function claude(model: string, content: any[], system: string, maxTokens = 700) {
  const key = env('ANTHROPIC_API_KEY'); if (!key) throw new Bad('ANTHROPIC_API_KEY is missing.', 409);
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, thinking: { type: 'disabled' }, system, messages: [{ role: 'user', content }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Bad(`Claude said ${r.status}: ${j?.error?.message || ''}`.trim(), 502);
  const text = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('').trim();
  return { text, cost: claudeCost(j.usage) };
}
const img = (bytes: Uint8Array) => ({ type: 'image', source: { type: 'base64', media_type: mimeOf(bytes), data: b64(bytes) } });
function parseJson(t: string) { const m = t.match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch (_) { return null; } }

export const ROOMS = ['Living Room', 'Family Room', 'Great Room', 'Bedroom', 'Primary Bedroom', 'Kitchen', 'Dining Room', 'Home Office', 'Bathroom', 'Bonus Room', 'Loft', 'Game Room', 'Basement', 'Sunroom', 'Nursery', 'Covered Porch', 'Deck', 'Other'];

async function analyze(photo: any, set: any, by: string) {
  const bytes = await bytesOf(photo.original_path);
  // Past corrections teach the room guess: the team's label vs what Claude guessed
  const { data: fixes } = await admin.from('staging_photos').select('room_guess, room_label, analysis').not('room_label', 'is', null).not('room_guess', 'is', null).order('created_at', { ascending: false }).limit(60);
  const lessons = (fixes ?? []).filter((f: any) => f.room_label !== f.room_guess).slice(0, 15)
    .map((f: any) => `- Looked like "${f.room_guess}" but the team labeled it "${f.room_label}"${f.analysis?.summary ? ` (${String(f.analysis.summary).slice(0, 140)})` : ''}`);
  const system = `You analyze real estate listing photos for a virtual staging tool. Answer with JSON only.`;
  const text = `Look at this listing photo. Reply with JSON:
{"room": one of ${JSON.stringify(ROOMS)},
 "confidence": 0-1,
 "summary": "one sentence: room, size feel, light",
 "keep": ["every fixed feature that must not change: windows (count/where), doors, openings, flooring type/color, fireplace, built-ins, beams, ceiling, light fixtures, stairs, view"],
 "focal_point": "what furniture should face",
 "clearances": ["doorways/paths/windows that must stay clear"],
 "existing_furniture": "none, or what is already in the room",
 "size": "small | medium | large",
 "stageable": true/false (false for closets, laundry rooms, garages, exteriors without a usable porch/deck, or rooms already fully furnished)}
${lessons.length ? `\nThe team has corrected these guesses before; learn from them:\n${lessons.join('\n')}` : ''}`;
  const r = await claude(set.claude_model, [img(bytes), { type: 'text', text }], system, 700);
  await logCall({ kind: 'analyze', engine: 'claude', model: set.claude_model, cost_usd: r.cost, photo_id: photo.id, by_member: by });
  const a = parseJson(r.text) || { summary: r.text.slice(0, 300) };
  const room = ROOMS.includes(a.room) ? a.room : 'Other';
  await admin.from('staging_photos').update({ analysis: a, room_guess: room }).eq('id', photo.id);
  return { room_guess: room, analysis: a, cost: r.cost };
}

async function writePrompt(photo: any, batch: any, preset: any, standing: any, refsInfo: string, issues: string[], set: any, by: string, bytes: Uint8Array) {
  const system = standing?.body || 'Write a virtual staging prompt.';
  const a = photo.analysis || {};
  const text = `Write the staging prompt for this photo.

Room (labeled by the team): ${photo.room_label || photo.room_guess || 'unknown'}
What Claude saw earlier: ${JSON.stringify({ summary: a.summary, keep: a.keep, focal_point: a.focal_point, clearances: a.clearances, existing_furniture: a.existing_furniture, size: a.size })}
Style preset: ${preset ? `${preset.name}. ${preset.prompt}` : 'Modern (Knox View default)'}
${batch.notes ? `Notes from the team for this set: ${batch.notes}` : ''}
${refsInfo}
${issues.length ? `The last render failed review for: ${issues.join('; ')}. Write the prompt so these cannot happen again.` : ''}
${a.existing_furniture && !/^none/i.test(String(a.existing_furniture)) ? 'The room already has some objects in it: keep every existing object exactly as it is (Knox View SOP) and stage around them, unless the team notes ask to remove something.' : ''}
Reply with the prompt text only.`;
  const r = await claude(set.claude_model, [img(bytes), { type: 'text', text }], system, 900);
  await logCall({ kind: 'prompt', engine: 'claude', model: set.claude_model, cost_usd: r.cost, photo_id: photo.id, by_member: by });
  return { prompt: r.text, cost: r.cost };
}

// ---- image engines ----
// If an engine rejects an optional parameter (models differ), drop it and try once more.
const ASPECTS: [string, number][] = [['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 1.5], ['2:3', 2 / 3], ['16:9', 16 / 9], ['9:16', 9 / 16], ['5:4', 1.25], ['4:5', 0.8]];
const nearest = (w: number, h: number) => ASPECTS.reduce((b, x) => Math.abs(x[1] - w / h) < Math.abs(b[1] - w / h) ? x : b)[0];

async function renderGoogle(set: any, prompt: string, images: Uint8Array[], w: number, h: number) {
  const key = env('GEMINI_API_KEY'); if (!key) return { needsEngine: 'google' };
  const parts: any[] = [{ text: prompt }, ...images.map(b => ({ inline_data: { mime_type: mimeOf(b), data: b64(b) } }))];
  let imageConfig: any = { aspectRatio: nearest(w, h), imageSize: set.google_size || '2K' };
  for (let tryN = 0; tryN < 2; tryN++) {
    const body: any = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'], ...(imageConfig ? { imageConfig } : {}) } };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(set.google_model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = String(j?.error?.message || r.status);
      if (tryN === 0 && imageConfig && /imageConfig|image_config|imageSize|aspect/i.test(m)) { imageConfig = null; continue; }
      throw new Bad(`Google said ${r.status}: ${m.slice(0, 200)}`, 502);
    }
    const out = (j.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data || p.inline_data?.data);
    if (!out) throw new Bad(`Google returned no image (${j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'no reason given'}).`, 502);
    const d = out.inlineData || out.inline_data;
    return { bytes: await unb64(d.data), cost: GOOGLE_PRICE[set.google_size] ?? 0.12 };
  }
  throw new Bad('Google render failed.', 502);
}

async function renderOpenAI(set: any, prompt: string, images: Uint8Array[], w: number, h: number) {
  const key = env('OPENAI_API_KEY'); if (!key) return { needsEngine: 'openai' };
  const size = w / h > 1.15 ? '1536x1024' : w / h < 0.87 ? '1024x1536' : '1024x1024';
  let opt: Record<string, string> = { size, quality: set.openai_quality || 'high', output_format: 'jpeg', input_fidelity: 'high' };
  for (let tryN = 0; tryN < 3; tryN++) {
    const fd = new FormData();
    fd.append('model', set.openai_model); fd.append('prompt', prompt);
    images.forEach((b, i) => fd.append('image[]', new Blob([b], { type: mimeOf(b) }), `photo${i}.${extOf(mimeOf(b))}`));
    for (const [k, v] of Object.entries(opt)) fd.append(k, v);
    const r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = String(j?.error?.message || r.status); const p = j?.error?.param || Object.keys(opt).find(k => m.includes(k));
      if (p && opt[p] && tryN < 2) { const { [p]: _, ...rest } = opt; opt = rest; continue; }
      throw new Bad(`OpenAI said ${r.status}: ${m.slice(0, 200)}`, 502);
    }
    const d = j.data?.[0]?.b64_json; if (!d) throw new Bad('OpenAI returned no image.', 502);
    return { bytes: await unb64(d), cost: OPENAI_PRICE[opt.quality || 'high'] ?? 0.2 };
  }
  throw new Bad('OpenAI render failed.', 502);
}

async function stage(body: any, set: any, by: string) {
  const { data: photo } = await admin.from('staging_photos').select('*').eq('id', String(body.photoId || '')).maybeSingle();
  if (!photo) throw new Bad('Photo not found.', 404);
  const engine = set.engine === 'openai' ? 'openai' : 'google';
  if (!env(engine === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY')) return { needsEngine: engine };
  const used = await spent();
  if (used >= Number(set.cap_usd || 0) && !body.allowOver) return { needsOk: true, spent: used, cap: Number(set.cap_usd || 0) };

  const { data: batch } = await admin.from('staging_batches').select('*').eq('id', photo.batch_id).single();
  const { data: preset } = batch.preset_id ? await admin.from('staging_presets').select('*').eq('id', batch.preset_id).maybeSingle() : { data: null };
  const { data: standing } = await admin.from('staging_prompts').select('*').order('version', { ascending: false }).limit(1).maybeSingle();
  const bytes = await bytesOf(photo.original_path);

  // reference images: same room / first room of the set (from HQ), then the preset's saved examples (max 4 total)
  const refPaths: string[] = [...(Array.isArray(body.refs) ? body.refs : []), ...((preset?.reference_paths as string[]) || [])].filter(Boolean).slice(0, 4);
  const refs = await Promise.all(refPaths.map(p => bytesOf(p).catch(() => null)));
  const good = refs.filter(Boolean) as Uint8Array[];
  const sameRoom = Array.isArray(body.refs) && body.refs.length && body.sameRoom;
  const refsInfo = good.length ? `The image model will also receive ${good.length} reference image(s) after the photo. ${sameRoom ? 'Reference 1 is THIS SAME ROOM already staged from another angle: use the identical furniture in the identical positions.' : 'They show rooms already staged in this house or approved examples of this style: match their furniture, materials and colors.'} Refer to them as "the reference image(s)".` : '';

  const issues: string[] = Array.isArray(body.issues) ? body.issues.map(String).slice(0, 6) : [];
  const w = await writePrompt(photo, batch, preset, standing, refsInfo, issues, set, by, bytes);
  const finalPrompt = `${w.prompt}\n\nThe first image is the photo to stage; edit it, keep its exact framing.${good.length ? ' The other images are references only.' : ''}`;

  let out: any;
  try { out = engine === 'openai' ? await renderOpenAI(set, finalPrompt, [bytes, ...good], photo.width || 3, photo.height || 2) : await renderGoogle(set, finalPrompt, [bytes, ...good], photo.width || 3, photo.height || 2); }
  catch (e) { await logCall({ kind: 'render', engine, model: engine === 'openai' ? set.openai_model : set.google_model, cost_usd: 0, ok: false, photo_id: photo.id, by_member: by }); throw e; }
  if (out.needsEngine) return out;

  const model = engine === 'openai' ? set.openai_model : set.google_model;
  await logCall({ kind: 'render', engine, model, cost_usd: out.cost, photo_id: photo.id, by_member: by });
  const mime = mimeOf(out.bytes);
  const { data: prev } = await admin.from('staging_outputs').select('id', { count: 'exact' }).eq('photo_id', photo.id);
  const id = crypto.randomUUID();
  const path = `out/${photo.batch_id}/${photo.id}/${id}.${extOf(mime)}`;
  const up = await admin.storage.from('staging').upload(path, out.bytes, { contentType: mime, upsert: false });
  if (up.error) throw new Bad(`Couldn't save the staged photo: ${up.error.message}`, 500);
  const row = { id, photo_id: photo.id, engine, model, prompt: w.prompt, prompt_version: standing?.version ?? null, path, attempt: (prev?.length || 0) + 1, cost_usd: Math.round((out.cost + w.cost) * 10000) / 10000 };
  const { error } = await admin.from('staging_outputs').insert(row);
  if (error) throw new Bad(error.message, 500);
  return { ok: true, output: row, mime };
}

async function qc(body: any, set: any, by: string) {
  const { data: o } = await admin.from('staging_outputs').select('*, staging_photos(*)').eq('id', String(body.outputId || '')).maybeSingle();
  if (!o) throw new Bad('Staged photo not found.', 404);
  if (!o.qc_path) throw new Bad('Upload the review copy first.');
  const before = await bytesOf(o.staging_photos.original_path), after = await bytesOf(o.qc_path);
  const keep = o.staging_photos.analysis?.keep;
  const text = `Image 1 is the original listing photo. Image 2 is the virtually staged version. Review image 2 like a strict real estate photo editor.
FAIL it if any fixed feature or existing object changed: walls, windows (count, size, position), doors, openings, flooring, ceiling, fireplace, built-ins, cabinets, light fixtures, the view, the camera angle or crop. Also fail it for: furniture blocking a doorway or walkway, furniture out of scale, warped or melted objects, floating furniture, wrong room type (labeled ${o.staging_photos.room_label || o.staging_photos.room_guess}), text or logos, people or pets, or an obviously fake look.
${keep ? `Features that had to stay: ${JSON.stringify(keep)}` : ''}
Reply with JSON only: {"pass": true/false, "issues": ["short, specific problems"], "score": 1-10}`;
  const r = await claude(set.claude_model, [img(before), img(after), { type: 'text', text }], 'You review virtual staging for accuracy. Answer with JSON only.', 400);
  await logCall({ kind: 'qc', engine: 'claude', model: set.claude_model, cost_usd: r.cost, photo_id: o.photo_id, by_member: by });
  const q = parseJson(r.text) || { pass: true, issues: [], note: 'Review reply unreadable' };
  q.pass = q.pass !== false; q.issues = Array.isArray(q.issues) ? q.issues.slice(0, 6) : [];
  await admin.from('staging_outputs').update({ qc: q, cost_usd: Number(o.cost_usd) + r.cost }).eq('id', o.id);
  return { ok: true, qc: q };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const body = await req.json().catch(() => ({} as any));
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
    const { data: me } = u?.user ? await admin.from('team_members').select('id, role, active, permissions').eq('id', u.user.id).maybeSingle() : { data: null };
    if (!me?.active || !(me.role === 'owner' || me.permissions?.super_admin === true)) throw new Bad('Only HQ super admins can use Virtual Staging.', 403);
    const { data: bs } = await admin.from('booking_settings').select('staging').eq('id', 1).single();
    const set = { ...DEF, ...(bs?.staging || {}) };

    if (body.action === 'status') {
      const { data: p } = await admin.from('staging_prompts').select('version').order('version', { ascending: false }).limit(1).maybeSingle();
      return json(req, { ...set, spent: await spent(), version: p?.version ?? 0, anthropic: !!env('ANTHROPIC_API_KEY'), google: !!env('GEMINI_API_KEY'), openai: !!env('OPENAI_API_KEY'), rooms: ROOMS });
    }
    if (body.action === 'settings') {
      const s = body.staging || {};
      const next: any = { ...set };
      if (s.engine) next.engine = s.engine === 'openai' ? 'openai' : 'google';
      if (s.google_model) next.google_model = String(s.google_model).trim().slice(0, 80);
      if (s.google_size && ['1K', '2K', '4K'].includes(s.google_size)) next.google_size = s.google_size;
      if (s.openai_model) next.openai_model = String(s.openai_model).trim().slice(0, 80);
      if (s.openai_quality && ['low', 'medium', 'high'].includes(s.openai_quality)) next.openai_quality = s.openai_quality;
      if (s.cap_usd != null) { const c = Number(s.cap_usd); if (!(c >= 0 && c <= 2000)) throw new Bad('Cap must be $0–$2,000.'); next.cap_usd = c; }
      await admin.from('booking_settings').update({ staging: next }).eq('id', 1);
      return json(req, { ok: true, ...next, spent: await spent() });
    }
    if (body.action === 'analyze') {
      const { data: photo } = await admin.from('staging_photos').select('*').eq('id', String(body.photoId || '')).maybeSingle();
      if (!photo) throw new Bad('Photo not found.', 404);
      return json(req, { ok: true, ...(await analyze(photo, set, me.id)) });
    }
    if (body.action === 'stage') return json(req, await stage(body, set, me.id));
    if (body.action === 'qc') return json(req, await qc(body, set, me.id));
    throw new Bad('Unknown action.');
  } catch (e) {
    const err = e as Bad;
    console.error('staging', err.message);
    return json(req, { error: err.message || 'Something went wrong' }, err.status || 500);
  }
});
