'use strict';

// ---- Configuración ----
const ASSETS = {
  XAU: { name: 'oro', title: 'Oro', icon: '🪙', url: 'https://api.gold-api.com/price/XAU', hasUnit: true, defPct: 1 },
  BTC: { name: 'bitcoin', title: 'Bitcoin', icon: '₿', url: 'https://api.gold-api.com/price/BTC', hasUnit: false, defPct: 3 },
};
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR';
const GRAMS_PER_OZ = 31.1034768;
const MAX_HISTORY = 500;
const STORE_KEY = 'alertaOro.v2';
const OLD_KEY = 'alertaOro.v1';

const $ = id => document.getElementById(id);

// ---- Estado persistente ----
function newAsset(code) {
  return { useBelow: false, below: '', usePct: true, pct: ASSETS[code].defPct,
           history: [], peak: null, belowArmed: true };   // precios en USD (oro: por onza)
}
const defaults = () => ({
  settings: { currency: 'USD', unit: 'oz', interval: 60, sound: true },
  view: 'XAU',
  assets: { XAU: newAsset('XAU'), BTC: newAsset('BTC') },
  alerts: [],         // [{ t, msg }]
  fx: { EUR: null, t: 0 },
});

function load() {
  const d = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s) {
      for (const c of Object.keys(ASSETS)) d.assets[c] = { ...d.assets[c], ...(s.assets || {})[c] };
      return { ...d, ...s, settings: { ...d.settings, ...s.settings }, assets: d.assets };
    }
    // Migrar la versión anterior (solo oro)
    const o = JSON.parse(localStorage.getItem(OLD_KEY));
    if (o) {
      const os = o.settings || {};
      Object.assign(d.assets.XAU, {
        useBelow: !!os.useBelow, below: os.below || '', usePct: os.usePct !== false, pct: os.pct || 1,
        history: o.history || [], peak: o.peak ?? null, belowArmed: o.belowArmed !== false,
      });
      Object.assign(d.settings, { currency: os.currency || 'USD', unit: os.unit || 'oz',
        interval: os.interval || 60, sound: os.sound !== false });
      d.alerts = (o.alerts || []).map(a => ({ ...a, msg: a.msg.startsWith('Oro') ? a.msg : 'Oro: ' + a.msg }));
      if (o.fx) d.fx = o.fx;
    }
  } catch (_) { /* almacenamiento no disponible */ }
  return d;
}
const state = load();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
}

// ---- Conversión y formato ----
function rate() {
  return state.settings.currency === 'EUR' ? (state.fx.EUR || null) : 1;
}
const perUnit = code => (ASSETS[code].hasUnit && state.settings.unit === 'g' ? GRAMS_PER_OZ : 1);
function fromUsd(code, p) {
  const r = rate();
  return r == null ? null : p * r / perUnit(code);
}
function toUsd(code, v) {
  const r = rate();
  return r == null ? null : v * perUnit(code) / r;
}
function fmt(code, p, withUnit = true) {
  const v = fromUsd(code, p);
  if (v == null) return '—';
  const big = v >= 10000;
  const s = new Intl.NumberFormat('es-ES', { style: 'currency', currency: state.settings.currency,
    minimumFractionDigits: big ? 0 : 2, maximumFractionDigits: big ? 0 : 2 }).format(v);
  return withUnit ? s + unitLabel(code) : s;
}
const unitLabel = code => (ASSETS[code].hasUnit ? (state.settings.unit === 'g' ? '/g' : '/oz') : '');
const pctStr = (v, d) => v.toLocaleString('es-ES', { maximumFractionDigits: d });
const time = t => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---- Red ----
async function fetchPrice(code) {
  const r = await fetch(ASSETS[code].url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const p = Number(j.price);
  if (!isFinite(p) || p <= 0) throw new Error('Respuesta no válida');
  return p;
}
async function refreshFx(force) {
  if (!force && state.fx.EUR && Date.now() - state.fx.t < 3600e3) return;
  try {
    const r = await fetch(FX_URL);
    const j = await r.json();
    if (j.rates && j.rates.EUR) state.fx = { EUR: j.rates.EUR, t: Date.now() };
  } catch (_) { /* se mantiene el último tipo conocido */ }
}

// ---- Avisos ----
let swReg = null;
async function notify(code, title, body) {
  const msg = ASSETS[code].title + ': ' + body;
  state.alerts.unshift({ t: Date.now(), msg });
  state.alerts = state.alerts.slice(0, 50);
  if (state.settings.sound) beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    const opts = { body, icon: 'icon.svg', badge: 'icon.svg', tag: 'alerta-' + code, renotify: true };
    try {
      if (swReg) await swReg.showNotification(title, opts);
      else new Notification(title, opts);
    } catch (_) { try { new Notification(title, opts); } catch (_) {} }
  }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25].forEach(d => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 660 - d * 400;
      g.gain.setValueAtTime(0.2, ctx.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + d); o.stop(ctx.currentTime + d + 0.23);
    });
  } catch (_) {}
}

