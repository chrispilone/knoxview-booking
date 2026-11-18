/* Knox View Social Media Kit (shared by the client download page and the HQ Media Library).
   15 vertical Reel templates (1080 x 1920, 12 s) drawn on a canvas from the order's photos and its property website details.
   One Status dropdown (Coming Soon / Just Listed / Just Sold) changes every Reel. "Save Reel" records the canvas into an
   MP4 right in the browser (no servers, no per-Reel cost) and hands it to the phone's share sheet ("Save Video") or downloads it.
   Data comes from the `listing` function (action "kit"). Photos must be same-origin (Netlify Image CDN, /.netlify/images)
   so the canvas can be recorded.
   Use: KVKit.mount(hostEl, { mode: 'client' | 'hq', key, load: async () => kitData, img: (url, w) => sameOriginUrl,
                              saveHidden: async keys => {}, locked?: bool }) -> controller { attach(hostEl), refresh() } */
(function () {
'use strict';
const W = 1080, H = 1920, DUR = 12;

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const eo = x => 1 - Math.pow(1 - x, 3);
const eio = x => (x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a, b, x) => a + (b - a) * x;
const F = {
  sans: '"Inter", "Helvetica Neue", Arial, sans-serif',
  serif: '"Playfair Display", Georgia, "Times New Roman", serif',
  cond: '"Bebas Neue", "Oswald", "Arial Narrow", Impact, sans-serif',
};
function font(ctx, w, s, fam, style = '') { ctx.font = `${style} ${w} ${s}px ${fam}`.trim(); }
function spacing(ctx, px) { if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; }
function fit(ctx, text, maxW, size, w, fam, style = '') {
  let s = size; font(ctx, w, s, fam, style);
  while (ctx.measureText(text).width > maxW && s > 10) { s -= 2; font(ctx, w, s, fam, style); }
  return s;
}
function cover(ctx, img, x, y, w, h, z = 1, px = .5, py = .5) {
  if (!img || !img.width) { ctx.fillStyle = '#c9d3de'; ctx.fillRect(x, y, w, h); return; }
  const ir = img.width / img.height, r = w / h;
  let sw, sh;
  if (ir > r) { sh = img.height; sw = sh * r; } else { sw = img.width; sh = sw / r; }
  sw /= z; sh /= z;
  ctx.drawImage(img, (img.width - sw) * px, (img.height - sh) * py, sw, sh, x, y, w, h);
}
const pick = (S, i) => { const n = S.photos.length; return n ? S.photos[((i % n) + n) % n] : null; };
function slot(ctx, S, x, y, w, h, t, o = {}) {
  const period = o.period || 3, fade = o.fade ?? .6, zoom = o.zoom ?? .08, start = o.start || 0, off = o.offset || 0;
  const tt = t + off, k = Math.floor(tt / period), local = tt - k * period;
  const cur = pick(S, start + k), prev = pick(S, start + k - 1);
  ctx.save(); ctx.beginPath();
  if (o.r) ctx.roundRect(x, y, w, h, o.r); else ctx.rect(x, y, w, h);
  ctx.clip();
  const fading = local < fade && tt > fade;
  if (fading) cover(ctx, prev, x, y, w, h, 1 + zoom, o.px ?? .5, o.py ?? .5);
  ctx.globalAlpha = fading ? eio(local / fade) : 1;
  cover(ctx, cur, x, y, w, h, 1 + zoom * (local / period), o.px ?? .5, o.py ?? .5);
  ctx.restore();
}
function slideSlot(ctx, S, x, y, w, h, t, o = {}) {
  const period = o.period || 3, dur = o.dur || .7, start = o.start || 0, off = o.offset || 0, dir = o.dir || 1;
  const tt = t + off, k = Math.floor(tt / period), local = tt - k * period;
  const cur = pick(S, start + k), prev = pick(S, start + k - 1);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const p = tt < dur ? 1 : eio(clamp(local / dur));
  if (p < 1) cover(ctx, prev, x - dir * w * .3 * p, y, w, h, 1.06);
  cover(ctx, cur, x + dir * w * (1 - p), y, w, h, 1.06 - .04 * (local / period));
  ctx.restore();
}
function grad(ctx, y0, y1, a0, a1, color = '0,0,0') {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, `rgba(${color},${a0})`); g.addColorStop(1, `rgba(${color},${a1})`);
  ctx.fillStyle = g; ctx.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0));
}
function text(ctx, s, x, y, o = {}) {
  if (!s) return;
  ctx.save();
  ctx.globalAlpha *= o.a ?? 1;
  spacing(ctx, o.ls || 0);
  font(ctx, o.w || 400, o.s || 40, o.f || F.sans, o.style || '');
  if (o.max) fit(ctx, s, o.max, o.s || 40, o.w || 400, o.f || F.sans, o.style || '');
  ctx.fillStyle = o.c || '#fff'; ctx.textAlign = o.al || 'left'; ctx.textBaseline = o.bl || 'alphabetic';
  if (o.shadow) { ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = o.shadow; ctx.shadowOffsetY = 2; }
  ctx.fillText(s, x, y);
  ctx.restore();
}
function rise(ctx, t, a, fn, dist = 40, d = .6) {
  const p = eo(prog(t, a, a + d));
  if (p <= 0) return;
  ctx.save(); ctx.globalAlpha *= p; ctx.translate(0, dist * (1 - p)); fn(); ctx.restore();
}
const initials = name => String(name || '').split(/\s+/).filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase();
const join = (arr, sep = ' \u00b7 ') => arr.filter(Boolean).join(sep);

function avatar(ctx, S, cx, cy, r) {
  if (S.headshot) { ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip(); cover(ctx, S.headshot, cx - r, cy - r, r * 2, r * 2); ctx.restore(); return; }
  ctx.fillStyle = S.accent; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  text(ctx, initials(S.agent), cx, cy + 2, { s: r * .72, w: 700, al: 'center', bl: 'middle' });
}
function agentRow(ctx, S, x, y, o = {}) {
  if (!S.agent) return;
  const dark = o.dark, r = o.r || 44, sub = join([S.phone, S.brokerage]);
  const fg = dark ? '#16202b' : '#fff', subc = dark ? 'rgba(22,32,43,.62)' : 'rgba(255,255,255,.78)';
  let cx = x + r;
  if (o.al === 'center') {
    font(ctx, 600, 38, F.sans); const w1 = ctx.measureText(S.agent).width;
    font(ctx, 400, 30, F.sans); const w2 = ctx.measureText(sub).width;
    cx = x - (r * 2 + 24 + Math.min(Math.max(w1, w2), o.max || 760)) / 2 + r;
  }
  avatar(ctx, S, cx, y, r);
  const tx = cx + r + 24;
  text(ctx, S.agent, tx, sub ? y - 6 : y + 13, { s: 38, w: 600, c: fg, max: o.max || 760 });
  text(ctx, sub, tx, y + 36, { s: 30, w: 400, c: subc, max: o.max || 760 });
}
const specLine = S => S.specs.map(s => `${s.v} ${s.short}`).join('  \u00b7  ');
const countUp = (v, p) => {
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || !/^[\d,.]+$/.test(String(v).trim())) return v;
  const cur = n * eo(p), dec = String(v).includes('.');
  return dec ? cur.toFixed(1).replace(/\.0$/, '') : Math.round(cur).toLocaleString('en-US');
};
function icon(ctx, kind, x, y, s, color, lw = 3) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s / 48, s / 48);
  ctx.strokeStyle = color; ctx.lineWidth = lw * 48 / s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (kind === 'bed') { ctx.moveTo(4, 38); ctx.lineTo(4, 12); ctx.moveTo(4, 30); ctx.lineTo(44, 30); ctx.lineTo(44, 38); ctx.moveTo(4, 24); ctx.lineTo(44, 24); ctx.lineTo(44, 30); ctx.moveTo(10, 24); ctx.lineTo(10, 18); ctx.lineTo(22, 18); ctx.lineTo(22, 24); }
  else if (kind === 'bath') { ctx.moveTo(4, 24); ctx.lineTo(44, 24); ctx.moveTo(7, 24); ctx.lineTo(9, 34); ctx.quadraticCurveTo(10, 38, 15, 38); ctx.lineTo(33, 38); ctx.quadraticCurveTo(38, 38, 39, 34); ctx.lineTo(41, 24); ctx.moveTo(12, 24); ctx.lineTo(12, 10); ctx.quadraticCurveTo(12, 6, 16, 6); ctx.quadraticCurveTo(20, 6, 20, 10); ctx.moveTo(14, 38); ctx.lineTo(12, 43); ctx.moveTo(34, 38); ctx.lineTo(36, 43); }
  else { ctx.rect(6, 6, 36, 36); ctx.moveTo(14, 34); ctx.lineTo(34, 14); ctx.moveTo(26, 14); ctx.lineTo(34, 14); ctx.lineTo(34, 22); ctx.moveTo(14, 26); ctx.lineTo(14, 34); ctx.lineTo(22, 34); }
  ctx.stroke(); ctx.restore();
}
// columns of numbers (beds / baths / sq ft), spread evenly across the given width
function statCols(ctx, S, x0, x1, fn) { const n = S.specs.length; S.specs.forEach((s, i) => fn(s, x0 + (x1 - x0) * (i + .5) / n, i)); }

