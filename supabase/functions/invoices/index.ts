import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { PDFDocument, PDFString, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1';

// Client invoices for the booking portal (each booking is an invoice). Signed-in client actions:
//   list                     → { client, credits, invoices[] }   (also settles any online payment Stripe finished)
//   pay     { numbers[] }    → uses account credits first, then ONE card payment for the rest → { clientSecret, amount } or { paidByCredit }
//   apply_credit { numbers[] }  → uses account credit only (no card), for "Submit Order" with credit ticked
//   confirm { pi }           → after the card payment succeeds in the browser, marks those invoices paid
//   pdf     { number }       → { filename, base64 }   the invoice PDF (same template as the email attachment)
//   email   { number, to[] } → emails the invoice (PDF attached) to the email on file + up to 3 more people
//   sample  { key, paid }    → template preview PDF with made-up data (for checking the layout)
// Dates: invoice date = invoice_sent_at, else when the order was placed. Due date = invoice_due_at, else the invoice
// date. Date paid = paid_at (online payment, credits, or "Mark as paid" in HQ).
// Credits: client_credits ledger (HQ adds them). Used credit is stored on bookings.credit_applied.
// The Stripe webhook (booking function) still finalizes each card payment by metadata.booking_id; confirm and list
// cover every invoice in a multi-invoice payment.

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const SK = { test: env('STRIPE_SECRET_KEY'), live: env('STRIPE_LIVE_SECRET_KEY') };
const RESEND_KEY = env('RESEND_API_KEY');
const MAIL_FROM = env('DELIVERY_MAIL_FROM') || 'Knox View <bookings@mail.knoxview.com>';
const REPLY_TO = env('DELIVERY_REPLY_TO') || 'chris@knoxview.com';
const PORTAL = (env('PORTAL_URL') || 'https://bookbeta.knoxview.com').replace(/\/$/, '');
const G_ID = env('GOOGLE_CLIENT_ID'), G_SECRET = env('GOOGLE_CLIENT_SECRET');
const BIZ = { name: 'Knox View Real Estate Media', legal: 'Knox View Media LLC', address: ['Knox View Media LLC', '3912 Papermill Square NW', 'Knoxville, TN 37909'], owner: 'Chris Pilone', phone: '865-855-5669', email: 'chris@knoxview.com', web: 'knoxview.com', city: 'Knoxville, Tennessee' };
const ORIGINS = ['https://test.knoxview.com', 'https://book.knoxview.com', 'https://bookbeta.knoxview.com', 'https://knoxview-booking.netlify.app', 'https://hq.knoxview.com', 'http://localhost:8888', 'http://localhost:5173'];

const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  const ok = ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview-(booking|hq)\.netlify\.app$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class UserError extends Error { constructor(m: string, public status = 400) { super(m); } }
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }) : '';
const fmtLong = (d: string | null) => d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';

