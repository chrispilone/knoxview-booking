import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const CFG = window.KV_CONFIG;
const sb = createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } });
const $ = id => document.getElementById(id);
/* ----- Activity history (shown on the agent's profile in HQ): sign-ins with device, visits, downloads ----- */
function deviceName() {
  const u = navigator.userAgent || '', mob = /Mobi|Android|iPhone|iPad/i.test(u);
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac OS X|Macintosh/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /CrOS/.test(u) ? 'Chromebook' : /Linux/.test(u) ? 'Linux' : 'Unknown device';
  const br = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /FxiOS|Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : 'browser';
  return `${os} · ${br}${mob && !/iPhone|iPad|Android/.test(os) ? ' (mobile)' : ''}`;
}
// HQ "Access agent" sessions: remembered on this browser so their visits/downloads are labeled as Knox View, not the client
const viaTeam = () => { try { return sessionStorage.getItem('kv.team') === '1' || (!!localStorage.getItem('kv.teamUid') && localStorage.getItem('kv.teamUid') === S?.session?.user?.id); } catch (_) { return false; } };
function logAct(kind, summary, booking) {
  if (viaTeam() && kind !== 'team_view') { kind = 'team_view'; summary = 'Knox View (Access agent): ' + summary; }
  try { sb.rpc('log_client_activity', { p_kind: kind, p_summary: summary, p_device: deviceName(), p_booking: /^[0-9a-f-]{36}$/i.test(booking || '') ? booking : null }).then(() => {}, () => {}); } catch (_) {}
}
// Order / invoice number shown to people: KV-YYMM-### (order_no). number stays the internal key for links.
const ono = x => x?.order_no || (x?.number ? '#' + x.number : '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const STEPS = ['Property', 'Services', 'Schedule', 'Review & Pay']; // address first; to revert, swap back here + in isValid/validate/navs/render

async function api(action, body = {}, fn = 'booking') {
  const { data, error } = await sb.functions.invoke(fn, { body: { action, ...body } });
  if (error) {
    let msg = 'Something went wrong. Please try again.';
    try { msg = (await error.context.json()).error || msg; } catch (_) { /* keep default */ }
    const e = new Error(msg); e.status = error.context?.status; throw e;
  }
  return data;
}

/* ================= state ================= */
const S = {
  view: 'book', step: 0, loading: true, error: '',
  services: [], upsells: [], config: null, session: null, agent: null,
  pkg: null, items: new Set(), adu: false, ptype: '', // ptype: 'home' | 'land'
  addr: { street: '', unit: '', city: '', state: 'TN', zip: '', sqftLabel: '', occupancy: '', access: '', files: [] },
  slots: null, slotsFrom: null, slotsLoading: false, start: null, startLabel: '',
  contact: { first: '', last: '', email: '', phone: '', brokerage: '', notes: '' },
  payOpt: 'save_card', errors: {}, busy: false, useCredit: true,
  cp: { on: false, code: '', applied: null, err: '', busy: false }, // coupon code at checkout (applied = { code, label, kind, value, min_total })
  checkout: null, // { booking, clientSecret, intentType, elements }
  done: null, login: null, pdata: null, after: '',
};
const svc = id => S.services.find(s => s.id === id);
const isLand = () => S.ptype === 'land';
// Custom order page (built in HQ → Order Pages, assigned to this client): its own services and prices, same booking flow
const isCustom = () => S.ptype === 'custom' && !!S.config?.customPage;
const PAGE = () => S.config?.customPage || null;
function useServices() { S.services = isCustom() ? PAGE().services : (S.baseServices || S.services); }
function applyPage() { // after load / sign-in / sign-out
  const pg = PAGE();
  if (!pg && S.ptype === 'custom') { S.ptype = ''; S.pkg = null; S.items = new Set(); S.addr.sqftLabel = ''; }
  if (pg && !pg.show_default && !S.ptype) S.ptype = 'custom';
  if (pg && !pg.show_default && ['home', 'land', 'str'].includes(S.ptype)) { S.ptype = 'custom'; S.pkg = null; S.items = new Set(); S.addr.sqftLabel = ''; }
  useServices();
}
const packages = () => S.services.filter(s => s.kind === 'package' && (isCustom() || (s.category === 'land') === isLand())).sort((a, b) => a.sort_order - b.sort_order);
const LAND_SKIP = /zillow|3d tour|twilight/i; // home-only services hidden for land
const alacarte = () => S.services.filter(s => s.kind === 'addon' && s.category !== 'addon' && !(isLand() && LAND_SKIP.test(s.name))).sort((a, b) => a.sort_order - b.sort_order);
// Land size tiers (no price change yet; set a price per tier here later if needed)
// Add-ons: offered only after a listing package is picked (category 'addon'), with an example picture
const addonList = () => S.services.filter(s => s.kind === 'addon' && s.category === 'addon').sort((a, b) => a.sort_order - b.sort_order);
const ADDON_IMG = { 'e8cab6b1-3742-49a3-9f85-e888d886fd0d': 'interactive-floor-plan', 'ccbb8503-18b6-4f76-8193-5c7c056c97f0': '3d-floor-plan', 'd7f8797f-5243-4de0-b4d0-28d0ce3c6403': 'community-photos',
  '9550aba6-e6a5-4072-8633-00b538039a4b': 'virtual-staging', '66929c67-8107-4fb0-b422-d956d261058b': 'location-graphics' };
const ACRE_OPTIONS = [{ label: 'Up to 50 acres' }, { label: 'Over 50 acres' }];
// Photo count shown in packages: 30+ photos, or 40+ for homes over 3,500 sq ft
const photoCount = () => largeOn() ? '40+' : '30+';
const incLabel = i => /^photography$/i.test(i) ? `${photoCount()} photos` : i; // Luxury's "Premium photography" shows no count
// À la carte Photography: 25+ photos, or 30+ for homes over 3,500 sq ft
const alcPhotoCount = () => largeOn() ? '30+' : '25+';
const covered = () => new Set(S.pkg ? svc(S.pkg)?.covers ?? [] : []);
const inCart = () => { const c = new Set(S.items); if (S.pkg) c.add(S.pkg); return c; };
const anyOf = (list, set) => (list || []).some(x => set.has(x));
const largeEnabled = () => +(S.config?.settings?.large_fee || 0) > 0;
const largeOn = () => {
  if (!largeEnabled()) return false;
  const o = (S.config?.settings?.sqft_options || []).find(x => x.label === S.addr.sqftLabel);
  return S.adu || (o ? (o.max === null || o.max >= S.config.settings.large_sqft) : false);
};
const largeVisible = () => largeEnabled() && inCart().size > 0;
// À la carte price shown to the client: Photography is $250 (not $225) for homes over 3,500 sq ft on a photos-only order
const svcPrice = s => +s.price + (!S.pkg && largeOn() && /^photography$/i.test(s.name) ? 25 : 0);
// shown inside package prices: the package's own large-property fee, or the normal one
const pkgLargeFee = p => p && p.large_fee != null ? +p.large_fee : +S.config.settings.large_fee;
const sizeAdj = p => largeOn() ? pkgLargeFee(p) : 0;
// the fee to quote before a package is picked: the selected package's, or the one all shown packages share, else the normal fee
const largeFeeShown = () => { if (S.pkg) return pkgLargeFee(svc(S.pkg)); const fs = [...new Set(packages().map(pkgLargeFee))]; return fs.length === 1 ? fs[0] : +S.config.settings.large_fee; };
function lines() {
  const out = [];
  if (S.pkg) { const p = svc(S.pkg); out.push({ name: p.name + ' Package', price: +p.price + sizeAdj(p) }); }
  for (const id of S.items) { const s = svc(id); if (s) out.push({ name: s.name, price: svcPrice(s) }); }
  // photos-only orders over 3,500 sq ft: Photography is $250 instead of $225 (no separate large-home fee)
  return out;
}
const subTotal = () => lines().reduce((a, l) => a + l.price, 0);
// Coupon savings on this order (the server works it out again when the order is saved)
const couponOff = () => { const c = S.cp.applied, st = subTotal(); if (!c || st < c.min_total) return 0; return Math.round(Math.min(st, c.kind === 'percent' ? st * c.value / 100 : c.value) * 100) / 100; };
const total = () => Math.max(0, Math.round((subTotal() - couponOff()) * 100) / 100);
const selection = () => ({ packageId: S.pkg, serviceIds: [...S.items], sqftLabel: S.addr.sqftLabel, adu: S.adu, pageId: isCustom() ? PAGE().id : null, coupon: S.cp.applied?.code || null });
function upsells() {
  const c = inCart(), cov = covered();
  return S.upsells.filter(u => anyOf(u.show_when_any, c) && !anyOf(u.hide_when_any, c) && !cov.has(u.service_id) && svc(u.service_id));
}
function resetSchedule() { S.slots = null; S.start = null; S.startLabel = ''; S.pickDate = null; S.checkout = null; S.calFrom = null; }
function cleanup() {
  const cov = covered();
  for (const id of [...S.items]) if (cov.has(id)) S.items.delete(id);
  resetSchedule();
}

/* ================= actions ================= */
window.kv = {
  pickPkg(id) { if (S.pkg && S.pkg !== id) return; S.pkg = S.pkg === id ? null : id; cleanup(); render(); },
  toggle(id) { if (covered().has(id)) return; S.items.has(id) ? S.items.delete(id) : S.items.add(id); cleanup(); render(); },
  toggleAdu() { S.adu = !S.adu; resetSchedule(); render(); },
  go, pickSlot(start, label) { S.start = start; S.startLabel = label; S.checkout = null; render(); },
  moreSlots() { loadSlots(S.slots.days[S.slots.days.length - 1].date, true); },
  pickSugg(date, start, label) { S.pickDate = date; S.calFrom = dAdd(calFirst(), Math.floor((Date.parse(date) - Date.parse(calFirst())) / 864e5 / 14) * 14); S.start = start; S.startLabel = label; S.checkout = null; render(); },
  calToggle() { S.calOpen = !S.calOpen; if (S.calOpen && !S.calFrom && S.slots?.days?.length) S.calFrom = S.pickDate ? dSun(S.pickDate) : calFirst(); render(); if (S.calOpen) calEnsure(); },
  calShift(n) { const first = calFirst(); S.calFrom = dAdd(S.calFrom || first, n); if (S.calFrom < first) S.calFrom = first; S.pickDate = null; render(); calEnsure(); },
  setPay(v) { S.payOpt = v; S.checkout = null; render(); },
  svcTab(t) { S.svcTab = t === 'alc' ? 'alc' : 'pkg'; render(); document.querySelector('.svc-tabs')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
  ptype(t) { if (S.ptype === t) return; S.ptype = t; useServices(); S.addr.sqftLabel = ''; S.pkg = null; S.items = new Set(); S.adu = false; S.svcTab = 'pkg'; if (t === 'land') S.addr.occupancy = ''; resetSchedule(); render(); setTimeout(() => document.getElementById('o-size')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); },
  size(label) { S.addr.sqftLabel = label; resetSchedule(); render(); if (!inCart().size) setTimeout(() => document.getElementById('o-svc')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); },
  lbPhoto, lbMedia, lbStep, lbClose, showTerms, upFiles, rmFile, startCheckout, confirmPay, submitOrder, cancelPay() { S.checkout = null; S.error = ''; render(); }, signIn, signUp, setMode, sendCode, verifyCode, loginBack, setMethod, fmtPhone, signOut, payBooking, ldSend, ldCheck, ltab, lsize, ldPricing, lpAddr, locc, closeModal() { $('modal').innerHTML = ''; },
};

function go(n) {
  if (S.busy) return;
  if (n > S.step && !validate(S.step)) { render(); return; }
  if (n !== 3) S.checkout = null; // going back starts a fresh checkout (the old hold expires after 30 min)
  S.step = n; S.error = '';
  if (n === 2 && !S.slots) loadSlots();
  window.scrollTo({ top: 0, behavior: 'smooth' }); render();
}
function isValid(step) {
  if (step === 1) return inCart().size > 0;
  if (step === 0) { const a = S.addr; return a.street && a.city && a.state && /^\d{5}$/.test(a.zip) && a.sqftLabel; }
  if (step === 2) return !!S.start;
  if (step === 3) { const c = S.contact; return c.first && c.last && /\S+@\S+\.\S+/.test(c.email) && c.phone.replace(/\D/g, '').length >= 10; }
  return true;
}
function validate(step) {
  S.errors = {};
  const a = S.addr, c = S.contact;
  if (step === 0) { if (!a.street) S.errors.street = 1; if (!a.city) S.errors.city = 1; if (!/^\d{5}$/.test(a.zip)) S.errors.zip = 1; if (!a.sqftLabel) S.errors.sqftLabel = 1; }
  if (step === 3) { if (!c.first) S.errors.first = 1; if (!c.last) S.errors.last = 1; if (!/\S+@\S+\.\S+/.test(c.email)) S.errors.email = 1; if (c.phone.replace(/\D/g, '').length < 10) S.errors.phone = 1; }
  return isValid(step);
}
const canReach = n => { for (let i = 0; i < n; i++) if (!isValid(i)) return false; return true; };

async function loadSlots(from, append) {
  S.slotsLoading = true; render();
  try {
    const r = await api('slots', { ...selection(), from, days: 14 });
    if (append && S.slots) { r.days = [...S.slots.days, ...r.days.filter(d => !S.slots.days.some(x => x.date === d.date))]; }
    S.slots = r;
  } catch (e) { S.error = e.message; }
  S.slotsLoading = false; render();
}

/* ---------- Stripe ---------- */
let stripe = null;
function stripeReady() {
  const pk = S.config?.stripe?.publishableKey;
  if (!pk || !window.Stripe) return false;
  if (!stripe) stripe = window.Stripe(pk);
  return true;
}
const appearance = { theme: 'stripe', variables: { colorPrimary: '#1d3250', colorText: '#44546b', colorDanger: '#b0413e', fontFamily: 'Figtree, system-ui, sans-serif', borderRadius: '8px' } };

// "Submit Order": no card now, payment upon delivery (the `order` function books it and adds it to the calendar)
async function submitOrder() {
  if (!checkAll()) return;
  S.busy = true; S.error = ''; S.payOpt = 'pay_later'; render();
  try {
    S.done = await api('submit', { ...selection(), start: S.start, address: addrOut(), contact: S.contact }, 'order');
    freshAfterOrder();
    if (S.useCredit && myCredit()) { // "use my credit" ticked: put their account credit on this order now
      const c = await api('apply_credit', { numbers: [S.done.number] }, 'invoices').catch(() => null);
      const inv = c?.invoices?.[0];
      if (inv) { S.done.creditUsed = inv.credit; if (inv.paid) S.done.paymentStatus = 'paid'; S.done.due = inv.due; }
      loadInvoices(true);
    }
    S.view = 'done'; S.checkout = null; history.replaceState(null, '', '/');
  } catch (e) {
    S.error = e.message;
    if (e.status === 409) { resetSchedule(); S.slotsKey = null; setTimeout(() => document.getElementById('o-time')?.scrollIntoView({ behavior: 'smooth' }), 50); }
  }
  S.busy = false; render(); window.scrollTo({ top: 0 });
}
// "Pay Now and Submit Order": card payment through Stripe
async function startCheckout() {
  S.payOpt = 'pay_now';
  if (!checkAll()) return;
  if (S.useCredit && myCredit()) { // with credit: book it, use the credit, then card for whatever is left
    S.busy = true; S.error = ''; render();
    try {
      S.done = await api('submit', { ...selection(), start: S.start, address: addrOut(), contact: S.contact }, 'order');
      freshAfterOrder();
      S.view = 'done'; S.checkout = null; history.replaceState(null, '', '/');
      S.busy = false; render(); window.scrollTo({ top: 0 });
      await loadInvoices(true);
      invPay([S.done.number], { useCredits: true, onPaid: () => { S.done.paymentStatus = 'paid'; render(); } });
    } catch (e) {
      S.error = e.message; S.busy = false; render();
      if (e.status === 409) { resetSchedule(); S.slotsKey = null; setTimeout(() => document.getElementById('o-time')?.scrollIntoView({ behavior: 'smooth' }), 50); }
    }
    return;
  }
  if (!stripeReady()) { S.error = 'Online payments are not switched on yet. Please call ' + CFG.phone + ' to book.'; render(); return; }
  S.busy = true; S.error = ''; render();
  try {
    const r = await api('create', { ...selection(), start: S.start, paymentOption: S.payOpt,
      address: addrOut(), contact: S.contact });
    S.checkout = r;
    render();
    const elements = stripe.elements({ clientSecret: r.clientSecret, appearance });
    elements.create('payment', { layout: 'tabs' }).mount('#pay-el');
    S.checkout.elements = elements;
  } catch (e) {
    S.error = e.message;
    if (e.status === 409) { resetSchedule(); S.slotsKey = null; setTimeout(() => document.getElementById('o-time')?.scrollIntoView({ behavior: 'smooth' }), 50); }
  }
  S.busy = false; render();
}
async function confirmPay() {
  const co = S.checkout; if (!co?.elements) return;
  S.busy = true; S.error = ''; render();
  const returnUrl = `${location.origin}/?b=${co.booking.id}&t=${co.booking.token}`;
  const fn = co.intentType === 'setup' ? stripe.confirmSetup : stripe.confirmPayment;
  const { error } = await fn.call(stripe, { elements: co.elements, confirmParams: { return_url: returnUrl }, redirect: 'if_required' });
  if (error) { S.error = error.message; S.busy = false; render(); return; }
  await finishBooking(co.booking.id, co.booking.token);
}
async function finishBooking(id, token) {
  try {
    S.done = await api('confirm', { bookingId: id, token });
    freshAfterOrder();
    S.view = 'done'; S.checkout = null;
    history.replaceState(null, '', '/');
  } catch (e) { S.error = e.message; }
  S.busy = false; render(); window.scrollTo({ top: 0 });
}

/* ---------- auth + portal ---------- */
// Sign in with a one-time code: by email, or by text to a mobile number that matches a client record.
const LP = () => (S.login || (S.login = { stage: 'enter', mode: 'signin', method: 'email', email: '', phone: '', su: { first: '', last: '', phone: '', email: '', company: '' } }));
function keepInput() { const p = LP(), v = $('loginId')?.value; if (v != null) p[p.method === 'sms' ? 'phone' : 'email'] = v.trim(); }
function setMethod(m) {
  keepInput(); const p = LP();
  p.method = m === 'sms' ? 'sms' : 'email'; p.stage = 'enter'; S.error = ''; render();
  setTimeout(() => $('loginId')?.focus(), 30);
}
function fmtPhone(v) { const d = v.replace(/\D/g, '').replace(/^1(?=\d{10})/, '').slice(0, 10);
  return d.length < 4 ? d : d.length < 7 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`; }
async function signIn(ev) { // send a code to the email or phone they entered
  ev?.preventDefault(); keepInput();
  const p = LP();
  if (p.method === 'email' && !/\S+@\S+\.\S+/.test(p.email)) { S.error = 'Enter your email.'; render(); return; }
  if (p.method === 'sms' && p.phone.replace(/\D/g, '').replace(/^1(?=\d{10})/, '').length !== 10) { S.error = 'Enter your 10-digit mobile number.'; render(); return; }
  S.busy = true; S.error = ''; render();
  try {
    const r = await api('send', p.method === 'sms' ? { channel: 'sms', phone: p.phone } : { channel: 'email', email: p.email.toLowerCase() }, 'auth-code');
    Object.assign(p, { stage: 'code', ref: r.ref, to: r.to, expiresMin: r.expiresMin || 60 });
  } catch (e) { S.error = e.message; }
  S.busy = false; render();
  setTimeout(() => $('loginCode')?.focus(), 50);
}
function sendCode() { return LP().mode === 'signup' ? signUp() : signIn(); }
// New clients: name, mobile, email and brokerage. We email a code to confirm the email; the client record is created once it's verified.
const SU_FIELDS = ['first', 'last', 'phone', 'email', 'company'];
function keepSignup() { const su = LP().su; SU_FIELDS.forEach(k => { const v = $('su_' + k)?.value; if (v != null) su[k] = v.trim(); }); }
function setMode(m) {
  if (LP().mode === 'signup') keepSignup(); else keepInput();
  const p = LP(); p.mode = m === 'signup' ? 'signup' : 'signin'; p.stage = 'enter'; S.error = '';
  if (p.mode === 'signup' && !p.su.email && p.email) p.su.email = p.email; // carry over what they already typed
  if (p.mode === 'signin' && !p.email && p.su.email) { p.email = p.su.email; p.method = 'email'; }
  render(); setTimeout(() => $(p.mode === 'signup' ? 'su_first' : 'loginId')?.focus(), 30);
}
async function signUp(ev) {
  ev?.preventDefault(); keepSignup();
  const p = LP(), su = p.su;
  const bad = !su.first ? 'Enter your first name.' : !su.last ? 'Enter your last name.'
    : su.phone.replace(/\D/g, '').replace(/^1(?=\d{10})/, '').length !== 10 ? 'Enter your 10-digit mobile number.'
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(su.email) ? 'Enter a valid email.' : '';
  if (bad) { S.error = bad; render(); return; }
  S.busy = true; S.error = ''; render();
  try {
    const r = await api('signup', { name: `${su.first} ${su.last}`, first_name: su.first, last_name: su.last, phone: su.phone, email: su.email.toLowerCase(), company: su.company }, 'auth-code');
    Object.assign(p, { stage: 'code', ref: r.ref, to: r.to, expiresMin: r.expiresMin || 60, method: 'email', email: su.email });
  } catch (e) { S.error = e.message; }
  S.busy = false; render();
  setTimeout(() => $('loginCode')?.focus(), 50);
}
async function verifyCode(ev) {
  ev?.preventDefault();
  const code = ($('loginCode')?.value || '').replace(/\D/g, '');
  if (code.length < 6) { S.error = 'Enter the code we sent you.'; render(); return; }
  S.busy = true; S.error = ''; render();
  try {
    const r = await api('verify', { ref: LP().ref, code }, 'auth-code');
    const { error } = await sb.auth.setSession(r.session);
    if (error) throw error;
    try { sessionStorage.removeItem('kv.team'); localStorage.removeItem('kv.teamUid'); sessionStorage.setItem('kv.visit', '1'); } catch (_) {}
    logAct('signin', `Signed in with a ${LP().method === 'phone' ? 'text' : 'email'} code`);
    S.login = null; S.pdata = null; // the auth listener links the client record; then we go to their listings
    location.hash = S.after || '#listings';
  } catch (e) { S.error = e.message; }
  S.busy = false; render();
}
function loginBack() { LP().stage = 'enter'; S.error = ''; render(); }
async function reloadPage() { try { const c = await api('config'); S.config = c; applyPage(); render(); } catch (_) { /* keep what we have */ } }
async function signOut() { await sb.auth.signOut(); if (S.config) S.config.customPage = null; applyPage(); S.session = null; S.agent = null; S.pdata = null; S.login = null; S.photo = null; INV.data = null; INV.pdf = {}; INV.dmedia = {}; UI.menu = false; location.hash = '#account'; render(); }
async function loadPortal() {
  S.pdata = { loading: true }; render();
  try { S.pdata = await api('portal'); if (S.pdata.agent) { S.agent = { ...S.agent, ...S.pdata.agent }; fillContact(); } } catch (e) { S.pdata = { error: e.message }; }
  render();
  loadZillow();
}
async function payBooking(id) {
  const viaShare = !!SHARE && !D.data?.mine; // someone the link was forwarded to: pay through the share link
  const num = viaShare ? null : (S.pdata?.bookings || []).find(b => b.id === id)?.number || invAll().find(i => i.id === id)?.number || (D.key === id ? D.data?.head?.number : null);
  if (num) return invPay([num]);
  if (!stripeReady()) { alertModal('Online payments are not switched on yet.'); return; }
  try {
    const r = viaShare ? await api('share-pay', { token: SHARE }) : await api('pay', { bookingId: id });
    if (r.alreadyPaid) { if (S.view === 'delivery') loadDelivery(S.dl.key); else loadPortal(); return; }
    $('modal').innerHTML = `<div class="modal"><div class="panel"><h2 style="font-size:22px">Pay to download</h2>
      <div class="tot" style="padding:6px 0 0"><span>Amount due</span><span>${money(r.booking.total)}</span></div>
      <div id="pay-el2" style="margin-top:14px"></div><div id="payErr"></div>
      <div class="nav"><button class="btn o" onclick="kv.closeModal()">Cancel</button><button class="btn" id="payGo">Pay ${money(r.booking.total)}</button></div></div></div>`;
    const elements = stripe.elements({ clientSecret: r.clientSecret, appearance });
    elements.create('payment').mount('#pay-el2');
    $('payGo').onclick = async () => {
      $('payGo').disabled = true;
      const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: SHARE ? location.origin + location.pathname : `${location.origin}/#invoices` }, redirect: 'if_required' });
      if (error) { $('payErr').innerHTML = `<div class="msg err">${esc(error.message)}</div>`; $('payGo').disabled = false; return; }
      await api('confirm', { bookingId: r.booking.id, token: r.booking.token }).catch(() => {});
      kv.closeModal(); S.pdata = null; if (S.view === 'delivery') loadDelivery(S.dl.key); else loadPortal();
    };
  } catch (e) { alertModal(e.message); }
}
function alertModal(text) {
  $('modal').innerHTML = `<div class="modal"><div class="panel"><p>${esc(text)}</p><div class="nav"><span></span><button class="btn" onclick="kv.closeModal()">OK</button></div></div></div>`;
}

/* ================= views ================= */
// Upsell pop-ups are switched on and off per upsell in HQ (Bookings → Portal settings → Upsells).
// Only active upsells are readable by the public, so this stays true; set false to hide them all.
const SHOW_UPSELLS = true;

// ===== Package examples: a small swipe strip under the selected package. Tapping a photo, the 3D tour or a video
// opens it in a viewer on this page (dark background, X to close) so nobody leaves the booking flow.
const TOUR_ZILLOW = 'https://www.zillow.com/view-imx/b55c2ba6-cc6e-47b1-8e2c-6f39e2fa26ef/?utm_source=captureapp';
const TOUR_PREMIUM = 'https://www.zillow.com/view-imx/387714a0-c187-4298-bad5-51082b18bd8f?setAttribution=mls&wl=true&initialViewType=pano';
const VIMEO = id => `https://player.vimeo.com/video/${id}?autoplay=1&muted=1&playsinline=1&loop=1&title=0&byline=0&portrait=0&dnt=1`;
const EX = {
  '97876a6f-31bf-4b2e-b3c5-111d9dfc6ee5': { dir: 'essentials', imgs: [['front','Photos'],['kitchen','Photos'],['living','Photos'],['primary','Photos'],['aerial-house','Drone Photos'],['aerial-wide','Drone Photos'],['twilight','Virtual Twilight'],['floorplan','2D Floor Plan']] },
  '2af4fccb-2e5e-40e0-9413-5a5f2a711e9d': { dir: 'zillow', leads: [['living', 'Zillow 3D Tour', 'tour', TOUR_ZILLOW]], imgs: [['front-angle','Photos'],['kitchen-living','Photos'],['primary','Photos'],['aerial-pin','Drone Photos'],['aerial-street','Drone Photos'],['twilight','Virtual Twilight'],['floorplan','2D Floor Plan']] },
  '5d0329ed-225f-4ccf-aed9-8307780de1b4': { dir: 'social', leads: [['aerial-wide', 'Social Media Video', 'video', '1229552456']], imgs: [['front-yard','Photos'],['kitchen','Photos'],['living','Photos'],['bedroom','Photos'],['aerial-pin','Drone Photos'],['twilight','Virtual Twilight'],['floorplan','2D Floor Plan']] },
  '271ce816-6215-4ead-b063-d4ae920276bc': { dir: 'premium', leads: [['aerial-yard', 'Premium Video', 'video', '1216825550'], ['living', 'Zillow 3D Tour', 'tour', TOUR_PREMIUM]], imgs: [['front','Photos'],['kitchen-island','Photos'],['primary','Photos'],['aerial-pin','Drone Photos'],['twilight','Virtual Twilight'],['floorplan','2D Floor Plan']] },
};
function vExample(id) {
  const e = EX[id]; if (!e) return '';
  const src = n => `/img/ex/${e.dir}/${n}.jpg`;
  const tile = (n, cap, k) => `<button type="button" class="ex-t${/floor/i.test(cap) ? ' fp' : ''}" onclick="kv.lbPhoto('${id}',${k})"><img src="${src(n)}" alt="${esc(cap)}" loading="lazy" decoding="async"><figcaption>${esc(cap)}</figcaption></button>`;
  const leads = (e.leads || []).map(([n, cap, kind, ref], k) => `<button type="button" class="ex-t ex-lead" onclick="kv.lbMedia('${id}',${k})"><img src="${src(n)}" alt="" loading="lazy"><span class="ex-ic">${kind === 'video' ? '&#9654;' : '3D'}</span><figcaption>${esc(cap)}</figcaption></button>`).join('');
  return `<div class="ex" role="region" aria-label="Example of what's included">
    <div class="ex-h"><span>Example of what you get</span><span class="ex-hint">Tap to view</span></div>
    <div class="ex-s">${leads}${e.imgs.map(([n, c], k) => tile(n, c, k)).join('')}</div></div>`;
}

