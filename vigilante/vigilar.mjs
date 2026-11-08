// Vigilante en segundo plano: lo ejecuta GitHub Actions cada 5 minutos.
// Comprueba el precio del oro y del bitcoin, envía avisos con ntfy y guarda
// el estado y el historial (que la app usa para dibujar las velas del oro).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const DIR = process.env.DATOS_DIR || 'datos';
const CONFIG = process.env.CONFIG || 'avisos.json';
const TOPIC = (process.env.NTFY_TOPIC || '').trim();
const PRUEBA = process.env.PRUEBA === 'true';
const APP_URL = process.env.APP_URL || '';
const GRAMS_PER_OZ = 31.1034768;
const H = 3600_000, D = 24 * H;

const ASSETS = {
  XAU: { clave: 'oro', nombre: 'oro', titulo: 'Oro', unidad: true },
  BTC: { clave: 'bitcoin', nombre: 'bitcoin', titulo: 'Bitcoin', unidad: false },
};

const readJson = async (f, def) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return def; } };

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'alerta-oro-vigilante' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}
async function firstOk(...fns) {
  for (const fn of fns) { try { const v = await fn(); if (v > 0) return v; } catch (e) { console.warn(e.message); } }
  return null;
}

const precios = {
  XAU: () => firstOk(async () => Number((await getJson('https://api.gold-api.com/price/XAU')).price)),
  BTC: () => firstOk(
    async () => Number((await getJson('https://api.exchange.coinbase.com/products/BTC-USD/ticker')).price),
    async () => Number((await getJson('https://api.gold-api.com/price/BTC')).price)),
};

async function enviar(titulo, mensaje, tags) {
  console.log(`AVISO: ${titulo} — ${mensaje}`);
  if (!TOPIC) { console.warn('Falta el secreto NTFY_TOPIC: no se envía la notificación.'); return; }
  const r = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: TOPIC, title: titulo, message: mensaje, tags, priority: 4,
                           ...(APP_URL ? { click: APP_URL } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) console.warn('ntfy respondió HTTP ' + r.status);
}

// Reduce el historial: todo de los últimos 2 días, uno cada 30 min hasta 30 días, uno cada 6 h hasta 200 días
function aclarar(puntos, ahora) {
  const out = [], visto = new Set();
  for (const [t, p] of puntos.sort((a, b) => a[0] - b[0])) {
    const edad = ahora - t;
    if (edad > 200 * D) continue;
    const paso = edad <= 2 * D ? 0 : edad <= 30 * D ? 30 * 60_000 : 6 * H;
    if (paso) { const k = paso + ':' + Math.floor(t / paso); if (visto.has(k)) continue; visto.add(k); }
    out.push([t, p]);
  }
  return out;
}

async function main() {
  const cfg = await readJson(CONFIG, {});
  const estado = await readJson(`${DIR}/estado.json`, {});
  const historial = await readJson(`${DIR}/historial.json`, {});
  const ahora = Date.now();

  const moneda = cfg.moneda === 'USD' ? 'USD' : 'EUR';
  let tasa = 1;
  if (moneda === 'EUR') {
    tasa = await firstOk(async () => (await getJson('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR')).rates.EUR)
      || estado.tasaEUR || null;
    if (tasa) estado.tasaEUR = tasa;
  }

  const lineasPrueba = [];
  for (const [code, A] of Object.entries(ASSETS)) {
    const c = cfg[A.clave] || {};
    const p = await precios[code]();
    if (!p) { console.warn(`Sin precio de ${A.nombre}`); continue; }
    (historial[code] ||= []).push([ahora, p]);
    historial[code] = aclarar(historial[code], ahora);

    const porUnidad = A.unidad && c.unidad === 'gramo' ? GRAMS_PER_OZ : 1;
    const fmt = usd => {
      if (!tasa) return '$' + Math.round(usd).toLocaleString('es-ES');
      const v = usd * tasa / porUnidad, d = v >= 10000 ? 0 : 2;
      const n = v.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' });
      return (moneda === 'EUR' ? n + ' €' : '$' + n) + (A.unidad ? (porUnidad > 1 ? '/g' : '/oz') : '');
    };
    lineasPrueba.push(`${A.titulo}: ${fmt(p)}`);
    if (c.activo === false) continue;

    const s = (estado[code] ||= { pico: null, armado: true, limiteUsd: null });

    // 1) Por debajo de un precio (en la moneda y unidad de avisos.json)
    const limite = Number(c.baja_de) > 0 && tasa ? Number(c.baja_de) * porUnidad / tasa : null;
    if (limite !== s.limiteUsd) { s.limiteUsd = limite; s.armado = true; }
    if (limite) {
      if (p < limite && s.armado) {
        s.armado = false;
        await enviar(`🔻 El ${A.nombre} ha bajado`, `${A.titulo} a ${fmt(p)}, por debajo de ${fmt(limite)}.`, ['chart_with_downwards_trend']);
      } else if (p >= limite * 1.001) s.armado = true;
    }

    // 2) Caída de X % desde el máximo
    if (s.pico == null || p > s.pico) s.pico = p;
    const pct = Number(c.caida_porcentaje);
    if (pct > 0) {
      const caida = (s.pico - p) / s.pico * 100;
      if (caida >= pct) {
        await enviar(`📉 Caída del ${A.nombre}`,
          `${A.titulo} ha bajado un ${caida.toLocaleString('es-ES', { maximumFractionDigits: 2 })} % desde ${fmt(s.pico)}. Ahora: ${fmt(p)}.`,
          ['chart_with_downwards_trend']);
        s.pico = p;
      }
    }
  }

  if (PRUEBA) {
    await enviar('✅ Avisos con la app cerrada activados',
      lineasPrueba.length ? 'Precios ahora: ' + lineasPrueba.join(' · ') : 'No se pudieron leer los precios ahora mismo.',
      ['white_check_mark']);
  }

  estado.actualizado = new Date(ahora).toISOString();
  await mkdir(DIR, { recursive: true });
  await writeFile(`${DIR}/estado.json`, JSON.stringify(estado, null, 1));
  await writeFile(`${DIR}/historial.json`, JSON.stringify(historial));
  console.log('Precios:', lineasPrueba.join(' · ') || 'ninguno');
}

main().catch(e => { console.error(e); process.exit(1); });