/* ---------------- TEMPLATES (key, name, draw) ---------------- */
const TEMPLATES = [];
const T = (key, name, draw) => TEMPLATES.push({ key, name, draw });

T('editorial', 'Editorial', (ctx, t, S) => {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const hp = eo(prog(t, 0, .7));
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, 660 * hp); ctx.clip();
  slot(ctx, S, 0, 0, W, 660, t, { period: 3, start: 0, zoom: .06 }); grad(ctx, 380, 660, 0, .35);
  ctx.restore();
  rise(ctx, t, .35, () => text(ctx, S.status.toLowerCase(), 1040, 620, { s: 170, w: 500, al: 'right', max: 1000, shadow: 18, ls: -4 }), 30);
  rise(ctx, t, .5, () => slot(ctx, S, 40, 700, 340, 900, t, { period: 3, offset: 1, start: 4, zoom: .05 }));
  const side = join([S.agent && S.agent.toUpperCase(), S.phone], '  \u00b7  ');
  if (side) rise(ctx, t, .7, () => { ctx.save(); ctx.translate(92, 1570); ctx.rotate(-Math.PI / 2); text(ctx, side, 0, 0, { s: 34, w: 500, ls: 5, shadow: 10, max: 840 }); ctx.restore(); });
  rise(ctx, t, .6, () => {
    text(ctx, S.addr, 420, 762, { s: 46, w: 500, c: '#1b1b1b', max: 620 });
    text(ctx, S.city, 420, 816, { s: 40, w: 400, c: '#1b1b1b', max: 620 });
    text(ctx, join([S.price, ...S.specs.map(s => `${s.v} ${s.label}`)]), 420, 886, { s: 32, w: 400, c: '#555', max: 620 });
  }, 24);
  [940, 1172, 1404].forEach((y, i) => rise(ctx, t, .8 + i * .12, () => slot(ctx, S, 420, y, 620, 210, t, { period: 3, offset: 2 - i * .5, start: 1 + i * 2, zoom: .05 }), 30));
  rise(ctx, t, 1.2, () => text(ctx, S.brokerage, 40, 1652, { s: 30, w: 600, c: '#1b1b1b', max: 980 }), 10);
  slot(ctx, S, 0, 1690, W, 230, t, { period: 3, start: 3, zoom: .03 });
});

T('full-bleed', 'Full Bleed', (ctx, t, S) => {
  slot(ctx, S, 0, 0, W, H, t, { period: 2.4, zoom: .14, fade: .7 });
  grad(ctx, 0, 420, .45, 0); grad(ctx, 820, 1700, 0, .82); ctx.fillStyle = 'rgba(0,0,0,.82)'; ctx.fillRect(0, 1700, W, 220);
  rise(ctx, t, .3, () => text(ctx, S.status, 70, 1170, { s: 150, f: F.serif, style: 'italic', max: 940 }));
  ctx.fillStyle = S.accent; ctx.fillRect(74, 1210, 160 * eo(prog(t, .6, 1.2)), 8);
  rise(ctx, t, .7, () => {
    text(ctx, S.addr, 70, 1310, { s: 64, w: 700, max: 940 });
    text(ctx, S.city, 70, 1366, { s: 40, a: .85, max: 940 });
    text(ctx, specLine(S), 70, 1440, { s: 32, w: 600, ls: 3, a: .9, max: 940 });
  });
  rise(ctx, t, 1, () => {
    if (S.agent || S.price) { ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(70, 1490, 940, 2); }
    agentRow(ctx, S, 70, 1580, { max: S.price ? 520 : 820 });
    text(ctx, S.price, 1010, 1592, { s: 52, w: 700, al: 'right' });
  });
});

T('split-screen', 'Split Screen', (ctx, t, S) => {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  slideSlot(ctx, S, 0, 0, W, 880, t, { period: 3, dir: 1, start: 0 });
  slideSlot(ctx, S, 0, 1040, W, 880, t, { period: 3, dir: -1, start: 3, offset: .4 });
  const bp = eo(prog(t, 0, .6));
  ctx.fillStyle = S.accent; ctx.fillRect(W / 2 * (1 - bp), 880, W * bp, 160);
  rise(ctx, t, .4, () => text(ctx, S.status.toUpperCase(), W / 2, 1012, { s: 150, f: F.cond, al: 'center', ls: 14, max: 980 }), 20);
  rise(ctx, t, .8, () => {
    ctx.fillStyle = 'rgba(255,255,255,.96)'; ctx.fillRect(60, 1360, 820, 250);
    text(ctx, S.addr, 100, 1440, { s: 54, w: 700, c: '#111', max: 740 });
    text(ctx, join([S.city, S.price]), 100, 1494, { s: 34, c: '#444', max: 740 });
    text(ctx, specLine(S), 100, 1566, { s: 28, w: 600, ls: 2, c: S.accent, max: 740 });
  });
  if (S.agent) rise(ctx, t, 1, () => { ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(60, 250, 720, 130); agentRow(ctx, S, 82, 315, { r: 40, max: 560 }); }, -20);
});

T('polaroid', 'Polaroid Drop', (ctx, t, S) => {
  ctx.fillStyle = '#F2EEE7'; ctx.fillRect(0, 0, W, H);
  rise(ctx, t, .1, () => text(ctx, S.status, W / 2, 400, { s: 160, f: F.serif, style: 'italic', c: '#1d1d1d', al: 'center', max: 960 }));
  const lp = eo(prog(t, .5, 1.1)); ctx.fillStyle = S.accent; ctx.fillRect(W / 2 - 110 * lp, 452, 220 * lp, 6);
  const caps = [S.addr, ...S.specs.map(s => `${s.v} ${s.long}`), S.city, S.price].filter(Boolean);
  const rots = [-5, 4, -3, 6, -6, 3, -2, 5], dx = [-20, 30, -35, 20, 10, -25, 25, -10];
  for (let i = 0; i < 8; i++) {
    const t0 = .4 + i * 1.45; if (t < t0) break;
    const p = eo(prog(t, t0, t0 + .5));
    ctx.save();
    ctx.translate(W / 2 + dx[i], 1040 + (i % 2) * 14);
    ctx.rotate((rots[i] + (1 - p) * 10) * Math.PI / 180);
    const sc = lerp(1.35, 1, p); ctx.scale(sc, sc); ctx.globalAlpha = p;
    ctx.shadowColor = 'rgba(0,0,0,.22)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 16;
    ctx.fillStyle = '#fff'; ctx.fillRect(-380, -330, 760, 660); ctx.shadowColor = 'transparent';
    cover(ctx, pick(S, i), -350, -300, 700, 500, 1.04);
    text(ctx, caps[i % caps.length], 0, 280, { s: 40, f: F.serif, style: 'italic', c: '#333', al: 'center', max: 680 });
    ctx.restore();
  }
  rise(ctx, t, 1.2, () => agentRow(ctx, S, W / 2, 1530, { dark: true, al: 'center' }));
});

