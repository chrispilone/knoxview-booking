import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// Client profile photo (headshot) for the booking portal. Kept separate from `booking` so HQ and the
// property websites can reuse the same photo fields without touching checkout code.
//   get    → { photo_url }
//   set    → { path, original }  saves photos the browser uploaded to agent-photos/<user id>/ (storage policy only
//            allows their own folder), then removes the client's previous photo files
//   remove → clears the photo
//   extras { first_name, last_name, website_url, birth_month, birth_day } → the rest of their profile (birthday: month + day only)
//   notify { sms_appointment_reminders, sms_media_delivered } → text message preferences (sms_opt_in_at = when last turned on)
//   logo_set { path } / logo_remove → the agent's logo (PNG with transparency, agent-photos/<user id>/logo-*.png)
// agents.photo_url is a public 1000x1000 square JPEG (show it round with CSS where a circle is needed);
// agents.photo_original_path is the full photo (max 2400px) so it can be re-cropped later.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const ORIGINS = ['https://test.knoxview.com', 'https://book.knoxview.com', 'https://knoxview-booking.netlify.app', 'http://localhost:8888', 'http://localhost:5173'];
const BUCKET = 'agent-photos';

const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-booking\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class UserError extends Error { constructor(m: string, public status = 400) { super(m); } }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const user = jwt.split('.').length === 3 ? (await admin.auth.getUser(jwt)).data?.user : null;
    if (!user) return json(req, { error: 'Please sign in.' }, 401);
    const { data: agent } = await admin.from('agents').select('id, photo_url, photo_path, photo_original_path, brand_logo_url, brand_logo_path, first_name, last_name, website_url, birth_month, birth_day, phone, sms_appointment_reminders, sms_media_delivered').eq('auth_user_id', user.id).maybeSingle();
    const action = String(body.action || '');

    if (action === 'get') return json(req, { photo_url: agent?.photo_url ?? null, logo_url: agent?.brand_logo_url ?? null,
      extras: agent ? { first_name: agent.first_name, last_name: agent.last_name, website_url: agent.website_url, birth_month: agent.birth_month, birth_day: agent.birth_day } : null,
      notify: agent ? { sms_appointment_reminders: agent.sms_appointment_reminders, sms_media_delivered: agent.sms_media_delivered, phone: agent.phone } : null });

    if (action === 'extras') {
      if (!agent) throw new UserError('Save your name on your profile first.');
      const clean = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
      let site = clean(body.website_url, 300);
      if (site && !/^https?:\/\//i.test(site)) site = 'https://' + site;
      if (site && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(site)) throw new UserError('Check your website link, e.g. www.yourname.com');
      const m = Number(body.birth_month) || null, d = Number(body.birth_day) || null;
      if ((m && !d) || (!m && d)) throw new UserError('Pick both the month and the day for your birthday, or leave both blank.');
      const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (m && (m < 1 || m > 12 || d! < 1 || d! > days[m - 1])) throw new UserError('That birthday date doesn\'t exist.');
      const patch = { first_name: clean(body.first_name, 60) || null, last_name: clean(body.last_name, 60) || null, website_url: site || null, birth_month: m, birth_day: d };
      const { error } = await admin.from('agents').update(patch).eq('id', agent.id);
      if (error) throw error;
      return json(req, { extras: patch });
    }

    if (action === 'notify') {
      if (!agent) throw new UserError('Save your name on your profile first.');
      const patch: Record<string, unknown> = { sms_appointment_reminders: !!body.sms_appointment_reminders, sms_media_delivered: !!body.sms_media_delivered };
      if ((patch.sms_appointment_reminders || patch.sms_media_delivered) && !agent.phone) throw new UserError('Add your mobile phone in My Profile first, then turn on text messages.');
      const turnedOn = (patch.sms_appointment_reminders && !agent.sms_appointment_reminders) || (patch.sms_media_delivered && !agent.sms_media_delivered);
      if (turnedOn) patch.sms_opt_in_at = new Date().toISOString();
      const { error } = await admin.from('agents').update(patch).eq('id', agent.id);
      if (error) throw error;
      return json(req, { notify: { sms_appointment_reminders: patch.sms_appointment_reminders, sms_media_delivered: patch.sms_media_delivered, phone: agent.phone } });
    }

    if (action === 'logo_set' || action === 'logo_remove') {
      if (!agent) throw new UserError('Save your name on your profile first, then add your logo.');
      let url: string | null = null, path: string | null = null;
      if (action === 'logo_set') {
        const p = String(body.path || '');
        if (!(p.startsWith(user.id + '/logo-') && /^[\w-]+\/[\w.-]{1,120}$/.test(p))) throw new UserError('Your logo did not upload. Please try again.');
        const name = p.split('/')[1];
        const { data: found } = await admin.storage.from(BUCKET).list(user.id, { search: name, limit: 5 });
        if (!(found ?? []).some(f => f.name === name)) throw new UserError('Your logo did not upload. Please try again.');
        path = p; url = admin.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
      }
      const { error } = await admin.from('agents').update({ brand_logo_url: url, brand_logo_path: path }).eq('id', agent.id);
      if (error) throw error;
      if (agent.brand_logo_path && agent.brand_logo_path !== path && agent.brand_logo_path.startsWith(user.id + '/')) await admin.storage.from(BUCKET).remove([agent.brand_logo_path]).catch(() => {});
      return json(req, { logo_url: url });
    }

    if (action === 'set' || action === 'remove') {
      if (!agent) throw new UserError('Save your name on your profile first, then add your photo.');
      const mine = (p: unknown) => typeof p === 'string' && p.startsWith(user.id + '/') && /^[\w-]+\/[\w.-]{1,120}$/.test(p) ? p : null;
      let patch: Record<string, string | null>;
      if (action === 'remove') patch = { photo_url: null, photo_path: null, photo_original_path: null };
      else {
        const path = mine(body.path);
        if (!path) throw new UserError('Your photo did not upload. Please try again.');
        const name = path.split('/')[1];
        const { data: found } = await admin.storage.from(BUCKET).list(user.id, { search: name, limit: 5 });
        if (!(found ?? []).some(f => f.name === name)) throw new UserError('Your photo did not upload. Please try again.');
        patch = { photo_url: admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl, photo_path: path, photo_original_path: mine(body.original) ?? agent.photo_original_path ?? null };
      }
      const { error } = await admin.from('agents').update({ ...patch, photo_updated_at: new Date().toISOString() }).eq('id', agent.id);
      if (error) throw error;
      const stale = [agent.photo_path, agent.photo_original_path].filter(p => p && p !== patch.photo_path && p !== patch.photo_original_path) as string[];
      if (stale.length) await admin.storage.from(BUCKET).remove(stale).catch(() => {});
      return json(req, { photo_url: patch.photo_url });
    }

    return json(req, { error: 'Unknown action' }, 400);
  } catch (e) {
    const status = e instanceof UserError ? e.status : 500;
    if (status >= 500) console.error('client-photo error:', String((e as Error)?.message || e));
    return json(req, { error: e instanceof UserError ? e.message : 'Something went wrong. Please try again.' }, status);
  }
});