// ===== Terms & Conditions (Chris's wording, shown in the on-page viewer and at /terms.html) =====
const TERMS = {"title": "Rights and Usage", "sections": [["Grant of Rights", "You hereby grant to Knox View Media LLC, and its affiliates, contractors, commercial partners, licensees, successors and assigns a non-exclusive, perpetual, fully transferable, sublicensable worldwide right and license, to create, reproduce, display, transmit, and distribute the Work through any and all media now known or hereinafter developed. The \"Work\" is defined as photo(s), video(s), and/or 3D content, floor plans, graphics, audio, animation, constituent files, and other visual content of the property produced under these terms including any derivative works created therefrom. Any and all rights not expressly granted here are reserved to Knox View Media LLC, including copyright and ownership rights in the Work. Knox View Media LLC reserves the right to use the Work for the company's portfolio, samples, self-promotions, entry in contests or exhibitions, editorial use, or for display within or on the outside of Knox View Media LLC's premises. Knox View Media LLC further reserves the right to assign, transfer, license, distribute, or syndicate the Work and any and all rights in the Work to its commercial partners. Except as explicitly set forth in Section 5 herein, You have no ownership rights in the work and no right to sell or license the Work to any third party or copy, modify, reproduce, or create derivatives of the Work without the prior written consent of Knox View Media LLC."], ["Usage Rights", "In exchange for the Grant of Rights set forth herein, Knox View Media LLC grants to You the right to use the images created from the Work and provided to you by Knox View Media LLC for purposes of marketing and promoting the Property, promoting Your real estate business and/or the listing(s), Your brokerage(s), and/or Your business(es) (\"Your License\"). Your License is non-exclusive, non-transferable, covers all territories and media, and is for an unlimited time on websites owned by You. You may authorize third-party websites such as, but not limited to, Multiple Listing Service (MLS) or real estate listing portal websites to display said content solely for the purpose of advertising the subject listing, for as long as said listing is actively listed for sale by that listing agent. Your authorization to third-party websites will automatically expire once said listing is no longer available for sale or any relevant listing agreement between the Property owner and the listing agent has ended, whichever comes first."], ["Releases, Licenses, and Authorizations", "By contracting with Knox View Media LLC to produce the Work, You warrant and represent that You are authorized to enter into this Agreement with regard to the Property and You certify that You have obtained all appropriate and necessary releases, permissions, waivers, licenses and/or authorizations (hereinafter \"Clearances\") for the Grant of Rights and Usage Rights set forth in these Terms and Conditions, including but not limited Clearances from the owner of the Property and any other owners of intellectual property rights contained in, on, or around the Property and captured as part of the Work, including the underlying architectural work. You further warrant and represent that the Property owner and any occupants of the Property have waived any expectation of privacy rights in relation to the images captured and distributed in accordance with the grant of rights hereunder. You agree to indemnify and hold harmless Knox View Media LLC against any and all claims, costs, and expenses, including attorney's fees, due to uses of the Work for which You did not obtain the appropriate Clearance including uses that exceeded the Clearances actually obtained by You."], ["Indemnification/Hold Harmless", "You shall also indemnify and hold Knox View Media LLC, its officers, members, employees, contractors, licensees, sublicensees, agents, successors and assigns harmless from and against any and all liability, claims, injuries, damages, loss, expense, (including court costs and reasonable attorneys' fees) resulting from the performance of this Agreement, or any distribution or use of the Work created hereunder resulting from Your breach of any warranties, representations or certifications hereunder, or resulting from Your negligent or intentional acts or omissions and/or those of Your officers, agents, independent contractors, employees, family members, invitees, licensors, the Property owner, and/or guests."]]};
function termsHtml() { return `<h2>Terms &amp; Conditions</h2><h3>${esc(TERMS.title)}</h3>${TERMS.sections.map(([h, p]) => `<h4>${esc(h)}</h4><p>${esc(p)}</p>`).join('')}`; }
function showTerms() { lbOpen(`<div class="lb-doc">${termsHtml()}</div>`, 'doc'); }
// ----- viewer (lightbox) -----
const LB = { el: null, list: [], i: 0 };
function lbOpen(html, cls) {
  lbClose(true);
  const el = document.createElement('div'); el.className = 'lb ' + (cls || ''); el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<div class="lb-bg" onclick="kv.lbClose()"></div><div class="lb-box">${html}</div><button type="button" class="lb-x" onclick="kv.lbClose()" aria-label="Close">&times;</button>`;
  document.body.appendChild(el); document.body.classList.add('lb-open'); LB.el = el;
  requestAnimationFrame(() => el.classList.add('on'));
}
function lbClose(now) {
  const el = LB.el; if (!el) return; LB.el = null; document.body.classList.remove('lb-open');
  if (now === true) return el.remove();
  el.classList.remove('on'); setTimeout(() => el.remove(), 220);
}
function lbShow() {
  const [src, cap] = LB.list[LB.i], n = LB.list.length;
  LB.el.querySelector('.lb-img').src = src; LB.el.querySelector('.lb-cap').textContent = `${cap} · ${LB.i + 1} of ${n}`;
}
function lbPhoto(id, k) {
  const e = EX[id]; LB.list = e.imgs.map(([n, c]) => [`/img/ex/${e.dir}/${n}-lg.jpg`, c]); LB.i = k;
  lbOpen(`<div class="lb-photo"><img class="lb-img" alt=""><button type="button" class="lb-nav prev" onclick="kv.lbStep(-1)" aria-label="Previous">&#8249;</button><button type="button" class="lb-nav next" onclick="kv.lbStep(1)" aria-label="Next">&#8250;</button></div><div class="lb-cap"></div>`, 'photo');
  lbShow();
  let x0 = null; const ph = LB.el.querySelector('.lb-photo');
  ph.addEventListener('touchstart', ev => { x0 = ev.touches[0].clientX; }, { passive: true });
  ph.addEventListener('touchend', ev => { if (x0 === null) return; const dx = ev.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 40) lbStep(dx < 0 ? 1 : -1); });
}
function lbStep(d) { if (!LB.el || !LB.list.length) return; LB.i = (LB.i + d + LB.list.length) % LB.list.length; lbShow(); }
function lbMedia(id, k) {
  const [, cap, kind, ref] = EX[id].leads[k];
  if (kind === 'video') lbOpen(`<div class="lb-vid"><iframe src="${VIMEO(ref)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen title="${esc(cap)}"></iframe></div><div class="lb-cap">${esc(cap)} · tap the speaker for sound</div>`, 'video');
  else lbOpen(`<div class="lb-tour"><iframe src="${ref}" allow="xr-spatial-tracking; gyroscope; accelerometer; fullscreen" allowfullscreen title="${esc(cap)}"></iframe></div><div class="lb-cap">${esc(cap)} · drag to look around, tap the circles to move</div>`, 'tour');
}
document.addEventListener('keydown', ev => { if (!LB.el) return; if (ev.key === 'Escape') lbClose(); if (ev.key === 'ArrowRight') lbStep(1); if (ev.key === 'ArrowLeft') lbStep(-1); });
// Custom page price below the normal price: show the normal price crossed out
const was = (x, add = 0) => isCustom() && +x.list_price > +x.price ? `<s class="was">${money(+x.list_price + add)}</s>` : '';
function vServices(inline) {
  const cov = covered();
  const pk = packages().map(p => `
    <button class="card round pkg ${S.pkg === p.id ? 'sel' : S.pkg ? 'dim' : ''}" onclick="kv.pickPkg('${p.id}')" aria-pressed="${S.pkg === p.id}" ${S.pkg && S.pkg !== p.id ? 'aria-disabled="true"' : ''}>
      <span class="tick">${CHECK}</span>
      <div class="pkg-h"><div class="pkg-nm"><h3>${esc(p.name)}</h3>${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ''}</div>
        <span class="pkg-p">${was(p, sizeAdj(p))}${money(+p.price + sizeAdj(p))}</span></div>
      <ul class="chk two">${(p.includes || []).map(i => `<li>${CHECK}<span>${esc(incLabel(i))}</span></li>`).join('')}</ul>
    </button>${S.pkg === p.id ? vExample(p.id) : ''}`).join('');
  const ups = upsells().map(u => `<div class="up"><div style="flex:1"><h3>${esc(u.title)}</h3><p>${esc(u.description)}</p></div>
      <button class="btn lt" onclick="kv.toggle('${u.service_id}')">+ ${money(svc(u.service_id).price)}</button></div>`).join('');
  const row = s => {
    const inc = cov.has(s.id), sel = S.items.has(s.id);
    return `<button class="row ${sel ? 'sel' : ''} ${inc ? 'incl' : ''}" onclick="kv.toggle('${s.id}')" aria-pressed="${sel || inc}" ${inc ? 'aria-disabled="true"' : ''}>
      <span class="box">${CHECK}</span>
      <span class="row-t"><span class="row-n">${esc(s.name)}</span>${/^photography$/i.test(s.name) && !isLand() ? `<span class="row-d">${alcPhotoCount()} photos</span>` : s.description ? `<span class="row-d">${esc(s.description)}</span>` : ''}</span>
      <span class="row-p">${inc ? `<span class="inc">Included in ${esc(svc(S.pkg).name)}</span>` : was(s, svcPrice(s) - s.price) + money(svcPrice(s))}</span></button>`;
  };
  const card = s => {
    const inc = cov.has(s.id), sel = S.items.has(s.id);
    return `<button class="card sq small-card ${sel ? 'sel' : ''} ${inc ? 'incl' : ''}" onclick="kv.toggle('${s.id}')" aria-pressed="${sel || inc}">
      ${inc ? `<span class="badge g">Included in ${esc(svc(S.pkg).name)}</span>` : ''}
      <span class="tick">${CHECK}</span><h3>${esc(s.name)}</h3>
      <div class="price">${inc ? '<span style="color:var(--ok)">Included</span>' : was(s) + money(s.price)}</div>
      ${s.description ? `<div class="meta">${esc(s.description)}</div>` : ''}</button>`;
  };
  const st = S.config.settings;
  const large = false ? `<section class="sec"><div class="sec-h"><i style="background:#8ca6cc"></i><h2>Property Add-Ons</h2></div>
      <p class="d">For larger homes and properties with extra structures.</p><div class="grid">
      <button class="card sq small-card ${S.adu ? 'sel' : ''}" onclick="kv.toggleAdu()" aria-pressed="${S.adu}"><span class="tick">${CHECK}</span>
      <h3>${esc(st.large_label)}</h3><div class="price">${money(largeFeeShown())}</div><div class="meta">Over ${Number(st.large_sqft).toLocaleString()} sq ft, or an ADU / guest house / extra structure</div></button></div></section>` : '';
  const onlyOne = isCustom() && (!packages().length || !alacarte().length);
  const tab = isLand() ? 'pkg' : onlyOne ? (packages().length ? 'pkg' : 'alc') : (S.svcTab || 'pkg'), nAlc = [...S.items].length;
  const tabs = `<div class="svc-tabs" role="tablist">
      <button type="button" role="tab" aria-selected="${tab === 'pkg'}" class="${tab === 'pkg' ? 'on' : ''}" onclick="kv.svcTab('pkg')">Packages${S.pkg ? ' <i>1</i>' : ''}</button>
      <button type="button" role="tab" aria-selected="${tab === 'alc'}" class="${tab === 'alc' ? 'on' : ''}" onclick="kv.svcTab('alc')">À La Carte${nAlc ? ` <i>${nAlc}</i>` : ''}</button></div>`;
  return `${isLand() || onlyOne ? '' : tabs}
    ${tab === 'pkg' ? `<section class="sec"><div class="sec-h"><i style="background:#1d3250"></i><h2>${isLand() ? 'Land Media Packages' : isCustom() ? esc(PAGE().title) + ' Packages' : 'Listing Media Packages'}</h2></div>
      ${S.pkg ? `<p class="pkg-note">${esc(svc(S.pkg).name)} selected. Tap it again to choose a different package.</p>` : ''}<div class="pkgs">${pk}</div>
      </section>
    ${SHOW_UPSELLS && ups ? `<section class="sec">${ups}</section>` : ''}`
    : `<section class="sec"><div class="sec-h"><i style="background:#1f3c66"></i><h2>À La Carte Services</h2></div>
      <p class="d">${S.pkg ? `Add services to your ${esc(svc(S.pkg).name)} package, or book any service on its own.` : 'Need just one thing? Book any service on its own.'} A basic floor plan is included with every photo shoot.</p>
      <div class="list">${alacarte().map(row).join('')}</div>
      ${onlyOne ? '' : `<p class="svc-switch"><a href="javascript:kv.svcTab('pkg')">← Back to packages</a></p>`}</section>`}
    ${large}
    ${inline ? '' : `<div class="nav"><button class="btn o" onclick="kv.go(0)">Back</button><button class="btn" onclick="kv.go(2)" ${inCart().size ? '' : 'disabled'}>Continue to schedule</button></div>`}`;
}
// ===== Land: attach a tax map / plat / survey to the order (private storage; shows on the order in HQ) =====
const UP = { busy: 0, err: '' };
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
function vUpload() {
  const fs = S.addr.files || [];
  return `<div class="full upl"><label>Tax map or plat <span class="upl-opt">(optional)</span></label>
    <p class="upl-d">Attach the tax record map, plat or survey that shows which lot it is.</p>
    ${fs.map((f, i) => `<div class="upl-f"><span>📎 ${esc(f.name)}</span><small>${fmtSize(f.size || 0)}</small><button type="button" onclick="kv.rmFile(${i})" aria-label="Remove ${esc(f.name)}">&times;</button></div>`).join('')}
    ${UP.busy ? `<div class="upl-f busy"><span class="spin"></span><span>Uploading…</span></div>` : ''}
    ${fs.length < 5 ? `<label class="upl-btn"><input type="file" accept=".pdf,image/*" multiple onchange="kv.upFiles(this)">+ Attach a file</label><small class="upl-h">PDF or photo, up to 15 MB</small>` : ''}
    ${UP.err ? `<div class="msg err">${esc(UP.err)}</div>` : ''}</div>`;
}
async function upFiles(input) {
  const list = [...(input.files || [])].slice(0, 5 - (S.addr.files || []).length); input.value = '';
  UP.err = '';
  for (const file of list) {
    if (file.size > 15 * 1048576) { UP.err = `${file.name} is over 15 MB.`; continue; }
    if (!/^(application\/pdf|image\/)/.test(file.type || '') && !/\.(pdf|jpe?g|png|heic|heif|webp|gif)$/i.test(file.name)) { UP.err = `${file.name}: please attach a PDF or a photo.`; continue; }
    UP.busy++; render();
    const id = crypto.randomUUID?.() || ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ Math.random() * 16 >> c / 4).toString(16));
    const name = file.name.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(-100) || 'file';
    const path = `land/${id}/${name}`;
    const { error } = await sb.storage.from('order-files').upload(path, file, { contentType: file.type || undefined, upsert: false });
    UP.busy--;
    if (error) UP.err = `Couldn't upload ${file.name}. Please try again.`;
    else (S.addr.files = S.addr.files || []).push({ path, name: file.name, size: file.size, type: file.type });
    render();
  }
}
function rmFile(i) { S.addr.files.splice(i, 1); render(); }
// What the order sends for the address: land orders label the Parcel ID; only land orders send files
const addrOut = () => ({ ...S.addr, unit: isLand() && S.addr.unit ? `Parcel ID ${S.addr.unit}` : S.addr.unit, files: isLand() ? (S.addr.files || []) : [] });
function field(key, label, obj, opt = {}) {
  const v = S[obj][key] || '', req = opt.req !== false, err = S.errors[key] ? 'err' : '';
  const a = `data-o="${obj}" data-k="${key}"`;
  const inp = opt.options
    ? `<select ${a}><option value="">${opt.ph || 'Select…'}</option>${opt.options.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    : opt.area ? `<textarea rows="3" ${a} placeholder="${esc(opt.ph || '')}">${esc(v)}</textarea>`
    : `<input ${a} value="${esc(v)}" placeholder="${esc(opt.ph || '')}" ${opt.type ? `type="${opt.type}"` : ''} ${opt.ac ? `autocomplete="${opt.ac}"` : ''} ${opt.im ? `inputmode="${opt.im}"` : ''}>`;
  return `<div class="${opt.full ? 'full' : ''} ${opt.pair ? 'pair' : ''} ${err}"><label>${label}${req ? ' <em>*</em>' : ''}</label>${inp}</div>`;
}
function vProperty() {
  const st = S.config.settings;
  const bySize = (st.sqft_options || []).find(o => o.label === S.addr.sqftLabel);
  const big = largeEnabled() && bySize && (bySize.max === null || bySize.max >= st.large_sqft);
  return `<section class="sec"><div class="sec-h"><i style="background:#1d3250"></i><h2>Property</h2></div>
    <p class="d">Where are we shooting?</p>
    <div class="panel"><div class="fg pairs">
      ${field('street', 'Street address', 'addr', { full: true, ph: '123 Mountain View Dr', ac: 'address-line1' })}
      ${field('unit', 'Unit / Lot', 'addr', { req: false, ph: 'Optional', ac: 'address-line2' })}
      ${field('city', 'City', 'addr', { ph: 'Knoxville', ac: 'address-level2' })}
      ${field('state', 'State', 'addr', { pair: true, options: ['TN', 'NC', 'GA', 'KY', 'VA'] })}
      ${field('zip', 'ZIP', 'addr', { pair: true, ph: '37902', im: 'numeric', ac: 'postal-code' })}
      ${field('sqftLabel', 'Select your square footage', 'addr', { full: true, options: (st.sqft_options || []).map(o => o.label) })}
      ${field('occupancy', 'Occupancy', 'addr', { req: false, options: ['Vacant', 'Owner occupied', 'Tenant occupied'], ph: 'Select (optional)' })}
      ${field('access', 'Access notes', 'addr', { full: true, req: false, area: true, ph: 'Lockbox code, gate code, pets, who will be there…' })}
    </div>
    ${largeEnabled() && !big ? `<label class="check"><input type="checkbox" ${S.adu ? 'checked' : ''} onchange="kv.toggleAdu()"> This property has an ADU, guest house or extra structure (+${money(largeFeeShown())})</label>` : ''}
    </div></section>
    <div class="nav"><span></span><button class="btn" onclick="kv.go(1)">Continue to services</button></div>`;
}
// ---- Schedule: three suggested times, plus a full two-week calendar on request ----
const dAdd = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dSun = d => dAdd(d, -new Date(d + 'T12:00:00Z').getUTCDay());
const calFirst = () => { const ds = S.slots?.days || []; return dSun((ds.find(d => d.times.length) || ds[0]).date); }; // the week of the first opening
const dFmt = (d, o) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
const slotHour = t => { const m = String(t.label).match(/(\d+):\d+\s*(AM|PM)/i); if (!m) return 9; let h = +m[1] % 12; if (/pm/i.test(m[2])) h += 12; return h; };
function suggestSlots(days) { // soonest, the next open day, and one about a week out — spread across different days
  const open = days.filter(d => d.times.length); if (!open.length) return [];
  const out = [{ d: open[0], t: open[0].times[0] }];
  if (open[1]) out.push({ d: open[1], t: open[1].times[Math.floor(open[1].times.length / 2)] });
  const later = open.find(d => d.date >= dAdd(open[0].date, 5) && !out.some(p => p.d === d)) || open.find(d => !out.some(p => p.d === d));
  if (later) out.push({ d: later, t: later.times[Math.min(1, later.times.length - 1)] });
  return out;
}
function relDay(date) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: S.slots?.tz || 'America/New_York' });
  const n = Math.round((Date.parse(date) - Date.parse(today)) / 864e5);
  return n <= 0 ? 'Today' : n === 1 ? 'Tomorrow' : n < 7 ? `In ${n} days` : n < 14 ? 'Next week' : `In ${Math.round(n / 7)} weeks`;
}
function calEnsure() { // make sure the visible two weeks are loaded
  const days = S.slots?.days || []; if (!days.length || S.slotsLoading) return;
  const last = days[days.length - 1].date, end = dAdd(S.calFrom || calFirst(), 13);
  if (end > last) loadSlots(last, true);
}
function vSchedule(inline) {
  if (!S.slots) return `<div class="panel loading"><span class="spin"></span> Checking the calendar…</div>${S.error ? `<div class="msg err">${esc(S.error)}</div>` : ''}`;
  const days = S.slots.days, sel = S.start ? new Date(S.start) : null;
  const mins = Math.round(S.slots.minutes / 15) * 15, dur = mins >= 60 ? `${Math.floor(mins / 60)} hr${mins % 60 ? ` ${mins % 60} min` : ''}` : `${mins} min`;
  const sugg = suggestSlots(days);
  const cards = sugg.length ? `<div class="sg-row">${sugg.map(({ d, t }) => `
      <button class="sg ${S.start === t.start ? 'sel' : ''}" onclick="kv.pickSugg('${d.date}','${t.start}','${esc(t.label)}')">
        <span class="sg-h">${relDay(d.date)}</span>
        <span class="sg-b"><b>${dFmt(d.date, { month: 'short', day: 'numeric' })}</b><small>${dFmt(d.date, { weekday: 'long' })}</small><small>${esc(t.label)}</small></span>
      </button>`).join('')}</div>`
    : `<div class="hint">No open times in the next two weeks. Open the full calendar or call ${esc(CFG.phone)}.</div>`;
  let cal = '';
  if (S.calOpen) {
    const first = calFirst(), start = S.calFrom || first, grid = Array.from({ length: 14 }, (_, i) => dAdd(start, i));
    const byDate = new Map(days.map(d => [d.date, d]));
    const active = S.pickDate && byDate.get(S.pickDate)?.times.length && grid.includes(S.pickDate) ? S.pickDate : grid.find(g => byDate.get(g)?.times.length);
    const day = active && byDate.get(active);
    const groups = day ? [['Morning', h => h < 12], ['Afternoon', h => h >= 12 && h < 17], ['Evening', h => h >= 17]]
      .map(([name, f]) => [name, day.times.filter(t => f(slotHour(t)))]).filter(([, ts]) => ts.length) : [];
    cal = `<div class="cal">
      <div class="cal-nav">
        <button class="link" onclick="kv.calShift(-14)" ${start <= first ? 'disabled' : ''}>‹ Previous 2 weeks</button>
        <b>${dFmt(grid[0], { month: 'short', day: 'numeric' })} – ${dFmt(grid[13], grid[0].slice(5, 7) === grid[13].slice(5, 7) ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}</b>
        <button class="link" onclick="kv.calShift(14)" ${S.slotsLoading ? 'disabled' : ''}>Next 2 weeks ›</button>
      </div>
      <div class="cal-grid">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(w => `<span class="cal-w">${w}</span>`).join('')}
        ${grid.map(g => { const ok = byDate.get(g)?.times.length; return `<button class="cal-d ${g === active ? 'sel' : ''}" ${ok ? '' : 'disabled'} onclick="S_pickDate('${g}')" aria-label="${dFmt(g, { weekday: 'long', month: 'long', day: 'numeric' })}${ok ? '' : ', no openings'}">${+g.slice(8)}</button>`; }).join('')}</div>
      ${S.slotsLoading ? '<div class="hint" style="margin-top:12px"><span class="spin"></span> Loading more dates…</div>' : ''}
      ${day ? `<p class="cal-t">${dFmt(active, { month: 'long', day: 'numeric' })} · available times (ET)</p>
        ${groups.map(([name, ts]) => `<div class="cal-g"><small>${name}</small><div class="pills">${ts.map(t => `<button class="pill ${S.start === t.start ? 'sel' : ''}" onclick="kv.pickSlot('${t.start}','${esc(t.label)}')">${esc(t.label)}</button>`).join('')}</div></div>`).join('')}`
        : !S.slotsLoading ? '<div class="hint" style="margin-top:12px">No open times these two weeks. Try the next two weeks.</div>' : ''}
    </div>`;
  }
  return `<section class="sec">${inline ? '' : '<div class="sec-h"><i style="background:#1d3250"></i><h2>Schedule</h2></div>'}
    <p class="d">Estimated time on site: <b>${dur}</b>.</p>
    <div class="panel">
      <p class="sg-q">Will any of these times work for you?</p>
      ${cards}
      <button class="cal-toggle" onclick="kv.calToggle()" aria-expanded="${!!S.calOpen}">${S.calOpen ? 'Hide full calendar ▴' : 'Show full calendar ▾'}</button>
      ${cal}
      ${sel ? `<div class="callout"><span>✓ ${sel.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at ${esc(S.startLabel)}</span></div>` : ''}
      ${(svc(S.pkg)?.name === 'Luxury' || [...S.items].some(id => /twilight photos/i.test(svc(id)?.name || ''))) ? '<div class="hint" style="margin-top:10px">Twilight photos are captured at sunset. We\'ll confirm the twilight time with you.</div>' : ''}
    </div></section>
    ${inline ? '' : `<div class="nav"><button class="btn o" onclick="kv.go(1)">Back</button><button class="btn" onclick="kv.go(3)" ${S.start ? '' : 'disabled'}>Continue to review</button></div>`}`;
}
window.S_pickDate = d => { S.pickDate = d; render(); };

function vReview(inline) {
  const a = S.addr, when = S.start ? new Date(S.start).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + S.startLabel : '';
  const locked = !!S.checkout;
  const payLabels = { save_card: ['Save card now, charge on delivery', 'Your card is charged when your media is delivered.'], pay_now: ['Pay in full now', ''] };
  return `<section class="sec"><div class="sec-h"><i style="background:#1d3250"></i><h2>Your details</h2></div>
    ${S.session ? `<p class="d">Signed in as ${esc(S.session.user.email)}.</p>` : `<p class="d">Booked with us before? <a href="#account">Sign in</a> to see all your orders in one place.</p>`}
    <div class="panel"><fieldset ${locked ? 'disabled' : ''} style="border:0;padding:0;margin:0"><div class="fg">
      ${field('first', 'First name', 'contact', { ac: 'given-name' })}
      ${field('last', 'Last name', 'contact', { ac: 'family-name' })}
      ${field('email', 'Email', 'contact', { type: 'email', ac: 'email' })}
      ${field('phone', 'Mobile', 'contact', { type: 'tel', ac: 'tel', im: 'tel' })}
      ${field('brokerage', 'Brokerage', 'contact', { req: false, full: true, ac: 'organization' })}
      ${field('notes', 'Notes for the photographer', 'contact', { req: false, full: true, area: true })}
    </div></fieldset></div></section>
    <section class="sec"><div class="sec-h"><i style="background:#1d3250"></i><h2>Review &amp; pay</h2></div>
    <div class="panel review"><dl style="margin:0">
      <dt>Property</dt><dd>${esc(a.street)}${a.unit ? ', ' + esc(a.unit) : ''}, ${esc(a.city)}, ${esc(a.state)} ${esc(a.zip)}<br><span class="hint">${esc(a.sqftLabel)}${a.occupancy ? ' · ' + esc(a.occupancy) : ''}</span></dd>
      <dt>Appointment</dt><dd>${esc(when)}</dd>
      <dt>Services</dt><dd>${lines().map(l => esc(l.name)).join(', ')}</dd>
      ${couponOff() ? `<dt>Coupon</dt><dd><span class="cr-txt">${esc(S.cp.applied.code)} · −${money2(couponOff())}</span></dd>` : ''}
      <dt>Total</dt><dd><b style="color:var(--primary)">${money2(total())}</b></dd>
    </dl>
    ${locked ? '' : vCoupon()}
    ${myCredit() && !locked ? `<label class="cr-box" style="margin-top:14px"><input type="checkbox" ${S.useCredit ? 'checked' : ''} onchange="kv.useCredit(this.checked)">
      <span><b>Use my account credit</b><small>You have ${money2(myCredit())} available.${S.useCredit ? ` ${money2(Math.min(myCredit(), total()))} comes off this order, so ${Math.max(0, total() - myCredit()) > 0 ? `you pay ${money2(Math.max(0, total() - myCredit()))}` : "there's nothing left to pay"}.` : ''}</small></span></label>` : ''}
    ${locked ? `<div class="pay"><b style="color:var(--primary)">Pay now · ${money(S.checkout.booking.total)}</b><div id="pay-el"></div></div>` : ''}
    </div></section>
    <div id="revErr">${S.error ? `<div class="msg err">${esc(S.error)}</div>` : ''}</div>
    <div class="nav" id="revNav">
      ${locked
        ? `<button class="btn o" onclick="kv.cancelPay()" ${S.busy ? 'disabled' : ''}>Back</button>
           <button class="btn" onclick="kv.confirmPay()" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Pay ' + money(S.checkout.booking.total) + ' &amp; Submit Order'}</button>`
        : `${inline ? '<span></span>' : `<button class="btn o" onclick="kv.go(2)" ${S.busy ? 'disabled' : ''}>Back</button>`}
           <div class="submit-opts">
             <div class="submit-main"><button class="btn" onclick="kv.submitOrder()" ${S.busy ? 'disabled' : ''}>${S.busy && S.payOpt === 'pay_later' ? '<span class="spin"></span>' : 'Submit Order'}</button>
               <small>Payment upon delivery</small></div>
             ${total() > 0 ? `<button class="btn o" onclick="kv.startCheckout()" ${S.busy ? 'disabled' : ''}>${S.busy && S.payOpt === 'pay_now' ? '<span class="spin"></span>' : 'Pay Now and Submit Order'}</button>` : ''}
           </div>`}
    </div>
    <p class="terms-note">By submitting an order, you agree to our <a href="javascript:kv.showTerms()">Terms &amp; Conditions</a>.</p>`;
}
function vDone() {
  const d = S.done || {};
  const when = d.start ? new Date(d.start).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const ok = ['scheduled'].includes(d.status);
  return `<div class="panel done-box"><div class="big" style="${ok ? '' : 'background:#c08a1e'}">${CHECK}</div>
    <h2 style="font-size:28px">${ok ? "You're booked" : 'Almost done'}</h2>
    <p>${ok ? `Order ${esc(ono(d))} · ${esc(when)}` : 'We received your order but the payment is still processing. We\'ll confirm by email.'}</p>
    <p class="hint">${d.creditUsed ? `${money2(d.creditUsed)} of your account credit was used. ` : ''}${d.paymentStatus === 'paid' ? 'Paid in full. ' : d.paymentStatus === 'card_saved' ? 'Your card is saved and will be charged when your media is delivered. ' : 'Payment is due when your media is delivered. '}A confirmation is on its way.</p>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px">
      <a class="btn" href="#listings" style="text-decoration:none">View my listings</a>
      <button class="btn o" onclick="location.href='/'">Book another</button></div></div>`;
}
function vLogin() {
  const p = LP(), sms = p.method === 'sms', signup = p.mode === 'signup';
  const err = S.error ? `<div class="msg err">${esc(S.error)}</div>` : '';
  const spin = '<span class="spin"></span>';
  const toggle = `<div class="seg" role="tablist" aria-label="Sign in with">
      <button type="button" role="tab" aria-selected="${!sms}" class="${sms ? '' : 'on'}" onclick="kv.setMethod('email')">Email</button>
      <button type="button" role="tab" aria-selected="${sms}" class="${sms ? 'on' : ''}" onclick="kv.setMethod('sms')">Phone number</button></div>`;
  if (p.stage === 'code') return `
      <p class="d" style="margin:6px 0 16px">We ${sms ? 'texted' : 'emailed'} a code to <b>${esc(p.to)}</b>. It expires in ${p.expiresMin >= 60 ? '1 hour' : p.expiresMin + ' minutes'}.</p>
      <form onsubmit="kv.verifyCode(event)"><label>Sign-in code</label>
      <input id="loginCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" style="font-size:22px;letter-spacing:6px;text-align:center">
      ${err}
      <button class="btn" style="width:100%;margin-top:14px" ${S.busy ? 'disabled' : ''}>${S.busy ? spin : 'Sign in'}</button></form>
      <p class="hint" style="margin-top:14px"><a href="javascript:kv.sendCode()">Send a new code</a>
        ${signup ? '' : `· <a href="javascript:kv.setMethod('${sms ? 'email' : 'sms'}')">${sms ? 'Use email instead' : 'Use phone number instead'}</a>`}
        · <a href="javascript:kv.loginBack()">${signup ? 'Edit my details' : `Change ${sms ? 'number' : 'email'}`}</a></p>`;
  if (signup) {
    const f = (k, label, attrs) => `<label for="su_${k}" style="margin-top:12px">${label}</label><input id="su_${k}" value="${esc(p.su[k])}" ${attrs}>`;
    return `
      <p class="d" style="margin:6px 0 4px">Enter your details to get started.</p>
      <form onsubmit="kv.signUp(event)" novalidate>
      <div class="su-row"><div>${f('first', 'First name', 'autocomplete="given-name" required')}</div><div>${f('last', 'Last name', 'autocomplete="family-name" required')}</div></div>
      ${f('phone', 'Mobile number', 'type="tel" inputmode="tel" autocomplete="tel-national" required placeholder="(865) 555-1234" oninput="this.value=kv.fmtPhone(this.value)"')}
      ${f('email', 'Email', 'type="email" autocomplete="email" required placeholder="you@brokerage.com"')}
      ${f('company', 'Brokerage / team <span style="text-transform:none;font-weight:400;color:var(--slate)">(optional)</span>', 'autocomplete="organization" placeholder="Brokerage / team"')}
      <p class="hint" style="margin:8px 0 0">We'll email you a code to confirm it's you. After that you can sign in with your email or mobile number. No password needed.</p>
      ${err}
      <button class="btn" style="width:100%;margin-top:14px" ${S.busy ? 'disabled' : ''}>${S.busy ? spin : 'Create account'}</button></form>
      <p class="hint" style="margin-top:16px;text-align:center">Already have an account? <a href="javascript:kv.setMode('signin')"><b>Sign in</b></a></p>`;
  }
  return `
      <p class="d" style="margin:6px 0 14px">Get a one-time code to sign in. No password needed.</p>
      ${toggle}
      <form onsubmit="kv.signIn(event)">
      ${sms
        ? `<label for="loginId">Mobile number</label><input id="loginId" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(865) 555-1234" value="${esc(p.phone)}" oninput="this.value=kv.fmtPhone(this.value)">
           <p class="hint" style="margin:6px 0 0">Use the mobile number on file with us. We'll text your code to it.</p>`
        : `<label for="loginId">Email</label><input id="loginId" type="email" autocomplete="email" placeholder="you@brokerage.com" value="${esc(p.email)}">
           <p class="hint" style="margin:6px 0 0">Use the email you book with. We'll email your code to it.</p>`}
      ${err}
      <button class="btn" style="width:100%;margin-top:14px" ${S.busy ? 'disabled' : ''}>${S.busy ? spin : sms ? 'Text me a code' : 'Email me a code'}</button></form>
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e3e8ef;text-align:center">
        <p class="hint" style="margin:0 0 10px">New to Knox View? Create an account to book and track your orders.</p>
        <button type="button" class="btn o" style="width:100%" onclick="kv.setMode('signup')">Create an account</button></div>`;
}
// ---- Landing: the first page of book.knoxview.com for anyone not signed in ----
// A "See pricing" | "Client sign in" toggle. See pricing takes the address (Google) and home size, then jumps to the packages.
const SMS_LINK = 'sms:+18658555669';
const IC_PHONE = '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>';
const IC_MAIL = '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><path d="M3 6l9 7 9-7"/>';
const IC_IN = '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>';
const IC_CHAT = '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.9-.9L3 20.5l1.5-4.6a8.4 8.4 0 0 1-1-4.4A8.5 8.5 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>';
const IC_PIN = '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>';
const IC_OK = '<circle cx="12" cy="12" r="9.5"/><path d="M8 12.5l2.7 2.7L16.5 9"/>';
const IC_ARROW = '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>';
const svg = (d, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
function ldKind(v) { // what's typed in the sign-in field: 'email', 'sms' (10-digit phone) or null
  v = String(v || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';
  if (!/[a-z@]/i.test(v) && v.replace(/\D/g, '').replace(/^1(?=\d{10})/, '').length === 10) return 'sms';
  return null;
}
function ldCheck(el) {
  LP().ident = el.value; const b = $('ldGo'); if (b) b.disabled = !ldKind(el.value);
  if (S.error) { S.error = ''; const e = $('ldErr'); if (e) e.innerHTML = ''; }
}
function ldSend(prefer) { // "Continue" (no prefer) or "Login via SMS" / "Login via Email"
  const p = LP(), v = ($('loginId')?.value || '').trim(), kind = ldKind(v);
  p.ident = v;
  if (prefer && kind !== prefer) { // empty, or the wrong kind for the button they tapped: ask for the right one
    p.method = prefer; p.ident = '';
    S.error = prefer === 'sms' ? "Enter your mobile number and we'll text you a code." : "Enter your email and we'll email you a code.";
    render(); setTimeout(() => $('loginId')?.focus(), 30); return;
  }
  if (!kind) { S.error = v ? 'Enter a valid email or 10-digit mobile number.' : 'Enter your email or mobile number.'; render(); return; }
  p.method = kind; p[kind === 'sms' ? 'phone' : 'email'] = v;
  return signIn();
}
function ltab(t) { if (t !== 'signin') { location.hash = '#order'; return; } S.ltab = 'signin'; S.error = ''; render(); setTimeout(() => $(S.ltab === 'signin' ? 'loginId' : 'lpStreet')?.focus(), 30); }
function lsize(label) { S.addr.sqftLabel = label; resetSchedule(); S.error = ''; render(); }
function locc(v) { S.addr.occupancy = v; S.error = ''; render(); }
function ldPricing() { // "View pricing": straight to the packages (Services step)
  const a = S.addr; a.street = ($('lpStreet')?.value ?? a.street ?? '').trim();
  ['city', 'zip'].forEach(k => { const el = $('lp_' + k); if (el) a[k] = el.value.trim(); });
  if (!a.state) a.state = 'TN';
  const err = !a.street ? 'Enter the listing address.' : !a.city || !/^\d{5}$/.test(a.zip || '') ? 'Add the city and 5-digit ZIP for this address.'
    : !a.sqftLabel ? 'Pick the home size.' : !a.occupancy ? 'Let us know if the property is vacant or occupied.' : '';
  if (err) { S.error = err; render(); return; }
  S.error = ''; S.errors = {}; S.view = 'book'; history.pushState(null, '', '#order');
  S.step = 1; render(); window.scrollTo({ top: 0 });
}
function vLandingSignin() {
  const p = LP();
  if (p.stage === 'code' || p.mode === 'signup') {
    const h = p.stage === 'code' ? `Check your ${p.method === 'sms' ? 'phone' : 'email'}` : 'Create your account';
    return `<h2 class="ld-h">${h}</h2>${vLogin()}`;
  }
  const ph = p.method === 'sms' && !p.ident && S.error ? 'Mobile number' : p.method === 'email' && !p.ident && S.error ? 'Email' : 'Email or phone';
  return `<form onsubmit="event.preventDefault();kv.ldSend()" novalidate>
      <label for="loginId" class="ld-lbl">Email or phone number</label>
      <input id="loginId" class="ld-in" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="${ph}" value="${esc(p.ident || '')}" oninput="kv.ldCheck(this)">
      <div id="ldErr">${S.error ? `<div class="msg err">${esc(S.error)}</div>` : ''}</div>
      <button id="ldGo" class="lp-go" ${S.busy || !ldKind(p.ident) ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : `Continue ${svg(IC_ARROW)}`}</button>
    </form>
    <div class="ld-or"><span>Or get a one-time code</span></div>
    <div class="ld-otp">
      <button type="button" onclick="kv.ldSend('sms')" ${S.busy ? 'disabled' : ''}>${svg(IC_PHONE)} Text me</button>
      <button type="button" onclick="kv.ldSend('email')" ${S.busy ? 'disabled' : ''}>${svg(IC_MAIL)} Email me</button>
    </div>
    <p class="ld-alt">Don't have an account? <a href="javascript:kv.setMode('signup')">Create an account</a></p>`;
}
function lpAddr(el) { const v = (el?.value || '').trim(); if (v !== (S.addr.street || '')) S.addr.street = v; if (v.length >= 5 || !v) render(); }
function vLandingPrice() {
  const a = S.addr, opts = S.config.settings.sqft_options || [];
  const done = a.street && a.city && a.zip, hasAddr = (a.street || '').trim().length >= 5;
  const line = [a.street + (a.unit ? ` #${a.unit}` : ''), a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const sel = (id, ph, list, val, fn) => `<div class="lp-sel"><select id="${id}" onchange="kv.${fn}(this.value)" aria-label="${ph}">
      <option value="">${ph}</option>${list.map(o => `<option ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
  let n = 1;
  return `<div class="lp-q"><span class="lp-n">${n++}</span> Listing address</div>
    <label class="lp-addr ${done ? 'ok' : ''}">${svg(IC_PIN, 22)}<input id="lpStreet" data-o="addr" data-k="street" placeholder="Start typing the address" value="${esc(a.street || '')}" autocomplete="off" aria-label="Listing address" onchange="kv.lpAddr(this)"></label>
    ${done ? `<p class="lp-picked">${svg(IC_OK, 17)} ${esc(line)}</p>`
      : hasAddr ? `<div class="lp-row"><input id="lp_city" data-o="addr" data-k="city" placeholder="City" value="${esc(a.city || '')}" autocomplete="address-level2"><input id="lp_zip" data-o="addr" data-k="zip" placeholder="ZIP" inputmode="numeric" maxlength="5" value="${esc(a.zip || '')}" autocomplete="postal-code"></div>
        <p class="lp-hint">Didn't see it in the list? Add the city and ZIP.</p>`
      : `<p class="lp-hint">Pick the address from the list and we'll fill in the rest.</p>`}
    ${hasAddr ? `<div class="lp-q"><span class="lp-n">${n++}</span> Home size</div>
      ${sel('lpSize', 'Select home size', opts.map(o => o.label), a.sqftLabel, 'lsize')}
      <p class="lp-hint">Heated square feet. A close guess is fine.</p>` : ''}
    ${hasAddr && a.sqftLabel ? `<div class="lp-q"><span class="lp-n">${n++}</span> Is the property vacant?</div>
      ${sel('lpOcc', 'Select occupancy', ['Vacant', 'Owner occupied', 'Tenant occupied'], a.occupancy, 'locc')}` : ''}
    ${S.error ? `<div class="msg err">${esc(S.error)}</div>` : ''}
    ${hasAddr && a.sqftLabel ? `<button class="lp-go" onclick="kv.ldPricing()" ${a.occupancy ? '' : 'disabled'}>View pricing ${svg(IC_ARROW, 18)}</button>` : ''}`;
}
function vLanding() {
  const tab = 'signin';
  return `<div class="lp">
    <div class="lp-main">
      <header class="lp-top"><div class="lp-in lp-bar">
        <a class="lp-logo" href="https://www.knoxview.com" target="_blank" rel="noopener" aria-label="Knox View Real Estate Media"></a>
        <div class="lp-actions">
          <a class="lp-signin" href="#order">Book now</a>
          <a class="lp-text" href="${SMS_LINK}">${svg(IC_CHAT, 16)} Text us</a>
        </div>
      </div></header>
      <div class="lp-in">
        <section class="lp-hero">
          <h1>${tab === 'price' ? 'Let’s make your listing <em>shine.</em>' : 'Client <em>login.</em>'}</h1>
          ${tab === 'price' ? '<p>Enter the address and home size to see <b>your exact price</b>.</p>' : ''}
        </section>
        <div class="lp-card">
          <div class="lp-body">${tab === 'price' ? vLandingPrice() : vLandingSignin()}</div>
        </div>
        ${tab === 'price' ? '' : `<a class="lp-go lp-book" href="#order">Book a shoot ${svg(IC_ARROW)}</a>`}
        <p class="lp-foot">Questions? Call or text <a href="tel:+18658555669">865-855-5669</a><br><a class="lp-terms" href="javascript:kv.showTerms()">Terms &amp; Conditions</a></p>
      </div>
    </div>
    <aside class="lp-photo"><div class="lp-cap"><a class="lp-photo-book" href="#order">Book a shoot ${svg(IC_ARROW)}</a><b>Knox View Real Estate Media</b><span>Photo · Video · Drone · 3D tours<br>Knoxville &amp; the Smokies</span></div></aside>
  </div>`;
}
function vAccount() { return vLanding(); }


/* ================= client portal (signed in) ================= */
const ic = (p, s = 18) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.5L21.5 7H6"/>',
  home: '<path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z"/>',
  inv: '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  vid: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="M16 10l6-3.5v11L16 14z"/>',
  eye: '<path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/>',
  cal: '<rect x="3" y="4.5" width="18" height="17" rx="2"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.5"/>',
  cards: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  again: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  filter: '<path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/>',
  xc: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  none: '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M3 3l18 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
};
const UI = (S.ui = { lview: 'cards', sort: 'new', q: '', itab: 'pending', iq: '', menu: false });
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' }) : '';
const fmtShort = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const initials = n => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const PORTAL_VIEWS = ['listings', 'invoices', 'profile', 'delivery'];

function listingsAll() {
  const d = S.pdata; if (!d || !d.agent) return [];
  const st = (media, b) => {
    const any = media.some(m => m.delivered);
    if (b?.locked || b?.hasDelivery || any) return ['Delivered', 'g'];
    if (!b) return ['In progress', 'c'];
    if (b.status === 'completed' || (b.status === 'scheduled' && new Date(b.shoot_start) <= new Date())) return ['Completed', 'c'];
    if (b.status === 'scheduled') return ['Scheduled', 'y'];
    return ['Pending', 'y'];
  };
  const out = (d.bookings || []).map(b => ({
    // media title (set in HQ) names the listing; otherwise the address
    key: b.id, line1: (b.media_title || '').trim() || b.address + (b.unit ? ', ' + b.unit : ''),
    line2: [(b.media_title || '').trim() ? b.address + (b.unit ? ', ' + b.unit : '') : '', b.city, [b.state, b.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    date: b.shoot_start, status: st(b.media || [], b), cover: b.cover_url, media: b.media || [], b,
  }));
  for (const l of d.listings || []) out.push({ key: l.id, line1: l.address || 'Listing', line2: l.city || '', date: l.date, status: st(l.media, null), cover: null, media: l.media });
  const q = UI.q.trim().toLowerCase();
  const list = q ? out.filter(x => `${x.line1} ${x.line2} ${x.b ? ono(x.b) : ''}`.toLowerCase().includes(q)) : out;
  const t = x => Date.parse(x.date || 0) || 0;
  return list.sort(UI.sort === 'old' ? (a, b) => t(a) - t(b) : UI.sort === 'addr' ? (a, b) => a.line1.localeCompare(b.line1, 'en', { numeric: true }) : (a, b) => t(b) - t(a));
}
const findListing = key => listingsAll().find(x => x.key === key) || (UI.q = '', listingsAll().find(x => x.key === key));
const linkOf = (l, kind) => l.media.find(m => kind === 'photo' ? m.dropbox : m.vimeo);

function acts(l) {
  const ph = linkOf(l, 'photo'), vd = linkOf(l, 'video');
  const b = (fn, icon, title, lbl) => `<button class="act" onclick="${fn}" title="${title}" aria-label="${title}">${ic(icon)}<span class="al">${lbl}</span></button>`;
  const dl = `#delivery/${l.key}`, has = l.media.some(m => m.delivered) || l.b?.hasDelivery;
  const go = (tab, icon, title, on) => on ? `<a class="act" href="${dl}/${tab}" title="${title}" aria-label="${title}">${ic(icon)}<span class="al">${title}</span></a>` : `<span class="act off" title="${title} · not ready yet">${ic(icon)}<span class="al">${title}</span></span>`;
  return [go('photos', I.dl, 'Photos', !!ph || (has && l.media.some(m => m.media === 'photo'))),
    `<a class="act" href="${dl}" title="Media & delivery" aria-label="Media & delivery">${ic(I.eye)}<span class="al">All media</span></a>`,
    l.b?.site_slug && l.b.websites_enabled !== false ? b(`kv.siteEdit('${l.b.id}')`, I.globe2, 'Property website: edit it and copy the links', 'Website') : '',
    l.b && l.b.invoice !== false ? b(`kv.invoiceFor(${l.b.number})`, I.inv, 'Order details, invoice and appointment', 'Order') : '',
    l.b ? b(`kv.resched(${l.b.number})`, I.cal, 'Reschedule this shoot', 'Reschedule') : b(`kv.orderAgain('${l.key}')`, I.again, 'Book this address again', 'Rebook'),
    l.b ? `<button class="act act-x" onclick="kv.cancelAppt(${l.b.number})" title="Cancel appointment" aria-label="Cancel appointment">${ic(I.xc)}<span class="al">Cancel</span></button>` : ''].join('');
}
function cover(l) {
  return l.cover ? `<img src="${esc(l.cover)}" alt="" loading="lazy">`
    : `<div class="ph">${ic(I.home, 34)}<b>Knox View</b><small>Real Estate Media</small></div>`;
}
function vListings() {
  const all = listingsAll();
  const tools = `<div class="ptools">
    <div class="tabs"><button class="${UI.lview === 'cards' ? 'on' : ''}" onclick="kv.ui('lview','cards')">${ic(I.cards)}Card view</button><button class="${UI.lview === 'table' ? 'on' : ''}" onclick="kv.ui('lview','table')">${ic(I.table)}Table view</button></div>
    <span class="grow"></span>
    <label class="sel-l"><span>Sort by</span><select onchange="kv.ui('sort',this.value)">
      <option value="new" ${UI.sort === 'new' ? 'selected' : ''}>Newest first</option><option value="old" ${UI.sort === 'old' ? 'selected' : ''}>Oldest first</option><option value="addr" ${UI.sort === 'addr' ? 'selected' : ''}>Address</option></select></label>
    <div class="srch">${ic(I.search, 16)}<input id="lq" type="search" placeholder="Search" value="${esc(UI.q)}" oninput="kv.search('q',this.value,'lq')"></div></div>`;
  if (!all.length) return tools + empty(UI.q ? 'No listings match your search.' : 'No listings yet. Book your first shoot and it will show up here.', !UI.q);
  if (UI.lview === 'table') return tools + `<div class="tbl-w"><table class="tbl"><thead><tr><th>Address</th><th>Shoot date</th><th>Status</th><th class="r">Media</th></tr></thead><tbody>
    ${all.map(l => `<tr><td><b>${esc(l.line1)}</b><div class="hint">${esc(l.line2)}</div></td><td>${esc(fmtShort(l.date))}</td>
      <td><span class="pill ${l.status[1]}">${esc(l.status[0])}</span></td><td class="r"><div class="acts">${acts(l)}</div></td></tr>`).join('')}</tbody></table></div>`;
  return tools + `<div class="lgrid">${all.map(l => `<article class="lcard">
    <a class="lcov" href="#delivery/${l.key}" aria-label="Media for ${esc(l.line1)}">${cover(l)}<span class="lstat ${l.status[1]}">${esc(l.status[0])}</span></a>
    <div class="lbody"><div class="laddr">${esc(l.line1)}<br><span>${esc(l.line2)}</span></div>
      <div class="lmeta2"><span>${ic(I.cal)}${esc(fmtDate(l.date))}</span>${l.b && upcomingShoot(l.b) ? `<button class="btn o sm addcal" onclick="kv.addCal(${l.b.number}, this)">${ic(I.cal, 15)} Add to my calendar</button>` : ''}</div>
      ${l.b && ZS.by[l.b.id]?.last ? vZillowLine(l.b.id) : ''}
      ${l.b?.locked ? `<button class="btn" style="width:100%;margin-top:10px" onclick="kv.payBooking('${l.b.id}')">${ic(I.lock, 15)} Pay to download</button>` : ''}
      <div class="acts">${acts(l)}</div></div></article>`).join('')}</div>`;
}
function empty(text, cta) {
  return `<div class="empty-st">${ic(I.none, 64)}<p>${esc(text)}</p>${cta ? '<a class="btn" href="#order" style="text-decoration:none">Order now</a>' : ''}</div>`;
}

