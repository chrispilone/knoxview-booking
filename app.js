import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const CFG = window.KV_CONFIG;
const sb = createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } });
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const STEPS = ['Services', 'Property', 'Schedule', 'Review & Pay'];

async function api(action, body = {}) {
  const { data, error } = await sb.functions.invoke('booking', { body: { action, ...body } });
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
  done: null, portal: null,
};
const svc = id => S.services.find(s => s.id === id);
const packages = () => S.services.filter(s => s.kind === 'package').sort((a, b) => a.sort_order - b.sort_order);
const alacarte = () => S.services.filter(s => s.kind === 'addon').sort((a, b) => a.sort_order - b.sort_order);
const covered = () => new Set(S.pkg ? svc(S.pkg)?.covers ?? [] : []);
const inCart = () => { const c = new Set(S.items); if (S.pkg) c.add(S.pkg); return c; };
const anyOf = (list, set) => (list || []).some(x => set.has(x));
const largeOn = () => {
  const o = (S.config?.settings?.sqft_options || []).find(x => x.label === S.addr.sqftLabel);
  return S.adu || (o ? (o.max === null || o.max >= S.config.settings.large_sqft) : false);
};
const largeVisible = () => !!S.pkg || [...S.items].some(id => /photograph/i.test(svc(id)?.name || ''));
function lines() {
  const out = [];
  if (S.pkg) { const p = svc(S.pkg); out.push({ name: p.name + ' Package', price: +p.price, subs: p.includes }); }
  for (const id of S.items) { const s = svc(id); if (s) out.push({ name: s.name, price: +s.price }); }
  if (largeOn() && largeVisible()) out.push({ name: S.config.settings.large_label, price: +S.config.settings.large_fee });
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
  if (!largeVisible()) S.adu = false;
  resetSchedule();
}

/* ================= actions ================= */
window.kv = {
  pickPkg(id) { S.pkg = S.pkg === id ? null : id; cleanup(); render(); },
  toggle(id) { if (covered().has(id)) return; S.items.has(id) ? S.items.delete(id) : S.items.add(id); cleanup(); render(); },
  toggleAdu() { S.adu = !S.adu; resetSchedule(); render(); },
  go, pickSlot(start, label) { S.start = start; S.startLabel = label; S.checkout = null; render(); },
  moreSlots() { loadSlots(S.slots.days[S.slots.days.length - 1].date, true); },
  setPay(v) { S.payOpt = v; S.checkout = null; render(); },
  startCheckout, confirmPay, signIn, signOut, payBooking, closeModal() { $('modal').innerHTML = ''; },
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
  if (step === 0) return inCart().size > 0;
  if (step === 1) { const a = S.addr; return a.street && a.city && a.state && /^\d{5}$/.test(a.zip) && a.sqftLabel; }
  if (step === 2) return !!S.start;
  if (step === 3) { const c = S.contact; return c.first && c.last && /\S+@\S+\.\S+/.test(c.email) && c.phone.replace(/\D/g, '').length >= 10; }
  return true;
}
function validate(step) {
  S.errors = {};
  const a = S.addr, c = S.contact;
  if (step === 1) { if (!a.street) S.errors.street = 1; if (!a.city) S.errors.city = 1; if (!/^\d{5}$/.test(a.zip)) S.errors.zip = 1; if (!a.sqftLabel) S.errors.sqftLabel = 1; }
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
async function signIn(ev) {
  ev?.preventDefault();
  const email = $('loginEmail').value.trim();
  if (!/\S+@\S+\.\S+/.test(email)) { S.error = 'Enter your email.'; render(); return; }
  S.busy = true; S.error = ''; render();
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/#account`, data: { portal: 'client' } } });
  S.busy = false;
  S.portal = { sent: !error, email };
  if (error) S.error = error.message;
  render();
}
async function signOut() { await sb.auth.signOut(); S.session = null; S.agent = null; S.portal = null; location.hash = ''; render(); }
async function loadPortal() {
  S.portal = { loading: true }; render();
  try { S.portal = await api('portal'); } catch (e) { S.portal = { error: e.message }; }
  render();
}
async function payBooking(id) {
  if (!stripeReady()) { alertModal('Online payments are not switched on yet.'); return; }
  try {
    const r = await api('pay', { bookingId: id });
    if (r.alreadyPaid) { loadPortal(); return; }
    $('modal').innerHTML = `<div class="modal"><div class="panel"><h2 style="font-size:22px">Pay ${money(r.booking.total)}</h2>
      <div id="pay-el2" style="margin-top:14px"></div><div id="payErr"></div>
      <div class="nav"><button class="btn o" onclick="kv.closeModal()">Cancel</button><button class="btn" id="payGo">Pay now</button></div></div></div>`;
    const elements = stripe.elements({ clientSecret: r.clientSecret, appearance });
    elements.create('payment').mount('#pay-el2');
    $('payGo').onclick = async () => {
      $('payGo').disabled = true;
      const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: `${location.origin}/#account` }, redirect: 'if_required' });
      if (error) { $('payErr').innerHTML = `<div class="msg err">${esc(error.message)}</div>`; $('payGo').disabled = false; return; }
      await api('confirm', { bookingId: r.booking.id, token: r.booking.token }).catch(() => {});
      kv.closeModal(); loadPortal();
    };
  } catch (e) { alertModal(e.message); }
}
function alertModal(text) {
  $('modal').innerHTML = `<div class="modal"><div class="panel"><p>${esc(text)}</p><div class="nav"><span></span><button class="btn" onclick="kv.closeModal()">OK</button></div></div></div>`;
}