/* ---------------- Stripe ---------------- */
function form(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(path: string, live: boolean, body?: Record<string, unknown>) {
  const key = live ? SK.live : SK.test;
  if (!key || !(live ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/).test(key)) throw new UserError('Online payments are not switched on yet. Please call 865-855-5669.', 503);
  const r = await fetch('https://api.stripe.com/v1' + path, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body ? form(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `Stripe error ${r.status}`);
  return d;
}

/* ---------------- data ---------------- */
const COLS = 'id, number, order_no, coupon_code, coupon_discount, status, address, unit, city, state, zip, items, subtotal, discount, tax, total, credit_applied, paid, paid_at, paid_method, payment_status, payment_option, stripe_payment_intent_id, stripe_livemode, stripe_customer_id, shoot_start, created_at, invoice_sent_at, invoice_due_at, client_name, client_email, client_phone, cover_url, marketing_url, require_payment, public_token, invoice';
// invoice = false: placed in HQ with "Create an invoice? No", so it isn't listed, payable or shareable as an invoice
const isInvoice = (b: any) => b.invoice !== false && b.status !== 'cancelled' && !(b.status === 'requested' && b.payment_status === 'unpaid');
const dueOf = (b: any) => b.paid ? 0 : Math.max(0, r2(+b.total - +(b.credit_applied || 0)));
function shape(b: any) {
  const invDate = b.invoice_sent_at || b.created_at;
  return {
    id: b.id, number: b.number, order_no: b.order_no || '#' + b.number, address: b.address + (b.unit ? ', ' + b.unit : ''), place: [b.city, [b.state, b.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    items: (b.items || []).map((i: any) => ({ name: i.name, price: +i.price, kind: i.kind })),
    subtotal: +(b.subtotal ?? b.total), discount: +(b.discount || 0), coupon_code: b.coupon_code || null, coupon_discount: +(b.coupon_discount || 0), tax: +(b.tax || 0), total: +b.total, credit: +(b.credit_applied || 0), due: dueOf(b),
    paid: !!b.paid, paid_at: b.paid ? b.paid_at : null, paid_method: b.paid_method, payment_status: b.payment_status,
    invoice_date: invDate, due_date: b.invoice_due_at || invDate, shoot_start: b.shoot_start, cover_url: b.cover_url || null, marketing: !!b.marketing_url,
  };
}
async function me(req: Request) {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const user = jwt.split('.').length === 3 ? (await admin.auth.getUser(jwt)).data?.user : null;
  if (!user) throw new UserError('Please sign in.', 401);
  const { data: agent } = await admin.from('agents').select('id, full_name, email, phone, brokerage, team_name').eq('auth_user_id', user.id).maybeSingle();
  return { user, agent };
}
async function creditBalance(agentId: string) {
  const { data } = await admin.from('client_credits').select('amount').eq('agent_id', agentId);
  return r2((data ?? []).reduce((a, c) => a + +c.amount, 0));
}
async function oneInvoice(agentId: string, number: unknown) {
  const { data: b } = await admin.from('bookings').select(COLS).eq('agent_id', agentId).eq('number', Number(number) || -1).maybeSingle();
  if (!b || !isInvoice(b)) throw new UserError('Invoice not found', 404);
  return b;
}
// Use the client's account credit on these invoices, oldest first. Fully covered invoices are marked paid.
async function applyCredits(agentId: string, list: any[]) {
  let bal = await creditBalance(agentId);
  for (const b of list) {
    const use = r2(Math.min(bal, dueOf(b)));
    if (use <= 0) continue;
    const { data: row } = await admin.from('client_credits').insert({ agent_id: agentId, amount: -use, kind: 'applied', booking_id: b.id, note: `Used on invoice ${b.order_no || "#" + b.number}`, created_by: null }).select('id').single();
    if (await creditBalance(agentId) < 0) { await admin.from('client_credits').delete().eq('id', row!.id); break; } // another payment used it first
    b.credit_applied = r2(+(b.credit_applied || 0) + use); bal = r2(bal - use);
    const patch: Record<string, unknown> = { credit_applied: b.credit_applied, updated_at: new Date().toISOString() };
    if (dueOf(b) <= 0) Object.assign(patch, { paid: true, paid_at: new Date().toISOString(), paid_method: 'credit', payment_status: 'paid', ...(b.status === 'requested' ? { status: 'scheduled' } : {}) });
    await admin.from('bookings').update(patch).eq('id', b.id);
    if (patch.paid) Object.assign(b, { paid: true, paid_at: patch.paid_at, paid_method: 'credit', payment_status: 'paid' });
  }
}
// Card payments Stripe finished that we haven't recorded yet (e.g. the browser closed before confirming)
async function settle(bks: any[]) {
  const open = bks.filter(b => !b.paid && b.stripe_payment_intent_id && isInvoice(b));
  const byPi = new Map<string, any[]>();
  for (const b of open) byPi.set(b.stripe_payment_intent_id, [...(byPi.get(b.stripe_payment_intent_id) ?? []), b]);
  for (const [pi, list] of [...byPi].slice(0, 8)) {
    try {
      const p = await stripe(`/payment_intents/${pi}?expand[]=latest_charge`, !!list[0].stripe_livemode);
      const status = p.status === 'succeeded' ? 'paid' : p.status === 'processing' ? 'processing' : null;
      if (!status) continue;
      const at = p.latest_charge?.created ? new Date(p.latest_charge.created * 1000).toISOString() : new Date().toISOString();
      const patch = status === 'paid' ? { paid: true, paid_at: at, payment_status: 'paid', ...(list[0].status === 'requested' ? { status: 'scheduled' } : {}) } : { payment_status: 'processing' };
      await admin.from('bookings').update({ ...patch, updated_at: new Date().toISOString() }).in('id', list.map(b => b.id)).eq('paid', false);
      for (const b of list) Object.assign(b, patch);
    } catch (e) { console.error('settle', pi, String(e)); }
  }
}

/* ---------------- invoice PDF (the invoice template) ---------------- */
let LOGO: Uint8Array | null | undefined;
async function logoBytes() {
  if (LOGO === undefined) { try { const r = await fetch(`${PORTAL}/img/logo-navy.png`); LOGO = r.ok ? new Uint8Array(await r.arrayBuffer()) : null; } catch { LOGO = null; } }
  return LOGO;
}
// Helvetica covers Windows-1252 only: swap anything else for a plain equivalent
const t = (s: unknown) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
async function invoicePdf(b: any, client: any) {
  // Layout follows Chris's invoice sample (Spiro style): title, logo, From / status + dates, Bill To,
  // listing + order date + "View all details" link, bordered Description / Cost breakdown / Order total table, totals.
  const inv = shape(b);
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${inv.order_no} - ${inv.address}`); doc.setAuthor(BIZ.legal); doc.setCreator('Knox View');
  const page = doc.addPage([612, 792]);
  const R = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
  const INK = rgb(0.1, 0.12, 0.16), MUTE = rgb(0.42, 0.47, 0.55), LINE = rgb(0.2, 0.22, 0.26), SOFT = rgb(0.82, 0.84, 0.87);
  const ACC = rgb(0.114, 0.196, 0.314), GREEN = rgb(0.18, 0.48, 0.33), RED = rgb(0.75, 0.22, 0.2);
  const M = 54, RX = 612 - M;
  const w = (s: string, f: any, z: number) => f.widthOfTextAtSize(t(s), z);
  const text = (s: string, x: number, y: number, o: { f?: any; s?: number; c?: any; right?: boolean; center?: boolean } = {}) => {
    const f = o.f || R, z = o.s || 10, str = t(s), tw = f.widthOfTextAtSize(str, z);
    page.drawText(str, { x: o.right ? x - tw : o.center ? x - tw / 2 : x, y, size: z, font: f, color: o.c || INK });
  };
  const pair = (k: string, v: string, x: number, y: number, c?: any) => { text(k, x, y, { s: 10 }); text(v, x + w(k, R, 10) + 3, y, { s: 10, f: B, c }); };
  const wrap = (s: string, f: any, z: number, width: number) => {
    const out: string[] = []; let line = '';
    for (const word of t(s).split(/\s+/)) { const next = line ? line + ' ' + word : word; if (f.widthOfTextAtSize(next, z) > width && line) { out.push(line); line = word; } else line = next; }
    if (line) out.push(line); return out.length ? out : [''];
  };
  const link = (url: string, x1: number, y1: number, x2: number, y2: number) => {
    const annot = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x1, y1, x2, y2], Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) } }));
    page.node.addAnnot(annot);
  };
  const portalLink = `${PORTAL}/#invoices/${inv.number}`;
  // title + logo
  let y = 792 - 64;
  text(`Invoice: ${inv.order_no}`, RX, y, { f: B, s: 20, right: true });
  const logo = await logoBytes();
  if (logo) { const img = await doc.embedPng(logo); const h = 56, lw = img.width * h / img.height; page.drawImage(img, { x: M, y: y - 62, width: lw, height: h }); }
  else text('KNOX VIEW', M, y - 40, { f: B, s: 22, c: ACC });
  y -= 110;
  // From (left) · status + dates (right)
  const col = 306;
  text('From:', M, y, { f: B });
  BIZ.address.forEach((l, i) => text(i ? l : BIZ.legal, M, y - 13 - i * 13));
  const fromEnd = y - 13 - BIZ.address.length * 13;
  text(BIZ.email, M, fromEnd - 10); text(BIZ.phone, M, fromEnd - 23);
  pair('Status: ', inv.paid ? 'Invoice Paid' : inv.due > 0 ? 'Payment Due' : 'Unpaid', col, y - 13, inv.paid ? GREEN : RED);
  if (inv.paid && inv.paid_at) pair('Date paid: ', fmtLong(inv.paid_at).replace(', ', ' - '), col, y - 26);
  pair('Date: ', fmtLong(inv.invoice_date).replace(', ', ' - '), col, fromEnd - 10);
  pair('Due Date: ', fmtLong(inv.due_date).replace(', ', ' - '), col, fromEnd - 23);
  y = fromEnd - 33;
  page.drawLine({ start: { x: M, y }, end: { x: RX, y }, thickness: 0.6, color: SOFT });
  y -= 14;
  // Bill to
  text('Bill To:', M, y, { f: B });
  const bill = [client?.full_name || b.client_name, [client?.team_name, client?.brokerage].filter(Boolean).join(' - '), client?.email || b.client_email, client?.phone || b.client_phone].filter(Boolean) as string[];
  bill.forEach((l, i) => text(l, M, y - 13 - i * 13));
  y -= 13 + bill.length * 13 + 36;
  // listing
  const listing = [inv.address, inv.place].filter(Boolean).join(', ');
  let ly = y; wrap(`Listing: ${listing}`, B, 10, RX - M).forEach((l, i) => { if (i === 0) { text('Listing: ', M, ly); text(l.replace(/^Listing: /, ''), M + w('Listing: ', R, 10), ly, { f: B }); } else text(l, M, ly, { f: B }); ly -= 13; });
  text(`Date Ordered: ${fmtLong(b.created_at).replace(', ', ' - ')}${inv.shoot_start ? `     Shoot: ${fmtLong(inv.shoot_start).replace(', ', ' - ')}` : ''}`, M, ly); ly -= 13;
  text('View All Details', M, ly, { c: ACC }); page.drawLine({ start: { x: M, y: ly - 2 }, end: { x: M + w('View All Details', R, 10), y: ly - 2 }, thickness: 0.6, color: ACC });
  link(portalLink, M, ly - 3, M + w('View All Details', R, 10), ly + 10);
  const dx = M + w('View All Details', R, 10) + 18;
  text('Download Media', dx, ly, { c: ACC }); page.drawLine({ start: { x: dx, y: ly - 2 }, end: { x: dx + w('Download Media', R, 10), y: ly - 2 }, thickness: 0.6, color: ACC });
  link(b.public_token ? `${PORTAL}/d/${b.public_token}` : `${PORTAL}/#delivery/${b.id}`, dx, ly - 3, dx + w('Download Media', R, 10), ly + 10);
  y = ly - 10;
  // table: Description | Cost Breakdown | Order Total (order total cell spans the rows)
  const c1 = M, c2 = M + 300, c3 = M + 400, c4 = RX, head = 30;
  const rows = [...inv.items.map(i => ({ name: i.name || 'Service', price: i.price }))];
  const cpOff = Math.min(+inv.discount || 0, +inv.coupon_discount || 0), other = r2((+inv.discount || 0) - cpOff);
  if (cpOff && inv.coupon_code) rows.push({ name: `Coupon ${inv.coupon_code}`, price: -cpOff });
  if (other > 0 || (inv.discount && !inv.coupon_code)) rows.push({ name: 'Discount', price: -(inv.coupon_code ? other : inv.discount) });
  rows.push({ name: 'Tax', price: inv.tax });
  const lines = rows.map(r => wrap(r.name, R, 10, c2 - c1 - 16));
  const rowH = lines.map(l => Math.max(24, l.length * 13 + 11));
  const bodyH = rowH.reduce((a, h) => a + h, 0), top = y, bottom = y - head - bodyH;
  const L = (x1: number, y1: number, x2: number, y2: number) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.8, color: LINE });
  L(c1, top, c4, top); L(c1, bottom, c4, bottom); L(c1, top, c1, bottom); L(c2, top, c2, bottom); L(c3, top, c3, bottom); L(c4, top, c4, bottom);
  L(c1, top - head, c4, top - head);
  text('Description', c1 + 8, top - 13, { f: B }); text('Cost', c2 + 8, top - 13, { f: B }); text('Breakdown', c2 + 8, top - 25, { f: B }); text('Order Total', c3 + 8, top - 13, { f: B });
  let ry = top - head;
  rows.forEach((r, i) => {
    lines[i].forEach((l, k) => text(l, c1 + 8, ry - 15 - k * 13));
    text(money(r.price), c2 + 8, ry - 15);
    ry -= rowH[i];
    if (i < rows.length - 1) L(c1, ry, c3, ry);
  });
  text(money(inv.total), (c3 + c4) / 2, top - head - bodyH / 2 - 4, { center: true });
  y = bottom - 22;
  text('Total number of listings in this invoice: 1', M, y); y -= 22;
  text('Note: The amounts do not include reschedule & cancellation fees.', M, y, { c: MUTE }); y -= 28;
  // totals (right aligned)
  const tot = (k: string, v: string, c?: any) => { const vw = w(v, B, 10); text(v, RX, y, { f: B, right: true, c }); text(k, RX - vw - 3, y, { right: true }); y -= 14; };
  tot('Included Tax:', money(inv.tax));
  if (inv.credit) tot('Account Credit Applied:', '-' + money(inv.credit));
  tot('Amount Paid:', money(inv.paid ? Math.max(0, r2(inv.total - inv.credit)) : 0));
  tot('Balance Due:', money(inv.due), inv.due > 0 ? RED : undefined);
  y -= 14;
  if (!inv.paid && inv.due > 0) {
    text('Pay this invoice online', M, y, { c: ACC }); page.drawLine({ start: { x: M, y: y - 2 }, end: { x: M + w('Pay this invoice online', R, 10), y: y - 2 }, thickness: 0.6, color: ACC });
    link(portalLink, M, y - 3, M + w('Pay this invoice online', R, 10), y + 10);
  }
  // footer
  text('Thank you for your business!', M, 64, { f: B, s: 10, c: ACC });
  text(`Questions? Call or text ${BIZ.phone} or email ${BIZ.email}.`, M, 50, { s: 9, c: MUTE });
  text('1/1', RX, 36, { s: 8, c: MUTE, right: true });
  return await doc.save();
}
function b64bytes(u8: Uint8Array) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
const b64str = (str: string) => b64bytes(new TextEncoder().encode(str));
const fileName = (b: any) => `Knox View Invoice ${b.order_no || b.number} - ${String(b.address || '').replace(/[^\w ,.-]+/g, '').trim().slice(0, 60)}.pdf`;

/* ---------------- invoice email ---------------- */
const F = 'font-family:Arial,Helvetica,sans-serif;';
function invoiceEmail(b: any, client: any) {
  const inv = shape(b), link = !inv.paid && b.public_token ? `${PORTAL}/pay/${b.public_token}` : `${PORTAL}/#invoices/${inv.number}`, first = String(client?.full_name || b.client_name || '').split(' ')[0] || 'there';
  const heading = inv.paid ? 'Invoice paid' : 'Your invoice';
  const row = (k: string, v: string) => `<tr><td style="padding:6px 0;${F}font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#1f3c66;width:120px;">${k}</td><td style="padding:6px 0;${F}font-size:15px;color:#44546b;">${v}</td></tr>`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background-color:#f5f4f0;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f4f0"><tr><td align="center" style="padding:28px 12px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td bgcolor="#0d1726" style="border-radius:12px 12px 0 0;line-height:0;font-size:0;"><img src="${PORTAL}/email-header.jpg" width="600" alt="Knox View Real Estate Media" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:12px 12px 0 0;" /></td></tr>
<tr><td bgcolor="#ffffff" style="padding:34px 32px 30px 32px;border-radius:0 0 12px 12px;">
  <h1 style="margin:0 0 6px 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:32px;font-weight:normal;letter-spacing:1px;text-transform:uppercase;color:#1f3c66;">${heading}</h1>
  <p style="margin:0 0 20px 0;${F}font-size:13px;color:#8a96a8;">${esc(inv.address)}${inv.place ? ', ' + esc(inv.place) : ''}</p>
  <p style="margin:0 0 16px 0;${F}font-size:15px;line-height:24px;color:#44546b;">Hi ${esc(first)},</p>
  <p style="margin:0 0 20px 0;${F}font-size:15px;line-height:24px;color:#44546b;">${inv.paid ? 'Thank you for ordering with Knox View! Your invoice is paid in full.' : 'Thank you for ordering with Knox View! Your invoice is below.'} A PDF copy is attached.</p>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e7edf6" style="border-radius:12px;margin:0 0 22px 0;"><tr><td style="padding:16px 20px;"><table width="100%" cellpadding="0" cellspacing="0" border="0">
    ${row('Invoice', inv.order_no)}${row('Invoice total', money(inv.total))}${inv.credit ? row('Credit applied', '-' + money(inv.credit)) : ''}${row('Balance due', money(inv.due))}${row(inv.paid ? 'Date paid' : 'Due', esc(fmtLong(inv.paid ? inv.paid_at : inv.due_date)))}</table></td></tr></table>
  <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;"><tr><td bgcolor="#1d3250" style="border-radius:8px;"><a href="${esc(link)}" style="display:inline-block;padding:13px 26px;${F}font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#ffffff;text-decoration:none;">${inv.paid ? 'View invoice' : 'View &amp; pay invoice'}</a></td></tr></table>
  <p style="margin:0;${F}font-size:15px;line-height:22px;color:#44546b;">Questions? Call or text <a href="tel:+18658555669" style="color:#1f3c66;">${BIZ.phone}</a> or email <a href="mailto:${BIZ.email}" style="color:#1f3c66;">${BIZ.email}</a>.<br /><br />${BIZ.owner}<br /><span style="color:#1f3c66;">${BIZ.name}</span></p>
</td></tr>
<tr><td align="center" style="padding:18px 24px;"><p style="margin:0;${F}font-size:11px;line-height:17px;color:#8a96a8;">${BIZ.legal} &middot; ${BIZ.address.slice(1).join(', ')}</p></td></tr>
</table></td></tr></table></body></html>`;
  const text = `${heading}\n${inv.address}${inv.place ? ', ' + inv.place : ''}\n\nHi ${first},\n\nInvoice ${inv.order_no}\nInvoice total: ${money(inv.total)}\n${inv.credit ? `Credit applied: -${money(inv.credit)}\n` : ''}Balance due: ${money(inv.due)}\n\nView ${inv.paid ? '' : 'and pay '}your invoice: ${link}\nA PDF copy is attached.\n\nQuestions? ${BIZ.phone} · ${BIZ.email}\n${BIZ.owner}\n${BIZ.name}\n`;
  return { html, text, subject: `${inv.paid ? 'Paid invoice' : 'Invoice'} ${inv.order_no} · ${inv.address}` };
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
  const tk = await r.json(); if (!r.ok) return null;
  await admin.from('google_accounts').update({ access_token: tk.access_token, access_expires_at: new Date(Date.now() + (tk.expires_in ?? 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('member_id', owner.id);
  return tk.access_token as string;
}
const mimeWord = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64str(s)}?=`;
async function sendEmail(to: string[], subject: string, html: string, text: string, att: { name: string; b64: string }) {
  if (RESEND_KEY) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to, reply_to: REPLY_TO, subject, html, text, attachments: [{ filename: att.name, content: att.b64 }] }) });
    if (r.ok) return 'resend';
    console.error('resend failed', r.status, await r.text());
  }
  const tok = await ownerGmailToken();
  if (tok) {
    const mixed = 'kvinv_' + crypto.randomUUID().replace(/-/g, ''), alt = mixed + '_alt';
    const raw = [`To: ${to.join(', ')}`, `Reply-To: ${REPLY_TO}`, `Subject: ${mimeWord(subject)}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${mixed}"`, '',
      `--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '',
      `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64str(text),
      `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64str(html), `--${alt}--`,
      `--${mixed}`, `Content-Type: application/pdf; name="${att.name}"`, `Content-Disposition: attachment; filename="${att.name}"`, 'Content-Transfer-Encoding: base64', '', att.b64.replace(/.{76}/g, '$&\r\n'), `--${mixed}--`, ''].join('\r\n');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: b64str(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }) });
    if (r.ok) return 'gmail';
    console.error('gmail failed', r.status, await r.text());
  }
  throw new UserError("The email couldn't be sent right now. Please try again, or download the PDF instead.", 502);
}

/* ---------------- handler ---------------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    if (action === 'sample' && body.key === 'kv-layout-check') { // template preview with made-up data (no client data)
      const fake = { id: 'x', number: 1042, status: 'scheduled', address: '1208 Ft Craig Trl', unit: null, city: 'Maryville', state: 'TN', zip: '37803', items: [{ name: 'Premium Package (photos, drone, video walkthrough, 3D tour)', price: 549, kind: 'package' }, { name: 'Twilight Photos', price: 150, kind: 'service' }, { name: 'Large property (over 3,500 sq ft)', price: 75, kind: 'fee' }],
        subtotal: 774, discount: 0, tax: 0, total: 774, credit_applied: body.paid ? 0 : 100, paid: !!body.paid, paid_at: body.paid ? new Date().toISOString() : null, paid_method: null, payment_status: 'paid', created_at: new Date(Date.now() - 864e5 * 3).toISOString(), invoice_sent_at: null, invoice_due_at: null, client_name: 'Jane Agent', client_email: 'jane@example.com', client_phone: '865-555-0100', shoot_start: new Date(Date.now() - 864e5 * 5).toISOString() };
      return json(req, { base64: b64bytes(await invoicePdf(fake, { full_name: 'Jane Agent', brokerage: 'Prime Mountain Properties', team_name: 'Mount LeConte Team', email: 'jane@example.com', phone: '865-555-0100' })) });
    }
    if (action === 'hq_pdf') { // HQ (owner / super admins): any order's invoice PDF, exactly what the client gets
      const { user } = await me(req);
      const { data: tm } = await admin.from('team_members').select('role, active, permissions').eq('id', user.id).maybeSingle();
      if (!tm?.active || !(tm.role === 'owner' || tm.permissions?.super_admin === true)) throw new UserError('Only HQ super admins can open invoices.', 403);
      const { data: b } = await admin.from('bookings').select(COLS + ', agent_id').eq('id', String(body.bookingId || '')).maybeSingle();
      if (!b) throw new UserError('Invoice not found', 404);
      const { data: client } = b.agent_id ? await admin.from('agents').select('id, full_name, email, phone, brokerage, team_name').eq('id', b.agent_id).maybeSingle() : { data: null };
      return json(req, { filename: fileName(b), base64: b64bytes(await invoicePdf(b, client)) });
    }
    if (action === 'share_pdf') { // the payment link page (/pay/<token>): anyone with the order's link can open its invoice PDF
      const token = String(body.token || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) throw new UserError('Invoice not found', 404);
      const { data: b } = await admin.from('bookings').select(COLS + ', agent_id').eq('public_token', token).maybeSingle();
      if (!b || !isInvoice(b)) throw new UserError('Invoice not found', 404);
      const { data: client } = b.agent_id ? await admin.from('agents').select('id, full_name, email, phone, brokerage, team_name').eq('id', b.agent_id).maybeSingle() : { data: null };
      return json(req, { filename: fileName(b), base64: b64bytes(await invoicePdf(b, client)) });
    }
    if (action === 'hq_email') { // HQ (owner / super admins): email an order's invoice PDF to the client and anyone else
      const { user } = await me(req);
      const { data: tm } = await admin.from('team_members').select('role, active, permissions').eq('id', user.id).maybeSingle();
      if (!tm?.active || !(tm.role === 'owner' || tm.permissions?.super_admin === true)) throw new UserError('Only HQ super admins can email invoices.', 403);
      const { data: b } = await admin.from('bookings').select(COLS + ', agent_id').eq('id', String(body.bookingId || '')).maybeSingle();
      if (!b) throw new UserError('Invoice not found', 404);
      const to = [...new Set((Array.isArray(body.to) ? body.to : []).map((x: unknown) => String(x || '').trim().toLowerCase()).filter(Boolean))];
      if (!to.length) throw new UserError('Add an email address to send it to.');
      if (to.length > 6) throw new UserError('Send to 6 people at most.');
      for (const e of to) if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i.test(e)) throw new UserError(`"${e}" doesn't look like an email address.`);
      const { data: client } = b.agent_id ? await admin.from('agents').select('id, full_name, email, phone, brokerage, team_name').eq('id', b.agent_id).maybeSingle() : { data: null };
      const m = invoiceEmail(b, client);
      const provider = await sendEmail(to, m.subject, m.html, m.text, { name: fileName(b), b64: b64bytes(await invoicePdf(b, client)) });
      await admin.from('invoice_emails').insert({ booking_id: b.id, agent_id: b.agent_id, recipients: to, provider });
      await admin.from('bookings').update({ invoice_sent_at: b.invoice_sent_at || new Date().toISOString() }).eq('id', b.id);
      return json(req, { sent: to });
    }
    const { agent } = await me(req);

    if (action === 'list') {
      if (!agent) return json(req, { client: null, credits: 0, invoices: [] });
      const { data } = await admin.from('bookings').select(COLS).eq('agent_id', agent.id).order('created_at', { ascending: false }).limit(300);
      const bks = (data ?? []).filter(isInvoice);
      await settle(bks);
      return json(req, { client: { name: agent.full_name, email: agent.email }, credits: await creditBalance(agent.id), invoices: bks.map(shape) });
    }
    if (!agent) throw new UserError('Invoice not found', 404);

    if (action === 'pay') {
      const want = Array.isArray(body.numbers) ? body.numbers.map(Number).filter(Boolean) : [];
      const { data } = await admin.from('bookings').select(COLS).eq('agent_id', agent.id).eq('paid', false).order('created_at').limit(100);
      let list = (data ?? []).filter(isInvoice).filter(b => b.payment_status !== 'processing' && (!want.length || want.includes(b.number)));
      if (!list.length) return json(req, { alreadyPaid: true });
      // 1) account credits (only if the client ticked "use my credit"), oldest invoice first
      if (body.useCredits !== false) await applyCredits(agent.id, list);
      list = list.filter(b => !b.paid && dueOf(b) > 0).slice(0, 12);
      if (!list.length) return json(req, { paidByCredit: true });
      // 2) one card payment for the rest
      const live = !!list[0].stripe_livemode;
      if (list.some(b => !!b.stripe_livemode !== live)) list = list.filter(b => !!b.stripe_livemode === live);
      const amount = r2(list.reduce((a, b) => a + dueOf(b), 0));
      const customers = [...new Set(list.map(b => b.stripe_customer_id).filter(Boolean))];
      const nums = list.map(b => b.order_no || '#' + b.number).join(', ');
      const pi = await stripe('/payment_intents', live, {
        amount: Math.round(amount * 100), currency: 'usd', ...(customers.length === 1 ? { customer: customers[0] } : {}),
        'automatic_payment_methods[enabled]': 'true', description: `Knox View invoice${list.length > 1 ? 's' : ''} ${nums}`,
        ...(agent.email ? { receipt_email: agent.email } : {}),
        'metadata[booking_id]': list[0].id, 'metadata[booking_number]': String(list[0].number), 'metadata[booking_ids]': list.map(b => b.id).join(','), 'metadata[source]': 'portal_invoices',
      });
      await admin.from('bookings').update({ stripe_payment_intent_id: pi.id, updated_at: new Date().toISOString() }).in('id', list.map(b => b.id));
      return json(req, { clientSecret: pi.client_secret, pi: pi.id, amount, numbers: list.map(b => b.number) });
    }

    if (action === 'apply_credit') { // "Submit Order" (pay on delivery) with "use my credit" ticked: credit only, no card
      const want = Array.isArray(body.numbers) ? body.numbers.map(Number).filter(Boolean) : [];
      if (!want.length) throw new UserError('Invoice not found', 404);
      const { data } = await admin.from('bookings').select(COLS).eq('agent_id', agent.id).eq('paid', false).in('number', want);
      const list = (data ?? []).filter(b => b.status !== 'cancelled');
      await applyCredits(agent.id, list);
      return json(req, { credits: await creditBalance(agent.id), invoices: list.map(shape) });
    }

    if (action === 'confirm') {
      const pi = String(body.pi || '');
      if (!/^pi_\w+$/.test(pi)) throw new UserError('Payment not found', 404);
      const { data } = await admin.from('bookings').select(COLS).eq('agent_id', agent.id).eq('stripe_payment_intent_id', pi);
      await settle(data ?? []);
      return json(req, { paid: (data ?? []).every(b => b.paid), invoices: (data ?? []).map(shape) });
    }

    if (action === 'pdf') {
      const b = await oneInvoice(agent.id, body.number);
      return json(req, { filename: fileName(b), base64: b64bytes(await invoicePdf(b, agent)) });
    }

    if (action === 'email') {
      const b = await oneInvoice(agent.id, body.number);
      const own = String(agent.email || b.client_email || '').trim().toLowerCase();
      const extra = (Array.isArray(body.to) ? body.to : []).map((x: unknown) => String(x || '').trim().toLowerCase()).filter(Boolean);
      if (extra.length > 3) throw new UserError('You can add up to 3 more people.');
      for (const e of extra) if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i.test(e)) throw new UserError(`"${e}" doesn't look like an email address.`);
      const to = [...new Set([...(body.self === false ? [] : [own]), ...extra].filter(Boolean))];
      if (!to.length) throw new UserError('Add an email address to send it to.');
      const since = new Date(Date.now() - 86400_000).toISOString();
      const { count } = await admin.from('invoice_emails').select('id', { count: 'exact', head: true }).eq('agent_id', agent.id).gte('created_at', since);
      if ((count ?? 0) >= 15) throw new UserError("You've sent a lot of invoice emails today. Please download the PDF instead, or try again tomorrow.", 429);
      const m = invoiceEmail(b, agent);
      const provider = await sendEmail(to, m.subject, m.html, m.text, { name: fileName(b), b64: b64bytes(await invoicePdf(b, agent)) });
      await admin.from('invoice_emails').insert({ booking_id: b.id, agent_id: agent.id, recipients: to, provider });
      return json(req, { sent: to });
    }

    return json(req, { error: 'Unknown action' }, 400);
  } catch (e) {
    const status = e instanceof UserError ? e.status : 500;
    if (status >= 500) console.error('invoices error:', String((e as Error)?.message || e));
    return json(req, { error: e instanceof UserError ? e.message : 'Something went wrong. Please try again or call 865-855-5669.' }, status);
  }
});