/* ================= invoices (Spiro-style) =================
   Data comes from the `invoices` function: each order is an invoice. Credits are added in HQ and used up first
   when the client pays. Detail page: #invoices/<number> (media preview, download page, PDF, email). */
const INV = (S.inv = { data: null, loading: false, error: '', range: 'all', pdf: {}, dmedia: {} });
const money2 = n => (n < 0 ? '-' : '') + '$' + Math.abs(+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInv = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const myCredit = () => S.session ? Math.max(0, +(INV.data?.credits || 0)) : 0;
async function loadInvoices(quiet) {
  if (INV.fetching) return; INV.fetching = true;
  if (!quiet) { INV.loading = true; INV.error = ''; render(); }
  try { INV.data = await api('list', {}, 'invoices'); INV.error = ''; INV.pdf = {}; } catch (e) { INV.error = e.message; } // PDFs are rebuilt from live data, so drop cached copies
  INV.loading = false; INV.fetching = false; render();
}
const invAll = () => INV.data?.invoices || [];
const invFind = n => invAll().find(i => String(i.number) === String(n));
function invRows() {
  const all = invAll(), pend = all.filter(i => !i.paid), paid = all.filter(i => i.paid);
  const q = UI.iq.trim().toLowerCase().replace(/^#/, '');
  const since = { '30': 30, '90': 90, 'year': 365 }[INV.range];
  let rows = UI.itab === 'paid' ? paid : pend;
  if (since) rows = rows.filter(i => Date.parse(i.invoice_date) > Date.now() - since * 864e5);
  if (q) rows = rows.filter(i => `${i.number} ${i.order_no || ''} ${i.address} ${i.place} ${i.items.map(x => x.name).join(' ')}`.toLowerCase().includes(q));
  return { pend, paid, rows };
}
function invActs(i) {
  return `<div class="iacts"><a class="iact" href="#invoices/${i.number}" title="View invoice & media" aria-label="View invoice ${esc(ono(i))}">${ic(I.eye)}</a>
    <button class="iact" onclick="kv.invPdf(${i.number},'download')" title="Download PDF" aria-label="Download invoice ${esc(ono(i))} as PDF">${ic(I.dl)}</button>
    <button class="iact" onclick="kv.invEmail(${i.number})" title="Email invoice" aria-label="Email invoice ${esc(ono(i))}">${ic(I.mail)}</button></div>`;
}
function vInvoices() {
  if (UI.inv) return vInvoiceDetail(UI.inv);
  if (!INV.data) return INV.error ? `<div class="msg err">${esc(INV.error)} <a href="javascript:kv.reloadInvoices()">Try again</a></div>` : '<div class="panel loading"><span class="spin"></span> Loading invoices…</div>';
  const { pend, rows } = invRows();
  const bal = pend.reduce((a, i) => a + i.due, 0), cr = +INV.data.credits || 0, total = Math.max(0, bal - cr);
  const tab = (k, icon, label, n) => `<button class="${UI.itab === k ? 'on' : ''}" onclick="kv.ui('itab','${k}')">${ic(icon)}${label}<span class="t-long">&nbsp;invoices</span>${n ? ` <i>${n}</i>` : ''}</button>`;
  const head = `<div class="itools">
    <div class="tabs">${tab('pending', I.inv, 'Pending', pend.length)}${tab('paid', I.table, 'Paid', 0)}</div>
    ${UI.itab === 'pending' ? `<div class="ibal"><div><small>Balance due</small><b>${money2(bal)}</b></div><div><small>Credits</small><b class="${cr ? 'cr' : ''}">${cr ? '-(' + money2(cr) + ')' : money2(0)}</b></div><div><small>Total balance due</small><b>${money2(total)}</b></div></div>
      <button class="btn ipay" ${pend.some(i => i.due > 0) ? '' : 'disabled'} onclick="kv.invPay()">${total > 0 ? 'Pay ' + money2(total) : pend.some(i => i.due > 0) ? 'Pay with credit' : 'Pay'}</button>` : '<span class="grow"></span>'}
    <div class="isrch"><div class="srch">${ic(I.search, 16)}<input id="iq" type="search" placeholder="Search" value="${esc(UI.iq)}" oninput="kv.search('iq',this.value,'iq')"></div>
      <label class="ifilter" title="Filter by date">${ic(I.filter, 18)}<select aria-label="Show invoices from" onchange="kv.invRange(this.value)">
        ${[['all', 'All time'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['year', 'Last 12 months']].map(([v, l]) => `<option value="${v}" ${INV.range === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div></div>
    ${cr && UI.itab === 'pending' ? `<p class="hint ihint">You have ${money2(cr)} in account credit. It's used first when you pay.</p>` : ''}`;
  if (!rows.length) return head + empty(UI.iq || INV.range !== 'all' ? 'No invoices match your search.' : UI.itab === 'paid' ? 'No paid invoices yet.' : "You're all paid up. There are no pending invoices.", false);
  const paidTab = UI.itab === 'paid';
  return head + `<div class="tbl-w"><table class="tbl itbl"><thead><tr><th>Invoice #</th><th>Address</th><th class="r">Invoice total</th><th class="r">Amount due</th><th>Invoice date</th><th>Date due</th>${paidTab ? '<th>Date paid</th>' : ''}<th class="r">Actions</th></tr></thead><tbody>
    ${rows.map(i => `<tr><td class="inum"><a href="#invoices/${i.number}">${esc(ono(i))}</a>${!i.paid && i.payment_status === 'processing' ? ' <span class="pill">Processing</span>' : ''}</td>
      <td class="iaddr"><b>${esc(i.address)}</b><div class="hint">${esc(i.place)}</div></td>
      <td class="r" data-l="Invoice total">${money2(i.total)}</td><td class="r" data-l="Amount due"><b>${money2(i.due)}</b>${i.credit ? `<div class="hint">${money2(i.credit)} credit used</div>` : ''}</td>
      <td data-l="Invoice date">${esc(fmtInv(i.invoice_date))}</td><td data-l="Date due">${esc(fmtInv(i.due_date))}</td>${paidTab ? `<td data-l="Date paid">${esc(fmtInv(i.paid_at))}</td>` : ''}
      <td class="r">${invActs(i)}${!i.paid && i.due > 0 && i.payment_status !== 'processing' ? `<button class="btn sm" onclick="kv.invPay([${i.number}])">Pay ${money2(i.due)}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}
function vInvoiceDetail(n) {
  if (!INV.data) return INV.error ? `<div class="msg err">${esc(INV.error)}</div>` : '<div class="panel loading"><span class="spin"></span> Loading invoice…</div>';
  const i = invFind(n);
  if (!i) return `<a class="dl-back" href="#invoices">‹ Invoices</a><div class="msg err">That invoice wasn't found.</div>`;
  const m = INV.dmedia[i.id];
  if (!m) { INV.dmedia[i.id] = { loading: true }; api('delivery', { key: i.id }).then(d => { INV.dmedia[i.id] = { d }; render(); }).catch(() => { INV.dmedia[i.id] = { err: true }; render(); }); }
  const photos = m?.d?.photos || [], more = Math.max(0, photos.length - 6);
  const grid = !m || m.loading ? '<div class="loading" style="padding:20px 0"><span class="spin"></span> Loading media…</div>'
    : photos.length ? `<div class="igrid">${photos.slice(0, 6).map((p, k) => `<a href="#delivery/${i.id}/photos" class="ig ${k === 5 && more ? 'more' : ''}" aria-label="${k === 5 && more ? `See all ${photos.length} photos` : 'Open photos'}"><img src="${esc(p.thumb)}" alt="" loading="lazy">${k === 5 && more ? `<span>+${more} more<br><small>Tap to see all</small></span>` : ''}</a>`).join('')}</div>`
    : `<p class="hint">${m.d && (m.d.videos.length || m.d.tour) ? 'Your videos and tours are on the download page.' : 'Your photos will show here once your media is delivered.'}</p>`;
  const st = i.paid ? `<span class="pill g">Paid ${esc(fmtShort(i.paid_at))}</span>` : i.payment_status === 'processing' ? '<span class="pill">Payment processing</span>' : `<span class="pill w">Due ${esc(fmtShort(i.due_date))}</span>`;
  const line = (k, v, cls = '') => `<div class="iline ${cls}"><span>${k}</span><span>${v}</span></div>`;
  return `<a class="dl-back" href="#invoices">‹ Invoices</a>
  <div class="idet">
    <div class="idet-main">
      <div class="panel ihead"><div><small>Order</small><h2>${esc(ono(i))}</h2></div>${st}</div>
      ${vApptPanel(i)}
      <div class="panel">
        <div class="iorder"><div><small>Order</small><b>${esc(i.address)}</b><div class="hint">${esc(i.place)}${i.shoot_start ? ' · Shoot ' + esc(fmtShort(i.shoot_start)) : ''}</div></div>
          <a class="btn o sm" href="#delivery/${i.id}">${ic(I.dl, 15)} View download page</a></div>
        ${m?.d?.locked ? `<p class="hint">${ic(I.lock, 14)} Previews are watermarked until this invoice is paid.</p>` : ''}
        ${grid}
      </div>
      <div class="panel"><h3 class="ih3">Services</h3>
        ${i.items.map(x => line(esc(x.name), money2(x.price))).join('')}
        ${i.coupon_code && i.coupon_discount ? line('Coupon ' + esc(i.coupon_code), '-' + money2(Math.min(i.discount, i.coupon_discount))) : ''}${i.discount - (i.coupon_code ? Math.min(i.discount, i.coupon_discount || 0) : 0) > 0 ? line('Discount', '-' + money2(i.discount - (i.coupon_code ? Math.min(i.discount, i.coupon_discount || 0) : 0))) : ''}${i.tax ? line('Tax', money2(i.tax)) : ''}
        ${line('Invoice total', money2(i.total), 'b')}</div>
    </div>
    <aside class="panel iside">
      ${line('Invoice total', money2(i.total))}${i.credit ? line('Credit applied', '-' + money2(i.credit)) : ''}${i.paid ? line('Paid', '-' + money2(Math.max(0, i.total - i.credit))) : ''}
      ${line('Amount due', money2(i.due), 'big')}
      <div class="idates"><div><small>Invoice date</small>${esc(fmtShort(i.invoice_date))}</div><div><small>Due</small>${esc(fmtShort(i.due_date))}</div>${i.paid ? `<div><small>Paid</small>${esc(fmtShort(i.paid_at))}</div>` : ''}</div>
      ${!i.paid && i.due > 0 && i.payment_status !== 'processing' ? `<button class="btn iwide" onclick="kv.invPay([${i.number}])">Pay ${money2(i.due)}</button>${INV.data.credits > 0 ? `<p class="hint" style="margin:6px 0 0">Your ${money2(INV.data.credits)} credit is used first.</p>` : ''}` : ''}
      <button class="btn o iwide" onclick="kv.invPdf(${i.number},'view')">${ic(I.eye, 16)} View invoice</button>
      <button class="btn o iwide" onclick="kv.invPdf(${i.number},'download')">${ic(I.dl, 16)} Download PDF</button>
      <button class="btn o iwide" onclick="kv.invEmail(${i.number})">${ic(I.mail, 16)} Email invoice</button>
    </aside>
  </div>`;
}
async function invPdfBlob(n) {
  if (INV.pdf[n]) return INV.pdf[n];
  const r = await api('pdf', { number: n }, 'invoices');
  const bin = Uint8Array.from(atob(r.base64), c => c.charCodeAt(0));
  return (INV.pdf[n] = { blob: new Blob([bin], { type: 'application/pdf' }), name: r.filename });
}
async function invPdf(n, how) {
  // open the tab right away (before waiting) so phones don't block it as a pop-up
  const w = how === 'view' ? window.open('', '_blank') : null;
  if (w) w.document.write('<p style="font:16px system-ui;padding:24px;color:#44546b">Loading your invoice…</p>');
  try {
    const { blob, name } = await invPdfBlob(n);
    const url = URL.createObjectURL(blob);
    if (how === 'view') { if (w) w.location.href = url; else location.href = url; }
    else { const a = Object.assign(document.createElement('a'), { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove(); logAct('download', `Downloaded invoice ${ono(invFind(n) || { number: n })} (PDF)`); }
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) { w?.close(); alertModal(e.message); }
}
function invEmail(n) {
  const i = invFind(n), own = INV.data?.client?.email || S.session?.user?.email || '';
  $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel"><h2 style="font-size:22px">Email invoice ${esc(ono(i || { number: n }))}</h2>
    <p class="hint" style="margin:0 0 14px">${esc(i?.address || '')} · the PDF is attached.</p>
    ${own ? `<label class="check-row"><input type="checkbox" id="ieSelf" checked> Send to me (${esc(own)})</label>` : ''}
    <label for="ieTo" style="margin-top:12px">Also send to</label><p class="hint" style="margin:0 0 6px">Optional. Up to 3 email addresses, separated by commas.</p>
    <input id="ieTo" type="email" multiple inputmode="email" autocomplete="email" placeholder="name@example.com">
    <div id="ieMsg"></div>
    <div class="ph-nav"><button class="btn o" onclick="kv.closeModal()">Cancel</button><button class="btn" id="ieGo">Send</button></div></div></div>`;
  $('ieGo').onclick = async () => {
    const to = ($('ieTo').value || '').split(/[,;\s]+/).filter(Boolean), self = $('ieSelf')?.checked ?? false;
    if (!self && !to.length) { $('ieMsg').innerHTML = '<div class="msg err">Choose at least one person to send it to.</div>'; return; }
    $('ieGo').disabled = true; $('ieGo').innerHTML = '<span class="spin"></span>';
    try {
      const r = await api('email', { number: n, to, self }, 'invoices');
      $('modal').querySelector('.panel').innerHTML = `<h2 style="font-size:22px">Invoice sent</h2><p>Sent to ${r.sent.map(esc).join(', ')}.</p><div class="ph-nav"><span></span><button class="btn" onclick="kv.closeModal()">Done</button></div>`;
    } catch (e) { $('ieMsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; $('ieGo').disabled = false; $('ieGo').textContent = 'Send'; }
  };
}
// Before the card form: if they have account credit, let them choose to use it (ticked by default)
function invPay(numbers, opts = {}) {
  const cr = myCredit();
  if (!cr || opts.useCredits !== undefined) return invPayGo(numbers, { ...opts, useCredits: cr ? opts.useCredits !== false : false });
  const list = invAll().filter(i => !i.paid && i.due > 0 && (!numbers?.length || numbers.map(String).includes(String(i.number))));
  const due = Math.round(list.reduce((a, i) => a + i.due, 0) * 100) / 100;
  const label = list.length === 1 ? `invoice ${ono(list[0])}` : `${list.length} invoices`;
  const paint = () => {
    const use = $('icrUse')?.checked !== false, credit = use ? Math.min(cr, due) : 0, left = Math.round((due - credit) * 100) / 100;
    $('icrSum').innerHTML = `<div class="iline"><span>Amount due</span><span>${money2(due)}</span></div>${credit ? `<div class="iline"><span>Account credit</span><span class="cr-txt">-${money2(credit)}</span></div>` : ''}<div class="iline big"><span>You pay</span><span>${money2(left)}</span></div>`;
    $('icrGo').textContent = left > 0 ? `Continue to pay ${money2(left)}` : 'Pay with my credit';
  };
  $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel"><h2 style="font-size:22px">Pay ${esc(label)}</h2>
    <label class="cr-box"><input type="checkbox" id="icrUse" checked> <span><b>Use my account credit</b><small>You have ${money2(cr)} available.</small></span></label>
    <div id="icrSum" style="margin-top:12px"></div>
    <div class="ph-nav"><button class="btn o" onclick="kv.closeModal()">Cancel</button><button class="btn" id="icrGo">Continue</button></div></div></div>`;
  $('icrUse').onchange = paint; paint();
  $('icrGo').onclick = () => invPayGo(numbers, { ...opts, useCredits: $('icrUse').checked });
}
async function invPayGo(numbers, opts = {}) {
  if (!stripeReady() && !(opts.useCredits && myCredit())) { alertModal('Online payments are not switched on yet. Please call ' + CFG.phone + '.'); return; }
  $('modal').innerHTML = '<div class="modal"><div class="panel loading"><span class="spin"></span> Getting your invoice ready…</div></div>';
  try {
    const r = await api('pay', { numbers: numbers || [], useCredits: !!opts.useCredits }, 'invoices');
    if (r.alreadyPaid || r.paidByCredit) {
      INV.pdf = {}; await loadInvoices(true); S.pdata = null; opts.onPaid?.();
      $('modal').innerHTML = `<div class="modal"><div class="panel"><h2 style="font-size:22px">${r.paidByCredit ? 'Paid with your credit' : 'Already paid'}</h2><p>${r.paidByCredit ? 'Your account credit covered this. Thank you!' : 'This invoice is already paid.'}</p><div class="ph-nav"><span></span><button class="btn" onclick="kv.closeModal()">Done</button></div></div></div>`;
      return;
    }
    const label = r.numbers.length > 1 ? `${r.numbers.length} invoices (${r.numbers.map(x => ono(invFind(x) || { number: x })).join(', ')})` : `Invoice ${ono(invFind(r.numbers[0]) || { number: r.numbers[0] })}`;
    $('modal').innerHTML = `<div class="modal"><div class="panel"><h2 style="font-size:22px">Pay ${esc(label)}</h2>
      <div class="tot" style="padding:6px 0 0"><span>Amount due</span><span>${money2(r.amount)}</span></div>
      <div id="pay-el3" style="margin-top:14px"></div><div id="payErr"></div>
      <div class="ph-nav"><button class="btn o" onclick="kv.closeModal();kv.reloadInvoices()">Cancel</button><button class="btn" id="payGo">Pay ${money2(r.amount)}</button></div></div></div>`;
    const elements = stripe.elements({ clientSecret: r.clientSecret, appearance });
    elements.create('payment').mount('#pay-el3');
    $('payGo').onclick = async () => {
      $('payGo').disabled = true; $('payGo').innerHTML = '<span class="spin"></span>';
      const ret = `${location.origin}/${location.hash || '#invoices'}`;
      const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: ret }, redirect: 'if_required' });
      if (error) { $('payErr').innerHTML = `<div class="msg err">${esc(error.message)}</div>`; $('payGo').disabled = false; $('payGo').textContent = `Pay ${money2(r.amount)}`; return; }
      await api('confirm', { pi: r.pi }, 'invoices').catch(() => {});
      INV.pdf = {}; S.pdata = null; await loadInvoices(true); opts.onPaid?.();
      if (S.view === 'delivery') loadDelivery(S.dl.key);
      $('modal').innerHTML = `<div class="modal"><div class="panel"><h2 style="font-size:22px">Payment received</h2><p>Thank you! A receipt is on its way to your email.</p><div class="ph-nav"><span></span><button class="btn" onclick="kv.closeModal()">Done</button></div></div></div>`;
    };
  } catch (e) { kv.closeModal(); alertModal(e.message); }
}
Object.assign(window.kv, {
  invPdf, invEmail, invPay, reloadInvoices: () => loadInvoices(),
  invRange(v) { INV.range = v; render(); },
  useCredit(v) { S.useCredit = !!v; render(); },
  cpOn(v) { S.cp.on = !!v; if (!v) { S.cp.applied = null; S.cp.err = ''; } render(); if (v) setTimeout(() => $('cpCode')?.focus(), 30); },
  async cpApply() {
    const code = ($('cpCode')?.value || S.cp.code).trim(); S.cp.code = code;
    if (!code) { S.cp.err = 'Enter a coupon code.'; render(); return; }
    S.cp.busy = true; S.cp.err = ''; render();
    try {
      const c = await api('coupon', { code, email: S.contact.email || S.session?.user?.email || '' });
      S.cp.applied = c; S.cp.code = c.code;
      if (subTotal() < c.min_total) S.cp.err = `This code needs an order of at least ${money(c.min_total)}.`;
    } catch (e) { S.cp.applied = null; S.cp.err = e.message; }
    S.cp.busy = false; render();
  },
  cpType(v) { S.cp.code = v; },
  cpRemove() { S.cp.applied = null; S.cp.code = ''; S.cp.err = ''; render(); },
});

// Account → Notification Preferences: text messages the client wants (HQ shows and edits the same switches)
const NT_KEYS = ['sms_appointment_reminders', 'sms_media_delivered'];
const NT_NOTE = 'Message and data rates may apply. Reply STOP to any text to opt out, or turn these off here anytime.';
function vNotify() {
  const n = S.notify || {}, ph = n.phone || (S.pdata?.agent || S.agent || {}).phone, all = NT_KEYS.every(k => n[k]);
  const row = (k, title, sub, cls = '') => `<label class="nt-row ${cls}"><span><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>
    <span class="sw"><input type="checkbox" data-nt="${k}" ${k === 'all' ? (all ? 'checked' : '') : n[k] ? 'checked' : ''} onchange="kv.setNotify('${k}', this.checked)"><i aria-hidden="true"></i></span></label>`;
  return `<p class="nt-h">Text messages${ph ? ` to <b>${esc(kv.fmtPhone(ph))}</b>` : ''}</p>
    ${row('all', 'All notifications', '', 'nt-all')}
    ${row('sms_appointment_reminders', 'Appointment reminders', 'So you never forget')}
    ${row('sms_media_delivered', 'Media delivered', 'When your media is ready')}
    <p class="hint nt-msg" id="ntMsg">${ph ? NT_NOTE : 'Add your mobile phone in My Profile to turn on text messages.'}</p>`;
}
function vSettings() {
  const a = S.pdata?.agent || S.agent || {}, x = S.extras || {};
  const [f0, ...l0] = (a.full_name || '').split(' ');
  const first = x.first_name ?? f0 ?? '', last = x.last_name ?? l0.join(' ');
  const f = (k, label, v, attrs = '') => `<div><label for="st_${k}">${label}</label><input id="st_${k}" value="${esc(v || '')}" ${attrs}></div>`;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const bm = x.birth_month ?? '', bd = x.birth_day ?? '';
  const dmax = bm ? [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][bm - 1] : 31;
  const sec = (key, title, sub, body, open) => { const on = UI.sec?.[key] ?? open;
    return `<section class="acc ${on ? 'open' : ''}"><button type="button" class="acc-h" aria-expanded="${on}" onclick="kv.acc('${key}', ${!on})"><span><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="acc-b" ${on ? '' : 'hidden'}>${body}</div></section>`; };
  const profile = `<form onsubmit="kv.saveProfile(event)" class="fg">
      ${f('first', 'First name', first, 'autocomplete="given-name" required')}
      ${f('last', 'Last name', last, 'autocomplete="family-name" required')}
      ${f('phone', 'Mobile phone', a.phone ? kv.fmtPhone(a.phone) : '', 'type="tel" inputmode="tel" autocomplete="tel-national" oninput="this.value=kv.fmtPhone(this.value)"')}
      <div><label>Email</label><input value="${esc(a.email || S.session?.user?.email || '')}" disabled><p class="hint" style="margin:5px 0 0">This is how you sign in. To change it, call ${esc(CFG.phone)}.</p></div>
      ${f('brokerage', 'Brokerage', a.brokerage, 'autocomplete="organization"')}
      ${f('team_name', 'Team', a.team_name)}
      ${f('website', 'Website', x.website_url, 'type="url" inputmode="url" placeholder="www.yourwebsite.com" autocomplete="url"')}
      <div><label for="st_bm">Birthday</label><div class="bday">
        <select id="st_bm" onchange="kv.bdayMonth(this.value)" aria-label="Birthday month"><option value="">Month</option>${MONTHS.map((m, i) => `<option value="${i + 1}" ${+bm === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select>
        <select id="st_bd" aria-label="Birthday day"><option value="">Day</option>${Array.from({ length: dmax }, (_, i) => `<option ${+bd === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></div>
        <p class="hint" style="margin:5px 0 0">Just the month and day.</p></div>
      <div class="full">${S.error ? `<div class="msg err">${esc(S.error)}</div>` : ''}${UI.saved ? '<div class="msg info">Saved.</div>' : ''}
        <button class="btn" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Save changes'}</button></div>
    </form>
    ${a.id ? `<div class="acc-sub"><b>Photo &amp; logo</b><p class="hint">Used on your account and your property websites.</p>${vPhotoCard(a) + vLogoCard()}</div>` : ''}`;
  const app = `<p class="hint" style="margin:0 0 10px">Add Knox View to your home screen to book and check your orders like an app.</p>
      <p style="margin:0 0 6px"><b>iPhone:</b> open this page in Safari, tap the Share button, then <b>Add to Home Screen</b>.</p>
      <p style="margin:0"><b>Android:</b> open this page in Chrome, tap the ⋮ menu, then <b>Add to Home screen</b> (or <b>Install app</b>).</p>
      <p class="hint" style="margin:10px 0 0">The first time you open it from your home screen, sign in once with your email or phone.</p>`;
  return `<div class="prof"><h2 class="prof-t">Account</h2>
    ${sec('me', 'My Profile', '', profile, true)}
    ${sec('notify', 'Notification Preferences', '', vNotify(), false)}
    ${sec('app', 'Get the app', 'Add Knox View to your home screen', app, false)}</div>`;
}
/* ================= profile photo (headshot) =================
   One square photo per client, reused everywhere: the portal header and menu, HQ, and (later) branded property websites.
   Saved as a 1000x1000 JPEG (agents.photo_url). Round spots show it in a circle, so the editor shows the square and the circle.
   The full photo (downsized to 2400px) is kept too (agents.photo_original_path) so it can be re-cropped later. */
const PH = { OUT: 1000, ORIG: 2400, MAX_MB: 25 };
// S.photo = the signed-in client's photo URL ('' = none, null = not loaded yet)
const avatar = (a, cls = 'av') => S.photo
  ? `<span class="${cls} has-ph"><img src="${esc(S.photo)}" alt="" decoding="async"></span>`
  : `<span class="${cls}">${esc(initials(a?.full_name || S.session?.user?.email || ''))}</span>`;
function vPhotoCard(a) {
  const has = !!S.photo;
  return `<div class="ph-card">${avatar(a, 'av ph-big')}
    <div class="ph-txt"><b>Profile photo</b><p class="hint">${has ? 'This is the photo we show on your account and on your property websites.' : 'Add a headshot. We show it on your account and on your property websites.'}</p>
      <div class="ph-acts"><label class="btn sm"><input type="file" accept="image/*" onchange="kv.photoPick(this)" hidden>${has ? 'Change photo' : 'Add photo'}</label>
        ${has ? `<button type="button" class="btn sm o" onclick="kv.photoRemove()">Remove</button>` : ''}</div></div></div>`;
}
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.decoding = 'async'; img.src = url;
    await img.decode();
    return img;
  } catch (_) { throw new Error("That photo couldn't be opened. Try a JPG or PNG."); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
const toJpeg = (canvas, q = 0.9) => new Promise((ok, no) => canvas.toBlob(b => b ? ok(b) : no(new Error("Couldn't prepare the photo.")), 'image/jpeg', q));
async function photoPick(input) {
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  if (file.size > PH.MAX_MB * 1048576) return alertModal(`That photo is over ${PH.MAX_MB} MB. Please pick a smaller one.`);
  let img; try { img = await loadImage(file); } catch (e) { return alertModal(e.message); }
  if (Math.min(img.naturalWidth, img.naturalHeight) < 200) return alertModal('That photo is too small. Please pick one at least 200 pixels wide.');
  openCropper(img);
}
function openCropper(img) {
  const W = img.naturalWidth, H = img.naturalHeight;
  $('modal').innerHTML = `<div class="modal ph-modal" role="dialog" aria-modal="true" aria-labelledby="phT"><div class="panel ph-panel">
    <h2 id="phT">Adjust your photo</h2>
    <p class="hint">Drag to move. ${matchMedia('(pointer:coarse)').matches ? 'Pinch' : 'Scroll or use the slider'} to zoom. The square is your full photo; the circle shows round spots like your account icon.</p>
    <div class="ph-stage" id="phStage"><img id="phImg" src="${img.src}" alt="" draggable="false"><div class="ph-ring" aria-hidden="true"></div></div>
    <div class="ph-zoom"><span aria-hidden="true">−</span><input type="range" id="phZoom" min="1" max="4" step="0.01" value="1" aria-label="Zoom"><span aria-hidden="true">+</span></div>
    <div class="ph-prev"><span class="av ph-sm"><canvas id="phPrev" width="96" height="96"></canvas></span><small>Preview</small></div>
    <div class="msg err" id="phErr" hidden></div>
    <div class="ph-nav"><button class="btn o" type="button" onclick="kv.closeModal()">Cancel</button><button class="btn" type="button" id="phSave">Save photo</button></div>
  </div></div>`;
  const stage = $('phStage'), el = $('phImg'), zoomEl = $('phZoom'), prev = $('phPrev').getContext('2d');
  // c = crop square in image pixels: side = min(W,H)/zoom, (x,y) = its top-left
  const base = Math.min(W, H);
  const c = { z: 1, x: (W - base) / 2, y: (H - base) / 2 };
  const side = () => base / c.z;
  const clamp = () => { c.x = Math.min(Math.max(0, c.x), W - side()); c.y = Math.min(Math.max(0, c.y), H - side()); };
  let raf = 0;
  const draw = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const S0 = stage.clientWidth, k = S0 / side();
      el.style.width = W * k + 'px'; el.style.height = H * k + 'px';
      el.style.transform = `translate(${-c.x * k}px, ${-c.y * k}px)`;
      prev.clearRect(0, 0, 96, 96); prev.drawImage(img, c.x, c.y, side(), side(), 0, 0, 96, 96);
    });
  };
  const zoomTo = (z, fx = 0.5, fy = 0.5) => { // keep the point under (fx,fy) of the frame still
    z = Math.min(4, Math.max(1, z));
    const s0 = side(), px = c.x + fx * s0, py = c.y + fy * s0;
    c.z = z; const s1 = side(); c.x = px - fx * s1; c.y = py - fy * s1; clamp(); zoomEl.value = z; draw();
  };
  zoomEl.oninput = () => zoomTo(+zoomEl.value);
  stage.addEventListener('wheel', e => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomTo(c.z * Math.exp(-e.deltaY * 0.0015), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }, { passive: false });
  const pts = new Map(); let pinch = null;
  stage.onpointerdown = e => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: c.z }; } };
  stage.onpointermove = e => {
    const p = pts.get(e.pointerId); if (!p) return;
    const r = stage.getBoundingClientRect(), k = r.width / side();
    if (pts.size === 1) { c.x -= (e.clientX - p.x) / k; c.y -= (e.clientY - p.y) / k; clamp(); draw(); }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; zoomTo(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, ((a.x + b.x) / 2 - r.left) / r.width, ((a.y + b.y) / 2 - r.top) / r.height); }
  };
  stage.onpointerup = stage.onpointercancel = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  stage.onkeydown = e => { const st = side() * 0.03, m = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key]; if (m) { e.preventDefault(); c.x += m[0]; c.y += m[1]; clamp(); draw(); } };
  stage.tabIndex = 0; stage.setAttribute('aria-label', 'Photo position. Use arrow keys to move.');
  new ResizeObserver(draw).observe(stage);
  draw();
  $('phSave').onclick = async () => {
    const btn = $('phSave'), err = $('phErr'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; err.hidden = true;
    try {
      const out = document.createElement('canvas'); out.width = out.height = PH.OUT;
      const g = out.getContext('2d'); g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, PH.OUT, PH.OUT);
      g.drawImage(img, c.x, c.y, side(), side(), 0, 0, PH.OUT, PH.OUT);
      const sc = Math.min(1, PH.ORIG / Math.max(W, H)), og = document.createElement('canvas');
      og.width = Math.round(W * sc); og.height = Math.round(H * sc);
      const o2 = og.getContext('2d'); o2.imageSmoothingQuality = 'high'; o2.fillStyle = '#fff'; o2.fillRect(0, 0, og.width, og.height); o2.drawImage(img, 0, 0, og.width, og.height);
      const [sq, orig] = await Promise.all([toJpeg(out, 0.9), toJpeg(og, 0.88)]);
      const uid = S.session.user.id, t = Date.now().toString(36);
      const path = `${uid}/photo-${t}.jpg`, original = `${uid}/original-${t}.jpg`;
      const up = (p, b) => sb.storage.from('agent-photos').upload(p, b, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
      const [r1, r2] = await Promise.all([up(path, sq), up(original, orig)]);
      if (r1.error) throw new Error("Your photo didn't upload. Please try again.");
      const r = await api('set', { path, original: r2.error ? null : original }, 'client-photo');
      S.photo = r.photo_url || ''; kv.closeModal(); render();
    } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Save photo'; }
  };
}
async function photoRemove() {
  $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel"><h2 style="font-size:22px">Remove your photo?</h2>
    <p class="hint">Your initials will show instead until you add a new one.</p>
    <div class="ph-nav"><button class="btn o" onclick="kv.closeModal()">Cancel</button><button class="btn" id="phRm">Remove</button></div></div></div>`;
  $('phRm').onclick = async () => {
    $('phRm').disabled = true;
    try { await api('remove', {}, 'client-photo'); S.photo = ''; kv.closeModal(); render(); }
    catch (e) { kv.closeModal(); alertModal(e.message); }
  };
}
function setAgent(a) { if (!a) return; S.agent = { ...(S.agent || {}), ...a }; if (S.pdata) S.pdata.agent = { ...(S.pdata.agent || {}), ...a }; }
async function loadPhoto() { if (!S.session) return; try { const r = await api('get', {}, 'client-photo'); S.photo = r.photo_url || ''; S.logo = r.logo_url || ''; S.extras = r.extras || {}; S.notify = r.notify || {}; render(); } catch (_) { /* initials stay */ } }
Object.assign(window.kv, { photoPick, photoRemove });

/* ===== Logo (profile): the agent's own logo, PNG with transparency kept; used on property websites ===== */
function vLogoCard() {
  const has = !!S.logo;
  return `<div class="ph-card lg-card"><span class="lg-box">${has ? `<img src="${esc(S.logo)}" alt="Your logo">` : '<span>Logo</span>'}</span>
    <div class="ph-txt"><b>Logo</b><p class="hint">${has ? 'Your logo for your property websites and marketing.' : 'Add your logo or your team’s. A PNG with a transparent background looks best.'}</p>
      <div class="ph-acts"><label class="btn sm"><input type="file" accept="image/png,image/jpeg,image/webp" onchange="kv.logoPick(this)" hidden>${has ? 'Change logo' : 'Add logo'}</label>
        ${has ? `<button type="button" class="btn sm o" onclick="kv.logoRemove()">Remove</button>` : ''}</div></div></div>`;
}
// scale to max 1600px and trim empty (transparent or plain white) margins
function logoCanvas(img) {
  const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, empty = i => d[i + 3] < 12 || (d[i] > 248 && d[i + 1] > 248 && d[i + 2] > 248);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!empty((y * w + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return c;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02); x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const t = document.createElement('canvas'); t.width = x1 - x0 + 1; t.height = y1 - y0 + 1;
  t.getContext('2d').drawImage(c, x0, y0, t.width, t.height, 0, 0, t.width, t.height);
  return t;
}
async function logoPick(input) {
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  if (file.size > 15 * 1048576) return alertModal('That file is over 15 MB. Please pick a smaller one.');
  let img; try { img = await loadImage(file); } catch (_) { return alertModal("That logo couldn't be opened. Try a PNG or JPG."); }
  const cv = logoCanvas(img), src = cv.toDataURL('image/png');
  $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel"><h2 style="font-size:22px">Your logo</h2>
    <p class="hint">How it looks on light and dark backgrounds. We trimmed the empty space around it.</p>
    <div class="lg-prev"><span><img src="${src}" alt=""></span><span class="dk"><img src="${src}" alt=""></span></div>
    <div class="msg err" id="lgErr" hidden></div>
    <div class="ph-nav"><button class="btn o" type="button" onclick="kv.closeModal()">Cancel</button><button class="btn" type="button" id="lgSave">Save logo</button></div></div></div>`;
  $('lgSave').onclick = async () => {
    const btn = $('lgSave'), err = $('lgErr'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; err.hidden = true;
    try {
      const blob = await new Promise((ok, no) => cv.toBlob(b => b ? ok(b) : no(new Error("Couldn't prepare the logo.")), 'image/png'));
      const path = `${S.session.user.id}/logo-${Date.now().toString(36)}.png`;
      const up = await sb.storage.from('agent-photos').upload(path, blob, { contentType: 'image/png', cacheControl: '31536000', upsert: false });
      if (up.error) throw new Error("Your logo didn't upload. Please try again.");
      const r = await api('logo_set', { path }, 'client-photo');
      S.logo = r.logo_url || ''; kv.closeModal(); render();
    } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Save logo'; }
  };
}
async function logoRemove() {
  $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel"><h2 style="font-size:22px">Remove your logo?</h2>
    <div class="ph-nav"><button class="btn o" onclick="kv.closeModal()">Cancel</button><button class="btn" id="lgRm">Remove</button></div></div></div>`;
  $('lgRm').onclick = async () => {
    $('lgRm').disabled = true;
    try { await api('logo_remove', {}, 'client-photo'); S.logo = ''; kv.closeModal(); render(); }
    catch (e) { kv.closeModal(); alertModal(e.message); }
  };
}
Object.assign(window.kv, { logoPick, logoRemove });

const TEST_EMAIL = 'chris+test@knoxview.com';
const isTestAccount = () => (S.session?.user?.email || '').toLowerCase() === TEST_EMAIL;
function vPortal() {
  const p = S.pdata;
  if (isTestAccount() && p && !p.loading && !p.error) return `<div class="msg info testacct"><b>Test account.</b> You're viewing the portal as the test client (${TEST_EMAIL}). Sample orders are marked TEST.</div>` + vPortalBody();
  return vPortalBody();
}
function vPortalBody() {
  const p = S.pdata;
  if (S.view === 'invoices') return vInvoices(); // has its own data (invoices function)
  if (!p || p.loading) return '<div class="panel loading"><span class="spin"></span> Loading…</div>';
  if (p.error) return `<div class="msg err">${esc(p.error)} <a href="javascript:kv.reloadPortal()">Try again</a></div>`;
  return S.view === 'invoices' ? vInvoices() : S.view === 'profile' ? vSettings() : vListings();
}
function vPortalOrDelivery() {
  return S.view === 'delivery' ? vDelivery() : vPortal();
}

function vHeader() {
  const v = S.view, signedIn = !!S.session;
  const nav = signedIn ? [['#order', I.cart, 'Order now', v === 'book' || v === 'done'], ['#listings', I.home, 'Listings', v === 'listings' || v === 'delivery'], ['#profile', I.user, 'Account', v === 'profile']]
    .map(([h, i, t, on]) => `<a href="${h}" class="${on ? 'on' : ''}">${ic(i)}<span>${t}</span></a>`).join('') : '';
  $('pnav').innerHTML = nav;
  const a = S.pdata?.agent || S.agent, name = a?.full_name || S.session?.user?.email || '';
  $('acct').innerHTML = !signedIn ? `<div class="top-acts">${v === 'account' ? '<a class="signin" href="#order">Book now</a>' : '<a class="signin" href="#account">Sign in</a>'}<a class="top-text" href="${SMS_LINK}">${svg(IC_CHAT, 14)} Text us</a></div>`
    : `<button class="me" onclick="kv.menu(event)" aria-expanded="${UI.menu}" aria-label="Account menu">${avatar(a)}
        <span class="me-t"><b>${esc(name)}</b>${a?.brokerage ? `<small>${esc(a.brokerage)}</small>` : ''}</span>${ic(I.down, 16)}</button>
      ${UI.menu ? `<div class="menu" onclick="event.stopPropagation()"><div class="menu-h">${avatar(a)}<div><b>${esc(name)}</b><small>${esc(a?.email || S.session.user.email || '')}</small></div></div>
        <a href="#order" onclick="kv.menu()">${ic(I.cart)}Order now</a><a href="#listings" onclick="kv.menu()">${ic(I.home)}Listings</a><a href="#invoices" onclick="kv.menu()">${ic(I.inv)}Invoices</a><a href="#profile" onclick="kv.menu()">${ic(I.user)}Account</a><button onclick="kv.signOut()">${ic(I.out)}Log out</button></div>` : ''}`;
}

/* ================= delivery page (#delivery/<listing key>[/<tab>]) ================= */
// Modeled on the Spiro download page. Files come from the `media` function (signed links, only once the order is paid).
// Phones: files go through the share sheet, so iPhone offers "Save Video" (camera roll) / "Save N Images" to Photos.
I.photo = '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 16l-5-5-9 9"/>';
I.film = '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4"/>';
I.plan = '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h7v9M14 3v6h7M14 15h7"/>';
I.cube = '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/>';
I.ext = '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>';
I.share = '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>';
I.qr = '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4"/>';
I.code = '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>';
I.copy = '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
const ROLL = 'Save to Camera Roll'; // phones: photos go straight to Photos via the share sheet
const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
const D = (S.dl = { key: null, data: null, loading: false, error: '', tab: null, cur: 'photos', sels: {} });
// every set (photos, floor plans) keeps its own selection; D.sel is the selection of the set in use (D.cur)
Object.defineProperty(D, 'sel', { get() { return (D.sels[D.cur] ||= new Set()); }, set(v) { D.sels[D.cur] = v; } });
// The delivery page is also its own page: /d/<order share token>. That's the link in delivery emails and texts, so it
// works when forwarded to anyone (no sign-in). Downloads still unlock only after payment when the order requires it.
const SHARE = (location.pathname.match(/^\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i) || [])[1] || null;
const DL_TABS = ['photos', 'video', 'floorplan', 'tour', 'website'];

async function loadDelivery(key) {
  Object.assign(D, { key, data: null, loading: true, error: '', sel: new Set() }); render();
  try { D.data = SHARE ? await api('share-delivery', { token: SHARE }) : await api('delivery', { key }); } catch (e) { D.error = e.message; }
  if (SHARE && D.data?.head?.address) document.title = `${D.data.head.title || D.data.head.address} · Knox View`;
  D.loading = false; render();
}
// "‹ Listings" only for the client who owns this order (a forwarded share link has no listings to go back to)
const dlBack = () => !SHARE ? '<a class="dl-back" href="#listings">‹ Listings</a>' : D.data?.mine ? '<a class="dl-back" href="/#listings">‹ Listings</a>' : '';
const dTabs = d => [
  (d.photos.length || d.folders.length) && ['photos', I.photo, 'Photos'],
  d.videos.length && ['video', I.film, d.videos.length > 1 ? 'Videos' : 'Video'],
  d.tour && ['tour', I.cube, '3D Tour'],
  d.floorplans.length && ['floorplan', I.plan, d.floorplans.length > 1 ? 'Floor Plans' : 'Floor Plan'],
  d.websites.length && ['website', I.globe2, 'Property Website'],
].filter(Boolean);

function linkCard(title, url, icon, soon) {
  if (soon) return `<div class="dl-card soon"><h3>${icon ? ic(icon, 20) : ''}${esc(title)}</h3><p class="hint" style="margin:0">Coming soon. Your property website will appear here when it's ready.</p></div>`;
  if (!url) return `<div class="dl-card"><h3>${esc(title)}</h3><p class="hint" style="margin:0">${ic(I.lock, 14)} Unlocks after payment.</p></div>`;
  return `<div class="dl-card"><h3>${icon ? ic(icon, 20) : ''}${esc(title)}</h3>
    <input class="dl-url" readonly value="${esc(url)}" onclick="this.select()">
    <div class="dl-btns"><a class="btn o" href="${esc(url)}" target="_blank" rel="noopener">${ic(I.eye, 16)} View</a>
      <button class="btn o" onclick="kv.dCopy(${esc(JSON.stringify(url))}, ${esc(JSON.stringify(title + ' link'))})">${ic(I.copy, 16)} Copy</button>
      <button class="btn o" onclick="kv.dShare(${esc(JSON.stringify(url))}, ${esc(JSON.stringify(title))})">${ic(I.share, 16)} Share</button>
      <button class="btn o wide" onclick="kv.dQR(${esc(JSON.stringify(url))}, ${esc(JSON.stringify(title))})">${ic(I.qr, 16)} QR Code</button></div></div>`;
}
// the property website preview is drawn at desktop width (1280×800) and scaled down to fit the card
function fitSitePreview() {
  document.querySelectorAll('.site-pv-frame').forEach(f => { const i = f.querySelector('iframe'); if (!i) return;
    const k = f.clientWidth / 1280; i.style.transform = `scale(${k})`; f.style.height = Math.round(800 * k) + 'px'; });
}
window.addEventListener('resize', fitSitePreview);
// Property website tab: branded + unbranded (MLS) links to view, copy, share or QR, and a live preview of the branded site
function dWebsite(d) {
  const ws = d.websites;
  if (ws.every(w => w.soon)) return `<p class="hint" style="margin:14px 2px">Your property website will appear here when your order is complete.</p>`;
  const pv = ws.find(w => w.preview && w.url);
  if (pv) setTimeout(fitSitePreview, 0);
  return `<section class="dl-cards site-cards">${ws.map(w => linkCard(w.label, w.url, null, w.soon)).join('')}</section>
    ${pv ? `<section class="site-pv"><div class="site-pv-h"><b>Preview: Branded Website</b><a href="${esc(pv.url)}" target="_blank" rel="noopener">Open ${ic(I.ext, 14)}</a></div>
      <div class="site-pv-frame"><iframe title="Property website preview" loading="lazy" src="${esc(pv.url)}"></iframe></div></section>` : ''}`;
}
function vDelivery() {
  if (D.loading || !D.data) return D.error ? `${dlBack()}<div class="msg err">${esc(D.error)}</div>` : '<div class="panel loading"><span class="spin"></span> Getting your media…</div>';
  const d = D.data, tabs = dTabs(d), h = d.head;
  const when = h.date ? fmtDate(h.date) : '', hero = d.photos[0];
  const site = d.websites.find(w => w.preview && w.url);
  const delivered = tabs.length > 0 || d.websites.some(w => !w.soon) || !!d.marketing; // "ready" only once something is delivered
  const place = [h.title ? h.address : '', h.line2].filter(Boolean).join(' · ');
  // 1. hero: the first photo of the gallery behind the address, like the property website
  let out = `<header class="dlx-hero ${hero ? '' : 'plain'}">
    ${hero ? `<img class="dlx-hero-bg" src="${esc(hero.thumb)}" alt="" aria-hidden="true"><img class="dlx-hero-img ${D.heroIn === hero.view ? 'in' : ''}" src="${esc(hero.view || hero.thumb)}" alt="" onload="this.classList.add('in');kv.dHeroIn(this.src)" ${d.locked ? 'oncontextmenu="return false"' : ''}>` : ''}
    <div class="dlx-shade"></div>
    <div class="dlx-hero-in">
      ${dlBack().replace('class="dl-back"', 'class="dlx-back"')}
      ${h.brokerage ? `<p class="dlx-eyebrow">${esc(h.brokerage)}</p>` : ''}
      <h1>${esc(h.title || h.address)}</h1>
      ${place ? `<p class="dlx-place">${esc(place)}</p>` : ''}
      <p class="dlx-meta">${[when && esc(when), h.number && `Order ${esc(ono(h))}`].filter(Boolean).join('<i>·</i>')}</p>
      <div class="dlx-acts">
        ${d.locked && delivered ? `<button class="dlx-btn solid" onclick="kv.payBooking('${d.bookingId}')">${ic(I.lock, 16)} Pay to Download</button>` : ''}
        ${site ? `<a class="dlx-btn ${d.locked && delivered ? '' : 'solid'}" href="${esc(site.url)}" target="_blank" rel="noopener">${ic(I.globe2, 17)} View Property Website</a>` : ''}
        ${!d.locked && d.folders.find(f => f.zip) && !isPhone() ? `<a class="dlx-btn" href="${esc(d.folders.find(f => f.zip).zip)}">${ic(I.dl, 16)} Download All Photos</a>` : ''}
      </div>
      ${d.locked && delivered ? `<p class="dlx-note">Your media is ready. Preview everything below, then pay to unlock full-quality downloads.</p>` : ''}
    </div>
  </header>`;
  if (!tabs.length && !d.marketing) return out + `<div class="empty-st">${ic(I.photo, 56)}<p>Your media isn't delivered yet. We'll text and email you as soon as it is.</p></div>`;
  // 2. a slim menu that follows you down the page
  out += `<nav class="dlx-nav" id="dlxNav"><div class="dlx-nav-in">${tabs.map(([k, i, l]) => `<a href="javascript:kv.dTab('${k}')" data-k="${k}">${ic(i, 17)}<span>${l}</span></a>`).join('')}
    ${d.marketing ? (d.marketing.url ? `<a href="${esc(d.marketing.url)}" target="_blank" rel="noopener">${ic(I.ext, 16)}<span>Marketing</span></a>` : `<span class="off">${ic(I.lock, 15)}<span>Marketing</span></span>`) : ''}</div></nav>`;
  // 3. every section on one page, in order
  const body = { photos: dPhotos, video: dVideos, tour: dTour, floorplan: dPlans, website: dWebsite };
  const count = { photos: d.photos.length, video: d.videos.length > 1 ? d.videos.length : 0, floorplan: d.floorplans.length > 1 ? d.floorplans.length : 0 };
  out += tabs.map(([k, , l]) => `<section class="dlx-sec" id="dl-${k}" data-k="${k}">
    <div class="dlx-h"><h2>${l}</h2>${count[k] ? `<span>${count[k]}</span>` : ''}</div>
    <div class="dl-media">${body[k](d)}</div></section>`).join('');
  setTimeout(dlxWire, 0);
  return out;
}
// sticky menu: highlight the section on screen; jump to the section in the link (#photos, #website…) on first open
let dlxIO = null;
function dlxWire() {
  const nav = document.getElementById('dlxNav'); if (!nav) return;
  document.body.classList.add('dlx');
  const top = document.querySelector('header.top'); if (top) document.body.style.setProperty('--toph', top.offsetHeight + 'px');
  dlxIO?.disconnect();
  dlxIO = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) nav.querySelectorAll('[data-k]').forEach(a => a.classList.toggle('on', a.dataset.k === e.target.dataset.k)); }), { rootMargin: '-40% 0px -55% 0px' });
  document.querySelectorAll('.dlx-sec').forEach(sec => dlxIO.observe(sec));
  if (D.tab && !D.jumped) { D.jumped = true; const el = document.getElementById('dl-' + D.tab); if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth' }), 120); }
  fitSitePreview();
}
const cap1 = t => String(t).replace(/\b\w/g, c => c.toUpperCase()); // "floor plans" -> "Floor Plans" (buttons and headings)
const SET_LABEL = { photos: ['photo', 'photos'], floorplans: ['floor plan', 'floor plans'] };
const curSet = () => D.data[D.cur] || [];
const isDoc = p => /\.pdf$/i.test(p?.name || ''); // PDF floor plans: file tile, tap to download
function dGrid(d, key) {
  const sel = (D.sels[key] ||= new Set()), K = `kv.dUse('${key}');`;
  const list = d[key], n = sel.size, all = list.length, [one, many] = SET_LABEL[key];
  // long galleries show the first rows, then "Show all" (keeps the page short and quick; Select all still means all)
  const cap = isPhone() ? 12 : 16, open = (D.open ||= {})[key] || all <= cap + 4, shown = open ? list : list.slice(0, cap);
  const more = open ? '' : `<button class="dlx-more" onclick="kv.dMore('${key}')">Show All ${all} ${cap1(many)} ${ic('<path d="M6 9l6 6 6-6"/>', 16)}</button>`;
  const zip = key === 'photos' ? d.folders.find(f => f.zip)?.zip : null;
  const tile = (p, i, inner) => p.thumb && !isDoc(p) ? `<img src="${esc(p.thumb)}" alt="" loading="lazy" draggable="false" ${d.locked ? 'oncontextmenu="return false"' : ''}>` : `<span class="dl-file">${ic(I.plan, 34)}<small>${esc((p.name.split('.').pop() || '').toUpperCase())}</small></span>`;
  if (!all) return `<p class="hint" style="margin:14px 2px">${d.locked ? `Your ${many} unlock after payment.` : `Your ${many} are being prepared. Check back shortly.`}</p>
    ${zip ? `<a class="btn" href="${esc(zip)}">${ic(I.dl, 16)} Download All ${cap1(many)} (Zip)</a>` : ''}`;
  if (d.locked) return `<div class="dl-bar locked"><span>${ic(I.lock, 18)} <b>Preview.</b> ${all === 1 ? `Your ${one} downloads` : `All ${all} ${many} download`} in full resolution, without the watermark, after payment.</span>
</div>
    <div class="dl-grid preview ${key}">${shown.map((p, i) => `<figure class="dl-ph"><button class="dl-img" onclick="${K}kv.dView(${i})" aria-label="View ${esc(p.name)}">${tile(p, i)}</button>
      <figcaption><span>${esc(p.label || p.name)}</span></figcaption></figure>`).join('')}</div>${more}`;
  const bar = `<div class="dl-bar">
      ${all > 1 ? `<button class="btn o" onclick="${K}kv.dSelAll()">${n === all ? 'Clear Selection' : 'Select All'}</button>
      <button class="btn" ${n ? '' : 'disabled'} onclick="${K}kv.dPick()">${ic(I.dl, 16)} ${isPhone() && key === 'photos' ? `${ROLL}${n ? ` (${n})` : ''}` : `Download${n ? ` ${n}` : ''}`}</button>` : ''}
      ${zip && !isPhone() ? `<a class="btn o" href="${esc(zip)}">${ic(I.dl, 16)} Download All (Zip)</a>` : `<button class="btn ${all > 1 ? 'o' : ''}" onclick="${K}kv.dAll()">${ic(I.dl, 16)} Download${all > 1 ? ` All ${all}` : ''}</button>`}</div>
      <p class="hint dl-tip">Tap ${all > 1 ? `a ${one}` : `the ${one}`} to see it full size.${all > 1 ? ' Tap the box in the corner to select it.' : ''}${isPhone() ? ' After Download, choose <b>Save Images</b> to put it in Photos.' : ''}</p>`;
  return bar + `<div class="dl-grid ${key}">${shown.map((p, i) => `<figure class="dl-ph ${sel.has(i) ? 'sel' : ''}">
      <div class="dl-img"><button class="dl-open" onclick="${K}kv.dView(${i})" aria-label="View ${esc(p.name)}">${tile(p, i)}</button>
        ${all > 1 ? `<button class="dl-chk" onclick="${K}kv.dSel(${i})" aria-label="${sel.has(i) ? 'Unselect' : 'Select'} ${esc(p.name)}" aria-pressed="${sel.has(i)}">${CHECK}</button>` : ''}</div>
      <figcaption><span>${esc(p.label || p.name)}</span><span class="dl-q ${p.web ? '' : 'one'}">${p.web ? `<button title="Web quality: for MLS, online &amp; social media" onclick="${K}kv.dSave([${i}],'web')">${ic(I.dl, 14)} Web</button>` : ''}<button title="Full resolution: for print &amp; large displays" onclick="${K}kv.dSave([${i}],'high')">${ic(I.dl, 14)} ${p.web ? 'High' : 'Download'}</button></span></figcaption></figure>`).join('')}</div>${more}`;
}
const dPhotos = d => dGrid(d, 'photos');
/* ----- full-screen photo viewer: swipe / arrows, select from inside ----- */
function lbEl() { let el = document.getElementById('lb'); if (!el) { el = document.createElement('div'); el.id = 'lb'; document.body.appendChild(el); } return el; }
function lbPaint() {
  const d = D.data, list = curSet(), i = D.lb, p = list[i], el = lbEl(), sel = D.sel.has(i), multi = list.length > 1;
  el.className = 'lb on';
  el.innerHTML = `<div class="lb-top"><span>${multi ? `${i + 1} / ${list.length}` : ''}</span><span class="lb-name">${esc(p.label || p.name)}</span><button class="lb-x" onclick="kv.dLbClose()" aria-label="Close">✕</button></div>
    <div class="lb-stage ${D.cur}" id="lbStage"><img src="${esc(p.view || p.thumb || '')}" alt="${esc(p.name)}" draggable="false" ${d.locked ? 'oncontextmenu="return false"' : ''}>
      ${multi ? '<button class="lb-nav prev" onclick="kv.dLbGo(-1)" aria-label="Previous">‹</button><button class="lb-nav next" onclick="kv.dLbGo(1)" aria-label="Next">›</button>' : ''}</div>
    <div class="lb-bar">${d.locked
      ? `<span class="lb-note">${ic(I.lock, 16)} Preview · downloads unlock after payment</span>`
      : `${multi ? `<button class="btn ${sel ? '' : 'o'} lb-sel" onclick="kv.dLbSel()" aria-pressed="${sel}">${sel ? `${CHECK} Selected` : 'Select'}</button>` : ''}
         ${p.web ? `<button class="btn o" title="Web quality: for MLS, online &amp; social media" onclick="kv.dSave([${i}],'web')">${ic(I.dl, 16)} Web</button>` : ''}
         <button class="btn o" title="Full resolution: for print &amp; large displays" onclick="kv.dSave([${i}],'high')">${ic(I.dl, 16)} ${p.web ? 'High' : 'Download'}</button>
         ${D.sel.size ? `<button class="btn" onclick="kv.dLbClose();kv.dPick()">${ic(I.dl, 16)} ${isPhone() && D.cur === 'photos' ? `${ROLL} (${D.sel.size})` : `Download ${D.sel.size}`}</button>` : ''}`}</div>`;
  [i - 1, i + 1].forEach(k => { const q = list[(k + list.length) % list.length]; if (q && (q.view || q.thumb)) new Image().src = q.view || q.thumb; }); // preload neighbours
  const st = document.getElementById('lbStage'); let x0 = null, y0 = null;
  st.ontouchstart = e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; };
  st.ontouchend = e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (multi && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) kv.dLbGo(dx < 0 ? 1 : -1); else if (dy > 90) kv.dLbClose(); };
}
document.addEventListener('keydown', e => { if (D.lb == null) return; if (e.key === 'ArrowRight') kv.dLbGo(1); else if (e.key === 'ArrowLeft') kv.dLbGo(-1); else if (e.key === 'Escape') kv.dLbClose(); });
// Video titles shown to the client are always the property address, cleaned up ("1208 FT CRAIG TRL" -> "1208 Ft Craig Trl").
// The name from HQ (Branded, Unbranded, or a custom name) shows as a small tag next to it.
const DIRS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
function cleanAddress(a) {
  return String(a || '').replace(/\s+/g, ' ').replace(/[\s,.;]+$/, '').trim()
    .replace(/[A-Za-z][A-Za-z']*/g, w => DIRS.has(w.toUpperCase()) ? w.toUpperCase() : /^(po)$/i.test(w) ? 'PO' : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (m, n, x) => n + x.toLowerCase());
}
function dVideos(d) {
  const title = cleanAddress(d.head.address) || 'Video';
  return d.videos.map((v, i) => `<article class="dl-vid">
    <h3>${esc(title)}${v.label && v.label !== title ? ` <small>${esc(v.label)}</small>` : ''}</h3>
    <div class="dl-player ${v.portrait ? 'tall' : ''}">${v.preview && (v.embed || v.file) ? '<span class="dl-badge">Preview</span>' : ''}${v.embed ? `<iframe src="${esc(v.embed)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy" title="${esc(v.title)}"></iframe>`
      : v.file ? `<video src="${esc(v.file)}" controls playsinline preload="metadata"></video>`
      : v.poster ? `<img src="${esc(v.poster)}" alt="">` : `<div class="dl-ph-empty">${ic(d.locked ? I.lock : I.film, 40)}${v.pending ? '<p>Your video is being prepared.</p>' : ''}</div>`}</div>
    ${d.locked ? `<div class="dl-bar locked"><span>${ic(I.lock, 18)} <b>Preview.</b> Download and sharing unlock after payment.</span></div>` : `
    <div class="dl-vbtns">
      ${v.download ? `<button class="btn" onclick="kv.dVideo(${i})">${ic(I.dl, 16)} ${isPhone() ? ROLL : 'Download'}</button>` : v.open ? `<a class="btn" href="${esc(v.open)}" target="_blank" rel="noopener">${ic(I.ext, 16)} Open Video</a>` : ''}
      ${v.share && !d.locked ? `<button class="btn o" onclick="kv.dShare(${esc(JSON.stringify(v.share))}, ${esc(JSON.stringify(v.title))})">${ic(I.share, 16)} Share</button>` : ''}
      ${v.embed && !d.locked ? `<button class="btn o" onclick="kv.dEmbed(${i})">${ic(I.code, 16)} Embed</button>` : ''}
      ${v.share && !d.locked ? `<button class="btn o" onclick="kv.dCopy(${esc(JSON.stringify(v.share))}, 'Video link')">${ic(I.copy, 16)} Copy Video Link</button>` : ''}
    </div>`}${v.download && isPhone() ? `<p class="hint dl-tip">Tap <b>${ROLL}</b> to add it to the Photos app on this phone.</p>` : ''}</article>`).join('');
}
function dPlans(d) {
  const files = d.floorplans.filter(f => !f.open), links = d.floorplans.filter(f => f.open);
  return (files.length ? dGrid({ ...d, floorplans: files }, 'floorplans') : '') +
    links.map(f => `<a class="btn o" style="margin-top:12px" href="${esc(f.open)}" target="_blank" rel="noopener">${ic(I.ext, 16)} Open Floor Plan</a>`).join('');
}
function dTour(d) {
  const u = d.tour.url;
  if (!u) return `<p class="hint" style="margin:14px 2px">${ic(I.lock, 14)} Your 3D tour unlocks after payment.</p>`;
  const embed = /matterport|zillow|cupix|iguide|my\.matterport/i.test(u);
  return `<div class="dl-player">${embed ? `<iframe src="${esc(u)}" allow="fullscreen; xr-spatial-tracking" allowfullscreen loading="lazy" title="3D tour"></iframe>` : `<div class="dl-ph-empty">${ic(I.cube, 44)}</div>`}</div>
    <div class="dl-vbtns"><a class="btn" href="${esc(u)}" target="_blank" rel="noopener">${ic(I.ext, 16)} Open 3D Tour</a>
      <button class="btn o" onclick="kv.dShare(${esc(JSON.stringify(u))}, '3D tour')">${ic(I.share, 16)} Share</button>
      <button class="btn o" onclick="kv.dCopy(${esc(JSON.stringify(`<iframe src="${u}" width="100%" height="480" frameborder="0" allow="fullscreen; xr-spatial-tracking" allowfullscreen></iframe>`))}, 'Embed code')">${ic(I.code, 16)} Embed</button>
      <button class="btn o" onclick="kv.dCopy(${esc(JSON.stringify(u))}, 'Tour link')">${ic(I.copy, 16)} Copy Link</button></div>`;
}

/* ----- saving files (phones: share sheet → camera roll / Photos; computers: normal downloads) ----- */
function dModal(html) { $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel dl-modal">${html}</div></div>`; }
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2400); }
function anchorDownload(url, name) { const a = document.createElement('a'); a.href = url; a.download = name || ''; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }
async function fetchAsFile(url, name, onBytes) {
  const r = await fetch(url); if (!r.ok) throw new Error((await r.text().catch(() => '')) || 'Download failed');
  const total = +r.headers.get('content-length') || 0, type = r.headers.get('content-type') || 'application/octet-stream';
  const fromHeader = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1];
  if (!r.body || !onBytes) return new File([await r.blob()], fromHeader || name, { type });
  const rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onBytes(got, total); }
  return new File(parts, fromHeader || name, { type });
}
// list: [{ url, name }]. Phones share in batches (iOS asks once per batch); computers download each file.
async function saveFiles(list, what) {
  logAct('download', `Downloaded ${list.length === 1 ? (what === 'video' ? 'a video' : '1 file') : list.length + ' files'}${D?.data?.head?.address ? ' · ' + D.data.head.address : ''}`, D?.data?.bookingId || D?.key);
  const canShareFiles = isPhone() && navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.jpg', { type: 'image/jpeg' })] });
  if (!canShareFiles) {
    list.forEach((f, i) => setTimeout(() => anchorDownload(f.url, f.name), i * 450));
    toast(list.length > 1 ? `Downloading ${list.length} files…` : 'Downloading…'); return;
  }
  const size = what === 'video' ? 1 : 10;
  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size), label = list.length > size ? ` (${i + 1}–${i + chunk.length} of ${list.length})` : '';
    dModal(`<div class="dl-prep"><span class="spin"></span><p id="dlProg">Preparing ${what === 'video' ? 'your video' : chunk.length > 1 ? chunk.length + ' photos' : 'your photo'}${label}…</p></div>`);
    let files;
    try {
      const prog = $('dlProg'), done = new Array(chunk.length).fill(0), tot = new Array(chunk.length).fill(0);
      const tick = () => { const a = done.reduce((x, y) => x + y, 0), b = tot.reduce((x, y) => x + y, 0); if (prog && b) prog.textContent = `Preparing${label}… ${Math.round(a / b * 100)}% (${(a / 1048576).toFixed(1)} of ${(b / 1048576).toFixed(1)} MB)`; };
      files = await Promise.all(chunk.map((f, j) => fetchAsFile(f.url, f.name, (g, t) => { done[j] = g; tot[j] = t; tick(); })));
    } catch (e) { dModal(`<p>${esc(e.message)}</p><div class="nav"><span></span><button class="btn" onclick="kv.closeModal()">OK</button></div>`); return; }
    if (!navigator.canShare({ files })) { kv.closeModal(); chunk.forEach((f, j) => setTimeout(() => anchorDownload(f.url, f.name), j * 450)); return; }
    const ok = await new Promise(res => {
      dModal(`<div class="dl-ready">${CHECK}</div><p class="dl-ready-t">Your ${what === 'video' ? 'video is' : files.length > 1 ? `${files.length} photos are` : 'photo is'} ready for your Camera Roll.</p>
        <p class="hint" style="text-align:center;margin:0 0 14px">Tap <b>${ROLL}</b>, then choose <b>${what === 'video' ? 'Save Video' : files.length > 1 ? `Save ${files.length} Images` : 'Save Image'}</b>.</p>
        <button class="btn" id="dlGo" style="width:100%">${ic(I.dl, 16)} ${ROLL}</button>`);
      $('dlGo').onclick = () => navigator.share({ files }).then(() => res(true), e => res(e?.name !== 'AbortError' ? null : false)); // must run inside the tap
    });
    if (ok === false) break; // they cancelled the share sheet
  }
  kv.closeModal();
}
Object.assign(window.kv, {
  dView(i) { if (isDoc(curSet()[i]) || (!curSet()[i]?.thumb && !curSet()[i]?.view)) { const f = curSet()[i]; if (f?.high) kv.dSave([i], 'high'); return; } D.lb = i; document.body.style.overflow = 'hidden'; lbPaint(); },
  dLbGo(step) { const n = curSet().length; D.lb = (D.lb + step + n) % n; lbPaint(); },
  dLbSel() { const i = D.lb; D.sel.has(i) ? D.sel.delete(i) : D.sel.add(i); lbPaint(); render(); },
  dLbClose() { D.lb = null; document.body.style.overflow = ''; const el = document.getElementById('lb'); if (el) { el.className = 'lb'; el.innerHTML = ''; } },
  dTab(t) { D.tab = t; history.replaceState(null, '', SHARE ? `#${t}` : `#delivery/${D.key}/${t}`); document.getElementById('dl-' + t)?.scrollIntoView({ behavior: 'smooth' }); },
  dUse(k) { D.cur = k; },
  dMore(k) { (D.open ||= {})[k] = true; render(); },
  dHeroIn(u) { D.heroIn = u; },
  dSel(i) { if (D.data.locked) return; D.sel.has(i) ? D.sel.delete(i) : D.sel.add(i); render(); },
  dSelAll() { const l = curSet(); D.sel = D.sel.size === l.length ? new Set() : new Set(l.map((_, i) => i)); render(); },
  dPick() { // choose quality for the selected photos
    const n = D.sel.size, [one, many] = SET_LABEL[D.cur], roll = isPhone() && D.cur === 'photos';
    dModal(`<h2 style="font-size:22px;margin-bottom:12px">${roll ? `Save ${n} ${n === 1 ? one : many} to your Camera Roll?` : `Download ${n} ${n === 1 ? one : many}`}</h2>
      ${roll ? `<p class="hint" style="margin:-4px 0 12px">${n === 1 ? 'It saves' : 'They save'} straight to the Photos app on this phone.</p>` : ''}
      ${curSet().some(p => p.web) ? `<label class="radio sel"><input type="radio" name="dq" value="web" checked> <span><b>Web Quality</b> <span class="dq-rec">Recommended</span> <span class="hint">(MLS, online &amp; social media)</span><br><small class="hint">Smaller files, ready to upload</small></span></label>` : ''}
      <label class="radio ${curSet().some(p => p.web) ? '' : 'sel'}"><input type="radio" name="dq" value="high" ${curSet().some(p => p.web) ? '' : 'checked'}> <span><b>Full Resolution</b> <span class="hint">(print &amp; large displays)</span><br><small class="hint">Original size, the largest files</small></span></label>
      <div class="nav"><button class="btn o" onclick="kv.closeModal()">Cancel</button><button class="btn" onclick="kv.dSave([...kv._sel()], document.querySelector('[name=dq]:checked').value)">${ic(I.dl, 16)} ${roll ? ROLL : 'Download'}</button></div>`);
    document.querySelectorAll('[name=dq]').forEach(r => r.onchange = () => document.querySelectorAll('.dl-modal .radio').forEach(l => l.classList.toggle('sel', l.querySelector('input').checked)));
  },
  _sel: () => [...D.sel].sort((a, b) => a - b),
  dAll() { const l = curSet(); D.sel = new Set(l.map((_, i) => i)); render(); if (l.some(p => p.web)) kv.dPick(); else kv.dSave([...kv._sel()], 'high'); },
  dSave(idx, q) { const list = idx.map(i => curSet()[i]).map(p => ({ url: p[q], name: p.name })).filter(f => f.url); if (list.length) saveFiles(list, 'photo'); },
  dSaveUrl(url, name) { saveFiles([{ url, name }], /\.(mp4|mov|m4v)$/i.test(name) ? 'video' : 'photo'); },
  dVideo(i) {
    const v = D.data.videos[i], go = () => saveFiles([{ url: v.download, name: `${D.data.head.address}.mp4` }], 'video');
    if (!isPhone()) return go();
    // phones: confirm first, then the video is fetched and the share sheet saves it to Photos
    dModal(`<h2 style="font-size:22px;margin-bottom:8px">Save this video to your Camera Roll?</h2>
      <p class="hint" style="margin:0 0 14px">It saves straight to the Photos app on this phone. Videos can take a minute to get ready.</p>
      <div class="nav"><button class="btn o" onclick="kv.closeModal()">Cancel</button><button class="btn" id="dlVidGo">${ic(I.dl, 16)} ${ROLL}</button></div>`);
    $('dlVidGo').onclick = go;
  },
  async dShare(url, title) {
    if (navigator.share) { try { await navigator.share({ title, url }); return; } catch (e) { if (e?.name === 'AbortError') return; } }
    kv.dCopy(url, 'Link');
  },
  dCopy(text, what) { (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast(`${what} copied`), () => { prompt(`Copy the ${what.toLowerCase()}:`, text); }); },
  dEmbed(i) { const v = D.data.videos[i]; kv.dCopy(`<iframe src="${v.embed}" width="100%" height="${v.portrait ? 720 : 405}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`, 'Embed code'); },
  dQR(url, title) {
    dModal(`<h2 style="font-size:22px;margin-bottom:12px">${esc(title)}</h2><img src="https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=10&data=${encodeURIComponent(url)}" alt="QR code" style="width:100%;max-width:300px;display:block;margin:0 auto;border-radius:12px">
      <p class="hint" style="text-align:center">Scan with a phone camera, or save the image for flyers and signs.</p>
      <div class="nav"><a class="btn o" href="https://api.qrserver.com/v1/create-qr-code/?size=1200x1200&margin=20&format=png&data=${encodeURIComponent(url)}" target="_blank" rel="noopener">Full size</a><button class="btn" onclick="kv.closeModal()">Done</button></div>`);
  },
});

