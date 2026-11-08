'use strict';

// ============ Configuración ============
const ASSETS = {
  XAU: { name: 'oro', title: 'Oro', hasUnit: true, defPct: 1 },
  BTC: { name: 'bitcoin', title: 'Bitcoin', hasUnit: false, defPct: 3 },
};
const GOLD_URL = 'https://api.gold-api.com/price/XAU';          // USD/onza
const BTC_URL = 'https://api.gold-api.com/price/BTC';           // USD (respaldo si falla el directo)
const BTC_WS = 'wss://ws-feed.exchange.coinbase.com';           // precio de bitcoin en directo
const BTC_CANDLES = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300';
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR';
const POLL_MS = 10_000;           // oro (y bitcoin de respaldo)
const SAMPLE_MS = 10_000;         // un punto en el historial cada 10 s
const MAX_POINTS = 1500;          // al superarlo, se aclaran los puntos más antiguos
const DAY_MS = 24 * 3600_000;
const GRAMS_PER_OZ = 31.1034768;
const STORE_KEY = 'alertaOro.v3';

const $ = id => document.getElementById(id);

// ============ Estado ============
const newAsset = code => ({ useBelow: false, belowUsd: null, usePct: true, pct: ASSETS[code].defPct,
                            history: [], peak: null, belowArmed: true }); // precios en USD (oro: por onza)
const defaults = () => ({
  settings: { currency: 'EUR', unit: 'oz', sound: true, wake: false },
  view: 'XAU',
  assets: { XAU: newAsset('XAU'), BTC: newAsset('BTC') },
  alerts: [],        // { t, code, kind: 'pct' | 'below', msg }
  fx: { EUR: null, t: 0 },
});

function load() {
  const d = defaults();
  const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
  const s = read(STORE_KEY);
  if (s) {
    for (const c in ASSETS) d.assets[c] = { ...d.assets[c], ...(s.assets || {})[c] };
    return { ...d, ...s, settings: { ...d.settings, ...s.settings }, assets: d.assets };
  }
  // Migración desde versiones anteriores
  const v2 = read('alertaOro.v2');
  const v1 = !v2 && read('alertaOro.v1');
  if (v2 || v1) {
    const os = (v2 || v1).settings || {};
    const fx = (v2 || v1).fx || d.fx;
    const cur = os.currency || 'USD', unit = os.unit || 'oz';
    const toUsdOld = (code, v) => {
      const r = cur === 'EUR' ? fx.EUR : 1;
      if (!(v > 0) || !r) return null;
      return v * (ASSETS[code].hasUnit && unit === 'g' ? GRAMS_PER_OZ : 1) / r;
    };
    const old = v2 ? v2.assets : { XAU: { ...os, history: v1.history, peak: v1.peak, belowArmed: v1.belowArmed } };
    for (const c in ASSETS) {
      const o = (old || {})[c];
      if (!o) continue;
      Object.assign(d.assets[c], {
        useBelow: !!o.useBelow, belowUsd: toUsdOld(c, parseFloat(o.below)), usePct: o.usePct !== false,
        pct: parseFloat(o.pct) || ASSETS[c].defPct, history: o.history || [], peak: o.peak ?? null,
        belowArmed: o.belowArmed !== false,
      });
    }
    Object.assign(d.settings, { currency: cur, unit, sound: os.sound !== false });
    d.alerts = ((v2 || v1).alerts || []).map(a => ({ t: a.t, msg: a.msg }));
    d.fx = fx;
    d.view = (v2 && v2.view) || 'XAU';
  }
  return d;
}
const state = load();

let saveTimer = null;
function save(now) {
  clearTimeout(saveTimer);
  const doSave = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {} };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 3000);
}

// Datos en memoria (no se guardan)
const live = {
  XAU: { price: null, t: 0, updatedAt: null, open24: null, ok: false },
  BTC: { price: null, t: 0, updatedAt: null, open24: null, ok: false },
};