function checkAlerts(code, p) {
  const a = state.assets[code], A = ASSETS[code];

  // 1) Precio por debajo de un umbral (en la moneda y unidad elegidas)
  const belowVal = parseFloat(a.below);
  if (a.useBelow && belowVal > 0) {
    const limit = toUsd(code, belowVal);
    if (limit != null) {
      if (p < limit && a.belowArmed) {
        a.belowArmed = false;
        notify(code, `🔻 Ha bajado el ${A.name}`, `${fmt(code, p)}, por debajo de tu límite de ${fmt(code, limit)}.`);
      } else if (p >= limit) {
        a.belowArmed = true;
      }
    }
  }

  // 2) Caída de X % desde el máximo reciente
  if (a.peak == null || p > a.peak) a.peak = p;
  const pct = parseFloat(a.pct);
  if (a.usePct && pct > 0) {
    const drop = (a.peak - p) / a.peak * 100;
    if (drop >= pct) {
      notify(code, `📉 Caída del ${A.name}`, `ha bajado un ${pctStr(drop, 2)} % desde ${fmt(code, a.peak)}. Ahora: ${fmt(code, p)}.`);
      a.peak = p; // nueva referencia: el próximo aviso exige otra caída igual
    }
  }
}

// ---- Ciclo principal ----
let timer = null;
async function tick() {
  await refreshFx();
  const failed = [];
  await Promise.all(Object.keys(ASSETS).map(async code => {
    try {
      const p = await fetchPrice(code);
      const h = state.assets[code].history;
      h.push({ t: Date.now(), p });
      if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
      checkAlerts(code, p);
    } catch (e) {
      failed.push(ASSETS[code].title);
      console.error(code, e);
    }
  }));
  if (!failed.length) setStatus('En directo', 'ok');
  else if (failed.length === Object.keys(ASSETS).length) setStatus('Sin conexión con la API', 'err');
  else setStatus('Sin datos: ' + failed.join(', '), 'err');
  save();
  render();
}
function schedule() {
  clearInterval(timer);
  timer = setInterval(tick, state.settings.interval * 1000);
}
function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

// ---- Interfaz ----
function render() {
  const code = state.view, A = ASSETS[code], a = state.assets[code];
  const h = a.history;
  const last = h[h.length - 1];

  document.querySelectorAll('.tab').forEach(b => {
    const c = b.dataset.asset, hh = state.assets[c].history;
    b.classList.toggle('active', c === code);
    b.setAttribute('aria-selected', c === code);
    $('tab-' + c).textContent = hh.length ? fmt(c, hh[hh.length - 1].p) : '';
  });

  $('priceLabel').textContent = `Precio actual del ${A.name}`;
  $('settingsTitle').textContent = `¿Cuándo te aviso del ${A.name}?`;
  $('unitWrap').hidden = !A.hasUnit;

  $('price').textContent = last ? fmt(code, last.p) : '—';
  $('updated').textContent = last ? 'Actualizado a las ' + time(last.t) : '';

  const ch = $('change');
  if (h.length > 1) {
    const prev = h[h.length - 2].p, d = last.p - prev, pct = d / prev * 100;
    ch.textContent = (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '= ') + pctStr(Math.abs(pct), 3) + ' % desde la última lectura';
    ch.className = 'change ' + (d < 0 ? 'down' : d > 0 ? 'up' : '');
  } else { ch.textContent = ''; ch.className = 'change'; }

  const ps = h.map(x => x.p);
  $('min').textContent = ps.length ? fmt(code, Math.min(...ps), false) : '—';
  $('max').textContent = ps.length ? fmt(code, Math.max(...ps), false) : '—';

  const ul = $('alerts');
  ul.innerHTML = '';
  if (!state.alerts.length) ul.innerHTML = '<li class="muted">Aún no hay avisos.</li>';
  for (const al of state.alerts) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = new Date(al.t).toLocaleString('es-ES');
    li.append(t, document.createTextNode(al.msg));
    ul.append(li);
  }

  updateNotifyBtn();
  drawChart();
}