Object.assign(window.kv, {
  ui(k, v) { UI[k] = v; render(); },
  search(k, v, id) { UI[k] = v; render(); const el = $(id); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } },
  menu(ev) { ev?.stopPropagation(); UI.menu = !UI.menu; render(); },
  reloadPortal() { S.pdata = null; loadPortal(); },
  invoiceFor(n) { location.hash = '#invoices/' + n; },
  orderAgain(key) {
    const l = findListing(key); if (!l) return;
    if (l.b) Object.assign(S.addr, { street: l.b.address || '', unit: l.b.unit || '', city: l.b.city || '', state: l.b.state || 'TN', zip: l.b.zip || '' });
    else Object.assign(S.addr, { street: l.line1, city: l.line2 });
    S.step = 0; S.view = 'book'; resetSchedule(); location.hash = '#order'; render(); window.scrollTo({ top: 0 });
  },
  details(key) {
    const l = findListing(key); if (!l) return; const b = l.b;
    const media = l.media.some(m => m.delivered) ? `<p style="margin:0"><a class="btn" href="#delivery/${l.key}" onclick="kv.closeModal()" style="text-decoration:none">Open media & downloads</a></p>` : '<p class="hint">Media will appear here once it is delivered.</p>';
    $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel" style="max-width:540px">
      <h2 style="font-size:24px">${esc(l.line1)}</h2><div class="hint" style="margin:2px 0 12px">${esc(l.line2)}${b ? ` · Order ${esc(ono(b))}` : ''}</div>
      <span class="pill ${l.status[1]}">${esc(l.status[0])}</span>
      <dl class="review">${l.date ? `<dt>${b ? 'Shoot' : 'Date'}</dt><dd>${esc(new Date(l.date).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', ...(b ? { hour: 'numeric', minute: '2-digit' } : {}) }))}</dd>` : ''}
        ${b ? `<dt>Services</dt><dd>${(b.items || []).map(i => `<div class="line"><span>${esc(i.name)}</span><span>${money(i.price)}</span></div>`).join('')}<div class="tot"><span>Total</span><span>${money(b.total)}</span></div></dd>` : ''}
        <dt>Media</dt><dd>${media}</dd></dl>
      <div class="nav"><button class="btn o" onclick="kv.closeModal()">Close</button>${b && !b.paid ? `<button class="btn" onclick="kv.closeModal();kv.payBooking('${b.id}')">Pay ${money(b.total)}</button>` : ''}</div></div></div>`;
  },
  // open / close a profile section in place (no re-render, so unsaved typing stays)
  async setNotify(k, on) {
    const prev = { ...(S.notify || {}) }, msg = $('ntMsg');
    const sync = n => { document.querySelectorAll('[data-nt]').forEach(el => { el.checked = el.dataset.nt === 'all' ? NT_KEYS.every(x => n[x]) : !!n[el.dataset.nt]; }); };
    S.notify = { ...prev, ...(k === 'all' ? Object.fromEntries(NT_KEYS.map(x => [x, on])) : { [k]: on }) }; sync(S.notify);
    try {
      const r = await api('notify', Object.fromEntries(NT_KEYS.map(x => [x, !!S.notify[x]])), 'client-photo');
      S.notify = r.notify; sync(S.notify);
      if (msg) { msg.textContent = 'Saved.'; msg.classList.add('ok'); clearTimeout(UI.ntT); UI.ntT = setTimeout(() => { msg.classList.remove('ok'); msg.textContent = NT_NOTE; }, 2200); }
    } catch (e) { S.notify = prev; sync(prev); if (msg) { msg.textContent = e.message; msg.classList.remove('ok'); } }
  },
  acc(k, on) {
    UI.sec = { ...(UI.sec || {}), [k]: on };
    const btn = document.querySelector(`.acc-h[onclick*="'${k}'"]`); if (!btn) return render();
    const sec = btn.closest('.acc'); sec.classList.toggle('open', on); btn.setAttribute('aria-expanded', on);
    btn.setAttribute('onclick', `kv.acc('${k}', ${!on})`); sec.querySelector('.acc-b').hidden = !on;
  },
  // birthday: the day list follows the month (Feb has 29 so Feb 29 birthdays work)
  bdayMonth(m) {
    const sel = $('st_bd'); if (!sel) return; const keep = +sel.value || 0;
    const n = m ? [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] : 31;
    sel.innerHTML = '<option value="">Day</option>' + Array.from({ length: n }, (_, i) => `<option ${keep === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('');
  },
  async saveProfile(ev) {
    ev.preventDefault();
    const v = k => ($('st_' + k)?.value || '').trim();
    S.busy = true; S.error = ''; UI.saved = false; render();
    try {
      if (!v('first') || !v('last')) throw new Error('Enter your first and last name.');
      const ex = await api('extras', { first_name: v('first'), last_name: v('last'), website_url: v('website'), birth_month: v('bm'), birth_day: v('bd') }, 'client-photo');
      S.extras = ex.extras;
      const r = await api('profile', { full_name: `${v('first')} ${v('last')}`, phone: v('phone'), brokerage: v('brokerage'), team_name: v('team_name') });
      setAgent(r.agent); fillContact(); UI.saved = true;
    } catch (e) { S.error = e.message; }
    S.busy = false; render();
  },
});
document.addEventListener('click', () => { if (UI.menu) { UI.menu = false; render(); } });
function fillContact() {
  if (!S.agent) { if (S.session) S.contact.email = S.session.user.email; return; }
  const [first, ...rest] = (S.agent.full_name || '').split(' ');
  Object.assign(S.contact, { first: first || '', last: rest.join(' '), email: S.agent.email || S.session?.user?.email || '', phone: S.agent.phone || '', brokerage: S.agent.brokerage || '' });
}

