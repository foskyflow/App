'use strict';

// ---- Configuración ----
const PRICE_URL = 'https://api.gold-api.com/price/XAU';            // USD por onza troy
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR';
const GRAMS_PER_OZ = 31.1034768;
const MAX_HISTORY = 500;
const STORE_KEY = 'alertaOro.v1';

const $ = id => document.getElementById(id);

// ---- Estado persistente ----
const defaults = {
  settings: { useBelow: false, below: '', usePct: true, pct: 1, currency: 'USD', unit: 'oz', interval: 60, sound: true },
  history: [],        // [{ t, p }] p = USD/oz
  peak: null,         // máximo de referencia (USD/oz) para la caída en %
  belowArmed: true,   // evita repetir el aviso de umbral hasta que el precio vuelva a subir
  alerts: [],         // [{ t, msg }]
  fx: { EUR: null, t: 0 },
};

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s) return { ...defaults, ...s, settings: { ...defaults.settings, ...s.settings } };
  } catch (_) { /* almacenamiento no disponible */ }
  return structuredClone(defaults);
}
const state = load();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
}

// ---- Conversión y formato ----
function rate() {
  return state.settings.currency === 'EUR' ? (state.fx.EUR || null) : 1;
}
function fromUsdOz(p) {
  const r = rate();
  if (r == null) return null;
  return p * r / (state.settings.unit === 'g' ? GRAMS_PER_OZ : 1);
}
function toUsdOz(v) {
  const r = rate();
  if (r == null) return null;
  return v * (state.settings.unit === 'g' ? GRAMS_PER_OZ : 1) / r;
}
function fmt(p) {
  const v = fromUsdOz(p);
  if (v == null) return '—';
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: state.settings.currency,
    minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}
const unitLabel = () => (state.settings.unit === 'g' ? '/g' : '/oz');
const time = t => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---- Red ----
async function fetchPrice() {
  const r = await fetch(PRICE_URL, { cache: 'no-store' });
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
async function notify(title, body) {
  state.alerts.unshift({ t: Date.now(), msg: body });
  state.alerts = state.alerts.slice(0, 50);
  if (state.settings.sound) beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    const opts = { body, icon: 'icon.svg', badge: 'icon.svg', tag: 'alerta-oro', renotify: true };
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

function checkAlerts(p) {
  const s = state.settings;

  // 1) Precio por debajo de un umbral (en la moneda y unidad elegidas)
  const belowVal = parseFloat(s.below);
  if (s.useBelow && belowVal > 0) {
    const limit = toUsdOz(belowVal);
    if (limit != null) {
      if (p < limit && state.belowArmed) {
        state.belowArmed = false;
        notify('🔻 El oro ha bajado', `Precio ${fmt(p)}${unitLabel()}, por debajo de tu límite de ${fmt(limit)}${unitLabel()}.`);
      } else if (p >= limit) {
        state.belowArmed = true;
      }
    }
  }

  // 2) Caída de X % desde el máximo reciente
  if (state.peak == null || p > state.peak) state.peak = p;
  const pct = parseFloat(s.pct);
  if (s.usePct && pct > 0) {
    const drop = (state.peak - p) / state.peak * 100;
    if (drop >= pct) {
      notify('📉 Caída del oro', `Ha bajado un ${drop.toLocaleString('es-ES', { maximumFractionDigits: 2 })} % desde ${fmt(state.peak)}${unitLabel()}. Ahora: ${fmt(p)}${unitLabel()}.`);
      state.peak = p; // nueva referencia: el próximo aviso exige otra caída igual
    }
  }
}

// ---- Ciclo principal ----
let timer = null;
async function tick() {
  try {
    await refreshFx();
    const p = await fetchPrice();
    state.history.push({ t: Date.now(), p });
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
    checkAlerts(p);
    setStatus('En directo', 'ok');
  } catch (e) {
    setStatus('Sin conexión con la API', 'err');
    console.error(e);
  }
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
  const h = state.history;
  const last = h[h.length - 1];
  $('price').textContent = last ? fmt(last.p) + unitLabel() : '—';
  $('updated').textContent = last ? 'Actualizado a las ' + time(last.t) : '';

  const ch = $('change');
  if (h.length > 1) {
    const prev = h[h.length - 2].p, d = last.p - prev, pct = d / prev * 100;
    ch.textContent = (d >= 0 ? '▲ ' : '▼ ') + Math.abs(pct).toLocaleString('es-ES', { maximumFractionDigits: 3 }) + ' % desde la última lectura';
    ch.className = 'change ' + (d < 0 ? 'down' : 'up');
  } else { ch.textContent = ''; ch.className = 'change'; }

  if (h.length) {
    const ps = h.map(x => x.p);
    $('min').textContent = fmt(Math.min(...ps));
    $('max').textContent = fmt(Math.max(...ps));
  }

  const ul = $('alerts');
  ul.innerHTML = '';
  if (!state.alerts.length) ul.innerHTML = '<li class="muted">Aún no hay avisos.</li>';
  for (const a of state.alerts) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = new Date(a.t).toLocaleString('es-ES');
    li.append(t, document.createTextNode(a.msg));
    ul.append(li);
  }

  updateNotifyBtn();
  drawChart();
}

function drawChart() {
  const c = $('chart'), ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, hgt = 160;
  c.width = w * dpr; c.height = hgt * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, hgt);
  const pts = state.history.slice(-120);
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
  const belowVal = parseFloat(state.settings.below);
  if (state.settings.useBelow && belowVal > 0) {
    const lim = toUsdOz(belowVal);
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

function bindSettings() {
  const s = state.settings;
  $('useBelow').checked = s.useBelow; $('below').value = s.below;
  $('usePct').checked = s.usePct; $('pct').value = s.pct;
  $('currency').value = s.currency; $('unit').value = s.unit;
  $('interval').value = String(s.interval); $('sound').checked = s.sound;

  $('settings').addEventListener('input', async e => {
    const id = e.target.id;
    const prevCur = s.currency;
    s.useBelow = $('useBelow').checked; s.below = $('below').value;
    s.usePct = $('usePct').checked; s.pct = $('pct').value;
    s.currency = $('currency').value; s.unit = $('unit').value;
    s.sound = $('sound').checked;
    if (id === 'below') state.belowArmed = true;
    if (id === 'interval') { s.interval = Number($('interval').value); schedule(); }
    if (s.currency !== prevCur && s.currency === 'EUR') await refreshFx();
    save(); render();
  });

  $('notifyBtn').addEventListener('click', async () => {
    await Notification.requestPermission();
    updateNotifyBtn();
  });
  $('resetBtn').addEventListener('click', () => {
    const last = state.history[state.history.length - 1];
    state.peak = last ? last.p : null;
    state.belowArmed = true;
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