// ============ Conversión y formato ============
const rate = () => (state.settings.currency === 'EUR' ? state.fx.EUR || null : 1);
const perUnit = code => (ASSETS[code].hasUnit && state.settings.unit === 'g' ? GRAMS_PER_OZ : 1);
function fromUsd(code, p) { const r = rate(); return r == null || p == null ? null : p * r / perUnit(code); }
function toUsd(code, v) { const r = rate(); return r == null ? null : v * perUnit(code) / r; }
const curSymbol = () => (state.settings.currency === 'EUR' ? '€' : '$');
const unitLabel = code => (ASSETS[code].hasUnit ? (state.settings.unit === 'g' ? '/g' : '/oz') : '');
function decimals(v) { return v >= 10000 ? 0 : 2; }
function num(v, d) {
  return v.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' });
}
function fmt(code, p, withUnit = true) {
  const v = fromUsd(code, p);
  if (v == null) return '—';
  const s = state.settings.currency === 'EUR' ? num(v, decimals(v)) + ' €' : '$' + num(v, decimals(v));
  return withUnit ? s + unitLabel(code) : s;
}
const pctStr = (v, d = 2) => v.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
const hhmm = t => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

// ============ Recepción de precios ============
function onPrice(code, p, extra = {}) {
  if (!isFinite(p) || p <= 0) return;
  const L = live[code], now = Date.now();
  Object.assign(L, { price: p, t: now, ok: true }, extra);

  const a = state.assets[code], h = a.history;
  const last = h[h.length - 1];
  if (!last || now - last.t >= SAMPLE_MS) h.push({ t: now, p });
  else last.p = p;                               // el último punto sigue al precio en directo
  while (h.length && h[0].t < now - DAY_MS) h.shift();
  if (h.length > MAX_POINTS) {                   // quita uno de cada dos en la mitad más antigua
    const half = Math.floor(h.length / 2);
    a.history = h.slice(0, half).filter((_, i) => i % 2 === 0).concat(h.slice(half));
  }

  checkAlerts(code, p);
  save();
  scheduleRender();
}

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function pollGold() {
  try {
    const j = await getJson(GOLD_URL);
    const upd = j.updatedAt ? Date.parse(j.updatedAt) : null;
    onPrice('XAU', Number(j.price), { updatedAt: isFinite(upd) ? upd : null });
  } catch (e) { live.XAU.ok = false; scheduleRender(); }
}

async function pollBtcFallback() {
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - live.BTC.t < 20_000) return;
  try { onPrice('BTC', Number((await getJson(BTC_URL)).price)); }
  catch (e) { if (Date.now() - live.BTC.t > 30_000) { live.BTC.ok = false; scheduleRender(); } }
}

// Bitcoin en directo (WebSocket de Coinbase), con reconexión automática
let ws = null, wsRetry = 1000, wsTimer = null;
function connectBtc() {
  clearTimeout(wsTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try { ws = new WebSocket(BTC_WS); } catch (_) { return retryBtc(); }
  ws.onopen = () => {
    wsRetry = 1000;
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
  };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.type === 'ticker' && m.product_id === 'BTC-USD') {
      onPrice('BTC', Number(m.price), { open24: Number(m.open_24h) || null });
    }
  };
  ws.onclose = () => retryBtc();
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
function retryBtc() {
  clearTimeout(wsTimer);
  if (document.hidden) return;                     // se reconecta al volver a la app
  wsTimer = setTimeout(connectBtc, wsRetry);
  wsRetry = Math.min(wsRetry * 2, 30_000);
}

// Historial de las últimas 24 h de bitcoin para el gráfico
async function seedBtcHistory() {
  try {
    const rows = await getJson(BTC_CANDLES);       // [tiempo(s), mín, máx, apertura, cierre, volumen]
    const pts = rows.map(r => ({ t: r[0] * 1000, p: r[4] })).filter(x => x.t > Date.now() - DAY_MS);
    if (!pts.length) return;
    pts.sort((x, y) => x.t - y.t);
    const h = state.assets.BTC.history;
    const lastSeed = pts[pts.length - 1].t;
    state.assets.BTC.history = pts.concat(h.filter(x => x.t > lastSeed));
    scheduleRender();
  } catch (_) { /* el gráfico se irá llenando en directo */ }
}