function drawChart() {
  const code = state.view, a = state.assets[code];
  const c = $('chart'), ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, hgt = 160;
  c.width = w * dpr; c.height = hgt * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, hgt);
  const pts = a.history.slice(-120);
  const css = getComputedStyle(document.documentElement);
  if (pts.length < 2) {
    ctx.fillStyle = css.getPropertyValue('--muted');
    ctx.font = '13px system-ui';
    ctx.fillText('El gráfico aparecerá con más lecturas…', 8, hgt / 2);
    return;
  }
  const ps = pts.map(x => x.p);
  let lo = Math.min(...ps), hi = Math.max(...ps);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = 8;
  const x = i => pad + i * (w - 2 * pad) / (pts.length - 1);
  const y = v => pad + (hi - v) * (hgt - 2 * pad) / (hi - lo);

  // Línea del umbral, si está visible en el rango
  const belowVal = parseFloat(a.below);
  if (a.useBelow && belowVal > 0) {
    const lim = toUsd(code, belowVal);
    if (lim != null && lim >= lo && lim <= hi) {
      ctx.strokeStyle = css.getPropertyValue('--down');
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad, y(lim)); ctx.lineTo(w - pad, y(lim)); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  const gold = css.getPropertyValue('--gold').trim();
  ctx.strokeStyle = gold; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((pt, i) => (i ? ctx.lineTo(x(i), y(pt.p)) : ctx.moveTo(x(i), y(pt.p))));
  ctx.stroke();
  ctx.lineTo(x(pts.length - 1), hgt); ctx.lineTo(x(0), hgt); ctx.closePath();
  ctx.globalAlpha = 0.12; ctx.fillStyle = gold; ctx.fill(); ctx.globalAlpha = 1;
}

function updateNotifyBtn() {
  const b = $('notifyBtn');
  if (!('Notification' in window)) { b.textContent = 'Notificaciones no disponibles'; b.disabled = true; return; }
  const p = Notification.permission;
  b.textContent = p === 'granted' ? '🔔 Notificaciones activadas' : p === 'denied' ? '🔕 Notificaciones bloqueadas' : '🔔 Activar notificaciones';
  b.disabled = p !== 'default';
}

// Rellena el formulario con los avisos del activo que se está viendo
function fillAssetForm() {
  const a = state.assets[state.view];
  $('useBelow').checked = a.useBelow; $('below').value = a.below;
  $('usePct').checked = a.usePct; $('pct').value = a.pct;
}

function bindSettings() {
  const s = state.settings;
  fillAssetForm();
  $('currency').value = s.currency; $('unit').value = s.unit;
  $('interval').value = String(s.interval); $('sound').checked = s.sound;

  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    state.view = b.dataset.asset;
    fillAssetForm();
    save(); render();
  }));

  $('settings').addEventListener('input', async e => {
    const id = e.target.id, a = state.assets[state.view];
    a.useBelow = $('useBelow').checked; a.below = $('below').value;
    a.usePct = $('usePct').checked; a.pct = $('pct').value;
    if (id === 'below') a.belowArmed = true;
    s.currency = $('currency').value; s.unit = $('unit').value; s.sound = $('sound').checked;
    if (id === 'interval') { s.interval = Number($('interval').value); schedule(); }
    if (id === 'currency' && s.currency === 'EUR') await refreshFx();
    save(); render();
  });

  $('notifyBtn').addEventListener('click', async () => {
    await Notification.requestPermission();
    updateNotifyBtn();
  });
  $('resetBtn').addEventListener('click', () => {
    const a = state.assets[state.view], last = a.history[a.history.length - 1];
    a.peak = last ? last.p : null;
    a.belowArmed = true;
    save();
    setStatus('Máximo reiniciado', 'ok');
  });
  window.addEventListener('resize', drawChart);
}

// ---- Inicio ----
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
}
bindSettings();
render();
tick();
schedule();
