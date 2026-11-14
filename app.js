import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const CFG = window.KV_CONFIG;
const sb = createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } });
const $ = id => document.getElementById(id);
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
  pkg: null, items: new Set(), adu: false,
  addr: { street: '', unit: '', city: '', state: 'TN', zip: '', sqftLabel: '', occupancy: '', access: '' },
  slots: null, slotsFrom: null, slotsLoading: false, start: null, startLabel: '',
  contact: { first: '', last: '', email: '', phone: '', brokerage: '', notes: '' },
  payOpt: 'save_card', errors: {}, busy: false,
  checkout: null, // { booking, clientSecret, intentType, elements }
  done: null, login: null, pdata: null, after: '',
};
const svc = id => S.services.find(s => s.id === id);
const packages = () => S.services.filter(s => s.kind === 'package').sort((a, b) => a.sort_order - b.sort_order);
const alacarte = () => S.services.filter(s => s.kind === 'addon').sort((a, b) => a.sort_order - b.sort_order);
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
const sizeAdj = () => largeOn() ? +S.config.settings.large_fee : 0; // shown inside package prices
function lines() {
  const out = [];
  if (S.pkg) { const p = svc(S.pkg); out.push({ name: p.name + ' Package', price: +p.price + sizeAdj(), subs: p.includes }); }
  for (const id of S.items) { const s = svc(id); if (s) out.push({ name: s.name, price: +s.price }); }
  if (!S.pkg && largeOn() && largeVisible()) out.push({ name: S.config.settings.large_label, price: +S.config.settings.large_fee });
  return out;
}
const total = () => lines().reduce((a, l) => a + l.price, 0);
const selection = () => ({ packageId: S.pkg, serviceIds: [...S.items], sqftLabel: S.addr.sqftLabel, adu: S.adu });
function upsells() {
  const c = inCart(), cov = covered();
  return S.upsells.filter(u => anyOf(u.show_when_any, c) && !anyOf(u.hide_when_any, c) && !cov.has(u.service_id) && svc(u.service_id));
}
function resetSchedule() { S.slots = null; S.start = null; S.startLabel = ''; S.pickDate = null; S.checkout = null; }
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
  setPay(v) { S.payOpt = v; S.checkout = null; render(); },
  startCheckout, confirmPay, signIn, signUp, setMode, sendCode, verifyCode, loginBack, setMethod, fmtPhone, signOut, payBooking, closeModal() { $('modal').innerHTML = ''; },
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

async function startCheckout() {
  if (!validate(3)) { render(); return; }
  if (!stripeReady()) { S.error = 'Online payments are not switched on yet. Please call ' + CFG.phone + ' to book.'; render(); return; }
  S.busy = true; S.error = ''; render();
  try {
    const r = await api('create', { ...selection(), start: S.start, paymentOption: S.payOpt,
      address: S.addr, contact: S.contact });
    S.checkout = r;
    render();
    const elements = stripe.elements({ clientSecret: r.clientSecret, appearance });
    elements.create('payment', { layout: 'tabs' }).mount('#pay-el');
    S.checkout.elements = elements;
  } catch (e) {
    S.error = e.message;
    if (e.status === 409) { resetSchedule(); S.step = 2; loadSlots(); }
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
    S.view = 'done'; S.checkout = null;
    history.replaceState(null, '', '/');
  } catch (e) { S.error = e.message; }
  S.busy = false; render(); window.scrollTo({ top: 0 });
}