async function refreshFx() {
  if (state.fx.EUR && Date.now() - state.fx.t < 3600_000) return;
  try {
    const j = await getJson(FX_URL);
    if (j.rates && j.rates.EUR) { state.fx = { EUR: j.rates.EUR, t: Date.now() }; save(); scheduleRender(); }
  } catch (_) { /* se mantiene el último tipo conocido */ }
}

// ============ Avisos ============
let swReg = null;
function notify(code, kind, title, body) {
  state.alerts.unshift({ t: Date.now(), code, kind, msg: body });
  state.alerts = state.alerts.slice(0, 50);
  save(true);
  if (state.settings.sound) beep();
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  if ('Notification' in window && Notification.permission === 'granted') {
    const opts = { body, icon: 'icon.svg', badge: 'icon.svg', tag: 'alerta-' + code, renotify: true };
    (swReg ? swReg.showNotification(title, opts) : Promise.reject())
      .catch(() => { try { new Notification(title, opts); } catch (_) {} });
  }
}

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    [0, 0.18].forEach((d, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = i ? 587 : 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + d + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + d); o.stop(ctx.currentTime + d + 0.32);
    });
  } catch (_) {}
}

function checkAlerts(code, p) {
  const a = state.assets[code], A = ASSETS[code];

  // 1) Por debajo de un precio
  if (a.useBelow && a.belowUsd > 0) {
    if (p < a.belowUsd && a.belowArmed) {
      a.belowArmed = false;
      notify(code, 'below', `🔻 El ${A.name} ha bajado`,
        `${A.title} a ${fmt(code, p)}, por debajo de ${fmt(code, a.belowUsd)}.`);
    } else if (p >= a.belowUsd * 1.001) {
      a.belowArmed = true;                         // se rearma al volver a superar el límite
    }
  }

  // 2) Caída de X % desde el máximo
  if (a.peak == null || p > a.peak) a.peak = p;
  const pct = parseFloat(a.pct);
  if (a.usePct && pct > 0) {
    const drop = (a.peak - p) / a.peak * 100;
    if (drop >= pct) {
      notify(code, 'pct', `📉 Caída del ${A.name}`,
        `${A.title} ha bajado un ${pctStr(drop)} % desde ${fmt(code, a.peak)}. Ahora: ${fmt(code, p)}.`);
      a.peak = p;                                  // el siguiente aviso exige otra caída igual
    }
  }
}

// ============ Interfaz ============
let renderPending = false, lastRender = 0;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  const wait = Math.max(0, 300 - (Date.now() - lastRender));
  setTimeout(() => requestAnimationFrame(() => { renderPending = false; lastRender = Date.now(); render(); }), wait);
}

