import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// CubiCasa <-> HQ. Public endpoint (no login), two callers:
//  1. The database, when an order is created / cancelled / deleted (header x-hq-hook = app_secrets 'cubicasa_hook'):
//       { action: 'cubicasa_draft', bookingId } or { action: 'cubicasa_cancel', orderId }
//  2. CubiCasa's webhook: { id, current_status, previous_status, ... } (unsigned, so nothing in it is trusted: the dropbox
//     function re-reads the order from CubiCasa with our API key before doing anything)
// The work happens in the dropbox function; this answers right away (CubiCasa retries slow or failed calls).
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const FN = `${Deno.env.get('SUPABASE_URL')}/functions/v1/dropbox`;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ok = (b: unknown = { ok: true }) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });

async function forward(body: Record<string, unknown>) {
  try {
    const r = await fetch(FN, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text();
    console.log('cubicasa', body.action, r.status, t.slice(0, 400));
  } catch (e) { console.error('cubicasa forward', String((e as Error)?.message || e)); }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return ok({ ok: true, service: 'Knox View HQ ↔ CubiCasa' });
  const body = await req.json().catch(() => ({} as any));
  const hook = req.headers.get('x-hq-hook');
  let job: Record<string, unknown> | null = null;
  if (hook) {
    const { data } = await admin.from('app_secrets').select('value').eq('key', 'cubicasa_hook').maybeSingle();
    if (!data?.value || data.value !== hook) return new Response('forbidden', { status: 403 });
    if (body.action === 'cubicasa_draft' && body.bookingId) job = { action: 'cubicasa_draft', bookingId: String(body.bookingId) };
    if (body.action === 'cubicasa_cancel' && body.orderId) job = { action: 'cubicasa_cancel', orderId: String(body.orderId) };
  } else if (body && (typeof body.id === 'string' || typeof body.id === 'number') && /^[\w-]{1,80}$/.test(String(body.id))) {
    console.log('cubicasa webhook', body.id, body.previous_status, '->', body.current_status, body.product_type);
    job = { action: 'cubicasa_event', orderId: String(body.id) };
  }
  if (!job) return ok({ ok: true, ignored: true });
  // @ts-ignore EdgeRuntime is provided by Supabase
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(forward(job)); else await forward(job);
  return ok();
});