T('film-strip', 'Film Strip', (ctx, t, S) => {
  ctx.fillStyle = '#121212'; ctx.fillRect(0, 0, W, H);
  rise(ctx, t, .1, () => {
    const words = S.status.toUpperCase().split(' '), a = words[0] + ' ', b = words.slice(1).join(' ');
    spacing(ctx, 6); const sz = fit(ctx, a + b, 980, 220, 400, F.cond);
    const w0 = ctx.measureText(a).width, w1 = ctx.measureText(b).width, x = W / 2 - (w0 + w1) / 2;
    text(ctx, a, x, 440, { s: sz, f: F.cond, ls: 6 });
    text(ctx, b, x + w0, 440, { s: sz, f: F.cond, ls: 6, c: S.accentLight });
  });
  rise(ctx, t, .4, () => { text(ctx, S.addr, W / 2, 520, { s: 46, w: 600, al: 'center', c: '#eee', max: 960 }); text(ctx, S.city, W / 2, 574, { s: 34, al: 'center', c: '#999', max: 960 }); }, 20);
  const ip = eo(prog(t, .2, 1));
  ctx.save(); ctx.translate(W * (1 - ip), 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 650, W, 560);
  const sp = 74, shift = (t * 140) % sp;
  ctx.fillStyle = '#2a2a2a';
  for (let x = -shift; x < W; x += sp) { ctx.beginPath(); ctx.roundRect(x, 668, 38, 24, 4); ctx.roundRect(x, 1168, 38, 24, 4); ctx.fill(); }
  const pw = 640, step = pw + 24, n = Math.max(S.photos.length, 1), total = step * n, off = (t * 140) % total;
  for (let i = 0; i < n + 2; i++) {
    let x = i * step - off + 80; x = ((x % total) + total) % total - step;
    if (x > W || x + pw < 0) continue;
    cover(ctx, pick(S, i), x, 710, pw, 440, 1.02);
    if (x + total < W) cover(ctx, pick(S, i), x + total, 710, pw, 440, 1.02);
  }
  ctx.restore();
  const cp = prog(t, 1, 2.4);
  if (!S.specs.length) rise(ctx, t, 1, () => text(ctx, (S.cityName || S.status).toUpperCase(), W / 2, 1390, { s: 130, f: F.cond, al: 'center', ls: 6, max: 960 }), 20);
  statCols(ctx, S, 0, W, (s, x, i) => rise(ctx, t, 1 + i * .1, () => {
    text(ctx, countUp(s.v, cp), x, 1390, { s: 130, f: F.cond, al: 'center', max: W / S.specs.length - 30 });
    text(ctx, s.label.toUpperCase(), x, 1440, { s: 26, w: 600, ls: 6, al: 'center', c: '#8a8a8a' });
  }, 20));
  rise(ctx, t, 1.4, () => {
    text(ctx, S.price, W / 2, 1530, { s: 52, w: 700, al: 'center', c: S.accentLight });
    text(ctx, join([S.agent, S.phone], '  \u00b7  '), W / 2, S.price ? 1600 : 1540, { s: 32, w: 500, al: 'center', c: '#bbb', max: 960 });
  }, 20);
});

T('grid-reveal', 'Grid Reveal', (ctx, t, S) => {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const tw = 522, th = 624;
  for (let i = 0; i < 6; i++) {
    const c = i % 2, r = Math.floor(i / 2), x = 12 + c * 534, y = 12 + r * 636;
    const p = eo(prog(t, i * .1, i * .1 + .5)); if (p <= 0) continue;
    ctx.save(); ctx.globalAlpha = p; ctx.translate(x + tw / 2, y + th / 2); ctx.scale(lerp(.7, 1, p), lerp(.7, 1, p));
    slot(ctx, S, -tw / 2, -th / 2, tw, th, t, { period: 2.6, offset: i * .43, start: i, zoom: .06 });
    ctx.restore();
  }
  const cp = eo(prog(t, 1.2, 1.8));
  if (cp > 0) {
    ctx.save(); ctx.globalAlpha = cp; ctx.translate(W / 2, 930); ctx.scale(lerp(.85, 1, cp), lerp(.85, 1, cp));
    ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 18;
    ctx.fillStyle = '#fff'; ctx.fillRect(-430, -330, 860, 660); ctx.shadowColor = 'transparent';
    text(ctx, S.status, 0, -170, { s: 104, f: F.serif, style: 'italic', c: S.accent, al: 'center', max: 760 });
    text(ctx, S.addr, 0, -60, { s: 56, w: 700, c: '#111', al: 'center', max: 760 });
    text(ctx, S.city, 0, -4, { s: 34, c: '#666', al: 'center', max: 760 });
    ctx.fillStyle = '#e5e5e5'; ctx.fillRect(-340, 40, 680, 2);
    text(ctx, specLine(S), 0, 110, { s: 30, w: 600, ls: 3, c: '#333', al: 'center', max: 760 });
    text(ctx, S.price, 0, 190, { s: 54, w: 700, c: '#111', al: 'center' });
    text(ctx, join([S.agent, S.phone]), 0, S.price ? 270 : 200, { s: 30, w: 500, c: '#777', al: 'center', max: 760 });
    ctx.restore();
  }
});

const _mask = new Map();
function maskCanvas(ctx) {
  const c = ctx.canvas, key = c.width + 'x' + c.height;
  if (!_mask.has(key)) { const m = document.createElement('canvas'); m.width = c.width; m.height = c.height; _mask.set(key, m); }
  const m = _mask.get(key), mx = m.getContext('2d');
  mx.setTransform(1, 0, 0, 1, 0, 0); mx.clearRect(0, 0, m.width, m.height); mx.setTransform(ctx.getTransform());
  return [m, mx];
}
T('letter-mask', 'Letter Mask', (ctx, t, S) => {
  ctx.fillStyle = '#0d0f12'; ctx.fillRect(0, 0, W, H);
  if (t < 7) {
    const [m, mx] = maskCanvas(ctx);
    const words = S.status.toUpperCase().split(' ');
    const ip = eo(prog(t, 0, .9)), sc = lerp(1.15, 1, ip);
    mx.save(); mx.translate(W / 2, 860); mx.scale(sc, sc);
    mx.fillStyle = '#fff'; mx.textAlign = 'center';
    let y = -((words.length - 1) * 330) / 2 + 150;
    words.forEach(wd => { fit(mx, wd, 1000, 460, 400, F.cond); mx.fillText(wd, 0, y); y += 330; });
    mx.restore();
    mx.globalCompositeOperation = 'source-in';
    slot(mx, S, 0, 0, W, H, t, { period: 3.5, zoom: .25, px: lerp(.2, .8, (t % 3.5) / 3.5) });
    mx.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = ip; ctx.drawImage(m, 0, 0); ctx.restore();
    rise(ctx, t, .8, () => { text(ctx, S.addr, W / 2, 1330, { s: 52, w: 600, al: 'center', max: 960 }); text(ctx, S.city, W / 2, 1386, { s: 36, al: 'center', a: .7, max: 960 }); }, 20);
    rise(ctx, t, 1.1, () => agentRow(ctx, S, W / 2, 1530, { al: 'center' }), 20);
  }
  const fp = prog(t, 6.2, 7);
  if (fp > 0) {
    ctx.save(); ctx.globalAlpha = eio(fp);
    slot(ctx, S, 0, 0, W, H, t, { period: 2.6, start: 2, zoom: .12 });
    grad(ctx, 900, 1700, 0, .85); ctx.fillStyle = 'rgba(0,0,0,.85)'; ctx.fillRect(0, 1700, W, 220);
    ctx.restore();
    rise(ctx, t, 6.9, () => {
      text(ctx, S.status.toUpperCase(), 70, 1260, { s: 34, w: 700, ls: 10, c: S.accentLight });
      text(ctx, S.price || S.addr, 70, 1350, { s: S.price ? 84 : 64, w: 800, max: 940 });
      text(ctx, specLine(S), 70, 1420, { s: 32, w: 500, ls: 3, a: .9, max: 940 });
      agentRow(ctx, S, 70, 1540, {});
    });
  }
});