const shown = { code: null, price: null };
function render() {
  const code = state.view, A = ASSETS[code], a = state.assets[code], L = live[code];
  const h = a.history;
  const price = L.price ?? (h.length ? h[h.length - 1].p : null);

  // Pestañas
  document.querySelectorAll('.assets button').forEach(b => {
    const c = b.dataset.asset;
    b.classList.toggle('active', c === code);
    b.setAttribute('aria-selected', c === code);
    const pc = live[c].price ?? (state.assets[c].history.slice(-1)[0] || {}).p;
    $('tab-' + c).textContent = pc ? fmt(c, pc) : '—';
  });

  // Estado de conexión
  const anyOk = live.XAU.ok || live.BTC.ok;
  const allOk = live.XAU.ok && live.BTC.ok;
  const liveEl = $('live');
  liveEl.className = 'live ' + (allOk ? 'ok' : anyOk ? 'warn' : (live.XAU.t || live.BTC.t ? 'err' : ''));
  liveEl.querySelector('span').textContent = allOk ? 'En directo'
    : anyOk ? 'Sin datos de ' + (live.XAU.ok ? 'bitcoin' : 'oro')
    : (live.XAU.t || live.BTC.t ? 'Sin conexión' : 'Conectando…');

  // Precio principal
  $('assetName').textContent = A.title + (A.hasUnit ? (state.settings.unit === 'g' ? ' · gramo' : ' · onza troy') : '');
  const closed = code === 'XAU' && L.updatedAt && Date.now() - L.updatedAt > 20 * 60_000;
  $('market').textContent = closed ? 'Mercado cerrado' : '';
  const priceEl = $('price');
  priceEl.textContent = price != null ? fmt(code, price) : '—';
  if (shown.code === code && shown.price != null && price != null && price !== shown.price) {
    priceEl.classList.remove('flash-up', 'flash-down');
    void priceEl.offsetWidth;
    priceEl.classList.add(price > shown.price ? 'flash-up' : 'flash-down');
    setTimeout(() => priceEl.classList.remove('flash-up', 'flash-down'), 450);
  }
  shown.code = code; shown.price = price;

  // Variación: 24 h (o desde el primer dato disponible)
  let ref = null, refLabel = '';
  if (code === 'BTC' && L.open24) { ref = L.open24; refLabel = 'en 24 h'; }
  else if (h.length) {
    ref = h[0].p;
    refLabel = Date.now() - h[0].t > DAY_MS - 3600_000 ? 'en 24 h' : 'desde las ' + hhmm(h[0].t);
  }
  const ch = $('change');
  if (price != null && ref) {
    const pc = (price - ref) / ref * 100;
    ch.textContent = (pc > 0 ? '+' : pc < 0 ? '−' : '') + pctStr(Math.abs(pc)) + ' %';
    ch.className = 'chip ' + (pc > 0 ? 'up' : pc < 0 ? 'down' : '');
    $('changeLabel').textContent = refLabel;
  } else { ch.textContent = '—'; ch.className = 'chip'; $('changeLabel').textContent = ''; }

  // Pie del gráfico
  const ps = h.map(x => x.p);
  $('min').textContent = ps.length ? fmt(code, Math.min(...ps), false) : '—';
  $('max').textContent = ps.length ? fmt(code, Math.max(...ps), false) : '—';
  $('rangeLabel').textContent = h.length ? (Date.now() - h[0].t > DAY_MS - 3600_000 ? 'Últimas 24 h' : 'Desde las ' + hhmm(h[0].t)) : '';

  // Avisos del activo
  $('alertsTitle').textContent = 'Avisos del ' + A.name;
  $('belowUnit').textContent = curSymbol() + unitLabel(code);
  $('peakInfo').textContent = a.peak ? 'desde el máximo de ' + fmt(code, a.peak) : 'desde el precio máximo';
  $('unitRow').hidden = !A.hasUnit;
  setSeg('currencySeg', state.settings.currency);
  setSeg('unitSeg', state.settings.unit);

  renderAlerts();
  updateNotifyBtn();
  drawChart();
}

function setSeg(id, v) {
  $(id).querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
}

function renderAlerts() {
  const ul = $('alerts');
  ul.textContent = '';
  if (!state.alerts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Aún no hay avisos. Te avisaré aquí y con una notificación.';
    ul.append(li);
    $('clearBtn').hidden = true;
    return;
  }
  $('clearBtn').hidden = false;
  for (const al of state.alerts.slice(0, 15)) {
    const li = document.createElement('li');
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = al.kind === 'below' ? '↓' : '↘';
    const tx = document.createElement('div');
    tx.textContent = al.msg;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = new Date(al.t).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    tx.append(t);
    li.append(ic, tx);
    ul.append(li);
  }
}

