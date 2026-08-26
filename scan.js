// ============================================================
// ScalpScan Pro - Alert Bot (v6.8 lógica + FIX E/F) - Node.js
// Escanea 50 pares en Binance, aplica la MISMA lógica que el
// scanner web (4H obligatorio + gates de volumen MTF, incl.
// PREPARING) y manda un mensaje a Telegram si hay ELITE/SUPER/PREP.
//
// Requiere Node 18+ (fetch nativo). Variables de entorno:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en el entorno.');
  process.exit(1);
}

const PAIRS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'DOGEUSDT','ADAUSDT','AVAXUSDT','TRXUSDT','DOTUSDT',
  'MATICUSDT','LINKUSDT','LTCUSDT','BCHUSDT','NEARUSDT',
  'UNIUSDT','ATOMUSDT','ETCUSDT','XLMUSDT','INJUSDT',
  'OPUSDT','ARBUSDT','APTUSDT','SUIUSDT','RUNEUSDT',
  'FTMUSDT','AAVEUSDT','LDOUSDT','ICPUSDT','FILUSDT',
  'MKRUSDT','SNXUSDT','CRVUSDT','COMPUSDT','DYDXUSDT',
  'WLDUSDT','SEIUSDT','TIAUSDT','STXUSDT','ORDIUSDT',
  'PYTHUSDT','JUPUSDT','PENDLEUSDT','ONDOUSDT','FETUSDT',
  'RENDERUSDT','THETAUSDT','GALAUSDT','SANDUSDT','MANAUSDT'
];

// MODO AGRESIVO — umbrales relajados a propósito para generar más señales.
// Esto sube el ruido/falsos positivos; es el trade-off pedido.
const MTF_MIN_VOL     = 0.7;
const PREP_MIN_VOL_4H = 0.3;
const PREP_MIN_VOL_1H = 0.5;

// FIX E — denominadores reales de cada sistema de score. earlyWarning() solo
// puede generar 5 triggers como máximo (EMA cruzando, RSI cerca, squeeze,
// vol construyendo, StochK cruzando), mientras que evalPair() puntúa sobre
// 9 condiciones para señales confirmadas/trend. Antes fmtSignal() mostraba
// siempre "/9" incluso para PREPARING, así que un "2/9" real de PREPARING
// (que es en verdad 2 de 5, un 40%) se leía como un mediocre 22%.
const CONFIRMED_MAX_SCORE = 9;
const PREP_MAX_SCORE = 5;