T('gallery-frame', 'Gallery Frame', (ctx, t, S) => {
  ctx.fillStyle = '#FAFAF7'; ctx.fillRect(0, 0, W, H);
  rise(ctx, t, .1, () => {
    const st = S.status.toUpperCase();
    text(ctx, st, W / 2, 300, { s: 40, w: 700, ls: 16, al: 'center', c: S.accent });
    font(ctx, 700, 40, F.sans); spacing(ctx, 16); const tw = ctx.measureText(st).width / 2 + 40; spacing(ctx, 0);
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(90, 286, W / 2 - tw - 90, 2); ctx.fillRect(W / 2 + tw, 286, W / 2 - tw - 90, 2);
  }, 10);
  const fp = eo(prog(t, .2, 1));
  ctx.save(); ctx.beginPath(); ctx.rect(90, 360 + 400 * (1 - fp), 900, 820 * fp + .01); ctx.clip();
  slot(ctx, S, 90, 360, 900, 820, t, { period: 3, zoom: .07 }); ctx.restore();
  rise(ctx, t, .8, () => {
    text(ctx, S.addr, W / 2, 1290, { s: 78, f: F.serif, c: '#1a1a1a', al: 'center', max: 900 });
    text(ctx, join([S.city, S.price]), W / 2, 1346, { s: 36, c: '#777', al: 'center', max: 900 });
  }, 20);
  const cp = prog(t, 1.1, 2.4), n = S.specs.length;
  statCols(ctx, S, 90, 990, (s, x, i) => rise(ctx, t, 1.1 + i * .1, () => {
    text(ctx, countUp(s.v, cp), x, 1490, { s: 72, f: F.serif, c: '#1a1a1a', al: 'center', max: 900 / n - 30 });
    text(ctx, s.label.toUpperCase(), x, 1534, { s: 22, w: 700, ls: 6, c: '#999', al: 'center' });
  }, 16));
  ctx.fillStyle = 'rgba(0,0,0,.12)'; for (let i = 1; i < n; i++) ctx.fillRect(90 + 900 * i / n, 1430, 1, 110);
  if (!n && S.cityName) rise(ctx, t, 1.1, () => text(ctx, S.cityName, W / 2, 1490, { s: 64, f: F.serif, style: 'italic', c: '#1a1a1a', al: 'center', max: 900 }), 16);
  rise(ctx, t, 1.5, () => {
    const line = join([S.agent, S.phone, S.brokerage], '  \u00b7  ');
    if (!line) return;
    ctx.fillStyle = 'rgba(0,0,0,.12)'; ctx.fillRect(90, 1580, 900, 1);
    text(ctx, line, W / 2, 1636, { s: 28, w: 500, c: '#555', al: 'center', max: 900 });
  }, 10);
});

T('swipe-stack', 'Swipe Stack', (ctx, t, S) => {
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#EEF3F9'); g.addColorStop(1, '#DCE6F2');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const period = 2.2, k = Math.floor(t / period), local = t - k * period;
  const sw = eio(prog(local, 1.55, 2.2)), cy = 250, cw = 860, ch = 960;
  for (let d = 2; d >= 0; d--) {
    const dd = d - sw, sc = 1 - .06 * dd, oy = 34 * dd;
    ctx.save(); ctx.translate(W / 2, cy + ch / 2 + oy); ctx.scale(sc, sc);
    if (d === 0) { const ip = eo(prog(t, 0, .6)); ctx.translate(-1400 * sw, (1 - ip) * -300); ctx.rotate(-18 * sw * Math.PI / 180); ctx.globalAlpha = Math.min(1, ip * 2); }
    ctx.shadowColor = 'rgba(20,40,70,.22)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(-cw / 2, -ch / 2, cw, ch, 28); ctx.fill(); ctx.shadowColor = 'transparent';
    ctx.save(); ctx.beginPath(); ctx.roundRect(-cw / 2 + 16, -ch / 2 + 16, cw - 32, ch - 32, 18); ctx.clip();
    cover(ctx, pick(S, k + d), -cw / 2 + 16, -ch / 2 + 16, cw - 32, ch - 32, 1.05); ctx.restore();
    if (d === 0) {
      const st = S.status.toUpperCase();
      spacing(ctx, 4); font(ctx, 700, 34, F.sans); const pw = ctx.measureText(st).width + 64; spacing(ctx, 0);
      ctx.fillStyle = S.accent; ctx.beginPath(); ctx.roundRect(-cw / 2 + 44, -ch / 2 + 44, pw, 70, 35); ctx.fill();
      text(ctx, st, -cw / 2 + 44 + pw / 2, -ch / 2 + 92, { s: 34, w: 700, ls: 4, al: 'center' });
    }
    ctx.restore();
  }
  rise(ctx, t, .5, () => {
    text(ctx, S.addr, 110, 1340, { s: 66, w: 800, c: '#0f1d2e', max: 860 });
    text(ctx, S.city, 110, 1394, { s: 36, w: 500, c: '#5a6b80', max: 860 });
    text(ctx, specLine(S), 110, 1452, { s: 30, w: 600, ls: 2, c: '#5a6b80', max: 860 });
  }, 24);
  rise(ctx, t, .8, () => { text(ctx, S.price, 970, 1594, { s: 56, w: 800, c: S.accent, al: 'right' }); agentRow(ctx, S, 110, 1580, { dark: true, r: 40, max: S.price ? 420 : 740 }); }, 24);
});

T('magazine', 'Magazine Cover', (ctx, t, S) => {
  slot(ctx, S, 0, 0, W, H, t, { period: 3, zoom: .1, start: 0 });
  grad(ctx, 0, 700, .62, 0); grad(ctx, 1150, 1720, 0, .8); ctx.fillStyle = 'rgba(0,0,0,.8)'; ctx.fillRect(0, 1720, W, 200);
  rise(ctx, t, 0, () => {
    const city = (S.cityName || '').toUpperCase();
    if (city) text(ctx, `${city} EDITION`, W / 2, 250, { s: 28, w: 600, ls: 12, al: 'center', a: .9, max: 960 });
    text(ctx, S.status.toUpperCase(), W / 2, 420, { s: 190, w: 900, f: F.serif, al: 'center', max: 990, shadow: 20 });
  }, -30, .8);
  S.specs.forEach((s, i) => {
    const p = eo(prog(t, .8 + i * .18, 1.4 + i * .18)); if (p <= 0) return;
    ctx.save(); ctx.globalAlpha = p; ctx.translate(-80 * (1 - p), 0);
    ctx.fillStyle = S.accentLight; ctx.fillRect(70, 640 + i * 110, 8, 64);
    text(ctx, `${s.v} ${s.long}`, 100, 692 + i * 110, { s: 56, w: 800, shadow: 14, max: 600 });
    ctx.restore();
  });
  const bp = eo(prog(t, 1.4, 1.9));
  if (bp > 0 && S.price) {
    ctx.save(); ctx.translate(800, 1150); ctx.rotate((-8 + Math.sin(t * 1.4) * 1.5) * Math.PI / 180); ctx.scale(bp, bp);
    ctx.fillStyle = S.accent; ctx.beginPath(); ctx.arc(0, 0, 165, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, 148, 0, Math.PI * 2); ctx.stroke();
    text(ctx, S.priceLabel.toUpperCase(), 0, -24, { s: 26, w: 700, ls: 4, al: 'center' });
    text(ctx, S.price, 0, 40, { s: 54, w: 800, al: 'center', max: 270 });
    ctx.restore();
  }
  rise(ctx, t, 1.2, () => {
    text(ctx, S.addr, 70, 1450, { s: 76, w: 700, f: F.serif, max: 940 });
    text(ctx, S.city, 70, 1508, { s: 36, w: 500, a: .85, max: 940 });
    if (S.agent) text(ctx, `Presented by ${join([S.agent, S.phone])}`, 70, 1600, { s: 30, w: 500, a: .85, max: 940 });
  });
});

T('ticker', 'Ticker', (ctx, t, S) => {
  ctx.fillStyle = '#0b0b0b'; ctx.fillRect(0, 0, W, H);
  slot(ctx, S, 0, 420, W, 1080, t, { period: 2.5, zoom: .1 });
  grad(ctx, 1150, 1500, 0, .75);
  const unit = `${S.status.toUpperCase()}   \u2022   `;
  ctx.save(); ctx.fillStyle = S.accent; ctx.fillRect(0, 230, W, 190); ctx.beginPath(); ctx.rect(0, 230, W, 190); ctx.clip();
  spacing(ctx, 4); font(ctx, 400, 150, F.cond); const uw = ctx.measureText(unit).width;
  let x = -((t * 170) % uw); ctx.fillStyle = '#fff'; while (x < W) { ctx.fillText(unit, x, 385); x += uw; }
  ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(0, 1500, W, 190); ctx.clip();
  spacing(ctx, 4); font(ctx, 400, 150, F.cond); ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2.5;
  x = ((t * 170) % uw) - uw; while (x < W) { ctx.strokeText(unit, x, 1655); x += uw; }
  ctx.restore(); spacing(ctx, 0);
  rise(ctx, t, .5, () => { text(ctx, S.addr, 60, 1380, { s: 64, w: 800, max: 960 }); text(ctx, join([S.city, S.price], '  \u00b7  '), 60, 1440, { s: 36, w: 500, a: .9, max: 960 }); }, 24);
  if (S.agent) rise(ctx, t, .8, () => { ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(40, 450, 720, 120); agentRow(ctx, S, 60, 510, { r: 38, max: 580 }); }, -20);
});