// "I have a coupon code" box on the review step (same style as the account credit box)
function vCoupon() {
  const c = S.cp, ap = c.applied;
  return `<div class="cp-box${c.on ? ' on' : ''}" style="margin-top:14px">
    <label class="cr-box cp-tick"><input type="checkbox" ${c.on ? 'checked' : ''} onchange="kv.cpOn(this.checked)">
      <span><b>I have a coupon code</b>${ap && couponOff() ? `<small class="cr-txt">${esc(ap.code)} applied · ${esc(ap.label)} · you save ${money2(couponOff())}</small>` : ''}</span></label>
    ${c.on ? (ap ? `<div class="cp-row"><span class="cp-code">${esc(ap.code)}</span><button type="button" class="btn o sm" onclick="kv.cpRemove()">Remove</button></div>`
      : `<div class="cp-row"><input id="cpCode" value="${esc(c.code)}" placeholder="Coupon code" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="40"
          oninput="kv.cpType(this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();kv.cpApply()}">
        <button type="button" class="btn sm" onclick="kv.cpApply()" ${c.busy ? 'disabled' : ''}>${c.busy ? '<span class="spin"></span>' : 'Apply'}</button></div>`) : ''}
    ${c.on && c.err ? `<div class="msg err" style="margin:8px 0 0">${esc(c.err)}</div>` : ''}
  </div>`;
}

