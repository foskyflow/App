'use strict';

// ============ Configuración ============
const ASSETS = {
  XAU: { name: 'oro', title: 'Oro', hasUnit: true, defPct: 1 },
  BTC: { name: 'bitcoin', title: 'Bitcoin', hasUnit: false, defPct: 3 },
};
const GOLD_URL = 'https://api.gold-api.com/price/XAU';          // USD/onza
const BTC_URL = 'https://api.gold-api.com/price/BTC';           // USD (respaldo si falla el directo)
const BTC_WS = 'wss://ws-feed.exchange.coinbase.com';           // precio de bitcoin en directo
const BTC_CANDLES = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=';
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR';
const POLL_MS = 10_000;           // oro (y bitcoin de respaldo)
const SAMPLE_MS = 10_000;         // un punto en el historial cada 10 s
const MAX_POINTS = 1500;          // al superarlo, se aclaran los puntos más antiguos
const DAY_MS = 24 * 3600_000;
const GRAMS_PER_OZ = 31.1034768;
const STORE_KEY = 'alertaOro.v3';
const MIN = 60_000, HOUR = 3600_000;

// Periodos del gráfico: duración, tamaño de cada vela y granularidad de Coinbase (s)
const RANGES = {
  '1D': { ms: DAY_MS, bucket: 15 * MIN, gran: 900, label: 'en 24 h', foot: 'Últimas 24 h' },
  '1S': { ms: 7 * DAY_MS, bucket: 2 * HOUR, gran: 3600, label: 'en 7 días', foot: 'Última semana' },
  '1M': { ms: 30 * DAY_MS, bucket: 12 * HOUR, gran: 21600, label: 'en 30 días', foot: 'Último mes' },
  '6M': { ms: 182 * DAY_MS, bucket: 3 * DAY_MS, gran: 86400, label: 'en 6 meses', foot: 'Últimos 6 meses' },
};

// Repositorio de GitHub donde el vigilante guarda los datos (rama "datos")
const REPO = (() => {
  const h = location.hostname, seg = location.pathname.split('/')[1];
  return h.endsWith('.github.io') && seg ? h.split('.')[0] + '/' + seg : 'foskyflow/App';
})();
const DATA_BASE = `https://raw.githubusercontent.com/${REPO}/datos/`;
const CONFIG_EDIT_URL = `https://github.com/${REPO}/edit/main/avisos.json`;

const $ = id => document.getElementById(id);

// ============ Estado ============
const newAsset = code => ({ useBelow: false, belowUsd: null, usePct: true, pct: ASSETS[code].defPct,
                            history: [], peak: null, belowArmed: true }); // precios en USD (oro: por onza)