// ---- Gráfico ----
let chartGeom = null, hoverX = null;
function drawChart() {
  const code = state.view, a = state.assets[code];
  const c = $('chart'), ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, H = c.clientHeight;
  if (!w) return;
  c.width = w * dpr; c.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, H);
  const css = getComputedStyle(document.documentElement);
  const col = n => css.getPropertyValue(n).trim();

  const pts = a.history;
  if (pts.length < 2) {
    chartGeom = null;
    ctx.fillStyle = col('--muted');
    ctx.font = '13px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('El gráfico se irá dibujando en directo…', w / 2, H / 2);
    return;
  }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { if (p.p < lo) lo = p.p; if (p.p > hi) hi = p.p; }
  if (hi - lo < hi * 1e-5) { lo -= hi * 5e-5; hi += hi * 5e-5; }
  const padX = 16, top = 22, bottom = 10;
  const x = t => padX + (t - t0) / Math.max(1, t1 - t0) * (w - 2 * padX);
  const y = v => top + (hi - v) / (hi - lo) * (H - top - bottom);
  chartGeom = { pts, x, y, w, H, padX };

  const up = pts[pts.length - 1].p >= pts[0].p;
  const line = col(up ? '--up' : '--down');

  // Línea de referencia (inicio del periodo)
  ctx.strokeStyle = col('--line'); ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
  ctx.beginPath(); ctx.moveTo(padX, y(pts[0].p)); ctx.lineTo(w - padX, y(pts[0].p)); ctx.stroke();

  // Límite "si baja de"
  if (a.useBelow && a.belowUsd >= lo && a.belowUsd <= hi) {
    ctx.strokeStyle = col('--down'); ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(padX, y(a.belowUsd)); ctx.lineTo(w - padX, y(a.belowUsd)); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Área y línea
  const grad = ctx.createLinearGradient(0, top, 0, H);
  grad.addColorStop(0, line + '33'); grad.addColorStop(1, line + '00');
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.p)) : ctx.moveTo(x(p.t), y(p.p))));
  ctx.lineTo(x(t1), H); ctx.lineTo(x(t0), H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.p)) : ctx.moveTo(x(p.t), y(p.p))));
  ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();

  // Punto actual
  const lx = x(t1), ly = y(pts[pts.length - 1].p);
  ctx.fillStyle = line + '33'; ctx.beginPath(); ctx.arc(lx, ly, 8, 0, 7); ctx.fill();
  ctx.fillStyle = line; ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, 7); ctx.fill();

  // Cursor táctil
  const tip = $('tip');
  if (hoverX == null) { tip.hidden = true; return; }
  const tx = t0 + (hoverX - padX) / (w - 2 * padX) * (t1 - t0);
  let best = pts[0];
  for (const p of pts) if (Math.abs(p.t - tx) < Math.abs(best.t - tx)) best = p;
  const bx = x(best.t), by = y(best.p);
  ctx.strokeStyle = col('--muted'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bx, top - 6); ctx.lineTo(bx, H); ctx.stroke();
  ctx.fillStyle = col('--surface'); ctx.strokeStyle = line; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(bx, by, 4.5, 0, 7); ctx.fill(); ctx.stroke();
  tip.hidden = false;
  tip.textContent = fmt(code, best.p, false) + ' · ' + hhmm(best.t);
  tip.style.left = Math.min(Math.max(bx, 70), w - 70) + 'px';
}

function bindChart() {
  const c = $('chart');
  const move = e => { const r = c.getBoundingClientRect(); hoverX = e.clientX - r.left; drawChart(); };
  const leave = () => { hoverX = null; drawChart(); };
  c.addEventListener('pointerdown', move);
  c.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' || e.buttons || e.pressure) move(e); });
  c.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') leave(); });
  c.addEventListener('pointerleave', leave);
  c.addEventListener('pointercancel', leave);
}

// ---- Notificaciones y pantalla ----
function updateNotifyBtn() {
  const b = $('notifyBtn');
  if (!('Notification' in window)) {
    b.textContent = /iPhone|iPad/.test(navigator.userAgent)
      ? 'Añade la app a la pantalla de inicio para recibir notificaciones'
      : 'Este navegador no admite notificaciones';
    b.disabled = true; return;
  }
  const p = Notification.permission;
  b.textContent = p === 'granted' ? '✓ Notificaciones activadas' : p === 'denied' ? 'Notificaciones bloqueadas en los ajustes' : 'Activar notificaciones';
  b.disabled = p !== 'default';
}