T('spec-sheet', 'Spec Sheet', (ctx, t, S) => {
  if (t < 4.6) {
    const k = Math.floor(t / 1.15); cover(ctx, pick(S, k), 0, 0, W, H, 1.1 + .05 * ((t % 1.15) / 1.15));
    ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(0, 0, W, H);
    S.status.toUpperCase().split(' ').forEach((wd, i) => {
      const p = eo(prog(t, .15 + i * .25, .55 + i * .25));
      ctx.save(); ctx.globalAlpha = p; ctx.translate(0, 40 * (1 - p));
      text(ctx, wd, W / 2, 900 + i * 190, { s: 200, w: 900, al: 'center', max: 980, shadow: 30 });
      ctx.restore();
    });
    return;
  }
  slot(ctx, S, 0, 0, W, H, t, { period: 3, start: 3, zoom: .08 });
  ctx.fillStyle = 'rgba(10,20,30,.35)'; ctx.fillRect(0, 0, W, H);
  const p = eo(prog(t, 4.6, 5.3));
  ctx.save(); ctx.translate(0, 900 * (1 - p));
  ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 50;
  const y0 = S.price ? 990 : 870, yA = y0 + 30 + S.specs.length * 120, ch = Math.max(400, (S.agent ? yA + 210 : yA + 20) - 560);
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(60, 560, 960, ch, 12); ctx.fill(); ctx.shadowColor = 'transparent';
  text(ctx, S.status.toUpperCase(), 120, 660, { s: 32, w: 700, ls: 10, c: S.accent });
  text(ctx, S.addr, 120, 760, { s: 72, w: 800, c: '#111', max: 840 });
  text(ctx, S.city, 120, 820, { s: 38, c: '#666', max: 840 });
  text(ctx, S.price, 120, 930, { s: 80, w: 300, c: '#111' });
  if (S.specs.length) { ctx.fillStyle = '#ececec'; ctx.fillRect(120, y0, 840, 2); }
  S.specs.forEach((s, i) => {
    const y = y0 + 70 + i * 120, ip = eo(prog(t, 5.2 + i * .15, 5.7 + i * .15));
    ctx.save(); ctx.globalAlpha = ip;
    icon(ctx, s.ic, 120, y, 64, S.accent, 2.5);
    text(ctx, s.v, 220, y + 50, { s: 56, w: 700, c: '#111' });
    font(ctx, 700, 56, F.sans); const vw = ctx.measureText(s.v).width;
    text(ctx, s.long, 236 + vw, y + 50, { s: 36, c: '#777' });
    ctx.restore();
  });
  if (S.agent) { ctx.fillStyle = '#ececec'; ctx.fillRect(120, yA + 20, 840, 2); agentRow(ctx, S, 120, yA + 120, { dark: true }); }
  ctx.restore();
});

T('circle-reveal', 'Circle Reveal', (ctx, t, S) => {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const period = 2.4, k = Math.floor(t / period), local = t - k * period;
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, 1240); ctx.clip();
  cover(ctx, pick(S, k - 1), 0, 0, W, 1240, 1.08);
  ctx.beginPath(); ctx.arc(W / 2, 620, Math.max(eio(clamp(local)) * 1400, .1), 0, Math.PI * 2); ctx.clip();
  cover(ctx, pick(S, k), 0, 0, W, 1240, 1.08 - .04 * (local / period));
  ctx.restore();
  const bp = eo(prog(t, .3, .9));
  ctx.save(); ctx.translate(W / 2, 1240); ctx.scale(bp, bp);
  ctx.fillStyle = S.accent; ctx.beginPath(); ctx.arc(0, 0, 230, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 12; ctx.stroke();
  const words = S.status.split(' ');
  text(ctx, words[0], 0, -10, { s: 92, f: F.serif, style: 'italic', al: 'center', max: 380 });
  text(ctx, words.slice(1).join(' '), 0, 78, { s: 92, f: F.serif, style: 'italic', al: 'center', max: 380 });
  ctx.restore();
  rise(ctx, t, .8, () => { text(ctx, S.addr, W / 2, 1560, { s: 56, w: 700, c: '#111', al: 'center', max: 960 }); text(ctx, join([S.city, S.price], '  \u00b7  '), W / 2, 1614, { s: 34, c: '#666', al: 'center', max: 960 }); }, 20);
  rise(ctx, t, 1, () => text(ctx, join([S.agent, S.phone]), W / 2, 1690, { s: 30, w: 600, c: S.accent, al: 'center', max: 960 }), 10);
});

T('diagonal', 'Diagonal Cut', (ctx, t, S) => {
  ctx.fillStyle = '#0f1b2b'; ctx.fillRect(0, 0, W, H);
  [[0, 0, 640], [1, 560, 640], [2, 1120, 560]].forEach(([i, y, h]) => {
    const p = eio(prog(t, i * .2, i * .2 + .8)), dir = i % 2 ? 1 : -1;
    ctx.save(); ctx.translate(dir * W * (1 - p), 0);
    ctx.beginPath(); ctx.moveTo(0, y + 120); ctx.lineTo(W, y); ctx.lineTo(W, y + h - 40); ctx.lineTo(0, y + h + 80); ctx.closePath(); ctx.clip();
    slot(ctx, S, 0, y, W, h + 120, t, { period: 2.8, offset: i * .9, start: i * 2, zoom: .1 });
    ctx.restore();
  });
  ctx.fillStyle = '#0f1b2b'; ctx.beginPath(); ctx.moveTo(0, 1460); ctx.lineTo(W, 1300); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
  ctx.fillStyle = S.accent; ctx.beginPath(); ctx.moveTo(0, 1460); ctx.lineTo(W, 1300); ctx.lineTo(W, 1312); ctx.lineTo(0, 1472); ctx.fill();
  rise(ctx, t, .9, () => {
    ctx.save(); ctx.translate(60, 1130); ctx.rotate(-8.5 * Math.PI / 180);
    const st = S.status.toUpperCase();
    spacing(ctx, 4); const sz = fit(ctx, st, 900, 170, 400, F.cond); const sw = ctx.measureText(st).width + 50;
    ctx.fillStyle = S.accent; ctx.fillRect(-20, -sz * .88, sw, sz * 1.06);
    text(ctx, st, 6, 0, { s: sz, f: F.cond, ls: 4 });
    ctx.restore();
  }, 30);
  rise(ctx, t, 1.1, () => { text(ctx, S.addr, 60, 1560, { s: 58, w: 800, max: 960 }); text(ctx, join([S.city, specLine(S)], '  \u00b7  '), 60, 1612, { s: 28, w: 500, a: .75, max: 960 }); }, 20);
  rise(ctx, t, 1.3, () => text(ctx, join([S.price, join([S.agent, S.phone], '  ')], '   \u00b7   '), 60, 1680, { s: 30, w: 600, c: S.accentLight, max: 960 }), 10);
});