/* ---------- auth + portal ---------- */
// Sign in with a one-time code: by email, or by text to a mobile number that matches a client record.
const LP = () => (S.login || (S.login = { stage: 'enter', mode: 'signin', method: 'email', email: '', phone: '', su: { name: '', phone: '', email: '', company: '' } }));
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
const SU_FIELDS = ['name', 'phone', 'email', 'company'];
function keepSignup() { const su = LP().su; SU_FIELDS.forEach(k => { const v = $('su_' + k)?.value; if (v != null) su[k] = v.trim(); }); }
function setMode(m) {
  if (LP().mode === 'signup') keepSignup(); else keepInput();
  const p = LP(); p.mode = m === 'signup' ? 'signup' : 'signin'; p.stage = 'enter'; S.error = '';
  if (p.mode === 'signup' && !p.su.email && p.email) p.su.email = p.email; // carry over what they already typed
  if (p.mode === 'signin' && !p.email && p.su.email) { p.email = p.su.email; p.method = 'email'; }
  render(); setTimeout(() => $(p.mode === 'signup' ? 'su_name' : 'loginId')?.focus(), 30);
}
async function signUp(ev) {
  ev?.preventDefault(); keepSignup();
  const p = LP(), su = p.su;
  const bad = su.name.split(/\s+/).filter(Boolean).length < 2 ? 'Enter your first and last name.'
    : su.phone.replace(/\D/g, '').replace(/^1(?=\d{10})/, '').length !== 10 ? 'Enter your 10-digit mobile number.'
    : !/\S+@\S+\.\S+/.test(su.email) ? 'Enter your email.' : '';
  if (bad) { S.error = bad; render(); return; }
  S.busy = true; S.error = ''; render();
  try {
    const r = await api('signup', { name: su.name, phone: su.phone, email: su.email.toLowerCase(), company: su.company }, 'auth-code');
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
    S.login = null; S.pdata = null; // the auth listener links the client record; then we go to their listings
    location.hash = S.after || '#listings';
  } catch (e) { S.error = e.message; }
  S.busy = false; render();
}
function loginBack() { LP().stage = 'enter'; S.error = ''; render(); }
async function signOut() { await sb.auth.signOut(); S.session = null; S.agent = null; S.pdata = null; S.login = null; UI.menu = false; location.hash = '#account'; render(); }
async function loadPortal() {
  S.pdata = { loading: true }; render();
  try { S.pdata = await api('portal'); if (S.pdata.agent) { S.agent = { ...S.agent, ...S.pdata.agent }; fillContact(); } } catch (e) { S.pdata = { error: e.message }; }
  render();
}
async function payBooking(id) {
  if (!stripeReady()) { alertModal('Online payments are not switched on yet.'); return; }
  try {
    const r = await api('pay', { bookingId: id });
    if (r.alreadyPaid) { if (S.view === 'delivery') loadDelivery(S.dl.key); else loadPortal(); return; }
    $('modal').innerHTML = `<div class="modal"><div class="panel"><h2 style="font-size:22px">Pay to download</h2>
      <div class="tot" style="padding:6px 0 0"><span>Amount due</span><span>${money(r.booking.total)}</span></div>
      <div id="pay-el2" style="margin-top:14px"></div><div id="payErr"></div>
      <div class="nav"><button class="btn o" onclick="kv.closeModal()">Cancel</button><button class="btn" id="payGo">Pay ${money(r.booking.total)}</button></div></div></div>`;
    const elements = stripe.elements({ clientSecret: r.clientSecret, appearance });
    elements.create('payment').mount('#pay-el2');
    $('payGo').onclick = async () => {
      $('payGo').disabled = true;
      const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: `${location.origin}/#invoices` }, redirect: 'if_required' });
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
function vServices() {
  const cov = covered();
  const pk = packages().map(p => `
    <button class="card round pkg ${S.pkg === p.id ? 'sel' : S.pkg ? 'dim' : ''}" onclick="kv.pickPkg('${p.id}')" aria-pressed="${S.pkg === p.id}" ${S.pkg && S.pkg !== p.id ? 'aria-disabled="true"' : ''}>
      <span class="tick">${CHECK}</span>
      <div class="pkg-h"><div class="pkg-nm"><h3>${esc(p.name)}</h3>${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ''}</div>
        <span class="pkg-p">${money(+p.price + sizeAdj())}<small>${sizeAdj() ? 'for ' + esc(S.addr.sqftLabel || 'large property') : 'starting'}</small></span></div>
      <ul class="chk two">${(p.includes || []).map(i => `<li>${CHECK}<span>${esc(i)}</span></li>`).join('')}</ul>
    </button>`).join('');
  const ups = upsells().map(u => `<div class="up"><div style="flex:1"><h3>${esc(u.title)}</h3><p>${esc(u.description)}</p></div>
      <button class="btn lt" onclick="kv.toggle('${u.service_id}')">+ ${money(svc(u.service_id).price)}</button></div>`).join('');
  const row = s => {
    const inc = cov.has(s.id), sel = S.items.has(s.id);
    return `<button class="row ${sel ? 'sel' : ''} ${inc ? 'incl' : ''}" onclick="kv.toggle('${s.id}')" aria-pressed="${sel || inc}" ${inc ? 'aria-disabled="true"' : ''}>
      <span class="box">${CHECK}</span>
      <span class="row-t"><span class="row-n">${esc(s.name)}</span>${s.description ? `<span class="row-d">${esc(s.description)}</span>` : ''}</span>
      <span class="row-p">${inc ? `<span class="inc">Included in ${esc(svc(S.pkg).name)}</span>` : money(s.price)}</span></button>`;
  };
  const card = s => {
    const inc = cov.has(s.id), sel = S.items.has(s.id);
    return `<button class="card sq small-card ${sel ? 'sel' : ''} ${inc ? 'incl' : ''}" onclick="kv.toggle('${s.id}')" aria-pressed="${sel || inc}">
      ${inc ? `<span class="badge g">Included in ${esc(svc(S.pkg).name)}</span>` : ''}
      <span class="tick">${CHECK}</span><h3>${esc(s.name)}</h3>
      <div class="price">${inc ? '<span style="color:var(--ok)">Included</span>' : money(s.price)}</div>
      ${s.description ? `<div class="meta">${esc(s.description)}</div>` : ''}</button>`;
  };
  const st = S.config.settings;
  const large = false ? `<section class="sec"><div class="sec-h"><i style="background:#8ca6cc"></i><h2>Property Add-Ons</h2></div>
      <p class="d">For larger homes and properties with extra structures.</p><div class="grid">
      <button class="card sq small-card ${S.adu ? 'sel' : ''}" onclick="kv.toggleAdu()" aria-pressed="${S.adu}"><span class="tick">${CHECK}</span>
      <h3>${esc(st.large_label)}</h3><div class="price">${money(st.large_fee)}</div><div class="meta">Over ${Number(st.large_sqft).toLocaleString()} sq ft, or an ADU / guest house / extra structure</div></button></div></section>` : '';
  return `
    <section class="sec"><div class="sec-h"><i style="background:#1d3250"></i><h2>Listing Media Packages</h2></div>
      ${S.pkg ? `<p class="pkg-note">${esc(svc(S.pkg).name)} selected. Tap it again to choose a different package.</p>` : ''}<div class="pkgs">${pk}</div></section>
    ${SHOW_UPSELLS && ups ? `<section class="sec">${ups}</section>` : ''}
    <section class="sec"><div class="sec-h"><i style="background:#1f3c66"></i><h2>À La Carte Services</h2></div>
      <p class="d">Need just one thing, or want to add to a package? Book any service on its own. A basic floor plan is included with every photo shoot.</p>
      <div class="list">${alacarte().map(row).join('')}</div></section>
    ${large}
    <div class="nav"><button class="btn o" onclick="kv.go(0)">Back</button><button class="btn" onclick="kv.go(2)" ${inCart().size ? '' : 'disabled'}>Continue to schedule</button></div>`;
}
function field(key, label, obj, opt = {}) {
  const v = S[obj][key] || '', req = opt.req !== false, err = S.errors[key] ? 'err' : '';
  const a = `data-o="${obj}" data-k="${key}"`;
  const inp = opt.options
    ? `<select ${a}><option value="">${opt.ph || 'Select…'}</option>${opt.options.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    : opt.area ? `<textarea rows="3" ${a} placeholder="${esc(opt.ph || '')}">${esc(v)}</textarea>`
    : `<input ${a} value="${esc(v)}" placeholder="${esc(opt.ph || '')}" ${opt.type ? `type="${opt.type}"` : ''} ${opt.ac ? `autocomplete="${opt.ac}"` : ''} ${opt.im ? `inputmode="${opt.im}"` : ''}>`;
  return `<div class="${opt.full ? 'full' : ''} ${err}"><label>${label}${req ? ' <em>*</em>' : ''}</label>${inp}</div>`;
}
function vProperty() {
  const st = S.config.settings;
  const bySize = (st.sqft_options || []).find(o => o.label === S.addr.sqftLabel);
  const big = largeEnabled() && bySize && (bySize.max === null || bySize.max >= st.large_sqft);
  return `<section class="sec"><div class="sec-h"><i style="background:#1d3250"></i><h2>Property</h2></div>
    <p class="d">Where are we shooting?</p>
    <div class="panel"><div class="fg">
      ${field('street', 'Street address', 'addr', { full: true, ph: '123 Mountain View Dr', ac: 'address-line1' })}
      ${field('unit', 'Unit / Lot', 'addr', { req: false, ph: 'Optional', ac: 'address-line2' })}
      ${field('city', 'City', 'addr', { ph: 'Knoxville', ac: 'address-level2' })}
      ${field('state', 'State', 'addr', { options: ['TN', 'NC', 'GA', 'KY', 'VA'] })}
      ${field('zip', 'ZIP', 'addr', { ph: '37902', im: 'numeric', ac: 'postal-code' })}
      ${field('sqftLabel', 'Select your square footage', 'addr', { full: true, options: (st.sqft_options || []).map(o => o.label) })}
      ${field('occupancy', 'Occupancy', 'addr', { req: false, options: ['Vacant', 'Owner occupied', 'Tenant occupied'], ph: 'Select (optional)' })}
      ${field('access', 'Access notes', 'addr', { full: true, req: false, area: true, ph: 'Lockbox code, gate code, pets, who will be there…' })}
    </div>
    ${largeOn() ? `<div class="callout"><span>Package prices on the next step include +${money(st.large_fee)} for ${big ? `homes ${Number(st.large_sqft).toLocaleString()}+ sq ft` : 'properties with an ADU or extra structure'}: more photos and more time on site.</span></div>` : ''}
    ${largeEnabled() && !big ? `<label class="check"><input type="checkbox" ${S.adu ? 'checked' : ''} onchange="kv.toggleAdu()"> This property has an ADU, guest house or extra structure (+${money(st.large_fee)})</label>` : ''}
    </div></section>
    <div class="nav"><span></span><button class="btn" onclick="kv.go(1)">Continue to services</button></div>`;
}
function vSchedule() {
  if (!S.slots) return `<div class="panel loading"><span class="spin"></span> Checking the calendar…</div>${S.error ? `<div class="msg err">${esc(S.error)}</div>` : ''}`;
  const days = S.slots.days;
  const sel = S.start ? new Date(S.start) : null;
  const activeDate = S.pickDate || days.find(d => d.times.length)?.date;
  const dayBtns = days.map(d => {
    const x = new Date(d.date + 'T12:00:00');
    return `<button class="day ${activeDate === d.date ? 'sel' : ''}" ${d.times.length ? '' : 'disabled'} onclick="S_pickDate('${d.date}')">
      <small>${x.toLocaleDateString('en-US', { weekday: 'short' })}</small><b>${x.getDate()}</b><small>${d.times.length ? x.toLocaleDateString('en-US', { month: 'short' }) : 'Full'}</small></button>`;
  }).join('');
  const day = days.find(d => d.date === activeDate);
  const times = day ? `<div class="slots">${day.times.map(t => `<button class="slot ${S.start === t.start ? 'sel' : ''}" onclick="kv.pickSlot('${t.start}','${esc(t.label)}')">${esc(t.label)}</button>`).join('')}</div>` : '<div class="hint" style="margin-top:14px">No open times in this range.</div>';
  return `<section class="sec"><div class="sec-h"><i style="background:#1d3250"></i><h2>Schedule</h2></div>
    <p class="d">Pick a day and arrival time. About ${Math.round(S.slots.minutes / 15) * 15} minutes on site for what you've selected.</p>
    <div class="panel"><div class="days">${dayBtns}<button class="day" onclick="kv.moreSlots()" ${S.slotsLoading ? 'disabled' : ''}><small>More</small><b>›</b><small>dates</small></button></div>${times}
    ${sel ? `<div class="callout"><span>✓ ${sel.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at ${esc(S.startLabel)}</span></div>` : ''}
    ${(svc(S.pkg)?.name === 'Luxury' || [...S.items].some(id => /twilight photos/i.test(svc(id)?.name || ''))) ? '<div class="hint" style="margin-top:10px">Twilight photos are captured at sunset. We\'ll confirm the twilight time with you.</div>' : ''}
    </div></section>
    <div class="nav"><button class="btn o" onclick="kv.go(1)">Back</button><button class="btn" onclick="kv.go(3)" ${S.start ? '' : 'disabled'}>Continue to review</button></div>`;
}
window.S_pickDate = d => { S.pickDate = d; render(); };

function vReview() {
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
      <dt>Total</dt><dd><b style="color:var(--primary)">${money(total())}</b></dd>
    </dl>
    <div class="pay"><b style="color:var(--primary)">Payment</b>
      ${(S.config.settings.payment_options || []).filter(k => payLabels[k]).map(k => `
      <label class="radio ${S.payOpt === k ? 'sel' : ''}" style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--body);font-size:14px">
        <input type="radio" name="pay" ${S.payOpt === k ? 'checked' : ''} ${locked ? 'disabled' : ''} onchange="kv.setPay('${k}')"><span><b>${payLabels[k][0]}</b>${payLabels[k][1] ? `<br><span class="hint">${payLabels[k][1]}</span>` : ''}</span></label>`).join('')}
      <div id="pay-el"></div>
    </div></div></section>
    <div id="revErr">${S.error ? `<div class="msg err">${esc(S.error)}</div>` : ''}</div>
    <div class="nav" id="revNav"><button class="btn o" onclick="kv.go(2)" ${S.busy ? 'disabled' : ''}>Back</button>
      ${locked
        ? `<button class="btn" onclick="kv.confirmPay()" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : S.checkout.intentType === 'payment' ? 'Pay ' + money(S.checkout.booking.total) + ' &amp; book' : 'Save card &amp; book'}</button>`
        : `<button class="btn" onclick="kv.startCheckout()" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Continue to payment'}</button>`}
    </div>`;
}
function vDone() {
  const d = S.done || {};
  const when = d.start ? new Date(d.start).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const ok = ['scheduled'].includes(d.status);
  return `<div class="panel done-box"><div class="big" style="${ok ? '' : 'background:#c08a1e'}">${CHECK}</div>
    <h2 style="font-size:28px">${ok ? "You're booked" : 'Almost done'}</h2>
    <p>${ok ? `Order #${esc(d.number)} · ${esc(when)}` : 'We received your order but the payment is still processing. We\'ll confirm by email.'}</p>
    <p class="hint">${d.paymentStatus === 'paid' ? 'Paid in full. ' : d.paymentStatus === 'card_saved' ? 'Your card is saved and will be charged when your media is delivered. ' : ''}A confirmation is on its way.</p>
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
      <p class="d" style="margin:6px 0 4px">New to Knox View? Enter your details to get started.</p>
      <form onsubmit="kv.signUp(event)" novalidate>
      ${f('name', 'Full name', 'autocomplete="name" placeholder="First and last name"')}
      ${f('phone', 'Mobile number', 'type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(865) 555-1234" oninput="this.value=kv.fmtPhone(this.value)"')}
      ${f('email', 'Email', 'type="email" autocomplete="email" placeholder="you@brokerage.com"')}
      ${f('company', 'Brokerage / team <span style="text-transform:none;font-weight:400;color:var(--slate)">(optional)</span>', 'autocomplete="organization" placeholder="e.g. Prime Mountain Properties"')}
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
function vAccount() {
  return `<div class="panel" style="max-width:460px;margin:0 auto"><h2 style="font-size:26px">${LP().mode === 'signup' ? 'Create account' : 'Client sign in'}</h2>
      ${vLogin()}
      <p class="hint" style="margin-top:16px"><a href="#order">← Book a shoot</a></p></div>`;
}
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
const PORTAL_VIEWS = ['listings', 'invoices', 'settings', 'delivery'];