const defaults = () => ({
  settings: { currency: 'EUR', unit: 'oz', sound: true, wake: false, chart: 'candles', range: '1D' },
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
const dayMonth = t => new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
const since = t => (Date.now() - t < DAY_MS && new Date(t).getDate() === new Date().getDate() ? 'las ' + hhmm(t) : 'el ' + dayMonth(t));
function stamp(t) {
  const r = state.settings.range;
  if (r === '1D') return hhmm(t);
  if (r === '1S') return new Date(t).toLocaleDateString('es-ES', { weekday: 'short' }) + ' ' + hhmm(t);
  return dayMonth(t);
}

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

// Velas de bitcoin (Coinbase) para cada periodo
const btcCandles = {};             // periodo -> { t, rows: [{ t, o, h, l, c }] }
async function loadBtcCandles(range, force) {
  const c = btcCandles[range];
  if (!force && c && Date.now() - c.t < 5 * MIN) return;
  try {
    const rows = await getJson(BTC_CANDLES + RANGES[range].gran);   // [tiempo(s), mín, máx, apertura, cierre, vol]
    btcCandles[range] = { t: Date.now(),
      rows: rows.map(r => ({ t: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4] })).sort((a, b) => a.t - b.t) };
    scheduleRender();
  } catch (_) { /* se usa el historial recogido en directo */ }
}

// Historial y estado que guarda el vigilante en segundo plano
let remote = { hist: null, histT: 0, estado: null, estadoT: 0 };
async function loadRemote(force) {
  const now = Date.now();
  if (force || now - remote.histT > 5 * MIN) {
    remote.histT = now;
    try { remote.hist = await getJson(DATA_BASE + 'historial.json?t=' + Math.floor(now / MIN)); scheduleRender(); } catch (_) {}
  }
  if (force || now - remote.estadoT > MIN) {
    remote.estadoT = now;
    try { remote.estado = await getJson(DATA_BASE + 'estado.json?t=' + Math.floor(now / MIN)); } catch (_) { remote.estado = null; }
    renderBackground();
  }
}

// Construye las velas del periodo elegido juntando todas las fuentes
function buildSeries(code) {
  const R = RANGES[state.settings.range], now = Date.now(), from = now - R.ms;
  let items = [];
  if (code === 'BTC' && btcCandles[state.settings.range]) {
    items = btcCandles[state.settings.range].rows.slice();
  } else if (remote.hist && remote.hist[code]) {
    items = remote.hist[code].map(([t, p]) => ({ t, o: p, h: p, l: p, c: p }));
  }
  const lastT = items.length ? items[items.length - 1].t : -Infinity;
  for (const pt of state.assets[code].history) {
    if (pt.t > lastT) items.push({ t: pt.t, o: pt.p, h: pt.p, l: pt.p, c: pt.p });
  }
  const lp = live[code].price;
  if (lp && live[code].t > lastT) items.push({ t: live[code].t, o: lp, h: lp, l: lp, c: lp });
  items.sort((a, b) => a.t - b.t);

  const out = [];
  for (const it of items) {
    if (it.t < from - R.bucket) continue;
    const k = Math.floor(it.t / R.bucket) * R.bucket;
    const cur = out[out.length - 1];
    if (cur && cur.t === k) { cur.h = Math.max(cur.h, it.h); cur.l = Math.min(cur.l, it.l); cur.c = it.c; }
    else out.push({ t: k, o: it.o, h: it.h, l: it.l, c: it.c });
  }
  return out.filter(c => c.t > from - R.bucket);
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
  const R = RANGES[state.settings.range];
  const series = buildSeries(code);
  const price = L.price ?? (h.length ? h[h.length - 1].p : series.length ? series[series.length - 1].c : null);

  // Pestañas
  document.querySelectorAll('.assets button').forEach(b => {
    const c = b.dataset.asset;
    b.classList.toggle('active', c === code);
    b.setAttribute('aria-selected', c === code);
    const pc = live[c].price ?? (state.assets[c].history.slice(-1)[0] || {}).p ?? (buildSeries(c).slice(-1)[0] || {}).c;
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

  // Variación en el periodo del gráfico
  const short = series.length && series[0].t > Date.now() - R.ms + 2 * R.bucket;
  let ref = null, refLabel = '';
  if (code === 'BTC' && state.settings.range === '1D' && L.open24) { ref = L.open24; refLabel = R.label; }
  else if (series.length) { ref = series[0].o; refLabel = short ? 'desde ' + since(series[0].t) : R.label; }
  const ch = $('change');
  if (price != null && ref) {
    const pc = (price - ref) / ref * 100;
    ch.textContent = (pc > 0 ? '+' : pc < 0 ? '−' : '') + pctStr(Math.abs(pc)) + ' %';
    ch.className = 'chip ' + (pc > 0 ? 'up' : pc < 0 ? 'down' : '');
    $('changeLabel').textContent = refLabel;
  } else { ch.textContent = '—'; ch.className = 'chip'; $('changeLabel').textContent = ''; }

  // Pie del gráfico
  $('min').textContent = series.length ? fmt(code, Math.min(...series.map(c => c.l)), false) : '—';
  $('max').textContent = series.length ? fmt(code, Math.max(...series.map(c => c.h)), false) : '—';
  $('rangeLabel').textContent = series.length ? (short ? 'Desde ' + since(series[0].t) : R.foot) : '';
  setSeg('rangeSeg', state.settings.range);
  setSeg('typeSeg', state.settings.chart);

  // Avisos del activo
  $('alertsTitle').textContent = 'Avisos del ' + A.name;
  $('belowUnit').textContent = curSymbol() + unitLabel(code);
  $('peakInfo').textContent = a.peak ? 'desde el máximo de ' + fmt(code, a.peak) : 'desde el precio máximo';
  $('unitRow').hidden = !A.hasUnit;
  setSeg('currencySeg', state.settings.currency);
  setSeg('unitSeg', state.settings.unit);

  renderAlerts();
  renderBackground();
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

// ---- Gráfico (línea o velas japonesas) ----
let hoverX = null;
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
  const tip = $('tip');

  const S = buildSeries(code);
  const candles = state.settings.chart === 'candles';
  if (S.length < 2) {
    tip.hidden = true;
    ctx.fillStyle = col('--muted');
    ctx.font = '13px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const msg = code === 'XAU' && state.settings.range !== '1D'
      ? ['Aún no hay historial del oro para este periodo.', 'Se irá llenando con el vigilante en segundo plano.']
      : ['El gráfico se irá dibujando en directo…'];
    msg.forEach((m, i) => ctx.fillText(m, w / 2, H / 2 + (i - (msg.length - 1) / 2) * 18));
    return;
  }

  let lo = Infinity, hi = -Infinity;
  for (const k of S) {
    lo = Math.min(lo, candles ? k.l : k.c); hi = Math.max(hi, candles ? k.h : k.c);
  }
  if (hi - lo < hi * 1e-5) { lo -= hi * 5e-5; hi += hi * 5e-5; }
  const padX = 16, top = 22, bottom = 10;
  const slot = (w - 2 * padX) / S.length;
  const x = i => padX + slot * (i + 0.5);
  const y = v => top + (hi - v) / (hi - lo) * (H - top - bottom);
  const upCol = col('--up'), downCol = col('--down');
  const trendCol = S[S.length - 1].c >= S[0].o ? upCol : downCol;

  // Referencia (apertura del periodo) y límite "si baja de"
  ctx.lineWidth = 1;
  ctx.strokeStyle = col('--line'); ctx.setLineDash([2, 4]);
  ctx.beginPath(); ctx.moveTo(padX, y(S[0].o)); ctx.lineTo(w - padX, y(S[0].o)); ctx.stroke();
  if (a.useBelow && a.belowUsd >= lo && a.belowUsd <= hi) {
    ctx.strokeStyle = downCol; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(padX, y(a.belowUsd)); ctx.lineTo(w - padX, y(a.belowUsd)); ctx.stroke();
  }
  ctx.setLineDash([]);

  if (candles) {
    const bw = Math.max(1, Math.min(14, slot * 0.64));
    S.forEach((k, i) => {
      const cx = Math.round(x(i)) + 0.5, colr = k.c >= k.o ? upCol : downCol;
      ctx.strokeStyle = colr; ctx.fillStyle = colr; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, y(k.h)); ctx.lineTo(cx, y(k.l)); ctx.stroke();
      const y1 = y(Math.max(k.o, k.c)), y2 = y(Math.min(k.o, k.c));
      ctx.fillRect(cx - bw / 2, y1, bw, Math.max(1, y2 - y1));
    });
    // Precio actual
    const ly = y(S[S.length - 1].c);
    ctx.strokeStyle = trendCol; ctx.setLineDash([1, 3]);
    ctx.beginPath(); ctx.moveTo(padX, ly); ctx.lineTo(w - padX, ly); ctx.stroke();
    ctx.setLineDash([]);
  } else {
    const grad = ctx.createLinearGradient(0, top, 0, H);
    grad.addColorStop(0, trendCol + '33'); grad.addColorStop(1, trendCol + '00');
    const path = () => { ctx.beginPath(); S.forEach((k, i) => (i ? ctx.lineTo(x(i), y(k.c)) : ctx.moveTo(x(i), y(k.c)))); };
    path(); ctx.lineTo(x(S.length - 1), H); ctx.lineTo(x(0), H); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    path(); ctx.strokeStyle = trendCol; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    const lx = x(S.length - 1), ly = y(S[S.length - 1].c);
    ctx.fillStyle = trendCol + '33'; ctx.beginPath(); ctx.arc(lx, ly, 8, 0, 7); ctx.fill();
    ctx.fillStyle = trendCol; ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, 7); ctx.fill();
  }

  // Cursor táctil
  if (hoverX == null) { tip.hidden = true; return; }
  const i = Math.max(0, Math.min(S.length - 1, Math.floor((hoverX - padX) / slot)));
  const k = S[i], bx = x(i);
  ctx.strokeStyle = col('--muted'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bx, top - 6); ctx.lineTo(bx, H); ctx.stroke();
  if (!candles) {
    ctx.fillStyle = col('--surface'); ctx.strokeStyle = trendCol; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(bx, y(k.c), 4.5, 0, 7); ctx.fill(); ctx.stroke();
  }
  const f = v => fmt(code, v, false);
  tip.hidden = false;
  tip.textContent = candles
    ? `${stamp(k.t)}\nAbre ${f(k.o)} · Cierra ${f(k.c)}\nMáx ${f(k.h)} · Mín ${f(k.l)}`
    : `${f(k.c)} · ${stamp(k.t)}`;
  const half = tip.offsetWidth / 2 + 4;
  tip.style.left = Math.min(Math.max(bx, half), w - half) + 'px';
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

// ---- Avisos con la app cerrada (vigilante de GitHub) ----
function renderBackground() {
  const el = $('bgStatus');
  const t = remote.estado && Date.parse(remote.estado.actualizado);
  if (!t) {
    el.className = 'bg-status';
    el.textContent = 'Aún no está activado. Sigue los pasos de abajo.';
    return;
  }
  const mins = Math.round((Date.now() - t) / MIN);
  const ok = mins <= 30;
  el.className = 'bg-status ' + (ok ? 'ok' : 'warn');
  el.textContent = (ok ? 'Activo · ' : 'Parado · ') + 'última comprobación ' +
    (mins < 1 ? 'hace un momento' : mins < 60 ? `hace ${mins} min` : 'el ' + dayMonth(t) + ' a las ' + hhmm(t));
}

function configJson() {
  const out = { moneda: state.settings.currency };
  for (const [code, key] of [['XAU', 'oro'], ['BTC', 'bitcoin']]) {
    const a = state.assets[code];
    const below = a.useBelow && a.belowUsd ? fromUsd(code, a.belowUsd) : null;
    out[key] = {
      activo: !!(a.usePct || (a.useBelow && a.belowUsd)),
      caida_porcentaje: a.usePct ? Number(a.pct) : null,
      baja_de: below != null ? +below.toFixed(decimals(below)) : null,
    };
    if (ASSETS[code].hasUnit) out[key].unidad = state.settings.unit === 'g' ? 'gramo' : 'onza';
  }
  return JSON.stringify(out, null, 2) + '\n';
}

async function copyConfig() {
  const txt = configJson(), btn = $('copyCfg');
  let ok = false;
  try { await navigator.clipboard.writeText(txt); ok = true; } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }
  btn.textContent = ok ? '✓ Copiado. Ahora pégalo en GitHub' : 'No se pudo copiar';
  setTimeout(() => { btn.textContent = 'Copiar mis avisos'; }, 4000);
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

  $('rangeSeg').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v; if (!v) return;
    s.range = v; hoverX = null;
    loadBtcCandles(v); save(true); render();
  });
  $('typeSeg').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v; if (!v) return;
    s.chart = v; save(true); render();
  });
  $('copyCfg').addEventListener('click', copyConfig);
  $('editCfg').href = CONFIG_EDIT_URL;

  // Al volver a la app: actualizar todo al momento
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollGold(); connectBtc(); pollBtcFallback(); applyWake(); loadRemote(); loadBtcCandles(state.settings.range);
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
loadBtcCandles(state.settings.range);
loadRemote(true);
setTimeout(pollBtcFallback, 4000);
setInterval(() => { if (!document.hidden) { pollGold(); pollBtcFallback(); } }, POLL_MS);
setInterval(() => { refreshFx(); loadRemote(); loadBtcCandles(state.settings.range); scheduleRender(); }, 60_000);
applyWake();