T('typewriter', 'Typewriter', (ctx, t, S) => {
  ctx.fillStyle = '#0c0c0c'; ctx.fillRect(0, 0, W, H);
  if (t > 2.2) {
    ctx.save(); ctx.globalAlpha = eio(prog(t, 2.2, 3));
    slot(ctx, S, 0, 0, W, H, t, { period: 2.2, offset: -2.2, zoom: .1, start: 1 });
    const g = ctx.createRadialGradient(W / 2, H / 2, 300, W / 2, H / 2, 1200);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.75)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    grad(ctx, 0, 620, .6, 0);
    ctx.restore();
  }
  if (t < 9) {
    const str = S.status, chars = Math.floor(clamp((t - .3) / 1.3) * str.length);
    const k = eio(prog(t, 2.2, 3)), yy = lerp(960, 380, k), sz = fit(ctx, str, 960, lerp(130, 96, k), 800, F.sans);
    const full = ctx.measureText(str).width, shown = str.slice(0, chars);
    ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.fillText(shown, W / 2 - full / 2, yy);
    const cw = ctx.measureText(shown).width;
    if (t < 2.4 && Math.floor(t * 2.5) % 2 === 0) { ctx.fillStyle = S.accentLight; ctx.fillRect(W / 2 - full / 2 + cw + 8, yy - sz * .75, 10, sz * .8); }
    rise(ctx, t, 2.8, () => { text(ctx, S.addr, W / 2, 470, { s: 50, w: 600, al: 'center', shadow: 12, max: 960 }); text(ctx, join([S.city, S.price], '  \u00b7  '), W / 2, 526, { s: 34, al: 'center', a: .85, shadow: 12, max: 960 }); }, 20);
    rise(ctx, t, 3.4, () => text(ctx, specLine(S), W / 2, 1560, { s: 34, w: 600, ls: 4, al: 'center', shadow: 14, max: 960 }), 20);
  }
  const ep = eo(prog(t, 9, 9.6));
  if (ep > 0) {
    ctx.fillStyle = `rgba(12,12,12,${.82 * ep})`; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalAlpha = ep; ctx.translate(0, 60 * (1 - ep));
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(110, 640, 860, 640, 10); ctx.fill();
    if (S.agent) {
      text(ctx, 'Schedule a showing', W / 2, 770, { s: 34, w: 600, ls: 4, c: S.accent, al: 'center' });
      avatar(ctx, S, W / 2, 900, 80);
      text(ctx, S.agent, W / 2, 1060, { s: 60, w: 800, c: '#111', al: 'center', max: 780 });
      text(ctx, S.phone, W / 2, 1130, { s: 44, c: '#333', al: 'center' });
      text(ctx, S.brokerage, W / 2, 1200, { s: 32, w: 500, c: '#888', al: 'center', max: 780 });
    } else {
      text(ctx, S.status.toUpperCase(), W / 2, 820, { s: 34, w: 600, ls: 6, c: S.accent, al: 'center' });
      text(ctx, S.addr, W / 2, 960, { s: 64, w: 800, c: '#111', al: 'center', max: 780 });
      text(ctx, S.city, W / 2, 1030, { s: 40, c: '#555', al: 'center', max: 780 });
      text(ctx, S.price, W / 2, 1150, { s: 56, w: 700, c: '#111', al: 'center' });
    }
    ctx.restore();
  }
});

/* ---------------- STATE ---------------- */
const STATUSES = ['Coming Soon', 'Just Listed', 'Just Sold'];
const STATUS = {
  'Coming Soon': { accent: '#B7791F', accentLight: '#F2B95A', priceLabel: 'Priced at' },
  'Just Listed': { accent: '#2B6CB0', accentLight: '#7FB7EE', priceLabel: 'Offered at' },
  'Just Sold':   { accent: '#B83A3A', accentLight: '#F08A84', priceLabel: 'Sold' },
};
// kit data (listing function) -> what the templates draw
function infoFrom(d) {
  const a = d.address || {}, ag = d.agent || {};
  const num = v => String(v || '').trim();
  const specs = [];
  const beds = num(d.beds).replace(/\s*(beds?|bedrooms?|br)\s*$/i, ''), baths = num(d.baths).replace(/\s*(baths?|bathrooms?|ba)\s*$/i, '');
  if (beds) specs.push({ v: beds, short: 'BD', label: 'Beds', long: beds === '1' ? 'Bedroom' : 'Bedrooms', ic: 'bed' });
  if (baths) specs.push({ v: baths, short: 'BA', label: 'Baths', long: baths === '1' ? 'Bathroom' : 'Bathrooms', ic: 'bath' });
  const size = num(d.size), m = size.match(/^([\d,.]+)\s*(sq\.?\s*ft\.?|sqft|square feet|sf)?$/i);
  if (size) specs.push(m ? { v: m[1], short: 'SQ FT', label: 'Sq Ft', long: 'Sq Ft', ic: 'area' } : { v: size, short: '', label: 'Size', long: '', ic: 'area' });
  return { addr: a.line || '', cityName: a.city || '', city: [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    price: num(d.price), specs, agent: num(ag.name), phone: num(ag.phone), brokerage: num(ag.brokerage) };
}
function buildState(status, info, photos, headshot) { return Object.assign({ status, photos, headshot }, STATUS[status], info); }
function drawFrame(ctx, i, t, S, scale) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.save(); TEMPLATES[i].draw(ctx, ((t % DUR) + DUR) % DUR, S); ctx.restore();
  spacing(ctx, 0);
}