function listingsAll() {
  const d = S.pdata; if (!d || !d.agent) return [];
  const st = (media, b) => {
    const any = media.some(m => m.delivered), all = media.length && media.every(m => m.delivered);
    if (b?.locked) return ['Ready · pay to unlock', 'w'];
    if (all) return ['Delivered', 'g'];
    if (any) return ['Partly delivered', 'g'];
    if (!b) return ['In progress', ''];
    if (b.status === 'completed') return ['Editing', ''];
    if (b.status === 'scheduled') return [new Date(b.shoot_start) > new Date() ? 'Scheduled' : 'Editing', ''];
    return ['Pending', 'w'];
  };
  const out = (d.bookings || []).map(b => ({
    key: b.id, line1: b.address + (b.unit ? ', ' + b.unit : ''),
    line2: [b.city, [b.state, b.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    date: b.shoot_start, status: st(b.media || [], b), cover: b.cover_url, media: b.media || [], b,
  }));
  for (const l of d.listings || []) out.push({ key: l.id, line1: l.address || 'Listing', line2: l.city || '', date: l.date, status: st(l.media, null), cover: null, media: l.media });
  const q = UI.q.trim().toLowerCase();
  const list = q ? out.filter(x => `${x.line1} ${x.line2} ${x.b ? '#' + x.b.number : ''}`.toLowerCase().includes(q)) : out;
  const t = x => Date.parse(x.date || 0) || 0;
  return list.sort(UI.sort === 'old' ? (a, b) => t(a) - t(b) : UI.sort === 'addr' ? (a, b) => a.line1.localeCompare(b.line1, 'en', { numeric: true }) : (a, b) => t(b) - t(a));
}
const findListing = key => listingsAll().find(x => x.key === key) || (UI.q = '', listingsAll().find(x => x.key === key));
const linkOf = (l, kind) => l.media.find(m => kind === 'photo' ? m.dropbox : m.vimeo);

function acts(l) {
  const ph = linkOf(l, 'photo'), vd = linkOf(l, 'video');
  const a = (href, icon, title) => href ? `<a class="act" href="${esc(href)}" target="_blank" rel="noopener" title="${title}" aria-label="${title}">${ic(icon)}</a>`
    : `<span class="act off" title="${title} · not ready yet">${ic(icon)}</span>`;
  const b = (fn, icon, title) => `<button class="act" onclick="${fn}" title="${title}" aria-label="${title}">${ic(icon)}</button>`;
  const dl = `#delivery/${l.key}`, has = l.media.some(m => m.delivered) || l.b?.hasDelivery;
  const go = (tab, icon, title, on) => on ? `<a class="act" href="${dl}/${tab}" title="${title}" aria-label="${title}">${ic(icon)}</a>` : `<span class="act off" title="${title} · not ready yet">${ic(icon)}</span>`;
  return [go('photos', I.dl, 'Photos', !!ph || (has && l.media.some(m => m.media === 'photo'))), go('video', I.vid, 'Video', !!vd || (has && l.media.some(m => m.media === 'video'))),
    `<a class="act" href="${dl}" title="Media & delivery" aria-label="Media & delivery">${ic(I.eye)}</a>`,
    l.b ? b(`kv.invoiceFor(${l.b.number})`, I.inv, 'Invoice') : '',
    b(`kv.orderAgain('${l.key}')`, I.again, 'Book this address again')].join('');
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
    <a class="lcov" href="#delivery/${l.key}" aria-label="Media for ${esc(l.line1)}">${cover(l)}</a>
    <div class="lbody"><div class="laddr">${esc(l.line1)}<br><span>${esc(l.line2)}</span></div>
      <div class="lmeta"><div>${ic(I.tag)}<span class="pill ${l.status[1]}">${esc(l.status[0])}</span></div><div>${ic(I.cal)}${esc(fmtDate(l.date))}</div></div>
      ${l.b?.locked ? `<button class="btn" style="width:100%;margin-top:10px" onclick="kv.payBooking('${l.b.id}')">${ic(I.lock, 15)} Pay to download</button>` : ''}
      <div class="acts">${acts(l)}</div></div></article>`).join('')}</div>`;
}
function empty(text, cta) {
  return `<div class="empty-st">${ic(I.none, 64)}<p>${esc(text)}</p>${cta ? '<a class="btn" href="#order" style="text-decoration:none">Order now</a>' : ''}</div>`;
}

function invoicesAll() {
  const bk = (S.pdata?.bookings || []);
  const pend = bk.filter(b => !b.paid), paid = bk.filter(b => b.paid);
  const q = UI.iq.trim().toLowerCase().replace(/^#/, '');
  const f = list => q ? list.filter(b => `${b.number} ${b.address} ${b.city || ''} ${(b.items || []).map(i => i.name).join(' ')}`.toLowerCase().includes(q)) : list;
  return { pend, paid, rows: f(UI.itab === 'paid' ? paid : pend) };
}
function vInvoices() {
  const { pend, paid, rows } = invoicesAll();
  const due = pend.reduce((a, b) => a + +b.total, 0), paidSum = paid.reduce((a, b) => a + +b.total, 0);
  const onFile = pend.filter(b => b.payment_status === 'card_saved').length;
  const payPill = b => b.paid ? '<span class="pill g">Paid</span>' : b.payment_status === 'card_saved' ? '<span class="pill">Card on file</span>' : b.payment_status === 'processing' ? '<span class="pill">Processing</span>' : `<span class="pill w">${b.payment_status === 'failed' ? 'Payment failed' : 'Unpaid'}</span>`;
  const head = `<div class="ptools">
    <div class="tabs"><button class="${UI.itab === 'pending' ? 'on' : ''}" onclick="kv.ui('itab','pending')">${ic(I.inv)}Pending invoices${pend.length ? ` <i>${pend.length}</i>` : ''}</button><button class="${UI.itab === 'paid' ? 'on' : ''}" onclick="kv.ui('itab','paid')">${ic(I.table)}Paid invoices</button></div>
    <div class="bal"><div><small>Balance due</small><b>${money(due)}</b></div><div><small>Card on file</small><b>${onFile}</b></div><div><small>Paid to date</small><b>${money(paidSum)}</b></div></div>
    <div class="srch">${ic(I.search, 16)}<input id="iq" type="search" placeholder="Search" value="${esc(UI.iq)}" oninput="kv.search('iq',this.value,'iq')"></div></div>
    ${onFile && UI.itab === 'pending' ? '<p class="hint" style="margin:-6px 0 14px">Orders with a card on file are charged automatically when your media is delivered. You can also pay any of them now.</p>' : ''}`;
  if (!rows.length) return head + empty(UI.iq ? 'No invoices match your search.' : UI.itab === 'paid' ? 'No paid invoices yet.' : "You're all paid up. No pending invoices.", false);
  return head + `<div class="tbl-w"><table class="tbl"><thead><tr><th>Invoice</th><th>Property</th><th>Shoot date</th><th>Services</th><th class="r">Amount</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map(b => `<tr><td><b>#${esc(b.number)}</b></td><td>${esc(b.address)}${b.unit ? ', ' + esc(b.unit) : ''}<div class="hint">${esc(b.city || '')}</div></td>
      <td>${esc(fmtShort(b.shoot_start))}</td><td class="svc">${(b.items || []).map(i => esc(i.name)).join(', ')}</td>
      <td class="r"><b>${money(b.total)}</b></td><td>${payPill(b)}${b.paid && b.paid_at ? `<div class="hint">${esc(fmtShort(b.paid_at))}</div>` : ''}</td>
      <td class="r">${b.paid ? '' : `<button class="btn sm" onclick="kv.payBooking('${b.id}')">Pay</button>`}</td></tr>`).join('')}</tbody></table></div>`;
}

function vSettings() {
  const a = S.pdata?.agent || S.agent || {};
  const f = (k, label, v, attrs = '') => `<div><label for="st_${k}">${label}</label><input id="st_${k}" value="${esc(v || '')}" ${attrs}></div>`;
  return `<div class="panel" style="max-width:640px"><h2 style="font-size:26px;margin-bottom:4px">Settings</h2>
    <p class="hint" style="margin:0 0 18px">Your contact details. We use these to fill in your bookings and reach you about shoots.</p>
    <form onsubmit="kv.saveProfile(event)" class="fg">
      <div class="full">${f('full_name', 'Full name', a.full_name, 'autocomplete="name"').slice(5, -6)}</div>
      ${f('phone', 'Mobile number', a.phone, 'type="tel" inputmode="tel" autocomplete="tel-national" oninput="this.value=kv.fmtPhone(this.value)"')}
      <div><label>Email</label><input value="${esc(a.email || S.session?.user?.email || '')}" disabled><p class="hint" style="margin:5px 0 0">This is how you sign in. To change it, call ${esc(CFG.phone)}.</p></div>
      ${f('brokerage', 'Brokerage', a.brokerage, 'autocomplete="organization"')}
      ${f('team_name', 'Team', a.team_name)}
      <div class="full">${S.error ? `<div class="msg err">${esc(S.error)}</div>` : ''}${UI.saved ? '<div class="msg info">Saved.</div>' : ''}
        <button class="btn" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Save changes'}</button></div>
    </form></div>
    <div class="panel" style="max-width:640px;margin-top:16px"><h2 style="font-size:22px;margin-bottom:6px">Get the app</h2>
      <p class="hint" style="margin:0 0 10px">Add Knox View to your home screen to book and check your orders like an app.</p>
      <p style="margin:0 0 6px"><b>iPhone:</b> open this page in Safari, tap the Share button, then <b>Add to Home Screen</b>.</p>
      <p style="margin:0"><b>Android:</b> open this page in Chrome, tap the ⋮ menu, then <b>Add to Home screen</b> (or <b>Install app</b>).</p>
      <p class="hint" style="margin:10px 0 0">The first time you open it from your home screen, sign in once with your email or phone.</p></div>`;
}

const TEST_EMAIL = 'chris+test@knoxview.com';
const isTestAccount = () => (S.session?.user?.email || '').toLowerCase() === TEST_EMAIL;
function vPortal() {
  const p = S.pdata;
  if (isTestAccount() && p && !p.loading && !p.error) return `<div class="msg info testacct"><b>Test account.</b> You're viewing the portal as the test client (${TEST_EMAIL}). Sample orders are marked TEST.</div>` + vPortalBody();
  return vPortalBody();
}
function vPortalBody() {
  const p = S.pdata;
  if (!p || p.loading) return '<div class="panel loading"><span class="spin"></span> Loading…</div>';
  if (p.error) return `<div class="msg err">${esc(p.error)} <a href="javascript:kv.reloadPortal()">Try again</a></div>`;
  return S.view === 'invoices' ? vInvoices() : S.view === 'settings' ? vSettings() : vListings();
}
function vPortalOrDelivery() {
  return S.view === 'delivery' ? vDelivery() : vPortal();
}

function vHeader() {
  const v = S.view, signedIn = !!S.session;
  const nav = signedIn ? [['#order', I.cart, 'Order now', v === 'book' || v === 'done'], ['#listings', I.home, 'Listings', v === 'listings' || v === 'delivery'], ['#invoices', I.inv, 'Invoices', v === 'invoices']]
    .map(([h, i, t, on]) => `<a href="${h}" class="${on ? 'on' : ''}">${ic(i)}<span>${t}</span></a>`).join('') : '';
  $('pnav').innerHTML = nav;
  const a = S.pdata?.agent || S.agent, name = a?.full_name || S.session?.user?.email || '';
  $('acct').innerHTML = !signedIn ? `<a class="signin" href="#account">${v === 'account' ? 'Book a shoot' : 'Sign in'}</a>`.replace('href="#account">Book', 'href="#order">Book')
    : `<button class="me" onclick="kv.menu(event)" aria-expanded="${UI.menu}"><span class="av">${esc(initials(a?.full_name || name))}</span>
        <span class="me-t"><b>${esc(name)}</b>${a?.brokerage ? `<small>${esc(a.brokerage)}</small>` : ''}</span>${ic(I.down, 16)}</button>
      ${UI.menu ? `<div class="menu" onclick="event.stopPropagation()"><div class="menu-h"><span class="av">${esc(initials(a?.full_name || name))}</span><div><b>${esc(name)}</b><small>${esc(a?.email || S.session.user.email || '')}</small></div></div>
        <a href="#settings" onclick="kv.menu()">${ic(I.gear)}Settings</a><a href="#invoices" onclick="kv.menu()">${ic(I.inv)}Invoices</a><button onclick="kv.signOut()">${ic(I.out)}Log out</button></div>` : ''}`;
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
const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
const D = (S.dl = { key: null, data: null, loading: false, error: '', tab: null, sel: new Set() });

async function loadDelivery(key) {
  Object.assign(D, { key, data: null, loading: true, error: '', sel: new Set() }); render();
  try { D.data = await api('delivery', { key }); } catch (e) { D.error = e.message; }
  D.loading = false; render();
}
const dTabs = d => [
  (d.photos.length || d.folders.length) && ['photos', I.photo, 'Photos'],
  d.videos.length && ['video', I.film, 'Video'],
  d.floorplans.length && ['floorplan', I.plan, 'Floor plan'],
  d.tour && ['tour', I.cube, '3D tour'],
].filter(Boolean);

function linkCard(title, url, icon, soon) {
  if (soon) return `<div class="dl-card soon"><h3>${icon ? ic(icon, 20) : ''}${esc(title)}</h3><p class="hint" style="margin:0">Coming soon. Your property website will appear here when it's ready.</p></div>`;
  if (!url) return `<div class="dl-card"><h3>${esc(title)}</h3><p class="hint" style="margin:0">${ic(I.lock, 14)} Unlocks after payment.</p></div>`;
  return `<div class="dl-card"><h3>${icon ? ic(icon, 20) : ''}${esc(title)}</h3>
    <input class="dl-url" readonly value="${esc(url)}" onclick="this.select()">
    <div class="dl-btns"><a class="btn o" href="${esc(url)}" target="_blank" rel="noopener">${ic(I.eye, 16)} View</a>
      <button class="btn o" onclick="kv.dShare(${esc(JSON.stringify(url))}, ${esc(JSON.stringify(title))})">${ic(I.share, 16)} Share</button>
      <button class="btn o wide" onclick="kv.dQR(${esc(JSON.stringify(url))}, ${esc(JSON.stringify(title))})">${ic(I.qr, 16)} QR code</button></div></div>`;
}
function vDelivery() {
  if (D.loading || !D.data) return D.error ? `<a class="dl-back" href="#listings">‹ Listings</a><div class="msg err">${esc(D.error)}</div>` : '<div class="panel loading"><span class="spin"></span> Getting your media…</div>';
  const d = D.data, tabs = dTabs(d), tab = (tabs.find(t => t[0] === D.tab) || tabs[0] || [])[0];
  const when = d.head.date ? fmtDate(d.head.date) : '';
  let out = `<a class="dl-back" href="#listings">‹ Listings</a>
    <header class="dl-head"><h1>${esc(d.head.address)}</h1><p>${esc([d.head.line2, d.head.brokerage].filter(Boolean).join(' · '))}</p>
      <p class="hint">${when ? esc(when) : ''}${d.head.number ? ` · Order #${esc(d.head.number)}` : ''}</p></header>`;
  if (d.locked) out += `<div class="dl-lock">${ic(I.lock, 22)}<div><b>Your media is ready.</b> Preview it below, then pay to download everything and unlock your links and 3D tour.</div>
      <button class="btn" onclick="kv.payBooking('${d.bookingId}')">Pay to download</button></div>`;
  const cards = d.websites.map(w => linkCard(w.label, w.url, null, w.soon)).join('');
  if (cards) out += `<section class="dl-cards">${cards}</section>`;
  if (!tabs.length && !d.marketing) return out + `<div class="empty-st">${ic(I.photo, 56)}<p>Your media isn't delivered yet. We'll text and email you as soon as it is.</p></div>`;
  out += `<section class="dl-media"><nav class="dl-tabs">${tabs.map(([k, i, l]) => `<button class="${k === tab ? 'on' : ''}" onclick="kv.dTab('${k}')">${ic(i, 20)}<span>${l}</span></button>`).join('')}
    ${d.marketing ? (d.marketing.url ? `<a class="dl-tabx" href="${esc(d.marketing.url)}" target="_blank" rel="noopener">${ic(I.ext, 20)}<span>Marketing content</span></a>` : `<span class="dl-tabx off">${ic(I.lock, 18)}<span>Marketing content</span></span>`) : ''}</nav>`;
  out += tab === 'photos' ? dPhotos(d) : tab === 'video' ? dVideos(d) : tab === 'floorplan' ? dPlans(d) : tab === 'tour' ? dTour(d) : '';
  return out + '</section>';
}
const SET_LABEL = { photos: ['photo', 'photos'], floorplans: ['floor plan', 'floor plans'] };
const curSet = () => D.data[D.cur] || [];
function dGrid(d, key) {
  D.cur = key;
  const list = d[key], n = D.sel.size, all = list.length, [one, many] = SET_LABEL[key];
  const zip = key === 'photos' ? d.folders.find(f => f.zip)?.zip : null;
  const tile = (p, i, inner) => p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy" draggable="false" ${d.locked ? 'oncontextmenu="return false"' : ''}>` : `<span class="dl-file">${ic(I.plan, 34)}<small>${esc((p.name.split('.').pop() || '').toUpperCase())}</small></span>`;
  if (!all) return `<p class="hint" style="margin:14px 2px">${d.locked ? `Your ${many} unlock after payment.` : `Your ${many} are being prepared. Check back shortly.`}</p>
    ${zip ? `<a class="btn" href="${esc(zip)}">${ic(I.dl, 16)} Download all ${many} (zip)</a>` : ''}`;
  if (d.locked) return `<div class="dl-bar locked"><span>${ic(I.lock, 18)} <b>Preview.</b> Pay to download ${all === 1 ? `your ${one}` : `all ${all} ${many}`} in full resolution, without the watermark.</span>
      <button class="btn" onclick="kv.payBooking('${d.bookingId}')">Pay to download</button></div>
    <div class="dl-grid preview ${key}">${list.map((p, i) => `<figure class="dl-ph"><button class="dl-img" onclick="kv.dView(${i})" aria-label="View ${esc(p.name)}">${tile(p, i)}</button>
      <figcaption><span>${esc(p.name)}</span></figcaption></figure>`).join('')}</div>`;
  const bar = `<div class="dl-bar">
      ${all > 1 ? `<button class="btn o" onclick="kv.dSelAll()">${n === all ? 'Clear selection' : 'Select all'}</button>
      <button class="btn" ${n ? '' : 'disabled'} onclick="kv.dPick()">${ic(I.dl, 16)} Download${n ? ` ${n}` : ''}</button>` : ''}
      ${zip && !isPhone() ? `<a class="btn o" href="${esc(zip)}">${ic(I.dl, 16)} Download all (zip)</a>` : `<button class="btn ${all > 1 ? 'o' : ''}" onclick="kv.dAll()">${ic(I.dl, 16)} Download${all > 1 ? ` all ${all}` : ''}</button>`}</div>
      <p class="hint dl-tip">Tap ${all > 1 ? `a ${one}` : `the ${one}`} to see it full size.${all > 1 ? ' Tap the box in the corner to select it.' : ''}${isPhone() ? ' After Download, choose <b>Save Images</b> to put it in Photos.' : ''}</p>`;
  return bar + `<div class="dl-grid ${key}">${list.map((p, i) => `<figure class="dl-ph ${D.sel.has(i) ? 'sel' : ''}">
      <div class="dl-img"><button class="dl-open" onclick="kv.dView(${i})" aria-label="View ${esc(p.name)}">${tile(p, i)}</button>
        ${all > 1 ? `<button class="dl-chk" onclick="kv.dSel(${i})" aria-label="${D.sel.has(i) ? 'Unselect' : 'Select'} ${esc(p.name)}" aria-pressed="${D.sel.has(i)}">${CHECK}</button>` : ''}</div>
      <figcaption><span>${esc(p.name)}</span><span class="dl-q ${p.web ? '' : 'one'}">${p.web ? `<button onclick="kv.dSave([${i}],'web')">${ic(I.dl, 14)} Web</button>` : ''}<button onclick="kv.dSave([${i}],'high')">${ic(I.dl, 14)} ${p.web ? 'High' : 'Download'}</button></span></figcaption></figure>`).join('')}</div>`;
}
const dPhotos = d => dGrid(d, 'photos');
/* ----- full-screen photo viewer: swipe / arrows, select from inside ----- */
function lbEl() { let el = document.getElementById('lb'); if (!el) { el = document.createElement('div'); el.id = 'lb'; document.body.appendChild(el); } return el; }
function lbPaint() {
  const d = D.data, list = curSet(), i = D.lb, p = list[i], el = lbEl(), sel = D.sel.has(i), multi = list.length > 1;
  el.className = 'lb on';
  el.innerHTML = `<div class="lb-top"><span>${multi ? `${i + 1} / ${list.length}` : ''}</span><span class="lb-name">${esc(p.name)}</span><button class="lb-x" onclick="kv.dLbClose()" aria-label="Close">✕</button></div>
    <div class="lb-stage ${D.cur}" id="lbStage"><img src="${esc(p.view || p.thumb || '')}" alt="${esc(p.name)}" draggable="false" ${d.locked ? 'oncontextmenu="return false"' : ''}>
      ${multi ? '<button class="lb-nav prev" onclick="kv.dLbGo(-1)" aria-label="Previous">‹</button><button class="lb-nav next" onclick="kv.dLbGo(1)" aria-label="Next">›</button>' : ''}</div>
    <div class="lb-bar">${d.locked
      ? `<span class="lb-note">${ic(I.lock, 16)} Preview</span><button class="btn" onclick="kv.dLbClose();kv.payBooking('${d.bookingId}')">Pay to download</button>`
      : `${multi ? `<button class="btn ${sel ? '' : 'o'} lb-sel" onclick="kv.dLbSel()" aria-pressed="${sel}">${sel ? `${CHECK} Selected` : 'Select'}</button>` : ''}
         ${p.web ? `<button class="btn o" onclick="kv.dSave([${i}],'web')">${ic(I.dl, 16)} Web</button>` : ''}
         <button class="btn o" onclick="kv.dSave([${i}],'high')">${ic(I.dl, 16)} ${p.web ? 'High' : 'Download'}</button>
         ${D.sel.size ? `<button class="btn" onclick="kv.dLbClose();kv.dPick()">${ic(I.dl, 16)} Download ${D.sel.size}</button>` : ''}`}</div>`;
  [i - 1, i + 1].forEach(k => { const q = list[(k + list.length) % list.length]; if (q && (q.view || q.thumb)) new Image().src = q.view || q.thumb; }); // preload neighbours
  const st = document.getElementById('lbStage'); let x0 = null, y0 = null;
  st.ontouchstart = e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; };
  st.ontouchend = e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (multi && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) kv.dLbGo(dx < 0 ? 1 : -1); else if (dy > 90) kv.dLbClose(); };
}
document.addEventListener('keydown', e => { if (D.lb == null) return; if (e.key === 'ArrowRight') kv.dLbGo(1); else if (e.key === 'ArrowLeft') kv.dLbGo(-1); else if (e.key === 'Escape') kv.dLbClose(); });
function dVideos(d) {
  return d.videos.map((v, i) => `<article class="dl-vid">
    <h3>${esc(v.title)}${v.label && v.label !== v.title ? ` <small>${esc(v.label)}</small>` : ''}</h3>
    <div class="dl-player ${v.portrait ? 'tall' : ''}">${v.preview && (v.embed || v.file) ? '<span class="dl-badge">Preview</span>' : ''}${v.embed ? `<iframe src="${esc(v.embed)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy" title="${esc(v.title)}"></iframe>`
      : v.file ? `<video src="${esc(v.file)}" controls playsinline preload="metadata"></video>`
      : v.poster ? `<img src="${esc(v.poster)}" alt="">` : `<div class="dl-ph-empty">${ic(d.locked ? I.lock : I.film, 40)}${v.pending ? '<p>Your video is being prepared.</p>' : ''}</div>`}</div>
    ${d.locked ? `<div class="dl-bar locked"><span>${ic(I.lock, 18)} Pay to download and share this video.</span><button class="btn" onclick="kv.payBooking('${d.bookingId}')">Pay to download</button></div>` : `
    <div class="dl-vbtns">
      ${v.download ? `<button class="btn" onclick="kv.dVideo(${i})">${ic(I.dl, 16)} ${isPhone() ? 'Save to phone' : 'Download'}</button>` : v.open ? `<a class="btn" href="${esc(v.open)}" target="_blank" rel="noopener">${ic(I.ext, 16)} Open video</a>` : ''}
      ${v.share && !d.locked ? `<button class="btn o" onclick="kv.dShare(${esc(JSON.stringify(v.share))}, ${esc(JSON.stringify(v.title))})">${ic(I.share, 16)} Share</button>` : ''}
      ${v.embed && !d.locked ? `<button class="btn o" onclick="kv.dEmbed(${i})">${ic(I.code, 16)} Embed</button>` : ''}
      ${v.share && !d.locked ? `<button class="btn o" onclick="kv.dCopy(${esc(JSON.stringify(v.share))}, 'Video link')">${ic(I.copy, 16)} Copy video link</button>` : ''}
    </div>`}${v.download && isPhone() ? '<p class="hint dl-tip">Tap <b>Save to phone</b>, then <b>Save Video</b> to add it to your camera roll.</p>' : ''}</article>`).join('');
}
function dPlans(d) {
  const files = d.floorplans.filter(f => !f.open), links = d.floorplans.filter(f => f.open);
  return (files.length ? dGrid({ ...d, floorplans: files }, 'floorplans') : '') +
    links.map(f => `<a class="btn o" style="margin-top:12px" href="${esc(f.open)}" target="_blank" rel="noopener">${ic(I.ext, 16)} Open floor plan</a>`).join('');
}
function dTour(d) {
  const u = d.tour.url;
  if (!u) return `<p class="hint" style="margin:14px 2px">${ic(I.lock, 14)} Your 3D tour unlocks after payment.</p>`;
  const embed = /matterport|zillow|cupix|iguide|my\.matterport/i.test(u);
  return `<div class="dl-player">${embed ? `<iframe src="${esc(u)}" allow="fullscreen; xr-spatial-tracking" allowfullscreen loading="lazy" title="3D tour"></iframe>` : `<div class="dl-ph-empty">${ic(I.cube, 44)}</div>`}</div>
    <div class="dl-vbtns"><a class="btn" href="${esc(u)}" target="_blank" rel="noopener">${ic(I.ext, 16)} Open 3D tour</a>
      <button class="btn o" onclick="kv.dShare(${esc(JSON.stringify(u))}, '3D tour')">${ic(I.share, 16)} Share</button>
      <button class="btn o" onclick="kv.dCopy(${esc(JSON.stringify(`<iframe src="${u}" width="100%" height="480" frameborder="0" allow="fullscreen; xr-spatial-tracking" allowfullscreen></iframe>`))}, 'Embed code')">${ic(I.code, 16)} Embed</button>
      <button class="btn o" onclick="kv.dCopy(${esc(JSON.stringify(u))}, 'Tour link')">${ic(I.copy, 16)} Copy link</button></div>`;
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
      dModal(`<div class="dl-ready">${CHECK}</div><p class="dl-ready-t">Your ${what === 'video' ? 'video is' : files.length > 1 ? 'photos are' : 'photo is'} ready to save.<br>Press continue.</p>
        <p class="hint" style="text-align:center;margin:0 0 14px">Then choose <b>${what === 'video' ? 'Save Video' : files.length > 1 ? `Save ${files.length} Images` : 'Save Image'}</b>.</p>
        <button class="btn" id="dlGo" style="width:100%">Continue</button>`);
      $('dlGo').onclick = () => navigator.share({ files }).then(() => res(true), e => res(e?.name !== 'AbortError' ? null : false)); // must run inside the tap
    });
    if (ok === false) break; // they cancelled the share sheet
  }
  kv.closeModal();
}
Object.assign(window.kv, {
  dView(i) { if (!curSet()[i]?.thumb && !curSet()[i]?.view) { const f = curSet()[i]; if (f?.high) kv.dSave([i], 'high'); return; } D.lb = i; document.body.style.overflow = 'hidden'; lbPaint(); },
  dLbGo(step) { const n = curSet().length; D.lb = (D.lb + step + n) % n; lbPaint(); },
  dLbSel() { const i = D.lb; D.sel.has(i) ? D.sel.delete(i) : D.sel.add(i); lbPaint(); render(); },
  dLbClose() { D.lb = null; document.body.style.overflow = ''; const el = document.getElementById('lb'); if (el) { el.className = 'lb'; el.innerHTML = ''; } },
  dTab(t) { D.tab = t; D.sel = new Set(); history.replaceState(null, '', `#delivery/${D.key}/${t}`); render(); },
  dSel(i) { if (D.data.locked) return; D.sel.has(i) ? D.sel.delete(i) : D.sel.add(i); render(); },
  dSelAll() { const l = curSet(); D.sel = D.sel.size === l.length ? new Set() : new Set(l.map((_, i) => i)); render(); },
  dPick() { // choose quality for the selected photos
    const n = D.sel.size, [one, many] = SET_LABEL[D.cur];
    dModal(`<h2 style="font-size:22px;margin-bottom:12px">Download ${n} ${n === 1 ? one : many}</h2>
      <label class="radio sel"><input type="radio" name="dq" value="high" checked> <span><b>High resolution</b><br><small class="hint">Full size, for print and MLS</small></span></label>
      ${curSet().some(p => p.web) ? `<label class="radio"><input type="radio" name="dq" value="web"> <span><b>Web quality</b><br><small class="hint">2048 px, smaller files for social and websites</small></span></label>` : ''}
      <div class="nav"><button class="btn o" onclick="kv.closeModal()">Cancel</button><button class="btn" onclick="kv.dSave([...kv._sel()], document.querySelector('[name=dq]:checked').value)">${ic(I.dl, 16)} Download</button></div>`);
    document.querySelectorAll('[name=dq]').forEach(r => r.onchange = () => document.querySelectorAll('.dl-modal .radio').forEach(l => l.classList.toggle('sel', l.querySelector('input').checked)));
  },
  _sel: () => [...D.sel].sort((a, b) => a - b),
  dAll() { const l = curSet(); D.sel = new Set(l.map((_, i) => i)); render(); if (l.some(p => p.web)) kv.dPick(); else kv.dSave([...kv._sel()], 'high'); },
  dSave(idx, q) { const list = idx.map(i => curSet()[i]).map(p => ({ url: p[q], name: p.name })).filter(f => f.url); if (list.length) saveFiles(list, 'photo'); },
  dSaveUrl(url, name) { saveFiles([{ url, name }], /\.(mp4|mov|m4v)$/i.test(name) ? 'video' : 'photo'); },
  dVideo(i) { const v = D.data.videos[i]; saveFiles([{ url: v.download, name: `${D.data.head.address}.mp4` }], 'video'); },
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
  invoiceFor(n) { UI.iq = '#' + n; UI.itab = S.pdata.bookings.find(b => b.number === n)?.paid ? 'paid' : 'pending'; location.hash = '#invoices'; },
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
      <h2 style="font-size:24px">${esc(l.line1)}</h2><div class="hint" style="margin:2px 0 12px">${esc(l.line2)}${b ? ` · Order #${esc(b.number)}` : ''}</div>
      <span class="pill ${l.status[1]}">${esc(l.status[0])}</span>
      <dl class="review">${l.date ? `<dt>${b ? 'Shoot' : 'Date'}</dt><dd>${esc(new Date(l.date).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', ...(b ? { hour: 'numeric', minute: '2-digit' } : {}) }))}</dd>` : ''}
        ${b ? `<dt>Services</dt><dd>${(b.items || []).map(i => `<div class="line"><span>${esc(i.name)}</span><span>${money(i.price)}</span></div>`).join('')}<div class="tot"><span>Total</span><span>${money(b.total)}</span></div></dd>` : ''}
        <dt>Media</dt><dd>${media}</dd></dl>
      <div class="nav"><button class="btn o" onclick="kv.closeModal()">Close</button>${b && !b.paid ? `<button class="btn" onclick="kv.closeModal();kv.payBooking('${b.id}')">Pay ${money(b.total)}</button>` : ''}</div></div></div>`;
  },
  async saveProfile(ev) {
    ev.preventDefault();
    const v = k => ($('st_' + k)?.value || '').trim();
    S.busy = true; S.error = ''; UI.saved = false; render();
    try {
      const r = await api('profile', { full_name: v('full_name'), phone: v('phone'), brokerage: v('brokerage'), team_name: v('team_name') });
      S.agent = r.agent; if (S.pdata) S.pdata.agent = r.agent; fillContact(); UI.saved = true;
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

function vSummary(btn) {
  const ls = lines();
  return `<h2>Your order</h2>
    ${ls.length ? ls.map(l => `<div class="line"><span>${esc(l.name)}</span><span>${money(l.price)}</span></div>${(l.subs || []).map(s => `<div class="line sub"><span>${esc(s)}</span><span>incl.</span></div>`).join('')}`).join('') : '<div class="empty">Choose a package or service to get started.</div>'}
    <div class="tot"><span>Total</span><span>${money(total())}</span></div>
    ${S.startLabel && S.step >= 2 ? `<div class="note">${new Date(S.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${esc(S.startLabel)}</div>` : ''}
    ${btn && S.step < 3 ? `<button class="btn" onclick="kv.go(${S.step + 1})" ${isValid(S.step) ? '' : 'disabled'}>Continue</button>` : ''}`;
}

/* ================= render ================= */
function render() {
  const portal = PORTAL_VIEWS.includes(S.view), acct = S.view === 'account' || portal, done = S.view === 'done';
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
  if (S.step === 3 && S.checkout?.elements && $('pay-el')?.childElementCount) {
    // Stripe's card form is mounted: patch only the error and buttons so the iframe isn't reloaded
    const tmp = document.createElement('div'); tmp.innerHTML = vReview();
    $('revErr').innerHTML = tmp.querySelector('#revErr').innerHTML;
    $('revNav').innerHTML = tmp.querySelector('#revNav').innerHTML;
  } else {
    $('view').innerHTML = [vProperty, vServices, vSchedule, vReview][S.step]() + (S.step < 3 && S.error ? `<div class="msg err">${esc(S.error)}</div>` : '');
  }
  $('sumDesk').innerHTML = vSummary(true);
  $('sumMob').innerHTML = vSummary(false);
  $('barTot').textContent = money(total());
  $('barSub').textContent = lines().length ? lines().map(l => l.name).join(' · ') : 'Nothing selected';
  const nb = $('barNext');
  nb.textContent = S.step < 3 ? 'Continue' : S.checkout ? (S.checkout.intentType === 'payment' ? 'Pay & book' : 'Save card & book') : 'To payment';
  nb.disabled = S.busy || (S.step === 1 ? !inCart().size : S.step === 2 ? !S.start : false);
  nb.onclick = () => S.step < 3 ? go(S.step + 1) : S.checkout ? confirmPay() : startCheckout();
}
document.addEventListener('input', e => {
  const o = e.target.dataset?.o, k = e.target.dataset?.k; if (!o) return;
  S[o][k] = e.target.value;
  if (S.errors[k]) { delete S.errors[k]; e.target.parentElement.classList.remove('err'); }
  if (k === 'sqftLabel') { resetSchedule(); render(); }
});
$('barOpen').onclick = () => $('sheet').classList.add('on');
$('sheet').onclick = e => { if (e.target.id === 'sheet') e.currentTarget.classList.remove('on'); };

function route() {
  S.error = '';
  const [h, hKey, hTab] = location.hash.replace('#', '').split('/');
  UI.menu = false; UI.saved = false;
  if (h === 'account' && S.session) { location.replace('#listings'); return; }
  if (PORTAL_VIEWS.includes(h)) {
    if (!S.session) { S.after = location.hash; S.view = 'account'; }
    else {
      S.view = h; if (!S.pdata && h !== 'delivery') loadPortal();
      if (h === 'delivery') { if (hKey && (hKey !== S.dl.key || !S.dl.data)) loadDelivery(hKey); S.dl.tab = hTab || S.dl.tab; if (hKey !== S.dl.key) S.dl.tab = hTab || null; }
    }
  } else S.view = h === 'account' ? 'account' : S.view === 'done' && !h ? 'done' : 'book';
  render(); if (PORTAL_VIEWS.includes(S.view) || S.view === 'account') window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

/* ================= boot ================= */
(async function boot() {
  try {
    const hand = location.hash.match(/^#ts=([\w-]+)$/); // HQ → "Open as test client" hands a session over in the URL fragment (never sent to a server)
    if (hand) {
      try { const t = JSON.parse(atob(hand[1].replace(/-/g, '+').replace(/_/g, '/'))); await sb.auth.setSession({ access_token: t.a, refresh_token: t.r }); }
      catch (e) { console.warn('test session handoff failed', e); }
      history.replaceState(null, '', location.pathname + '#listings');
    }
    const [svcs, ups, cfg, sess] = await Promise.all([
      sb.from('booking_services').select('id, kind, name, description, includes, price, duration_min, covers, badge, sort_order').order('sort_order'),
      sb.from('booking_upsells').select('service_id, title, description, show_when_any, hide_when_any, sort_order').order('sort_order'),
      api('config'),
      sb.auth.getSession(),
    ]);
    if (svcs.error) throw svcs.error;
    S.services = svcs.data; S.upsells = ups.data || []; S.config = cfg; S.session = sess.data.session;
    if (cfg.stripe?.mode === 'test') $('testbar').hidden = false;
    if (S.session) {
      const l = await api('link').catch(() => ({}));
      S.agent = l.agent; fillContact();
    }
    sb.auth.onAuthStateChange((_e, session) => {
      const was = !!S.session; S.session = session;
      if (session && !was) { api('link').then(l => { S.agent = l.agent; fillContact(); route(); }).catch(() => route()); }
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