// ============================================================
// INDICADORES (mismos que el scanner web v6.8)
// ============================================================
function ema(p, n) {
  if (p.length < n) return null;
  const k = 2 / (n + 1);
  let e = p.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < p.length; i++) e = p[i] * k + e * (1 - k);
  return e;
}
function rsiW(p, n = 14) {
  if (p.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = p[i] - p[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  for (let i = n + 1; i < p.length; i++) { const d = p[i] - p[i - 1]; ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n; }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function stochRsi(p) {
  const rp = 14, sp = 14, kp = 3, dp = 3;
  const rs = []; for (let i = rp; i < p.length; i++) rs.push(rsiW(p.slice(0, i + 1), rp));
  if (rs.length < sp + kp + dp) return { k: null, d: null };
  const rawK = [];
  for (let i = sp - 1; i < rs.length; i++) { const sl = rs.slice(i - sp + 1, i + 1); const lo = Math.min(...sl), hi = Math.max(...sl); rawK.push(hi === lo ? 50 : ((rs[i] - lo) / (hi - lo)) * 100); }
  const kS = [], dS = [];
  for (let i = kp - 1; i < rawK.length; i++) kS.push(rawK.slice(i - kp + 1, i + 1).reduce((a, b) => a + b, 0) / kp);
  for (let i = dp - 1; i < kS.length; i++) dS.push(kS.slice(i - dp + 1, i + 1).reduce((a, b) => a + b, 0) / dp);
  return { k: kS[kS.length - 1] ?? null, d: dS[dS.length - 1] ?? null };
}
function boll(p, n = 20, m = 2) {
  if (p.length < n) return null;
  const sl = p.slice(-n); const mid = sl.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(sl.reduce((s, x) => s + (x - mid) ** 2, 0) / n);
  return { upper: mid + m * std, mid, lower: mid - m * std, std };
}
function vwapCalc(candles) {
  const s = candles.slice(-96); let pv = 0, v = 0;
  for (const c of s) { const tp = (parseFloat(c[2]) + parseFloat(c[3]) + parseFloat(c[4])) / 3; const vol = parseFloat(c[5]); pv += tp * vol; v += vol; }
  return v > 0 ? pv / v : null;
}
function volSpikeCalc(candles) {
  const vols = candles.slice(-21, -1).map(c => parseFloat(c[5]));
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  const last = parseFloat(candles[candles.length - 1][5]);
  return { ratio: last / avg, avg, last };
}
function atrCalc(candles, n = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) { const h = parseFloat(candles[i][2]), l = parseFloat(candles[i][3]), pc = parseFloat(candles[i - 1][4]); trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  const r = trs.slice(-n); return r.reduce((a, b) => a + b, 0) / r.length;
}
function trendGeneric(candles) {
  const cl = candles.map(c => parseFloat(c[4])); const p = cl[cl.length - 1];
  const e21 = ema(cl, 21), e50 = ema(cl, 50); const r = rsiW(cl, 14); const vw = vwapCalc(candles);
  if (!e21 || !e50 || r === null) return 'neutral';
  const bull = (p > e21 ? 1 : 0) + (e21 > e50 ? 1 : 0) + (r > 50 ? 1 : 0) + (vw && p > vw ? 1 : 0);
  return bull >= 3 ? 'bull' : bull <= 1 ? 'bear' : 'neutral';
}

function earlyWarning(closes, candles, htf1h, htf4h, vol1h, vol4h) {
  const p = closes[closes.length - 1];
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const prev = closes.slice(0, -1);
  const pe9 = ema(prev, 9), pe21 = ema(prev, 21);
  const r = rsiW(closes, 14);
  const sk = stochRsi(closes), psk = stochRsi(prev);
  const bb = boll(closes);
  const vol = volSpikeCalc(candles);

  if (!e9 || !e21 || !e50 || !pe9 || !pe21 || r === null) return null;

  const emaCrossingLong  = pe9 <= pe21 && e9 > e21 * 0.998 && e9 < e21 * 1.005;
  const emaCrossingShort = pe9 >= pe21 && e9 < e21 * 1.002 && e9 > e21 * 0.995;
  // FIX D — ventana RSI ampliada (antes 46-52 / 48-54) para detectar el giro
  // un poco antes y no llegar tan lejos cuando la señal confirma.
  const rsiNearLong  = r >= 44 && r <= 54;
  const rsiNearShort = r >= 46 && r <= 56;
  const sqz = bb ? bb.std / bb.mid < 0.015 : false;
  const volBuilding = vol.ratio >= 1.2 && vol.ratio < 2.0;
  const stochCrossingLong  = psk.k !== null && sk.k !== null && psk.k < psk.d && sk.k >= sk.d && sk.k < 40;
  const stochCrossingShort = psk.k !== null && sk.k !== null && psk.k > psk.d && sk.k <= sk.d && sk.k > 60;

  if (vol.ratio < 1.0) return null;

  const v1h = typeof vol1h === 'number' ? vol1h : 0;
  const v4h = typeof vol4h === 'number' ? vol4h : 0;
  if (v4h < PREP_MIN_VOL_4H || v1h < PREP_MIN_VOL_1H) return null;

  if (sk.k !== null) {
    const prepLongStochOk  = sk.k < 70;
    const prepShortStochOk = sk.k > 30;
    const goingLong  = htf4h === 'bull';
    const goingShort = htf4h === 'bear';
    if (goingLong  && !prepLongStochOk)  return null;
    if (goingShort && !prepShortStochOk) return null;
  }

  const prepLong  = htf4h === 'bull' && (emaCrossingLong  || (rsiNearLong  && (sqz || volBuilding || stochCrossingLong)));
  const prepShort = htf4h === 'bear' && (emaCrossingShort || (rsiNearShort && (sqz || volBuilding || stochCrossingShort)));
  if (!prepLong && !prepShort) return null;

  const direction = prepLong ? 'preparing_long' : 'preparing_short';
  let triggers = [];
  if (prepLong) {
    if (emaCrossingLong)   triggers.push('EMA 9/21 cruzando ↑');
    if (rsiNearLong)       triggers.push(`RSI ${r.toFixed(1)} → cruzando 50`);
    if (sqz)               triggers.push('BB squeeze → explosión inminente');
    if (volBuilding)       triggers.push(`Vol ${vol.ratio.toFixed(1)}x construyendo`);
    if (stochCrossingLong) triggers.push('StochK cruzando ↑');
  } else {
    if (emaCrossingShort)   triggers.push('EMA 9/21 cruzando ↓');
    if (rsiNearShort)       triggers.push(`RSI ${r.toFixed(1)} → cruzando 50`);
    if (sqz)                triggers.push('BB squeeze → explosión inminente');
    if (volBuilding)        triggers.push(`Vol ${vol.ratio.toFixed(1)}x construyendo`);
    if (stochCrossingShort) triggers.push('StochK cruzando ↓');
  }

  return {
    signal: direction, triggers, score: triggers.length,
    price: p, rsi: r, stochK: sk.k, bb, vol, squeeze: sqz,
    pbPct: e9 ? Math.abs(p - e9) / e9 * 100 : 0
  };
}

function evalPair(closes, candles) {
  const p = closes[closes.length - 1];
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const prev = closes.slice(0, -1);
  const pe9 = ema(prev, 9), pe21 = ema(prev, 21);
  const r = rsiW(closes, 14), pr = rsiW(prev, 14);
  const sk = stochRsi(closes), psk = stochRsi(prev);
  const bb = boll(closes), pvwap = vwapCalc(candles), vol = volSpikeCalc(candles), at = atrCalc(candles);
  const prevBB = boll(prev);
  if (!e9 || !e21 || !e50 || !pe9 || !pe21 || r === null) return null;
  const aboveVWAP = pvwap ? p > pvwap : null;
  const bbPos = bb ? (p - bb.lower) / (bb.upper - bb.lower) : 0.5;
  const sqz = bb ? bb.std / bb.mid < 0.012 : false;
  const vs = vol.ratio > 1.5;
  const slL = Math.max(bb ? Math.min(p - bb.lower, at * 1.5) : at * 1.5, p * 0.004);
  const slS = Math.max(bb ? Math.min(bb.upper - p, at * 1.5) : at * 1.5, p * 0.004);
  const slPL = (slL / p) * 100, slPS = (slS / p) * 100;
  const ecL = pe9 <= pe21 && e9 > e21, ecS = pe9 >= pe21 && e9 < e21;
  let rcL = false, rcS = false;
  for (let i = 3; i >= 1; i--) { const s = closes.slice(0, -i), ps = closes.slice(0, -i - 1); if (ps.length < 21) continue; const a = ema(s, 9), b = ema(s, 21), c = ema(ps, 9), d = ema(ps, 21); if (a && b && c && d) { if (c <= d && a > b) rcL = true; if (c >= d && a < b) rcS = true; } }
  const rcUp = pr !== null && pr < 50 && r >= 50, rcDn = pr !== null && pr > 50 && r <= 50;
  const prevSqz = prevBB ? prevBB.std / prevBB.mid < 0.012 : false;
  const bbBL = prevSqz && !sqz && p > (bb ? bb.mid : p) && vs;
  const bbBS = prevSqz && !sqz && p < (bb ? bb.mid : p) && vs;
  const lc = candles[candles.length - 1];
  const co = parseFloat(lc[1]), cc = parseFloat(lc[4]), ch = parseFloat(lc[2]), cl2 = parseFloat(lc[3]);
  const body = Math.abs(cc - co), range = ch - cl2;
  const sBull = cc > co && range > 0 && body / range > 0.6 && vs;
  const sBear = cc < co && range > 0 && body / range > 0.6 && vs;
  const scUp = psk.k !== null && sk.k !== null && psk.k < psk.d && sk.k > sk.d && sk.k < 50;
  const scDn = psk.k !== null && sk.k !== null && psk.k > psk.d && sk.k < sk.d && sk.k > 50;
  const lConds = [ecL || rcL, rcUp || (r > 50 && r < 58), bbBL, sBull, scUp, vs, e21 > e50, aboveVWAP === true, p > e9];
  const sConds = [ecS || rcS, rcDn || (r < 50 && r > 42), bbBS, sBear, scDn, vs, e21 < e50, aboveVWAP === false, p < e9];
  const ls = lConds.filter(Boolean).length, ss = sConds.filter(Boolean).length;
  const rOkL = r >= 35 && r <= 72, rOkS = r >= 28 && r <= 65;
  const bbOkL = bb ? p > bb.lower * 0.985 : true, bbOkS = bb ? p < bb.upper * 1.015 : true;
  const stOkL = sk.k !== null ? sk.k < 85 : true, stOkS = sk.k !== null ? sk.k > 15 : true;
  const lv = (ecL || rcL || bbBL) && vs && ls >= 6 && slPL <= 2.5 && rOkL && bbOkL && stOkL;
  const sv = (ecS || rcS || bbBS) && vs && ss >= 6 && slPS <= 2.5 && rOkS && bbOkS && stOkS;
  const trendLongConds  = [e9 > e21 && e21 > e50, aboveVWAP === true, r >= 50 && r <= 70, p > e21, p > e9 * 0.995 && p < e9 * 1.015, sk.k !== null ? sk.k < 70 : true, vol.ratio > 0.7, bbPos >= 0.4 && bbPos <= 0.8, true];
  const trendShortConds = [e9 < e21 && e21 < e50, aboveVWAP === false, r >= 30 && r <= 50, p < e21, p < e9 * 1.005 && p > e9 * 0.985, sk.k !== null ? sk.k > 30 : true, vol.ratio > 0.7, bbPos >= 0.2 && bbPos <= 0.6, true];
  const tls = trendLongConds.filter(Boolean).length, tss = trendShortConds.filter(Boolean).length;
  const trendLongValid  = e9 > e21 && e21 > e50 && r >= 50 && r <= 70 && aboveVWAP === true && tls >= 6;
  const trendShortValid = e9 < e21 && e21 < e50 && r >= 30 && r <= 50 && aboveVWAP === false && tss >= 6;
  let signal = 'neutral', score = 0;
  if (lv && ls >= ss)              { signal = 'early_long';   score = ls; }
  else if (sv && ss > ls)          { signal = 'early_short';  score = ss; }
  else if (trendLongValid && !sv)  { signal = 'trend_long';   score = tls; }
  else if (trendShortValid && !lv) { signal = 'trend_short';  score = tss; }
  else                             { signal = 'neutral';      score = Math.max(ls, ss, tls, tss); }
  const pbPct = e9 ? Math.abs(p - e9) / e9 * 100 : 0;
  return { price: p, rsi: r, stochK: sk.k, bb, vol, squeeze: sqz, signal, score, pbPct };
}

function mtfVolumeOk(vol1h, vol4h) {
  const v1 = typeof vol1h === 'number' ? vol1h : 0;
  const v4 = typeof vol4h === 'number' ? vol4h : 0;
  return v1 >= MTF_MIN_VOL && v4 >= MTF_MIN_VOL;
}

// FIX F — antes esta función usaba d.signal.includes('long'/'short'), que
// también hace match con 'preparing_long'/'preparing_short'. En la práctica
// no se colaba ninguna PREPARING como SUPER/ELITE porque su score (máx. 5)
// nunca llegaba al umbral de isSuperSignal (≥7), pero era una condición
// frágil: si algún día el score máximo de earlyWarning() sube, o el umbral
// de SUPER baja de 5, una PREPARING podría promocionarse a SUPER/ELITE sin
// pasar por sus propios gates de volumen (0.3x/0.5x en vez de 0.7x).
// Ahora se exige explícitamente que la señal sea de un tipo "confirmado"
// real (early_/trend_), nunca preparing_.
function isConfirmedSignalType(signal) {
  return signal === 'early_long' || signal === 'early_short' ||
         signal === 'trend_long' || signal === 'trend_short';
}
function isConfirmed(d, htf, htf4h, vol1h, vol4h) {
  if (!d || d.signal === 'neutral') return false;
  if (!isConfirmedSignalType(d.signal)) return false; // FIX F
  if (htf4h !== (d.signal.includes('long') ? 'bull' : 'bear')) return false;
  const longOk  = d.signal.includes('long')  && htf === 'bull';
  const shortOk = d.signal.includes('short') && htf === 'bear';
  if (!(longOk || shortOk)) return false;
  if (!mtfVolumeOk(vol1h, vol4h)) return false;
  return true;
}
function isSuperSignal(d, htf, htf4h, vol1h, vol4h) {
  if (!isConfirmed(d, htf, htf4h, vol1h, vol4h)) return false;
  // MODO AGRESIVO: score 9→7, vol 2.5x→1.8x
  if (d.score < 7) return false;
  if (d.vol.ratio < 1.8) return false;
  return true;
}
function isEliteSignal(d, htf, htf4h, vol1h, vol4h) {
  if (!isSuperSignal(d, htf, htf4h, vol1h, vol4h)) return false;
  const isLong = d.signal.includes('long');
  const stoch = d.stochK;
  if (stoch === null) return false;
  // MODO AGRESIVO: StochK 35/65 → 45/55, distancia EMA9 1.5%→2.5%, RSI más ancho
  if (isLong && stoch > 45) return false;
  if (!isLong && stoch < 55) return false;
  if (d.pbPct > 2.5) return false;
  const rsi = d.rsi;
  if (isLong && (rsi < 35 || rsi > 72)) return false;
  if (!isLong && (rsi < 28 || rsi > 65)) return false;
  let slPct = 0;
  if (d.bb) {
    if (isLong) slPct = (d.price - d.bb.lower) / d.price * 100;
    else slPct = (d.bb.upper - d.price) / d.price * 100;
  } else slPct = 1.5;
  if (slPct > 2.5) return false;
  if (d.squeeze) return false;
  return true;
}
function isPreparing(d) {
  return d && (d.signal === 'preparing_long' || d.signal === 'preparing_short');
}

// ============================================================
// BINANCE FETCH
// ============================================================
// FIX: api.binance.com bloquea (HTTP 451) peticiones desde IPs de GitHub Actions
// (datacenters en EEUU, restringidos por Binance). data-api.binance.vision es un
// espejo público de solo-lectura de datos de mercado sin esa restricción.
const BINANCE_BASE = 'https://data-api.binance.vision';

async function klines(symbol, interval, limit) {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance error ${r.status} for ${symbol} ${interval}`);
  return r.json();
}

async function scanPair(symbol) {
  const [c15, c1h, c4h] = await Promise.all([
    klines(symbol, '15m', 150),
    klines(symbol, '1h', 100),
    klines(symbol, '4h', 50)
  ]);
  const closes15 = c15.map(c => parseFloat(c[4]));
  const htf1h = trendGeneric(c1h);
  const htf4h = trendGeneric(c4h);
  const vol1h = c1h.length >= 21 ? volSpikeCalc(c1h).ratio : 0;
  const vol4h = c4h.length >= 21 ? volSpikeCalc(c4h).ratio : 0;

  let d = evalPair(closes15, c15);
  if (!d) return null;

  const hasConfirmed4H = d.signal !== 'neutral' && htf4h === (d.signal.includes('long') ? 'bull' : 'bear');
  if (!hasConfirmed4H) {
    const ew = earlyWarning(closes15, c15, htf1h, htf4h, vol1h, vol4h);
    if (ew) d = ew;
    else d = { ...d, signal: 'neutral' };
  }

  return { symbol, d, htf1h, htf4h, vol1h, vol4h };
}

function classify(r) {
  const { d, htf1h, htf4h, vol1h, vol4h } = r;
  if (isEliteSignal(d, htf1h, htf4h, vol1h, vol4h)) return 'ELITE';
  if (isSuperSignal(d, htf1h, htf4h, vol1h, vol4h)) return 'SUPER';
  if (isPreparing(d) && htf4h === (d.signal === 'preparing_long' ? 'bull' : 'bear')) return 'PREPARING';
  return null;
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
  });
  if (!r.ok) {
    const body = await r.text();
    console.error('Error enviando a Telegram:', r.status, body);
  }
}

function fmtSignal(r, tipo) {
  const { symbol, d, vol1h, vol4h } = r;
  const dirEmoji = d.signal.includes('long') ? '🟢 LONG' : '🔴 SHORT';
  const tipoEmoji = tipo === 'ELITE' ? '👑 ELITE' : tipo === 'SUPER' ? '⭐ SUPER' : '⏳ PREPARING';
  // FIX E — denominador correcto según el tipo de señal (ver comentario arriba)
  const maxScore = tipo === 'PREPARING' ? PREP_MAX_SCORE : CONFIRMED_MAX_SCORE;
  return [
    `${tipoEmoji} · ${symbol.replace('USDT','/USDT')} · ${dirEmoji}`,
    `Score: ${d.score}/${maxScore} · Precio: ${d.price}`,
    `RSI: ${d.rsi.toFixed(1)} · StochK: ${d.stochK !== null ? d.stochK.toFixed(1) : '–'}`,
    `Vol 15M: ${d.vol.ratio.toFixed(1)}x · Vol 1H: ${(vol1h||0).toFixed(1)}x · Vol 4H: ${(vol4h||0).toFixed(1)}x`
  ].join('\n');
}

async function main() {
  const found = [];
  for (const sym of PAIRS) {
    try {
      const r = await scanPair(sym);
      if (!r) continue;
      const tipo = classify(r);
      if (tipo) found.push({ r, tipo });
    } catch (e) {
      console.error(`Error escaneando ${sym}:`, e.message);
    }
    await new Promise(res => setTimeout(res, 60)); // evitar rate limit de Binance
  }

  if (found.length === 0) {
    console.log('Sin señales ELITE/SUPER/PREPARING en este escaneo.');
    return;
  }

  // Ordenar: ELITE > SUPER > PREPARING
  const rank = t => t === 'ELITE' ? 0 : t === 'SUPER' ? 1 : 2;
  found.sort((a, b) => rank(a.tipo) - rank(b.tipo));

  const header = `📊 <b>ScalpScan Alertas</b> · ${found.length} señal${found.length !== 1 ? 'es' : ''} · ${new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })}`;
  const body = found.map(({ r, tipo }) => fmtSignal(r, tipo)).join('\n\n');
  await sendTelegram(`${header}\n\n${body}`);
  console.log(`Enviadas ${found.length} señal(es) a Telegram.`);
}

main().catch(e => {
  console.error('Error fatal:', e);
  process.exit(1);
});