function vSummary(btn) {
  const ls = lines();
  return `${btn ? '' : `<button class="sheet-x" onclick="document.getElementById('sheet').classList.remove('on')" aria-label="Close">Done</button>`}<h2>Your order</h2>
    ${ls.length ? ls.map(l => `<div class="line"><span>${esc(l.name)}</span><span>${money(l.price)}</span></div>${(l.subs || []).map(s => `<div class="line sub"><span>${esc(s)}</span><span>incl.</span></div>`).join('')}`).join('') : '<div class="empty">Choose a package or service to get started.</div>'}
    ${couponOff() ? `<div class="line cp-line"><span>Coupon ${esc(S.cp.applied.code)}</span><span>−${money2(couponOff())}</span></div>` : ''}
    <div class="tot"><span>Total</span><span>${couponOff() ? money2(total()) : money(total())}</span></div>
    ${S.startLabel && S.step >= 2 ? `<div class="note">${new Date(S.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${esc(S.startLabel)}</div>` : ''}
    ${btn && S.step < 3 ? `<button class="btn" onclick="kv.go(${S.step + 1})" ${isValid(S.step) ? '' : 'disabled'}>Continue</button>` : ''}`;
}

/* ================= render ================= */
// ================= One-page order form =================
// Home size → check services → property address → pick a time → your details → Submit. All on one page;
// each part appears once the one above it is filled in.
const addrOk = () => { const a = S.addr; return !!(a.street && a.city && a.state && /^\d{5}$/.test(a.zip || '')); };
const detailsOk = () => isValid(3);
function nextMissing() { // first section still needing an answer
  if (!S.ptype || S.ptype === 'str') return 'o-type';
  if (!S.addr.sqftLabel) return 'o-size';
  if (!inCart().size) return 'o-svc';
  if (!addrOk()) return 'o-addr';
  if (!S.start) return 'o-time';
  if (!detailsOk()) return 'o-you';
  return null;
}
function checkAll() { // before submitting: flag what's missing and jump to it
  validate(0); const e0 = { ...S.errors }; validate(3); S.errors = { ...e0, ...S.errors };
  const miss = nextMissing();
  if (miss) { S.error = ''; render(); document.getElementById(miss)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return false; }
  return true;
}
const oh = (id, n, title, sub = '') => `<div class="o-h" id="${id}"><span class="o-n">${n}</span><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div></div>`;
function vOne() {
  const a = S.addr, st = S.config.settings, land = isLand(), opts = land ? ACRE_OPTIONS : (st.sqft_options || []);
  const pg = PAGE();
  const tRow = (t, name, sub) => `<button class="tcard ${S.ptype === t ? 'sel' : ''}" onclick="kv.ptype('${t}')" aria-pressed="${S.ptype === t}">
      <span class="tc-img">${t === 'custom' ? (pg.cover_url ? `<img src="${esc(pg.cover_url)}" alt="" decoding="async">` : `<span class="tc-ph">${esc(pg.title)}</span>`) : `<img src="/img/type-${t === 'home' ? 'listing' : t}.jpg?v=3" alt="" decoding="async">`}<span class="tick">${CHECK}</span></span>
      <span class="tc-n">${name}</span></button>`;
  const type = `<section class="o-sec">${oh('o-type', 1, 'Choose your media')}
    ${!pg || pg.show_default ? `<div class="tcards">${tRow('home', 'Listing Media', '') + tRow('land', 'Land Media', '')}</div>` : ''}
    ${pg ? `<div class="mine${pg.show_default ? '' : ' only'}">${pg.show_default ? '<p class="mine-k"><span>Made for you</span></p>' : ''}
      <button class="mcard ${S.ptype === 'custom' ? 'sel' : ''}" onclick="kv.ptype('custom')" aria-pressed="${S.ptype === 'custom'}">
        <span class="mc-img">${pg.cover_url ? `<img src="${esc(pg.cover_url)}" alt="" decoding="async">` : `<span class="tc-ph">${esc(pg.title)}</span>`}</span>
        <span class="mc-t"><b>${esc(pg.title)}</b>${pg.welcome ? `<span class="mc-w">${esc(pg.welcome)}</span>` : ''}<span class="mc-go">${S.ptype === 'custom' ? 'Selected' : 'View your packages'} <i aria-hidden="true">→</i></span></span>
        <span class="tick">${CHECK}</span></button></div>` : ''}
    ${S.ptype === 'str' ? `<div class="soon"><b>Short-term rental media is coming soon.</b> Text us at <a href="${SMS_LINK}">865-855-5669</a> and we'll set up your shoot.</div>` : ''}</section>`;
  if (S.ptype === 'str') return type;
  const haveSvc = inCart().size > 0, aOk = addrOk();
  const size = !S.ptype ? '' : `<section class="o-sec">${oh('o-size', 2, land ? 'Land size' : 'Home size', land ? 'Total acreage' : 'Heated square feet')}
    <div class="list">${opts.map(o => `<button class="row ${a.sqftLabel === o.label ? 'sel' : ''}" onclick="kv.size(${esc(JSON.stringify(o.label))})" aria-pressed="${a.sqftLabel === o.label}">
      <span class="box rad">${CHECK}</span><span class="row-t"><span class="row-n">${esc(o.label)}</span></span></button>`).join('')}</div></section>`;
  const svcs = a.sqftLabel ? `<section class="o-sec">${oh('o-svc', 3, 'Services', land ? 'Choose a land package' : 'Check a package, or pick individual services')}${vServices(true)}</section>` : '';
  // Add-ons: listing media only, once a package is picked (services not already in the package)
  const cov = covered(), adds = !land && S.pkg ? addonList().filter(x => !cov.has(x.id)) : [];
  const addons = adds.length ? `<section class="o-sec">${oh('o-add', 4, 'Add-ons', `Optional extras for your ${esc(svc(S.pkg).name)} package`)}
    <div class="list">${adds.map(x => { const on = S.items.has(x.id); return `<div class="ad-w ${on ? 'on' : ''}"><button class="row ad ${on ? 'sel' : ''}" onclick="kv.toggle('${x.id}')" aria-pressed="${on}">
      <span class="box">${CHECK}</span><span class="row-t"><span class="row-n">${esc(x.name)}</span></span>
      <span class="row-p">+${money(x.price)}</span></button>
      ${on && x.description ? `<div class="ad-x"><p>${esc(x.description)}</p></div>` : ''}</div>`; }).join('')}</div></section>` : '';
  const nA = addons ? 5 : 4;
  const addr = a.sqftLabel && haveSvc ? `<section class="o-sec">${oh('o-addr', nA, 'Property address')}
    <div class="panel"><div class="fg pairs">
      ${field('street', 'Street address', 'addr', { full: true, ph: 'Start typing the address', ac: 'off' })}
      ${land ? field('unit', 'Parcel ID', 'addr', { req: false, ph: 'Optional', ac: 'off' }) : field('unit', 'Unit / Lot', 'addr', { req: false, ph: 'Optional', ac: 'address-line2' })}
      ${field('city', 'City', 'addr', { ph: 'Knoxville', ac: 'address-level2' })}
      ${field('state', 'State', 'addr', { pair: true, options: ['TN', 'NC', 'GA', 'KY', 'VA'] })}
      ${field('zip', 'ZIP', 'addr', { pair: true, ph: '37902', im: 'numeric', ac: 'postal-code' })}
      ${land ? '' : field('occupancy', 'Occupancy', 'addr', { req: false, options: ['Vacant', 'Owner occupied', 'Tenant occupied'], ph: 'Select (optional)' })}
      ${field('access', 'Access notes', 'addr', { full: true, req: false, area: true, ph: land ? 'Gate code, where to park, corners or boundary markers, who will be there…' : 'Lockbox code, gate code, pets, who will be there…' })}
      ${land ? vUpload() : ''}
    </div></div></section>` : '';
  const time = a.sqftLabel && haveSvc && aOk ? `<section class="o-sec">${oh('o-time', nA + 1, 'Pick a time')}${vSchedule(true)}</section>` : '';
  const you = a.sqftLabel && haveSvc && aOk && S.start ? `<section class="o-sec" id="o-you">${vReview(true)}</section>` : '';
  return type + size + svcs + addons + addr + time + you + (S.error && !S.start ? `<div class="msg err">${esc(S.error)}</div>` : '');
}
function updBar() { // bottom button: names the next thing to do, then "Submit Order"
  const nb = $('barNext'); if (!nb) return;
  nb.textContent = S.checkout ? 'Pay & Submit' : { 'o-type': 'Choose your media', 'o-size': isLand() ? 'Choose land size' : 'Choose home size', 'o-svc': 'Choose services', 'o-addr': 'Enter address', 'o-time': 'Pick a time', 'o-you': 'Your details' }[nextMissing()] || 'Submit Order';
  nb.disabled = !!S.busy;
}
function oneAfterRender() { // load open times once services + address are in; keep the order form and bar in sync
  if (S.view !== 'book') return;
  const key = JSON.stringify(selection());
  if (inCart().size && S.addr.sqftLabel && addrOk() && !S.slots && !S.slotsLoading && S.slotsKey !== key) { S.slotsKey = key; loadSlots(); }
}
document.addEventListener('change', e => { // when the address becomes complete (or incomplete), show/hide the calendar
  if (S.view !== 'book' || e.target.dataset?.o !== 'addr' || !['street', 'city', 'state', 'zip'].includes(e.target.dataset.k)) return;
  const ok = addrOk(); if (ok === !!S.addrWasOk) return;
  S.addrWasOk = ok; resetSchedule(); render();
  if (ok) setTimeout(() => document.getElementById('o-time')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
});

/* ================= payment link page (/pay/<order share token>) =================
   An invoice anyone can pay without signing in (e.g. an agent forwards it to their office or the seller).
   Shows the invoice, takes the card through Stripe, then thanks them and links to the download page. */
const PAYTOK = (location.pathname.match(/^\/pay\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i) || [])[1] || null;
const PL = { data: null, err: '', loading: false, paying: false, elements: null, secret: null, done: false };
async function loadPayLink() {
  PL.loading = true; render();
  try { PL.data = await api('share-invoice', { token: PAYTOK }); if (PL.data) document.title = `Invoice ${ono(PL.data)} · Knox View`; } catch (e) { PL.err = e.message; }
  PL.loading = false; render();
}
function vPayLink() {
  if (PL.loading || (!PL.data && !PL.err)) return '<div class="panel loading"><span class="spin"></span> Getting the invoice…</div>';
  if (PL.err) return `<div class="msg err">${esc(PL.err)}</div>`;
  const d = PL.data, paid = d.paid || PL.done;
  const line = (k, v, cls = '') => `<div class="pl-row ${cls}"><span>${k}</span><span>${v}</span></div>`;
  return `<section class="panel pl">
    <div class="pl-top"><div><p class="pl-k">Invoice ${esc(ono(d))}</p><h1>${esc(d.title || d.address)}</h1>
      <p class="hint">${esc([d.title ? d.address : '', d.line2].filter(Boolean).join(', '))}${d.client ? ` · ${esc(d.client)}` : ''}</p></div>
      <span class="pl-badge ${paid ? 'ok' : ''}">${paid ? 'Paid' : 'Due'}</span></div>
    <div class="pl-amt"><span>${paid ? 'Amount paid' : 'Amount due'}</span><b>${money2(paid ? d.total - d.credit : d.due)}</b></div>
    <div class="pl-links"><button type="button" class="pl-link" id="plPdf" onclick="kv.plPdf()">${ic(I.inv, 16)} View invoice PDF</button><a class="pl-link" href="/d/${PAYTOK}">${ic(I.dl, 16)} View download page</a></div>
    ${paid ? `<div class="msg ok pl-done"><b>${PL.done ? 'Payment received. Thank you!' : 'This invoice is paid. Thank you!'}</b> A receipt is on its way by email.</div>
        `
      : `<div id="plPay">${PL.secret ? '' : `<button class="btn pl-go" id="plStart" onclick="kv.plStart()">Pay ${money2(d.due)}</button>`}</div>
        <div id="plErr"></div>
        <p class="hint pl-sec">${ic(I.lock, 13)} Secure payment by Stripe. No account or sign-in needed.</p>`}
  </section>
  <p class="hint" style="text-align:center;margin-top:14px">Questions? Call or text <a href="tel:+18658555669">865-855-5669</a></p>`;
}
Object.assign(window.kv, {
  async plPdf() { // invoice PDF, opened in a new tab (or downloaded where tabs aren't allowed)
    const btn = $('plPdf'), win = window.open('about:blank', '_blank'); btn.disabled = true;
    try {
      const r = await api('share_pdf', { token: PAYTOK }, 'invoices');
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(r.base64), c => c.charCodeAt(0))], { type: 'application/pdf' }));
      if (win) win.location.href = url; else Object.assign(document.createElement('a'), { href: url, download: r.filename || 'invoice.pdf' }).click();
    } catch (e) { if (win) win.close(); alert(e.message); }
    btn.disabled = false;
  },
  async plStart() {
    if (!stripeReady()) { $('plErr').innerHTML = '<div class="msg err">Online payments are not switched on yet. Please call 865-855-5669.</div>'; return; }
    const b = $('plStart'); if (b) { b.disabled = true; b.textContent = 'Loading…'; }
    try {
      const r = await api('share-pay', { token: PAYTOK });
      if (r.alreadyPaid) { PL.done = true; return loadPayLink(); }
      PL.secret = r.clientSecret; PL.bk = r.booking;
      $('plPay').innerHTML = `<div id="plEl" style="margin-top:6px"></div><button class="btn pl-go" id="plGo">Pay ${money2(r.booking.total)}</button>`;
      PL.elements = stripe.elements({ clientSecret: r.clientSecret, appearance });
      PL.elements.create('payment').mount('#plEl');
      $('plGo').onclick = async () => {
        $('plGo').disabled = true; $('plErr').innerHTML = '';
        const { error } = await stripe.confirmPayment({ elements: PL.elements, confirmParams: { return_url: location.origin + location.pathname }, redirect: 'if_required' });
        if (error) { $('plErr').innerHTML = `<div class="msg err">${esc(error.message)}</div>`; $('plGo').disabled = false; return; }
        await api('confirm', { bookingId: PL.bk.id, token: PL.bk.token }).catch(() => {});
        PL.done = true; PL.secret = null; loadPayLink();
      };
    } catch (e) { $('plErr').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; if (b) { b.disabled = false; b.textContent = 'Try again'; } }
  },
});