/* ---------------- UI ---------------- */
const CSS = `
.kvk{--kb:#2B6CB0;--kbd:#1F4E80;--kbl:#EAF2FB;--kbm:#C9DDF2;--kink:#14212F;--kmute:#5B6B7C;--kline:#DCE4EE;font-family:Inter,system-ui,-apple-system,sans-serif;color:var(--kink)}
.kvk *{box-sizing:border-box}
.kvk svg.ki{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex:none}
.kvk-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 14px}
.kvk-lbl{font-size:13px;color:var(--kmute);font-weight:500}
.kvk-sel{position:relative}
.kvk-sel select{appearance:none;-webkit-appearance:none;background:#fff;border:1px solid var(--kbm);border-radius:6px;padding:10px 38px 10px 13px;font:600 15px Inter,system-ui,sans-serif;color:var(--kink);min-width:190px;cursor:pointer}
.kvk-sel svg{position:absolute;right:11px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--kb)}
.kvk-sp{flex:1}
.kvk-upd{font-size:12.5px;color:var(--kmute)}
.kvk-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--kline);background:#fff;color:var(--kink);border-radius:6px;padding:9px 13px;font:600 13.5px Inter,system-ui,sans-serif;cursor:pointer;text-decoration:none}
.kvk-btn:hover{border-color:var(--kbm)}
.kvk-btn.p{background:var(--kb);border-color:var(--kb);color:#fff}.kvk-btn.p:hover{background:var(--kbd)}
.kvk-btn[disabled]{opacity:.6;cursor:default}
.kvk-spin{animation:kvkspin 1s linear infinite}@keyframes kvkspin{to{transform:rotate(360deg)}}
.kvk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px}
.kvk-card{background:#fff;border:1px solid var(--kline);border-radius:8px;overflow:hidden;display:flex;flex-direction:column}
.kvk-card.off{opacity:.45}
.kvk-th{position:relative;aspect-ratio:9/16;background:#e7edf4;cursor:pointer;padding:0;border:0;display:block;width:100%}
.kvk-th canvas{width:100%;height:100%;display:block}
.kvk-play{position:absolute;right:8px;bottom:8px;width:28px;height:28px;border-radius:50%;background:rgba(0,0,0,.45);display:grid;place-items:center;color:#fff}
.kvk-meta{padding:9px 10px 10px;display:flex;flex-direction:column;gap:7px}
.kvk-row{display:flex;justify-content:space-between;align-items:center;gap:6px}
.kvk-name{font-weight:600;font-size:13.5px}.kvk-num{font-size:11.5px;color:var(--kmute)}
.kvk-tg{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--kmute);cursor:pointer;user-select:none}
.kvk-tg input{display:none}
.kvk-sw{width:30px;height:18px;border-radius:9px;background:#c6d1dd;position:relative;transition:.15s;flex:none}
.kvk-sw:after{content:"";position:absolute;width:14px;height:14px;border-radius:50%;background:#fff;top:2px;left:2px;transition:.15s}
.kvk-tg input:checked+.kvk-sw{background:var(--kb)}.kvk-tg input:checked+.kvk-sw:after{left:14px}
.kvk-msg{padding:18px;border:1px dashed var(--kline);border-radius:8px;color:var(--kmute);font-size:14px;background:#fff}
.kvk-m{position:fixed;inset:0;background:rgba(12,20,30,.86);z-index:9000;display:none;align-items:center;justify-content:center;padding:16px;font-family:Inter,system-ui,sans-serif}
.kvk-m.open{display:flex}
.kvk-mb{display:flex;gap:24px;align-items:center;max-height:100%}
.kvk-st{position:relative;height:min(82vh,820px);aspect-ratio:9/16;border-radius:8px;overflow:hidden;background:#000}
.kvk-st canvas{width:100%;height:100%;display:block}
.kvk-safe{position:absolute;inset:0;pointer-events:none;display:none}.kvk-safe.on{display:block}
.kvk-safe div{position:absolute;left:0;right:0;background:rgba(255,40,80,.18);border:1px dashed rgba(255,80,110,.8);color:#fff;font-size:11px;padding:4px 6px;font-weight:600}
.kvk-side{color:#fff;width:280px;display:flex;flex-direction:column;gap:11px}
.kvk-side h3{margin:0;font-size:21px;font-weight:700;color:#fff}
.kvk-side p{margin:0;color:#b9c6d4;font-size:14px;line-height:1.5}
.kvk-side .kvk-btn.g{background:transparent;color:#fff;border-color:rgba(255,255,255,.3)}
.kvk-pb{height:4px;background:rgba(255,255,255,.2);border-radius:2px;overflow:hidden;display:none}.kvk-pb i{display:block;height:100%;width:0;background:#7FB7EE}
.kvk-note{font-size:13px;color:#b9c6d4;min-height:18px}
.kvk-x{position:absolute;top:14px;right:14px;background:rgba(255,255,255,.12);border:0;color:#fff;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;cursor:pointer;z-index:2}
.kvk-navs{display:flex;gap:8px}.kvk-navs .kvk-btn{flex:1;padding:9px 6px}
.kvk-rec{position:fixed;left:-99999px;top:0;width:10px;height:10px}
@media (max-width:640px){
  .kvk-grid{grid-template-columns:repeat(2,1fr);gap:10px}
  .kvk-sel{flex:1}.kvk-sel select{width:100%;min-width:0}
  .kvk-upd{order:9;width:100%}.kvk-sp{display:none}
  .kvk-m{padding:0;align-items:stretch}
  .kvk-mb{flex-direction:column;gap:0;width:100%;height:100%}
  .kvk-st{height:auto;width:100%;flex:1;min-height:0;aspect-ratio:auto;border-radius:0}
  .kvk-st canvas{object-fit:contain}
  .kvk-side{width:100%;padding:12px 14px calc(14px + env(safe-area-inset-bottom));background:#0c141e;gap:8px}
  .kvk-side h3{font-size:17px}.kvk-side p.d{display:none}
}`;
const IC = {
  down: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>', chev: '<path d="M6 9l6 6 6-6"/>',
  play: '<path d="M8 5l11 7-11 7z"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', left: '<path d="M15 6l-6 6 6 6"/>', right: '<path d="M9 6l6 6-6 6"/>',
  frame: '<rect x="6" y="3" width="12" height="18" rx="1"/><path d="M6 7h12M6 16h12"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
};
const ic = (k, s) => `<svg class="ki" viewBox="0 0 24 24"${s ? ` style="width:${s}px;height:${s}px"` : ''}>${IC[k]}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
let booted = false;
function boot() {
  if (booted) return; booted = true;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  if (!document.querySelector('link[data-kvk-fonts]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.dataset.kvkFonts = '1';
    l.href = 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@300;400;500;600;700;800;900&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&display=swap';
    document.head.appendChild(l);
  }
}
const loadImg = src => new Promise(r => { if (!src) return r(null); const im = new Image(); im.crossOrigin = 'anonymous'; im.decoding = 'async'; im.onload = () => r(im); im.onerror = () => r(null); im.src = src; });
const fontsReady = () => Promise.all(['400 40px "Bebas Neue"', '400 40px Inter', '600 40px Inter', '800 40px Inter', 'italic 400 40px "Playfair Display"', '700 40px "Playfair Display"', '900 40px "Playfair Display"']
  .map(f => document.fonts.load(f).catch(() => {}))).catch(() => {});

function mount(host, opts) {
  boot();
  const mode = opts.mode || 'client', hq = mode === 'hq', key = opts.key || 'kit';
  const root = document.createElement('div'); root.className = 'kvk';
  let status = 'Just Listed'; try { status = localStorage.getItem('kvk-status:' + key) || status; } catch (_) {}
  if (!STATUS[status]) status = 'Just Listed';
  let data = null, S = null, hidden = new Set(), tiles = [], loadedAt = 0, err = '', loading = true;
  let modalOpen = false, cur = 0, mt0 = 0, recording = false, pending = null, raf = 0, t0 = performance.now();

  // modal (one per kit, lives on <body>)
  const modal = document.createElement('div'); modal.className = 'kvk kvk-m'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `<button class="kvk-x" aria-label="Close">${ic('x')}</button><div class="kvk-mb">
    <div class="kvk-st"><canvas></canvas><div class="kvk-safe"><div style="top:0;height:11.5%">Instagram top bar</div><div style="bottom:0;height:16.5%">Caption and buttons</div></div></div>
    <div class="kvk-side"><h3></h3><p class="d">A 12-second vertical Reel (1080 &times; 1920) for Instagram, Facebook and TikTok.</p>
      <button class="kvk-btn p" data-a="save">${ic('down')}<span>Save Reel</span></button>
      <div class="kvk-pb"><i></i></div><div class="kvk-note"></div>
      <div class="kvk-navs"><button class="kvk-btn g" data-a="prev">${ic('left')}Prev</button><button class="kvk-btn g" data-a="safe">${ic('frame')}Safe Zones</button><button class="kvk-btn g" data-a="next">Next${ic('right')}</button></div></div></div>`;
  document.body.appendChild(modal);
  const mcv = modal.querySelector('canvas'), mctx = mcv.getContext('2d'), saveBtn = modal.querySelector('[data-a=save]'), note = modal.querySelector('.kvk-note'), pb = modal.querySelector('.kvk-pb');
  const rec = document.createElement('canvas'); rec.className = 'kvk-rec'; rec.width = W; rec.height = H; document.body.appendChild(rec);
  const rctx = rec.getContext('2d');

  const visible = () => TEMPLATES.map((_, i) => i).filter(i => hq || !hidden.has(TEMPLATES[i].key));
  function paint() {
    if (loading) { root.innerHTML = `<div class="kvk-msg">Getting your Social Media Kit\u2026</div>`; return; }
    if (err) { root.innerHTML = `<div class="kvk-msg">${esc(err)}</div>`; return; }
    if (!data.ready) { root.innerHTML = `<div class="kvk-msg">${hq ? 'The Social Media Kit is made when this order is marked <b>Completed</b> with at least 3 photos in the gallery.' : 'Your Social Media Kit will appear here when your order is complete.'}</div>`; return; }
    if (data.locked && !hq) { root.innerHTML = `<div class="kvk-msg">${ic('lock', 15)} ${TEMPLATES.length - hidden.size} ready-to-post Reels unlock after payment.</div>`; return; }
    const n = visible().length;
    root.innerHTML = `<div class="kvk-bar">
        <span class="kvk-lbl">Status</span>
        <div class="kvk-sel"><select aria-label="Status">${STATUSES.map(s => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select>${ic('chev')}</div>
        <span class="kvk-sp"></span><span class="kvk-upd"></span>
        <button class="kvk-btn" data-a="refresh">${ic('refresh')}<span>${hq ? 'Regenerate Kit' : 'Refresh Kit'}</span></button></div>
      ${!data.price || !data.beds || !data.baths ? `<p class="kvk-lbl" style="margin:-4px 0 12px">${hq ? 'Price, beds or baths are missing. They come from the Property Website details' : 'Add your price, beds and baths in your Property Website details'}, then tap ${hq ? 'Regenerate Kit' : 'Refresh Kit'}.</p>` : ''}
      ${hq ? `<p class="kvk-lbl kvk-cnt" style="margin:-4px 0 12px">${n} of ${TEMPLATES.length} Reels visible to the client.${data.locked ? ' The client sees them after the order is paid.' : ''}</p>` : ''}
      <div class="kvk-grid">${visible().map((i, pos) => `<div class="kvk-card ${hidden.has(TEMPLATES[i].key) ? 'off' : ''}" data-i="${i}">
        <button class="kvk-th" data-open="${i}" aria-label="Play ${esc(TEMPLATES[i].name)}"><canvas></canvas><span class="kvk-play">${ic('play', 13)}</span></button>
        <div class="kvk-meta"><div class="kvk-row"><span class="kvk-name">${esc(TEMPLATES[i].name)}</span><span class="kvk-num">${String(pos + 1).padStart(2, '0')}</span></div>
          ${hq ? `<label class="kvk-tg"><input type="checkbox" data-vis="${TEMPLATES[i].key}" ${hidden.has(TEMPLATES[i].key) ? '' : 'checked'}><span class="kvk-sw"></span>Visible to Client</label>` : ''}
          <button class="kvk-btn" data-save="${i}">${ic('down')}Save Reel</button></div></div>`).join('')}</div>`;
    tiles = [...root.querySelectorAll('.kvk-card')].map(c => { const cv = c.querySelector('canvas'); return { i: +c.dataset.i, cv, ctx: cv.getContext('2d'), vis: false }; });
    const io = new IntersectionObserver(es => es.forEach(e => { const tl = tiles.find(x => x.cv.parentElement === e.target); if (tl) tl.vis = e.isIntersecting; }), { rootMargin: '120px' });
    tiles.forEach(tl => io.observe(tl.cv.parentElement));
    sizeTiles(); stamp();
    root.querySelector('select').onchange = e => { status = e.target.value; try { localStorage.setItem('kvk-status:' + key, status); } catch (_) {} rebuild(); };
    root.querySelector('[data-a=refresh]').onclick = () => load(true);
    root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => open(+b.dataset.open));
    root.querySelectorAll('[data-save]').forEach(b => b.onclick = () => open(+b.dataset.save, true));
    root.querySelectorAll('[data-vis]').forEach(x => x.onchange = async () => {
      x.checked ? hidden.delete(x.dataset.vis) : hidden.add(x.dataset.vis);
      x.closest('.kvk-card').classList.toggle('off', !x.checked);
      const lbl = root.querySelector('p.kvk-cnt'); if (lbl) lbl.firstChild.textContent = `${TEMPLATES.length - hidden.size} of ${TEMPLATES.length} Reels visible to the client.`;
      try { await opts.saveHidden?.([...hidden]); } catch (e) { x.checked = !x.checked; x.checked ? hidden.delete(x.dataset.vis) : hidden.add(x.dataset.vis); x.closest('.kvk-card').classList.toggle('off', !x.checked); alert(e.message || 'Could not save'); }
    });
  }
  function stamp() { const u = root.querySelector('.kvk-upd'); if (!u || !loadedAt) return; const m = Math.round((Date.now() - loadedAt) / 60000); u.textContent = m < 1 ? 'Updated just now' : `Updated ${m} min ago`; }
  setInterval(stamp, 30000);
  function sizeTiles() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    tiles.forEach(tl => { const w = Math.max(90, Math.round(tl.cv.getBoundingClientRect().width * dpr)); if (w && tl.cv.width !== w) { tl.cv.width = w; tl.cv.height = Math.round(w * 16 / 9); } });
  }
  addEventListener('resize', () => { sizeTiles(); sizeModal(); });
  function rebuild() { if (data) S = buildState(status, infoFrom(data), data._photos || [], data._headshot || null); }

  async function load(refresh) {
    const btn = root.querySelector('[data-a=refresh]');
    if (refresh && btn) { btn.disabled = true; btn.querySelector('svg').classList.add('kvk-spin'); }
    else { loading = true; paint(); }
    try {
      const d = await opts.load();
      hidden = new Set(d.kit?.hidden || []);
      if (d.ready && (!d.locked || hq)) {
        const [ims, head] = await Promise.all([Promise.all((d.photos || []).map(p => loadImg(opts.img(p.u, 1600)))), loadImg(d.agent?.photo ? opts.img(d.agent.photo, 400) : null), fontsReady()]);
        d._photos = ims.filter(Boolean); d._headshot = head;
        if (!d._photos.length) d.ready = false;
      }
      data = d; err = ''; loadedAt = Date.now(); t0 = performance.now();
    } catch (e) { if (!data) err = e.message || 'The Social Media Kit could not load.'; }
    loading = false; rebuild(); paint();
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!root.isConnected || !S) return;
    if (modalOpen) { if (!recording) drawFrame(mctx, cur, (now - mt0) / 1000, S, mcv.width / W); return; }
    const t = (now - t0) / 1000;
    tiles.forEach(tl => { if (tl.vis) { if (!tl.cv.width) sizeTiles(); drawFrame(tl.ctx, tl.i, t, S, tl.cv.width / W); } });
  }
  raf = requestAnimationFrame(loop);

  function sizeModal() {
    if (!modalOpen) return;
    const r = mcv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = r.width, h = r.height; if (w / h > 9 / 16) w = h * 9 / 16;
    mcv.width = Math.max(90, Math.round(w * dpr)); mcv.height = Math.round(mcv.width * 16 / 9);
  }
  function setSave(label, primary = true) { saveBtn.querySelector('span').textContent = label; saveBtn.classList.toggle('p', primary); }
  function open(i, autoSave) {
    if (recording) return;
    cur = i; modalOpen = true; mt0 = performance.now(); pending = null;
    modal.classList.add('open'); document.documentElement.style.overflow = 'hidden';
    modal.querySelector('h3').textContent = `${TEMPLATES[i].name} \u2014 ${status}`;
    note.textContent = ''; pb.style.display = 'none'; setSave('Save Reel');
    requestAnimationFrame(() => { sizeModal(); if (autoSave) build(); });
  }
  function close() { if (recording) return; modalOpen = false; pending = null; modal.classList.remove('open'); document.documentElement.style.overflow = ''; }
  function step(d) { if (recording) return; const L = visible(), k = L.indexOf(cur); open(L[(k + d + L.length) % L.length]); }
  modal.querySelector('.kvk-x').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelector('[data-a=prev]').onclick = () => step(-1);
  modal.querySelector('[data-a=next]').onclick = () => step(1);
  modal.querySelector('[data-a=safe]').onclick = () => modal.querySelector('.kvk-safe').classList.toggle('on');
  addEventListener('keydown', e => { if (!modalOpen) return; if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1); });
  saveBtn.onclick = () => pending ? deliver() : build();

  const MIMES = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01F', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  async function build() {
    if (recording) return;
    const mime = MIMES.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime || !rec.captureStream) { note.textContent = 'This browser can\u2019t make videos. Try Safari or Chrome.'; return; }
    recording = true; saveBtn.disabled = true; setSave('Making your Reel\u2026'); pb.style.display = 'block'; note.textContent = 'Keep this screen open. It takes about 12 seconds.';
    const idx = cur, St = S;
    drawFrame(rctx, idx, 0, St, 1);
    const stream = rec.captureStream(30);
    const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10000000 });
    const chunks = []; mr.ondataavailable = e => e.data.size && chunks.push(e.data);
    const stopped = new Promise(r => mr.onstop = r);
    mr.start(250);
    const start = performance.now();
    await new Promise(res => { (function f(now) {
      const t = (now - start) / 1000;
      if (t >= DUR) return res();
      drawFrame(rctx, idx, t, St, 1); drawFrame(mctx, idx, t, St, mcv.width / W);
      pb.firstChild.style.width = (t / DUR * 100).toFixed(1) + '%';
      requestAnimationFrame(f);
    })(start); });
    mr.stop(); await stopped; stream.getTracks().forEach(tr => tr.stop());
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const name = `${slug(S.addr) || 'listing'}-${slug(status)}-${TEMPLATES[idx].key}.${ext}`;
    pending = new File([new Blob(chunks, { type: mime.split(';')[0] })], name, { type: mime.split(';')[0] });
    recording = false; saveBtn.disabled = false; pb.style.display = 'none'; mt0 = performance.now();
    if (isPhone() && navigator.canShare?.({ files: [pending] })) { setSave('Save to Camera Roll'); note.textContent = 'Your Reel is ready. Tap Save to Camera Roll, then Save Video.'; }
    else deliver();
  }
  async function deliver() {
    const f = pending; if (!f) return;
    if (isPhone() && navigator.canShare?.({ files: [f] })) {
      try { await navigator.share({ files: [f] }); note.textContent = 'Saved. Find it in your Photos app.'; setSave('Save Reel', false); pending = null; }
      catch (e) { if (e?.name !== 'AbortError') note.textContent = 'Couldn\u2019t open the share sheet. Try again.'; }
      return;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    note.textContent = `Downloaded ${f.name}`; setSave('Save Reel', false); pending = null;
  }

  const ctl = {
    attach(el) { if (el && root.parentElement !== el) { el.innerHTML = ''; el.appendChild(root); requestAnimationFrame(sizeTiles); } },
    refresh: () => load(true),
    destroy() { cancelAnimationFrame(raf); modal.remove(); rec.remove(); root.remove(); },
  };
  ctl.attach(host); load(false);
  return ctl;
}

window.KVKit = { mount, TEMPLATES, STATUS, STATUSES, DUR, W, H, buildState, drawFrame, infoFrom };
})();