/* ================= views ================= */
// Upsell pop-ups (e.g. Zillow 3D, Real Twilight) are off until Chris picks which ones to show.
const SHOW_UPSELLS = false;
function vServices() {
  const cov = covered();
  const pk = packages().map(p => `
    <button class="card round ${S.pkg === p.id ? 'sel' : ''}" onclick="kv.pickPkg('${p.id}')" aria-pressed="${S.pkg === p.id}">
      ${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ''}
      <span class="tick">${CHECK}</span>
      <h3>${esc(p.name)}</h3>
      <div class="price">${money(p.price)}<small>starting</small></div>
      <ul class="chk">${(p.includes || []).map(i => `<li>${CHECK}<span>${esc(i)}</span></li>`).join('')}</ul>
    </button>`).join('');
  const ups = upsells().map(u => `<div class="up"><div style="flex:1"><h3>${esc(u.title)}</h3><p>${esc(u.description)}</p></div>
      <button class="btn lt" onclick="kv.toggle('${u.service_id}')">+ ${money(svc(u.service_id).price)}</button></div>`).join('');
  const row = s => {
    const inc = cov.has(s.id), sel = S.items.has(s.id);
    return `<button class="row ${sel ? 'sel' : ''} ${inc ? 'incl' : ''}" onclick="kv.toggle('${s.id}')" aria-pressed="${sel || inc}">
      <span class="box">${CHECK}</span>
      <span class="row-t"><span class="row-n">${esc(s.name)}</span>${s.description ? `<span class="row-d">${esc(s.description)}</span>` : ''}</span>
      <span class="row-p">${inc ? `<span class="inc">Included</span>` : money(s.price)}</span></button>`;
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
  const large = largeVisible() ? `<section class="sec"><div class="sec-h"><i style="background:#8ca6cc"></i><h2>Property Add-Ons</h2></div>
      <p class="d">For larger homes and properties with extra structures.</p><div class="grid">
      <button class="card sq small-card ${S.adu ? 'sel' : ''}" onclick="kv.toggleAdu()" aria-pressed="${S.adu}"><span class="tick">${CHECK}</span>
      <h3>${esc(st.large_label)}</h3><div class="price">${money(st.large_fee)}</div><div class="meta">Over ${Number(st.large_sqft).toLocaleString()} sq ft, or an ADU / guest house / extra structure</div></button></div></section>` : '';
  return `
    <section class="sec"><div class="sec-h"><i style="background:#1d3250"></i><h2>Listing Media Packages</h2></div>
      <div class="grid">${pk}</div></section>
    ${SHOW_UPSELLS && ups ? `<section class="sec">${ups}</section>` : ''}
    <section class="sec"><div class="sec-h"><i style="background:#1f3c66"></i><h2>À La Carte Services</h2></div>
      <p class="d">Need just one thing, or want to add to a package? Book any service on its own. A basic floor plan is included with every photo shoot.</p>
      <div class="list">${alacarte().map(row).join('')}</div></section>
    ${large}
    <div class="nav"><span></span><button class="btn" onclick="kv.go(1)" ${inCart().size ? '' : 'disabled'}>Continue to property</button></div>`;
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
  const big = bySize && (bySize.max === null || bySize.max >= st.large_sqft);
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
    ${big ? `<div class="callout"><span>Homes over ${Number(st.large_sqft).toLocaleString()} sq ft include the ${esc(st.large_label)} add-on (+${money(st.large_fee)}): more photos and more time on site.</span></div>` : ''}
    ${largeVisible() && !big ? `<label class="check"><input type="checkbox" ${S.adu ? 'checked' : ''} onchange="kv.toggleAdu()"> This property has an ADU, guest house or extra structure (+${money(st.large_fee)})</label>` : ''}
    </div></section>
    <div class="nav"><button class="btn o" onclick="kv.go(0)">Back</button><button class="btn" onclick="kv.go(2)">Continue to schedule</button></div>`;
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
      <a class="btn" href="#account" style="text-decoration:none">View my orders</a>
      <button class="btn o" onclick="location.href='/'">Book another</button></div></div>`;
}
function vAccount() {
  if (!S.session) {
    const p = S.portal || {};
    return `<div class="panel" style="max-width:460px;margin:0 auto"><h2 style="font-size:26px">Client sign in</h2>
      ${p.sent ? `<div class="msg info">Check <b>${esc(p.email)}</b> for a sign-in link. You can close this tab.</div>` : `
      <p class="d" style="margin:6px 0 16px">Use the email you book with. We'll send you a secure sign-in link — no password.</p>
      <form onsubmit="kv.signIn(event)"><label>Email</label><input id="loginEmail" type="email" autocomplete="email" required>
      ${S.error ? `<div class="msg err">${esc(S.error)}</div>` : ''}
      <button class="btn" style="width:100%;margin-top:14px" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span>' : 'Email me a sign-in link'}</button></form>`}
      <p class="hint" style="margin-top:16px"><a href="/">← Book a shoot</a></p></div>`;
  }
  const p = S.portal;
  if (!p || p.loading) return '<div class="panel loading"><span class="spin"></span> Loading your orders…</div>';
  if (p.error) return `<div class="msg err">${esc(p.error)}</div>`;
  const head = `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
    <div><h2 style="font-size:26px">My orders</h2><div class="hint">${esc(p.agent?.full_name || S.session.user.email)}</div></div>
    <div style="display:flex;gap:8px"><a class="btn" href="/" style="text-decoration:none">Book a shoot</a><button class="btn o" onclick="kv.signOut()">Sign out</button></div></div>`;
  if (!p.agent) return head + `<div class="panel"><p>We don't have any orders under <b>${esc(S.session.user.email)}</b> yet. Book your first shoot and it will show up here.</p></div>`;
  if (!p.bookings.length) return head + '<div class="panel"><p>No orders yet.</p></div>';
  const statusPill = b => b.status === 'completed' ? '<span class="pill g">Shot</span>' : b.status === 'scheduled' ? '<span class="pill">Scheduled</span>' : `<span class="pill w">${esc(b.status)}</span>`;
  const payPill = b => b.paid ? '<span class="pill g">Paid</span>' : b.payment_status === 'card_saved' ? '<span class="pill">Card on file</span>' : `<span class="pill w">${b.payment_status === 'failed' ? 'Payment failed' : 'Unpaid'}</span>`;
  return head + p.bookings.map(b => {
    const when = b.shoot_start ? new Date(b.shoot_start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    const media = (b.media || []).map(m => m.delivered
      ? (m.dropbox || m.vimeo ? [m.dropbox && `<a class="btn" href="${esc(m.dropbox)}" target="_blank" rel="noopener">${m.media === 'video' ? 'Download video' : 'Download photos'}</a>`, m.vimeo && `<a class="btn o" href="${esc(m.vimeo)}" target="_blank" rel="noopener">Watch video</a>`].filter(Boolean).join('') : `<span class="pill w">${esc(m.name)} ready · pay to unlock</span>`)
      : `<span class="pill">${esc(m.media === 'video' ? 'Video' : 'Photos')} in progress</span>`).join('');
    return `<div class="order"><div class="order-h"><div><h3>${esc(b.address)}${b.unit ? ', ' + esc(b.unit) : ''}</h3>
      <div class="hint">#${esc(b.number)} · ${esc(when)} · ${esc(b.city || '')}</div></div><b style="color:var(--primary);font-size:18px">${money(b.total)}</b></div>
      <div>${statusPill(b)}${payPill(b)}</div>
      <div class="hint" style="margin-top:8px">${(b.items || []).map(i => esc(i.name)).join(' · ')}</div>
      <div class="media">${media}${!b.paid ? `<button class="btn ${b.locked ? '' : 'o'}" onclick="kv.payBooking('${b.id}')">Pay ${money(b.total)}</button>` : ''}</div></div>`;
  }).join('');
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
  const acct = S.view === 'account', done = S.view === 'done';
  $('acctLink').textContent = S.session ? 'My orders' : 'Sign in';
  $('acctLink').href = acct ? '#' : '#account';
  if (acct) $('acctLink').textContent = 'Book a shoot';
  $('main').classList.toggle('one', acct || done);
  $('side').style.display = acct || done ? 'none' : '';
  $('steps').style.display = acct || done ? 'none' : '';
  $('bar').style.visibility = acct || done || S.loading ? 'hidden' : 'visible';
  if (S.loading) return;
  if (acct) { $('view').innerHTML = vAccount(); return; }
  if (done) { $('view').innerHTML = vDone(); return; }
  $('steps').innerHTML = STEPS.map((s, i) => `<button class="step ${S.step === i ? 'on' : ''} ${S.step > i ? 'done' : ''}" ${canReach(i) && !S.busy ? '' : 'disabled'} onclick="kv.go(${i})"><b>${S.step > i ? '✓' : i + 1}</b><span class="lbl">${s}</span></button>`).join('');
  if (S.step === 3 && S.checkout?.elements && $('pay-el')?.childElementCount) {
    // Stripe's card form is mounted: patch only the error and buttons so the iframe isn't reloaded
    const tmp = document.createElement('div'); tmp.innerHTML = vReview();
    $('revErr').innerHTML = tmp.querySelector('#revErr').innerHTML;
    $('revNav').innerHTML = tmp.querySelector('#revNav').innerHTML;
  } else {
    $('view').innerHTML = [vServices, vProperty, vSchedule, vReview][S.step]() + (S.step < 3 && S.error ? `<div class="msg err">${esc(S.error)}</div>` : '');
  }
  $('sumDesk').innerHTML = vSummary(true);
  $('sumMob').innerHTML = vSummary(false);
  $('barTot').textContent = money(total());
  $('barSub').textContent = lines().length ? lines().map(l => l.name).join(' · ') : 'Nothing selected';
  const nb = $('barNext');
  nb.textContent = S.step < 3 ? 'Continue' : S.checkout ? (S.checkout.intentType === 'payment' ? 'Pay & book' : 'Save card & book') : 'To payment';
  nb.disabled = S.busy || (S.step === 0 ? !inCart().size : S.step === 2 ? !S.start : false);
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
  S.view = location.hash === '#account' ? 'account' : S.view === 'done' ? 'done' : 'book';
  if (S.view === 'account' && S.session && (!S.portal || S.portal.sent)) loadPortal();
  render();
}
window.addEventListener('hashchange', route);

/* ================= boot ================= */
(async function boot() {
  try {
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
      S.agent = l.agent;
      if (S.agent) { const [first, ...rest] = (S.agent.full_name || '').split(' ');
        Object.assign(S.contact, { first: first || '', last: rest.join(' '), email: S.agent.email || S.session.user.email, phone: S.agent.phone || '', brokerage: S.agent.brokerage || '' }); }
      else S.contact.email = S.session.user.email;
    }
    sb.auth.onAuthStateChange((_e, session) => {
      const was = !!S.session; S.session = session;
      if (session && !was) { api('link').then(l => { S.agent = l.agent; route(); }).catch(() => route()); }
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