/* ================= property website editor =================
   Each completed order gets a single property website: listing.knoxview.com/<address> (branded, with the client's
   photo, logo and contact details) and /<address>/mls (unbranded). Clients edit the listing details here; the
   `listing` function saves them and the page updates within a couple of minutes. */
I.globe2 = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>';
const SITE_ICONS = { price: 'Price ($)', bed: 'Beds', bath: 'Baths', size: 'Size', lot: 'Lot', year: 'Year built', garage: 'Garage', home: 'Home', pool: 'Pool', view: 'View', star: 'Star' };
const SE = { id: null, data: null, saving: false };
async function siteEdit(id) {
  SE.id = id; SE.data = null;
  $('modal').innerHTML = `<div class="modal se-modal"><div class="panel se"><div class="panel loading"><span class="spin"></span> Loading your property website…</div></div></div>`;
  try { SE.data = await api('editor', { bookingId: id }, 'listing'); siteDraw(); }
  catch (e) { $('modal').innerHTML = `<div class="modal"><div class="panel"><p>${esc(e.message)}</p><div class="nav"><span></span><button class="btn" onclick="kv.closeModal()">OK</button></div></div></div>`; }
}
function siteLink(label, sub, url) {
  return `<div class="se-link"><div><b>${label}</b><small>${sub}</small><code>${esc(url.replace('https://', ''))}</code></div>
    <div class="se-lbtns"><button class="btn sm" onclick="kv.dCopy(${esc(JSON.stringify(url))}, '${label} link')">${ic(I.copy, 15)} Copy</button>
    <a class="btn o sm" href="${esc(url)}${SE.data.live ? '' : '?preview=' + encodeURIComponent(SE.data.preview)}" target="_blank" rel="noopener">${ic(I.ext, 15)} ${SE.data.live ? 'Open' : 'Preview'}</a></div></div>`;
}
function siteDraw() {
  const d = SE.data, s = d.site;
  const note = !d.live ? `<p class="msg info" style="margin:0 0 14px">${d.locked ? 'Your website goes live as soon as this order is paid. Until then only you can preview it.' : 'Your website isn’t live yet. Only you can preview it.'}</p>` : '';
  $('modal').innerHTML = `<div class="modal se-modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel se">
    <div class="se-head"><div><h2>Property Website</h2><p class="hint">${d.views ? `${Number(d.views).toLocaleString()} view${d.views === 1 ? '' : 's'} so far` : 'Share it anywhere: texts, social, email.'}</p></div>
      <button class="se-x" onclick="kv.closeModal()" aria-label="Close">${ic(I.xc, 22)}</button></div>
    ${note}
    ${d.links ? siteLink('Branded', 'With your photo, logo and contact info', d.links.branded) + siteLink('MLS', 'Unbranded, safe for the MLS', d.links.mls) : ''}
    <h3 class="se-h">Listing details</h3>
    <label class="se-f">Design<select id="seTpl">${Object.entries(d.templates || { cooper: 'The Cooper' }).map(([k, l]) => `<option value="${k}" ${s.template === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <label class="se-f">Title<input id="seTitle" maxlength="140" value="${esc(s.title || '')}" placeholder="123 Main St"></label>
    <label class="se-f">Subtitle<input id="seSub" maxlength="160" value="${esc(s.subtitle || '')}" placeholder="Gatlinburg, TN 37738"></label>
    <div class="se-facts" id="seFacts">${s.facts.map((f, i) => `<div class="se-fact ${f.show === false ? 'off' : ''}" data-i="${i}">
      <select aria-label="Icon" data-k="icon">${Object.entries(SITE_ICONS).map(([k, l]) => `<option value="${k}" ${f.icon === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input data-k="label" maxlength="40" value="${esc(f.label || '')}" placeholder="Label" aria-label="Label">
      <input data-k="value" maxlength="60" value="${esc(f.value || '')}" placeholder="${f.icon === 'price' ? '$450,000' : f.icon === 'size' ? '2,400 sq ft' : f.icon === 'lot' ? '1.2 acres' : 'Value'}" aria-label="${esc(f.label || 'Value')}" ${f.icon === 'price' ? 'inputmode="decimal"' : ''}>
      <div class="se-fbtns"><button type="button" title="Move up" onclick="kv.siteMove(${i},-1)" ${i ? '' : 'disabled'}>↑</button><button type="button" title="Move down" onclick="kv.siteMove(${i},1)" ${i < s.facts.length - 1 ? '' : 'disabled'}>↓</button>
        <label class="se-show" title="Show on the website"><input type="checkbox" data-k="show" ${f.show !== false ? 'checked' : ''}> Show</label></div></div>`).join('')}</div>
    <button type="button" class="btn o sm" onclick="kv.siteAddFact()" ${s.facts.length >= 12 ? 'disabled' : ''}>+ Add a detail</button>
    <label class="se-f" style="margin-top:16px">Description<textarea id="seDesc" rows="7" maxlength="6000" placeholder="Tell buyers what makes this home special. Leave a blank line between paragraphs.">${esc(s.description || '')}</textarea></label>
    <p class="hint" style="margin:-4px 0 0">Your name, photo, logo and phone come from your profile. Change them in Profile.</p>
    <div class="nav se-nav"><button class="btn o" onclick="kv.closeModal()">Close</button><button class="btn" id="seSave" onclick="kv.siteSave()">Save changes</button></div>
  </div></div>`;
}
function siteRead() { // the form back into SE.data.site
  const s = SE.data.site;
  s.title = $('seTitle').value; s.subtitle = $('seSub').value; s.description = $('seDesc').value; if ($('seTpl')) s.template = $('seTpl').value;
  document.querySelectorAll('.se-fact').forEach(row => { const f = s.facts[+row.dataset.i];
    row.querySelectorAll('[data-k]').forEach(el => { f[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; }); });
}
function siteMove(i, d) { siteRead(); const f = SE.data.site.facts, j = i + d; if (j < 0 || j >= f.length) return; [f[i], f[j]] = [f[j], f[i]]; siteDraw(); }
function siteAddFact() { siteRead(); SE.data.site.facts.push({ k: 'f' + Date.now().toString(36), icon: 'star', label: '', value: '', show: true }); siteDraw(); const r = [...document.querySelectorAll('.se-fact [data-k=label]')].pop(); r?.focus(); }
async function siteSave() {
  siteRead(); const btn = $('seSave'); btn.disabled = true; btn.textContent = 'Saving…';
  try { const r = await api('save', { bookingId: SE.id, site: SE.data.site }, 'listing'); SE.data.site = r.site; siteDraw(); toastMsg('Saved. Your website updates in a minute or two.'); }
  catch (e) { btn.disabled = false; btn.textContent = 'Save changes'; alert(e.message); }
}
function toastMsg(m) { let t = $('kvToast'); if (!t) { t = document.createElement('div'); t.id = 'kvToast'; t.className = 'kv-toast'; document.body.appendChild(t); }
  t.textContent = m; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2600); }
Object.assign(window.kv, { siteEdit, siteMove, siteAddFact, siteSave });

function render() {
  document.body.classList.toggle('dlx', S.view === 'delivery');
  if (S.view === 'paylink') { // payment link page: its own simple page
    document.body.classList.remove('landing'); $('landing').innerHTML = ''; vHeader();
    document.body.classList.add('in-portal'); $('main').classList.add('one'); $('main').classList.remove('wide');
    $('side').style.display = 'none'; $('steps').style.display = 'none'; $('bar').style.visibility = 'hidden';
    if (!PL.secret || !$('plEl')) $('view').innerHTML = vPayLink(); // don't re-render over the card form
    return;
  }
  const portal = PORTAL_VIEWS.includes(S.view), acct = S.view === 'account' || portal, done = S.view === 'done';
  const landing = S.view === 'account' && !S.loading;
  document.body.classList.toggle('landing', landing);
  if (landing) { $('landing').innerHTML = vLanding(); return; }
  $('landing').innerHTML = '';
  vHeader();
  document.body.classList.toggle('in-portal', portal);
  $('main').classList.toggle('one', acct || done);
  $('main').classList.toggle('wide', portal);
  $('side').style.display = acct || done ? 'none' : '';
  $('steps').style.display = acct || done ? 'none' : '';
  $('bar').style.visibility = acct || done || S.loading ? 'hidden' : 'visible';
  if (S.loading) return;
  if (portal) { $('view').innerHTML = vPortalOrDelivery(); return; }
  if (acct) { $('view').innerHTML = vAccount(); return; }
  if (done) { $('view').innerHTML = vDone(); return; }
  $('steps').innerHTML = STEPS.map((s, i) => `<button class="step ${S.step === i ? 'on' : ''} ${S.step > i ? 'done' : ''}" ${canReach(i) && !S.busy ? '' : 'disabled'} onclick="kv.go(${i})"><b>${S.step > i ? '✓' : i + 1}</b><span class="lbl">${s}</span></button>`).join('');
  S.step = 3; $('steps').style.display = 'none';
  if (S.checkout?.elements && $('pay-el')?.childElementCount) {
    // Stripe's card form is mounted: patch only the error and buttons so the iframe isn't reloaded
    const tmp = document.createElement('div'); tmp.innerHTML = vReview(true);
    $('revErr').innerHTML = tmp.querySelector('#revErr').innerHTML;
    $('revNav').innerHTML = tmp.querySelector('#revNav').innerHTML;
  } else {
    $('view').innerHTML = vOne();
  }
  $('sumDesk').innerHTML = vSummary(true);
  $('sumMob').innerHTML = vSummary(false);
  $('barTot').textContent = money(total());
  $('barSub').textContent = lines().length ? lines().map(l => l.name).join(' · ') : 'Nothing selected';
  const nb = $('barNext');
  updBar();
  nb.onclick = () => { const m = nextMissing(); S.checkout ? confirmPay() : m ? document.getElementById(m)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : submitOrder(); };
  oneAfterRender();
}
document.addEventListener('input', e => {
  const o = e.target.dataset?.o, k = e.target.dataset?.k; if (!o) return;
  S[o][k] = e.target.value;
  if (S.errors[k]) { delete S.errors[k]; e.target.parentElement.classList.remove('err'); }
  if (k === 'sqftLabel') { resetSchedule(); render(); }
  if (S.view === 'book') updBar();
});
$('barOpen').onclick = () => $('sheet').classList.add('on');
$('sheet').onclick = e => { if (e.target.id === 'sheet') e.currentTarget.classList.remove('on'); };

function route() {
  S.error = '';
  // Payment link page (/pay/<token>): links clicked from it (Book now, Sign in…) go to the portal.
  if (PAYTOK) {
    const t = location.hash.replace('#', '');
    if (t) { location.href = '/#' + t; return; }
    UI.menu = false; S.view = 'paylink';
    if (!PL.data && !PL.loading && !PL.err) loadPayLink(); else render();
    return;
  }
  // Share link page (/d/<token>): always the delivery page. Other links clicked from it (Book now, Sign in…) go to the portal.
  if (SHARE) {
    const t = location.hash.replace('#', '');
    if (t && !DL_TABS.includes(t)) { location.href = '/#' + t; return; }
    UI.menu = false; S.view = 'delivery'; if (t) D.tab = t;
    if (D.key !== SHARE || (!D.data && !D.loading)) loadDelivery(SHARE); else render();
    return;
  }
  const [h, hKey, hTab] = location.hash.replace('#', '').split('/');
  UI.menu = false; UI.saved = false;
  if (h === 'account' && S.session) { location.replace('#listings'); return; }
  if (h === 'settings') { location.replace('#profile'); return; }
  if (S.session && !INV.data && h !== 'invoices') loadInvoices(true);
  // Signed-in clients land on their Listings (first sign-in and every time they come back)
  if (!h && S.session && S.view !== 'done' && !S.busy) { location.replace('#listings'); return; }
  if (PORTAL_VIEWS.includes(h)) {
    if (!S.session) { S.after = location.hash; S.view = 'account'; }
    else {
      S.view = h; if (!S.pdata && h !== 'delivery') loadPortal();
      if (h === 'invoices') { UI.inv = hKey && /^\d+$/.test(hKey) ? hKey : null; loadInvoices(!!INV.data); }
      if (h === 'delivery') { if (hKey && (hKey !== S.dl.key || !S.dl.data)) loadDelivery(hKey); S.dl.tab = hTab || S.dl.tab; if (hKey !== S.dl.key) S.dl.tab = hTab || null; }
    }
  } else S.view = h === 'account' ? 'account' : S.view === 'done' && !h ? 'done' : 'book';
  render(); if (PORTAL_VIEWS.includes(S.view) || S.view === 'account') window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

/* ================= boot ================= */
(async function boot() {
  try {
    // HQ → "Open as test client" / "Client's download page" / "View invoice" hands a session over in the URL fragment
    // (never sent to a server). Optional &go= says where to land: delivery/<order id> or invoice/<order number>.
    const hand = location.hash.match(/^#ts=([\w-]+)(?:&go=([\w\/-]+))?$/);
    if (hand) {
      try { const t = JSON.parse(atob(hand[1].replace(/-/g, '+').replace(/_/g, '/'))); await sb.auth.setSession({ access_token: t.a, refresh_token: t.r });
        try { sessionStorage.setItem('kv.team', '1'); sessionStorage.setItem('kv.visit', '1'); const u = (await sb.auth.getUser()).data?.user?.id; if (u) localStorage.setItem('kv.teamUid', u); } catch (_) {}
        logAct('team_view', 'Knox View opened the portal as this client (Access agent)'); }
      catch (e) { console.warn('session handoff failed', e); }
      const go = hand[2] || '', inv = go.match(/^invoice\/(\d+)(\/paid)?$/);
      if (inv) UI.itab = inv[2] ? 'paid' : 'pending';
      history.replaceState(null, '', location.pathname + (/^delivery\/[\w-]+$/.test(go) ? '#' + go : inv ? '#invoices/' + inv[1] : '#listings'));
    }
    const load = () => Promise.all([
      sb.from('booking_services').select('id, kind, name, description, includes, price, duration_min, covers, badge, sort_order, category, large_fee').order('sort_order'),
      sb.from('booking_upsells').select('service_id, title, description, show_when_any, hide_when_any, sort_order').order('sort_order'),
      api('config'),
      sb.auth.getSession(),
    ]);
    let [svcs, ups, cfg, sess] = await load();
    // A broken or fake saved sign-in makes every request fail. Forget it on this device and load again, signed out.
    if (svcs.error && (svcs.error.code === 'PGRST301' || /jwt|token/i.test(svcs.error.message || ''))) {
      console.warn('Saved sign-in is no longer valid; signing out on this device', svcs.error.message);
      await sb.auth.signOut({ scope: 'local' }).catch(() => {});
      try { Object.keys(localStorage).filter(k => /^sb-.+-auth-token$/.test(k)).forEach(k => localStorage.removeItem(k)); } catch (_) {}
      [svcs, ups, cfg, sess] = await load();
    }
    if (svcs.error) throw svcs.error;
    S.services = S.baseServices = svcs.data; S.upsells = ups.data || []; S.config = cfg; S.session = sess.data.session; applyPage();
    if (cfg.stripe?.mode === 'test') $('testbar').hidden = false;
    if (S.session) {
      try { if (!sessionStorage.getItem('kv.visit')) { sessionStorage.setItem('kv.visit', '1'); logAct('visit', 'Opened the portal (already signed in)'); } } catch (_) {}
      const l = await api('link').catch(() => ({}));
      S.agent = l.agent; fillContact(); loadPhoto();
    }
    sb.auth.onAuthStateChange((_e, session) => {
      const was = !!S.session; S.session = session;
      if (session && !was) { api('link').then(l => { S.agent = l.agent; fillContact(); route(); loadPhoto(); }).catch(() => route()); reloadPage(); }
    });
    S.loading = false;
    // Returning from a bank redirect (3-D Secure etc.)
    const q = new URLSearchParams(location.search);
    if (q.get('b') && q.get('t')) { S.busy = true; await finishBooking(q.get('b'), q.get('t')); }
    route();
  } catch (e) {
    $('view').innerHTML = `<div class="msg err">We couldn't load the booking form. Please refresh, or call ${esc(CFG.phone)}.</div>`;
    console.error(e);
  }
})();

/* ================= Google address search (Places API New) =================
   Type a street address and pick a suggestion: street, unit, city, state and ZIP fill in.
   Billed per session (typing + one lookup); our volume stays inside Google's free monthly allowance. */
const GKEY = 'AIzaSyDI1r8ag79AVBBQhJftX9j5zpSnErm0mQY'; // browser key, locked to our sites and to Places/Maps/Geocoding in Google Cloud
const AC = { t: null, tok: null, list: [], i: -1, input: null, q: '' };
const acBoxEl = () => document.getElementById('acBox');
function acClose() { acBoxEl()?.remove(); AC.list = []; AC.i = -1; }
async function acSearch(input) {
  const q = input.value.trim(); AC.input = input; AC.q = q;
  if (q.length < 3) return acClose();
  AC.tok = AC.tok || (crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2));
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GKEY },
      body: JSON.stringify({ input: q, sessionToken: AC.tok, includedRegionCodes: ['us'], ...(/\d/.test(q) ? { includedPrimaryTypes: ['street_address', 'premise', 'subpremise'] } : {}), // with a house number: addresses only; without: streets, cabins and places too
        locationBias: { circle: { center: { latitude: 35.86, longitude: -83.75 }, radius: 50000 } } }), // Knoxville + the Smokies first
    });
    const d = await r.json();
    if (q !== AC.q || document.activeElement !== input) return;
    if (!r.ok) { console.warn('address search', d?.error?.message); return acClose(); }
    AC.list = (d.suggestions || []).map(s => s.placePrediction).filter(Boolean).slice(0, 5); AC.i = -1; acDraw();
  } catch (e) { console.warn('address search', e); }
}
function acDraw() {
  acBoxEl()?.remove();
  if (!AC.list.length || !AC.input?.isConnected) return;
  const r = AC.input.getBoundingClientRect(), box = document.createElement('div');
  box.id = 'acBox'; box.className = 'ac-box'; box.setAttribute('role', 'listbox');
  Object.assign(box.style, { left: r.left + scrollX + 'px', top: r.bottom + scrollY + 4 + 'px', width: r.width + 'px' });
  box.innerHTML = AC.list.map((p, i) => `<div class="ac-opt ${i === AC.i ? 'on' : ''}" role="option" data-ac="${i}"><b>${esc(p.structuredFormat?.mainText?.text || p.text?.text || '')}</b><small>${esc(p.structuredFormat?.secondaryText?.text || '')}</small></div>`).join('')
    + '<div class="ac-by">powered by Google</div>';
  box.addEventListener('mousedown', e => { const o = e.target.closest('[data-ac]'); if (o) { e.preventDefault(); acPick(+o.dataset.ac); } });
  document.body.appendChild(box);
}
async function acPick(i) {
  const p = AC.list[i], input = AC.input, cb = input?._acPick; acClose(); if (!p || !cb) return;
  try {
    const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(p.placeId)}?sessionToken=${AC.tok}`, { headers: { 'X-Goog-Api-Key': GKEY, 'X-Goog-FieldMask': 'addressComponents,location' } });
    AC.tok = null; // a pick ends the billing session
    const d = await r.json(); if (!r.ok) throw new Error(d?.error?.message || 'lookup failed');
    const c = t => (d.addressComponents || []).find(x => x.types.includes(t));
    const street = [c('street_number')?.longText, c('route')?.shortText].filter(Boolean).join(' ');
    cb({ street: street || p.structuredFormat?.mainText?.text || input.value, unit: c('subpremise')?.longText || '',
      city: (c('locality') || c('postal_town') || c('administrative_area_level_3') || c('sublocality'))?.longText || '',
      state: c('administrative_area_level_1')?.shortText || '', zip: c('postal_code')?.longText || '',
      lat: d.location?.latitude ?? null, lng: d.location?.longitude ?? null });
  } catch (e) { console.warn('address lookup', e); AC.tok = null; cb({ street: p.structuredFormat?.mainText?.text || input.value }); }
}
function acAttach(input, onPick) {
  if (!input) return; const fresh = !input._acPick; input._acPick = onPick; if (!fresh) return;
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', () => { clearTimeout(AC.t); AC.t = setTimeout(() => acSearch(input), 250); });
  input.addEventListener('keydown', e => {
    if (!acBoxEl()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); AC.i = (AC.i + (e.key === 'ArrowDown' ? 1 : -1) + AC.list.length) % AC.list.length; acDraw(); }
    else if (e.key === 'Enter' && AC.i >= 0) { e.preventDefault(); acPick(AC.i); }
    else if (e.key === 'Escape') acClose();
  });
  input.addEventListener('blur', () => setTimeout(acClose, 150));
}
addEventListener('resize', () => acClose());
// After every render: hook the order form's street field
{ const base = render; render = function () { base(); acHookOrderForm(); }; }
function acHookOrderForm() {
  acAttach(document.querySelector('[data-o="addr"][data-k="street"]'), a => {
    const states = ['TN', 'NC', 'GA', 'KY', 'VA'];
    S.addr.street = a.street;
    if (a.unit) S.addr.unit = a.unit;
    if (a.city) S.addr.city = a.city;
    if (states.includes(a.state)) S.addr.state = a.state;
    if (a.zip) S.addr.zip = a.zip;
    ['street', 'city', 'state', 'zip'].forEach(k => delete S.errors[k]);
    S.addrWasOk = addrOk(); resetSchedule(); render();
    if (S.addrWasOk && S.view === 'book') setTimeout(() => document.getElementById('o-time')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  });
}

/* ================= keeping portal data fresh ================= */
// After an order or payment, forget what was loaded so Listings and Invoices show it right away.
function freshAfterOrder() { S.cp = { on: false, code: '', applied: null, err: '', busy: false }; S.pdata = null; if (typeof INV !== 'undefined') { INV.data = null; INV.pdf = {}; INV.dmedia = {}; } }
// Reload whatever the current page shows (used by pull-to-refresh and when the app comes back to the front).
async function refreshView() {
  if (SHARE) { if (S.view === 'delivery') await loadDelivery(SHARE); return; }
  if (!S.session) return;
  const v = S.view, jobs = [loadPhoto()];
  if (v === 'delivery' && S.dl.key) jobs.push(loadDelivery(S.dl.key));
  else if (v === 'invoices') { INV.dmedia = {}; jobs.push(loadInvoices(true)); }
  else if (PORTAL_VIEWS.includes(v)) { jobs.push(loadPortal()); INV.data = null; }
  await Promise.all(jobs.map(j => Promise.resolve(j).catch(() => {})));
}
// Pull down from the top to refresh (phones / home-screen app). Same feel as HQ: the page and the indicator move
// together frame by frame, the arrow turns as you pull, then a spinner and a drawn checkmark.
// Sign-in page: reloads the page. Portal pages (Listings, Invoices, Profile, Delivery): reloads that page's data.
(function pullToRefresh() {
  if (!('ontouchstart' in window)) return;
  const el = document.createElement('div');
  el.id = 'ptr'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg class="ptr-ring" viewBox="0 0 40 40"><circle class="ptr-track" cx="20" cy="20" r="15"/><circle class="ptr-prog" cx="20" cy="20" r="15"/></svg>
    <svg class="ptr-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>
    <svg class="ptr-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.5l4.2 4.2 8.8-9.2"/></svg>`;
  document.body.appendChild(el);
  const prog = el.querySelector('.ptr-prog'), arrow = el.querySelector('.ptr-arrow'), C = 2 * Math.PI * 15;
  prog.style.strokeDasharray = C; prog.style.strokeDashoffset = C;
  const TRIGGER = 70, HOLD = 64, MAX = 150, R = 0.6, SOFT = MAX - TRIGGER;
  let startY = null, startX = 0, carry = 0, dist = 0, pulling = false, busy = false, armed = false, raf = 0, anim = 0, page = null, landing = false;
  // Which page can be pulled right now (null = none)
  const target = () => {
    if (document.body.classList.contains('landing')) return $('landing');
    if ((S.session || SHARE) && PORTAL_VIEWS.includes(S.view) && !$('modal').innerHTML && !document.querySelector('.lb')) return $('main');
    return null;
  };
  const scrolledParent = n => {
    for (; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1 && n.scrollTop > 0) return true;
    }
    return false;
  };
  // Finger travel -> pull distance: tracks the finger 1:R up to the trigger point, then eases into a soft stop.
  const resist = dy => { const d = Math.max(0, dy) * R; return d <= TRIGGER ? d : TRIGGER + SOFT * (1 - Math.exp(-(d - TRIGGER) / SOFT)); };
  const unresist = v => (v <= TRIGGER ? v : TRIGGER - SOFT * Math.log(1 - Math.min(v - TRIGGER, SOFT - 0.5) / SOFT)) / R;
  const paint = () => {
    raf = 0;
    if (!page) return;
    const p = Math.min(1, dist / TRIGGER);
    page.style.transform = dist > 0.5 ? `translate3d(0, ${dist.toFixed(2)}px, 0)` : '';
    // The indicator rises out from under the header with the page, then stays centred in the gap it opens.
    const y = Math.min(dist / 2 - 20, dist - 44);
    el.style.transform = `translate3d(-50%, ${y.toFixed(2)}px, 0) scale(${(0.72 + 0.28 * p).toFixed(3)})`;
    el.style.opacity = Math.max(0, Math.min(1, (dist - 6) / 30)).toFixed(3);
    if (!busy) {
      prog.style.strokeDashoffset = C * (1 - p);
      arrow.style.transform = `rotate(${(p * 180).toFixed(1)}deg)`;
      const ready = dist >= TRIGGER;
      if (ready !== armed) { armed = ready; el.classList.toggle('ready', ready); if (ready && navigator.vibrate) navigator.vibrate(8); }
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  const stop = () => { if (anim) cancelAnimationFrame(anim); anim = 0; };
  const tween = (to, ms) => new Promise(done => {
    stop();
    const from = dist, t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3);
      dist = from + (to - from) * e; paint();
      if (t < 1) anim = requestAnimationFrame(step); else { anim = 0; done(); }
    };
    anim = requestAnimationFrame(step);
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const reset = () => {
    if (page) page.style.transform = page.style.willChange = '';
    el.classList.remove('ready', 'spinning', 'done');
    el.style.opacity = 0; prog.style.transition = ''; armed = false;
  };
  window.addEventListener('touchstart', e => {
    if (busy || e.touches.length !== 1 || window.scrollY > 0) return;
    const pg = target();
    if (!pg || e.target.closest('input, textarea, select, [contenteditable], iframe, .no-ptr') || scrolledParent(e.target)) return;
    if (pg !== page) { stop(); reset(); dist = 0; page = pg; }
    landing = pg.id === 'landing';
    // the gap opens just under the header (or the top of the screen on the sign-in page)
    const hd = document.querySelector('header.top');
    el.style.top = (landing || !hd ? 0 : Math.max(0, hd.getBoundingClientRect().bottom)) + 'px';
    stop(); carry = dist > 0.5 ? unresist(dist) : 0; // catching it while it springs back continues from where it is
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; pulling = carry > 0;
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY, dx = e.touches[0].clientX - startX;
    if (!pulling) {
      if (dy < 6 || Math.abs(dx) > dy || window.scrollY > 0) { if (dy < 0 || Math.abs(dx) > 10) startY = null; return; }
      pulling = true; startY += 6; // start from zero so nothing jumps
      page.style.willChange = 'transform';
    }
    if (e.cancelable) e.preventDefault();
    dist = resist(carry + e.touches[0].clientY - startY); schedule();
  }, { passive: false });
  const end = async () => {
    if (startY === null) return;
    startY = null;
    if (!pulling) return;
    pulling = false;
    if (dist < TRIGGER) { await tween(0, 260); if (!pulling && !anim) reset(); return; }
    busy = true;
    el.classList.add('spinning');
    prog.style.transition = 'stroke-dashoffset .35s ease';
    prog.style.strokeDashoffset = C * 0.72;
    const t0 = Date.now();
    await tween(HOLD, 300);
    if (landing) { await wait(150); location.reload(); return; }
    try { await refreshView(); } catch (err) { console.warn(err); }
    await wait(Math.max(0, 600 - (Date.now() - t0))); // let the spinner read as a refresh
    el.classList.remove('spinning'); el.classList.add('done');
    prog.style.strokeDashoffset = 0;
    await wait(420);
    await tween(0, 340);
    reset(); busy = false;
  };
  window.addEventListener('touchend', end); window.addEventListener('touchcancel', end);
})();
// Coming back to the app (switching apps, unlocking the phone): refresh if it's been a minute
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 60000 && !$('modal').innerHTML) refreshView();
});