let wakeLock = null;
async function applyWake() {
  if (!('wakeLock' in navigator)) { $('wakeRow').hidden = true; return; }
  try {
    if (state.settings.wake && !document.hidden && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!state.settings.wake && wakeLock) {
      await wakeLock.release(); wakeLock = null;
    }
  } catch (_) { /* el sistema puede denegarlo (batería baja, etc.) */ }
}

// ---- Controles ----
function fillAssetForm() {
  const a = state.assets[state.view], code = state.view;
  $('usePct').checked = a.usePct; $('pct').value = a.pct;
  $('useBelow').checked = a.useBelow;
  const v = fromUsd(code, a.belowUsd);
  $('below').value = v != null ? +v.toFixed(decimals(v)) : '';
}

function bind() {
  const s = state.settings;
  fillAssetForm();
  $('sound').checked = s.sound;
  $('wake').checked = s.wake;

  document.querySelectorAll('.assets button').forEach(b => b.addEventListener('click', () => {
    state.view = b.dataset.asset;
    hoverX = null;
    fillAssetForm(); save(); render();
  }));

  const onAlertInput = e => {
    const a = state.assets[state.view];
    a.usePct = $('usePct').checked;
    a.pct = parseFloat($('pct').value) || a.pct;
    a.useBelow = $('useBelow').checked;
    const v = parseFloat($('below').value);
    a.belowUsd = v > 0 ? toUsd(state.view, v) : null;
    if (e.target.id === 'below' || e.target.id === 'useBelow') a.belowArmed = true;
    if (e.target.id === 'below' && v > 0 && !a.useBelow) { a.useBelow = true; $('useBelow').checked = true; }
    save(true); scheduleRender();
  };
  ['usePct', 'pct', 'useBelow', 'below'].forEach(id => $(id).addEventListener('input', onAlertInput));

  $('currencySeg').addEventListener('click', async e => {
    const v = e.target.closest('button')?.dataset.v; if (!v) return;
    s.currency = v;
    if (v === 'EUR') await refreshFx();
    fillAssetForm(); save(true); render();
  });
  $('unitSeg').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v; if (!v) return;
    s.unit = v; fillAssetForm(); save(true); render();
  });
  $('sound').addEventListener('change', e => { s.sound = e.target.checked; if (s.sound) beep(); save(true); });
  $('wake').addEventListener('change', e => { s.wake = e.target.checked; save(true); applyWake(); });

  $('notifyBtn').addEventListener('click', async () => {
    beep();                                        // desbloquea el audio en iPhone
    try { await Notification.requestPermission(); } catch (_) {}
    updateNotifyBtn();
  });
  $('resetBtn').addEventListener('click', () => {
    const code = state.view, a = state.assets[code];
    const p = live[code].price ?? (a.history.slice(-1)[0] || {}).p;
    a.peak = p ?? null; a.belowArmed = true;
    save(true); render();
  });
  $('clearBtn').addEventListener('click', () => { state.alerts = []; save(true); render(); });

  // Al volver a la app: actualizar todo al momento
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollGold(); connectBtc(); pollBtcFallback(); applyWake();
  });
  window.addEventListener('online', () => { pollGold(); connectBtc(); });
  window.addEventListener('resize', drawChart);
  bindChart();
}

// ============ Inicio ============
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
}
bind();
render();
refreshFx().then(() => { fillAssetForm(); render(); });
pollGold();
connectBtc();
seedBtcHistory();
setTimeout(pollBtcFallback, 4000);
setInterval(() => { if (!document.hidden) { pollGold(); pollBtcFallback(); } }, POLL_MS);
setInterval(() => { refreshFx(); scheduleRender(); }, 60_000);
applyWake();