/* ================= appointment: reschedule / cancel (appointment function) ================= */
// Same rule as the server: online changes close at 5:00 PM (Knoxville time) the day before the shoot
const BIZ_TZ = 'America/New_York';
function tzWall(date, time) { // local wall time in BIZ_TZ → Date
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number), g = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: BIZ_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(g).map(x => [x.type, x.value]));
  return new Date(g.getTime() - (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - g.getTime()));
}
function apptCutoff(shootIso) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: BIZ_TZ }).format(new Date(shootIso));
  return tzWall(new Date(Date.parse(day + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10), '17:00').getTime();
}
function apptRules(b) {
  if (!b) return { canChange: false, canCancel: false, reason: '' };
  const past = !b.shoot_start || Date.parse(b.shoot_start) < Date.now();
  if (b.status === 'cancelled') return { canChange: false, canCancel: false, kind: 'cancelled', reason: 'This appointment is cancelled.' };
  if (!['scheduled', 'requested'].includes(b.status) || b.hasDelivery || past) return { canChange: false, canCancel: false, kind: 'past', reason: 'This shoot already happened.' };
  if (Date.now() >= apptCutoff(b.shoot_start)) return { canChange: false, canCancel: false, kind: 'closed', reason: 'Rescheduling online is unavailable at this time. Please call or text our business phone.' };
  return { canChange: true, canCancel: !b.paid, kind: b.paid ? 'paid' : '', reason: b.paid ? "This order is paid, so to cancel it please call or text us and we'll take care of your refund." : '' };
}
// "Call or text us" pop-up (after the online cutoff, or to cancel a paid order)
function callTextModal(title, text, extra = '') {
  const tel = 'tel:+1' + CFG.phone.replace(/\D/g, '');
  $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel"><h2 style="font-size:22px">${esc(title)}</h2>
    <p>${esc(text)}</p>${extra}
    <div class="ct-btns"><a class="btn" href="${tel}">${ic('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>', 16)} Call ${esc(CFG.phone)}</a>
      <a class="btn o" href="${SMS_LINK}">${svg(IC_CHAT, 16)} Text us</a></div>
    <div class="ph-nav"><span></span><button class="btn o" onclick="kv.closeModal()">Close</button></div></div></div>`;
}
function apptBlocked(n, what) { // returns true if a pop-up explained why it can't be done online
  const b = (S.pdata?.bookings || []).find(x => x.number === n), r = apptRules(b);
  if (!b) return false;
  if (r.kind === 'closed') { callTextModal(`${what === 'cancel' ? 'Cancel' : 'Reschedule'} by phone`, `${what === 'cancel' ? 'Cancelling' : 'Rescheduling'} online is unavailable at this time. Please call or text our business phone.`); return true; }
  if (r.kind === 'past') { callTextModal('This shoot already happened', 'Need more media for this property? Book it again, or call or text us.', `<p><button class="btn o" onclick="kv.closeModal();kv.orderAgain('${b.id}')">Book this address again</button></p>`); return true; }
  if (r.kind === 'cancelled') { alertModal('This appointment is cancelled.'); return true; }
  if (what === 'cancel' && r.kind === 'paid') { callTextModal('Cancel a paid order', "This order is already paid, so please call or text us to cancel and we'll take care of your refund."); return true; }
  return false;
}
const fmtShoot = d => d ? new Date(d).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
function vApptPanel(i) {
  if (!S.pdata && !S.pdataLoading) { S.pdataLoading = true; loadPortal().finally(() => { S.pdataLoading = false; }); }
  const b = (S.pdata?.bookings || []).find(x => x.id === i.id);
  if (!b || !b.shoot_start) return '';
  const r = apptRules(b), upcoming = Date.parse(b.shoot_start) > Date.now() && !b.hasDelivery;
  return `<div class="panel iappt"><div class="iappt-h">${ic(I.cal, 20)}<div><small>${upcoming ? 'Your shoot' : 'Shoot date'}</small><b>${esc(fmtShoot(b.shoot_start))}</b></div></div>
    ${upcoming ? `<div class="iappt-b"><button class="btn o sm" onclick="kv.addCal(${i.number}, this)">${ic(I.cal, 15)} Add to my calendar</button><button class="btn o sm" onclick="kv.resched(${i.number})">${ic(I.cal, 15)} Reschedule</button><button class="btn sm danger-o" onclick="kv.cancelAppt(${i.number})">${ic(I.xc, 15)} Cancel appointment</button></div>` : ''}
    ${r.kind === 'closed' && upcoming ? `<p class="hint" style="margin:8px 0 0">Changes online close at 5:00 PM the day before your shoot. After that, call or text ${esc(CFG.phone)}.</p>` : ''}</div>`;
}
const RS = { n: null, from: null, days: [], day: null, pick: null, loading: false, err: '', current: null };
const ymd = d => d.toLocaleDateString('en-CA');
async function rsLoad(more) {
  RS.loading = true; RS.err = ''; rsPaint();
  try {
    const r = await api('slots', { number: RS.n, from: RS.from, days: 14 }, 'appointment');
    RS.current = r.current;
    RS.days = more ? [...RS.days, ...r.days] : r.days;
    if (!RS.day) RS.day = (RS.days.find(d => d.times.length) || {}).date || null;
  } catch (e) { RS.err = e.message; }
  RS.loading = false; rsPaint();
}
function rsPaint() {
  const box = $('rsBox'); if (!box) return;
  const days = RS.days.filter(d => d.open);
  const dayBtn = d => { const dt = new Date(d.date + 'T12:00:00'), n = d.times.length;
    return `<button class="rs-day ${RS.day === d.date ? 'on' : ''}" ${n ? '' : 'disabled'} onclick="kv.rsDay('${d.date}')"><small>${dt.toLocaleDateString('en-US', { weekday: 'short' })}</small><b>${dt.getDate()}</b><small>${dt.toLocaleDateString('en-US', { month: 'short' })}</small></button>`; };
  const sel = RS.days.find(d => d.date === RS.day);
  box.innerHTML = `${RS.current ? `<p class="hint" style="margin:0 0 12px">Currently: <b>${esc(fmtShoot(RS.current))}</b></p>` : ''}
    ${RS.err ? `<div class="msg err">${esc(RS.err)}</div>` : ''}
    <div class="rs-days">${days.map(dayBtn).join('')}${RS.loading ? '<span class="spin" style="margin:18px"></span>' : `<button class="rs-more" onclick="kv.rsMore()">Later<br>dates ›</button>`}</div>
    ${sel ? `<p class="rs-lbl">${esc(new Date(sel.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
      <div class="rs-times">${sel.times.map(t => `<button class="rs-t ${RS.pick === t.start ? 'on' : ''}" onclick="kv.rsPick('${t.start}')">${esc(t.label)}</button>`).join('')}</div>`
      : !RS.loading && !RS.err ? '<p class="hint">No open times in these dates. Tap "Later dates".</p>' : ''}`;
  const go = $('rsGo'); if (go) { go.disabled = !RS.pick || ($('rsWhy')?.value || '').trim().length < 3; go.textContent = RS.pick ? `Move to ${new Date(RS.pick).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Pick a new time'; }
}
function resched(n) {
  if (apptBlocked(n, 'resched')) return;
  Object.assign(RS, { n, from: ymd(new Date()), days: [], day: null, pick: null, err: '', current: null });
  $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel rs-panel"><h2 style="font-size:22px">Reschedule your shoot</h2>
    <div id="rsBox"></div>
    <label for="rsWhy" style="margin-top:14px">Reason for rescheduling <span class="req">*</span></label>
    <textarea id="rsWhy" rows="2" maxlength="500" placeholder="Seller needs another day, weather, listing date moved…" oninput="kv.rsCheck()"></textarea>
    <div class="ph-nav"><button class="btn o" onclick="kv.closeModal()">Never mind</button><button class="btn" id="rsGo" disabled>Pick a new time</button></div></div></div>`;
  $('rsGo').onclick = async () => {
    if (!RS.pick) return;
    if (($('rsWhy').value || '').trim().length < 3) { $('rsWhy').focus(); return; }
    $('rsGo').disabled = true; $('rsGo').innerHTML = '<span class="spin"></span>';
    try {
      const r = await api('reschedule', { number: RS.n, start: RS.pick, reason: $('rsWhy').value }, 'appointment');
      freshAfterOrder(); refreshView();
      $('modal').querySelector('.panel').innerHTML = `<h2 style="font-size:22px">You're all set</h2><p>Your shoot is now <b>${esc(r.label)}</b>.</p><div class="ph-nav"><span></span><button class="btn" onclick="kv.closeModal()">Done</button></div>`;
    } catch (e) { RS.err = e.message; RS.pick = null; if (e.status === 409) { RS.days = []; RS.day = null; rsLoad(); } else rsPaint(); }
  };
  rsLoad();
}
function cancelAppt(n) {
  if (apptBlocked(n, 'cancel')) return;
  const b = (S.pdata?.bookings || []).find(x => x.number === n);
  $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel"><h2 style="font-size:22px">Cancel this appointment?</h2>
    <p>${esc(b?.address || '')}${b?.shoot_start ? `<br><span class="hint">${esc(fmtShoot(b.shoot_start))}</span>` : ''}</p>
    <label for="caWhy" style="margin-top:6px">Reason for cancelling <span class="req">*</span></label>
    <textarea id="caWhy" rows="2" maxlength="500" placeholder="Listing delayed, seller not ready…" oninput="document.getElementById('caGo').disabled = this.value.trim().length < 3"></textarea>
    <p class="hint" style="margin:8px 0 0">Need a different day instead? <a href="javascript:kv.resched(${n})">Reschedule</a>.</p>
    <div id="caMsg"></div>
    <div class="ph-nav"><button class="btn o" onclick="kv.closeModal()">Keep appointment</button><button class="btn danger" id="caGo" disabled>Cancel appointment</button></div></div></div>`;
  $('caGo').onclick = async () => {
    $('caGo').disabled = true; $('caGo').innerHTML = '<span class="spin"></span>';
    try {
      const r = await api('cancel', { number: n, reason: $('caWhy').value }, 'appointment');
      freshAfterOrder();
      $('modal').querySelector('.panel').innerHTML = `<h2 style="font-size:22px">Appointment cancelled</h2><p>Your shoot is cancelled and removed from our schedule.${r.creditReturned ? ` ${money2(r.creditReturned)} of credit went back to your account.` : ''}</p><div class="ph-nav"><span></span><button class="btn" onclick="kv.closeModal();location.hash='#listings'">Done</button></div>`;
    } catch (e) { $('caMsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; $('caGo').disabled = false; $('caGo').textContent = 'Cancel appointment'; }
  };
}
Object.assign(window.kv, {
  resched, cancelAppt,
  rsDay(d) { RS.day = d; RS.pick = null; rsPaint(); },
  rsPick(t) { RS.pick = t; rsPaint(); },
  rsCheck() { const go = $('rsGo'); if (go) go.disabled = !RS.pick || $('rsWhy').value.trim().length < 3; },
  rsMore() { const last = RS.days[RS.days.length - 1]?.date; if (!last) return; RS.from = ymd(new Date(Date.parse(last + 'T12:00:00') + 864e5)); rsLoad(true); },
});

/* ================= Add to my calendar ================= */
// One tap: opens this shoot's calendar file from a signed link (appointment function). iPhone/iPad show the
// "Add to Calendar" sheet; computers open it in their calendar app. The file always has the current time, and the
// same event ID, so adding it again after a reschedule updates the event.
const upcomingShoot = b => b && ['scheduled', 'requested'].includes(b.status) && !b.hasDelivery && b.shoot_start && Date.parse(b.shoot_start) > Date.now();
const ICS = {};
async function addCal(n, btn) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
  try {
    const url = ICS[n] || (ICS[n] = (await api('ics_link', { number: n }, 'appointment')).url);
    location.href = url;
  } catch (e) { alertModal(e.message); }
  if (btn) setTimeout(() => { btn.disabled = false; btn.innerHTML = label; }, 800);
}
Object.assign(window.kv, { addCal });


/* ================= Zillow Stat Tracker (client side) =================
   Views, saves and days on Zillow for their listing, captured by Knox View (HQ → order → Zillow Stat Tracker).
   Zillow's counts cover the last 30 days, so per-day rates use min(days, 30). Benchmarks are Zillow Research's
   published nationwide ones: ~250 views/day → pending within a week; 5 saves/day → offer within a week; 10+ → above list. */
const ZS = { by: {}, loaded: false };
async function loadZillow() {
  if (!S.session) return;
  try {
    const [l, st] = await Promise.all([sb.from('zillow_listings').select('booking_id, url, status, final_reason'), sb.from('zillow_stats').select('booking_id, captured_at, views, saves, days_on_zillow, listing_status').order('captured_at', { ascending: true }).limit(1000)]);
    if (l.error || st.error) return;
    const by = {};
    for (const x of l.data || []) by[x.booking_id] = { ...x, snaps: [] };
    for (const r of st.data || []) if (by[r.booking_id]) by[r.booking_id].snaps.push(r);
    for (const k in by) by[k].last = by[k].snaps[by[k].snaps.length - 1] || null;
    ZS.by = by; ZS.loaded = true; if (S.view === 'listings') render();
  } catch (_) { /* stats are extra */ }
}
const zsDays = d => Math.min(Math.max(+d || 1, 1), 30);
const zsRate = (v, d) => v == null ? null : v / zsDays(d);
const zsN = v => v == null ? '—' : Number(v).toLocaleString();
function vZillowLine(id) {
  const z = ZS.by[id], s = z.last;
  return `<button type="button" class="zs-line" onclick="kv.zillowStats('${id}')"><span class="zs-z">Zillow</span>
    <span><b>${zsN(s.views)}</b> views</span><span><b>${zsN(s.saves)}</b> saves</span><span><b>${zsN(s.days_on_zillow)}</b> days</span><span class="zs-go">Stats →</span></button>`;
}
function zillowStats(id) {
  const z = ZS.by[id]; if (!z?.last) return;
  const s = z.last, vd = zsRate(s.views, s.days_on_zillow), sd = zsRate(s.saves, s.days_on_zillow);
  const b = (S.pdata?.bookings || []).find(x => x.id === id);
  const bench = [];
  if (sd != null) bench.push(sd >= 10 ? `<b>${sd.toFixed(1)} saves a day</b>: Zillow sees 10+ a day as a strong sign of selling above list price.`
    : sd >= 5 ? `<b>${sd.toFixed(1)} saves a day</b>: above Zillow's mark of 5 a day, where homes typically get an offer within a week.`
    : `<b>${sd.toFixed(1)} saves a day</b>: Zillow's mark for an offer within a week is 5 a day.`);
  if (vd != null) bench.push(vd >= 250 ? `<b>${Math.round(vd).toLocaleString()} views a day</b>: homes with 250+ a day tend to go pending within a week on Zillow.`
    : `<b>${Math.round(vd).toLocaleString()} views a day</b>: Zillow's fast-sale mark is about 250 a day.`);
  const snaps = z.snaps.slice(-8);
  const mx = Math.max(1, ...snaps.map(x => x.views || 0));
  $('modal').innerHTML = `<div class="modal" onclick="if(event.target===this)kv.closeModal()"><div class="panel zs-panel"><h2 style="font-size:22px;margin-bottom:2px">Zillow stats</h2>
    <p class="hint" style="margin:0 0 14px">${esc(b ? b.address : '')} · updated ${esc(new Date(s.captured_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}${z.status === 'final' && z.final_reason ? ' · ' + esc(z.final_reason) : ''}</p>
    <div class="zs-big"><div><b>${zsN(s.views)}</b><small>Views</small></div><div><b>${zsN(s.saves)}</b><small>Saves</small></div><div><b>${zsN(s.days_on_zillow)}</b><small>Days on Zillow</small></div></div>
    <div class="zs-rates"><span>${vd == null ? '—' : Math.round(vd).toLocaleString()} <small>views / day</small></span><span>${sd == null ? '—' : sd.toFixed(1)} <small>saves / day</small></span></div>
    ${bench.length ? `<h3 class="zs-h">How it compares on Zillow</h3><ul class="zs-bench">${bench.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
    ${snaps.length > 1 ? `<h3 class="zs-h">Views over time</h3><div class="zs-bars">${snaps.map(x => `<div><i style="height:${Math.max(4, Math.round((x.views || 0) / mx * 100))}%"></i><small>${esc(new Date(x.captured_at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }))}</small></div>`).join('')}</div>` : ''}
    <p class="hint" style="margin:12px 0 0">Zillow counts views and saves from the last 30 days, so these can go down over time. Benchmarks are from Zillow Research, nationwide.</p>
    <div class="ph-nav"><a class="btn o" href="${esc(z.url)}" target="_blank" rel="noopener">View on Zillow ↗</a><button class="btn" onclick="kv.closeModal()">Close</button></div></div></div>`;
}
Object.assign(window.kv, { zillowStats });
