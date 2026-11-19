/**
 * RouteGuard — live weather + disruption engine.
 *
 *  • Live Open-Meteo telemetry (zero-key): one batched request for every hub in the active network,
 *    `current=temperature_2m,wind_speed_10m,precipitation,weather_code`. Results are cached in
 *    localStorage; if the network is unavailable we fall back to the cache, then to a deterministic
 *    synthetic sea state so the simulator always works offline.
 *  • Disruption model: CONGESTION (strike / berth congestion), CLOSURE (blockade, Infinity weight),
 *    STORM (circular weather cell slowing every intersecting corridor) and a global FUEL shock.
 *  • compileContext() folds weather + disruptions + fuel into per-node / per-edge modifiers that the
 *    pathfinder consumes. Modifiers only ever slow things down or add cost, which keeps A* admissible.
 */

import { haversineKm } from '../data/corridorNetwork.js';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_PREFIX = 'routeguard.meteo.';
const CACHE_TTL_MS = 30 * 60 * 1000;

/* ─────────────────────────── Beaufort + WMO helpers ─────────────────────────── */

/** Beaufort force from a 10-minute mean wind in km/h (WMO / Met Office bands). */
const BEAUFORT_UPPER_KMH = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117];
const BEAUFORT_NAMES = ['Calm', 'Light air', 'Light breeze', 'Gentle breeze', 'Moderate breeze', 'Fresh breeze', 'Strong breeze', 'Near gale', 'Gale', 'Strong gale', 'Storm', 'Violent storm', 'Hurricane force'];

export function beaufort(kmh) {
  const v = Math.max(0, kmh ?? 0);
  let f = BEAUFORT_UPPER_KMH.findIndex((u) => v <= u);
  if (f === -1) f = 12;
  return { force: f, name: BEAUFORT_NAMES[f] };
}

const WMO = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Heavy showers',
  82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Severe thunderstorm',
};
export function weatherLabel(code) {
  return WMO[code] ?? `WMO ${code}`;
}

/**
 * Converts one hub's live conditions into corridor penalties.
 * Severe = wind > 45 km/h (≈ Beaufort 6–7) or heavy precipitation / convective weather codes.
 */
export function weatherImpact(w) {
  if (!w) return { severe: false, maritime: 1, road: 1, rail: 1, reasons: [] };
  const reasons = [];
  let maritime = 1;
  let road = 1;
  let rail = 1;
  if (w.wind > 45) {
    const s = Math.min(0.4, 0.12 + (w.wind - 45) / 120);
    maritime *= 1 - s;
    road *= 1 - s * 0.35;
    reasons.push(`wind ${Math.round(w.wind)} km/h (Bft ${beaufort(w.wind).force})`);
  }
  if (w.precip >= 4 || [65, 67, 75, 82, 86].includes(w.code)) {
    road *= 0.78;
    rail *= 0.92;
    maritime *= 0.94;
    reasons.push(`heavy precipitation ${w.precip.toFixed(1)} mm`);
  }
  if (w.code >= 95) {
    maritime *= 0.85;
    road *= 0.88;
    reasons.push(weatherLabel(w.code).toLowerCase());
  }
  return { severe: reasons.length > 0, maritime, road, rail, reasons };
}

/* ─────────────────────────── Live Open-Meteo fetcher ─────────────────────────── */

function storageGet(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode, blocked) — the cache is a convenience only */
  }
}

export const FORECAST_HOURS = 168;
const CACHE_VERSION = 2;

/** Weather sample points: every hub, plus the mid-point of every sea lane (open-ocean conditions). */
export function weatherPoints(network) {
  const pts = network.nodes.map((n) => ({ kind: 'node', id: n.id, coords: n.coords }));
  for (const e of network.edges) {
    if (e.mode !== 'MARITIME') continue;
    pts.push({ kind: 'lane', id: e.id, coords: e.waypoints[Math.floor(e.waypoints.length / 2)] });
  }
  return pts;
}

/** Deterministic synthetic 7-day hourly sea state, used only when Open-Meteo and the cache are unavailable. */
function syntheticSeries(coords, hour0) {
  let seed = Math.abs(Math.round(coords[0] * 1000) * 40503 + Math.round(coords[1] * 1000) * 9973 + Math.floor(hour0 / 24) * 7919);
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const lat = Math.abs(coords[1]);
  const base = 10 + rnd() * 18 + (lat > 40 ? 10 : 0);
  const phase = rnd() * 24;
  const gale = rnd() > 0.7 ? { at: Math.floor(rnd() * FORECAST_HOURS), len: 18 + Math.floor(rnd() * 30), peak: 30 + rnd() * 35 } : null;
  const wind = [];
  const precip = [];
  const code = [];
  const temp = [];
  for (let h = 0; h < FORECAST_HOURS; h++) {
    const inGale = gale && h >= gale.at && h < gale.at + gale.len;
    const g = inGale ? Math.sin(((h - gale.at) / gale.len) * Math.PI) : 0;
    const w = base + Math.sin((h + phase) / 7) * 6 + (inGale ? gale.peak * g : 0);
    const p = inGale ? Math.max(0, 6 * g - 1) : 0;
    wind.push(Math.round(Math.max(0, w) * 10) / 10);
    precip.push(Math.round(p * 10) / 10);
    code.push(p > 4 ? 65 : p > 0.5 ? 61 : w > 60 ? 95 : 2);
    temp.push(Math.round((31 - lat * 0.55 + Math.sin(((h % 24) - 9) / 3.8) * 4) * 10) / 10);
  }
  return { wind, precip, code, temp };
}

function syntheticWeather(network) {
  const hour0 = Math.floor(Date.now() / 3600000);
  const startOfDay = hour0 - (hour0 % 24);
  const series = {};
  for (const p of weatherPoints(network)) series[`${p.kind}:${p.id}`] = syntheticSeries(p.coords, startOfDay);
  return { status: 'SYNTHETIC', fetchedAt: Date.now(), startMs: startOfDay * 3600000, baseIndex: hour0 - startOfDay, series, version: CACHE_VERSION };
}

/**
 * Fetches current conditions AND a 7-day hourly forecast for every hub and every sea-lane mid-point
 * in one batched Open-Meteo request (comma-separated coordinates, no key).
 * Resolves to { status: 'LIVE'|'CACHED'|'SYNTHETIC', fetchedAt, startMs, baseIndex,
 *   series: {'node:SHA' | 'lane:EDGE-ID': {wind[], precip[], code[], temp[]}} }
 * where series[k].wind[baseIndex] is "now". Read conditions at a sim time with weatherAt(w, simHours).
 */
export async function fetchLiveWeather(network, { timeoutMs = 12000, fetchImpl = globalThis.fetch } = {}) {
  const cacheKey = CACHE_PREFIX + network.id;
  const cached = storageGet(cacheKey);
  const cacheOk = cached && cached.version === CACHE_VERSION;
  if (cacheOk && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return { ...cached, status: 'CACHED' };

  const pts = weatherPoints(network);
  const lat = pts.map((p) => p.coords[1].toFixed(2)).join(',');
  const lng = pts.map((p) => p.coords[0].toFixed(2)).join(',');
  const vars = 'temperature_2m,wind_speed_10m,precipitation,weather_code';
  const url = `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lng}&current=${vars}&hourly=${vars}&forecast_days=7&wind_speed_unit=kmh&timezone=GMT`;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    if (!fetchImpl) throw new Error('fetch unavailable');
    const res = await fetchImpl(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const json = await res.json();
    const arr = Array.isArray(json) ? json : [json];
    const series = {};
    let startMs = null;
    let baseIndex = 0;
    pts.forEach((p, i) => {
      const r = arr[i];
      const h = r?.hourly;
      if (!h?.time?.length) return;
      if (startMs == null) {
        startMs = Date.parse(`${h.time[0]}:00Z`);
        const nowIso = (r.current?.time ?? new Date().toISOString()).slice(0, 13);
        baseIndex = Math.max(0, h.time.findIndex((t) => t.slice(0, 13) === nowIso));
      }
      const s = {
        wind: h.wind_speed_10m.map((v) => v ?? 0),
        precip: h.precipitation.map((v) => v ?? 0),
        code: h.weather_code.map((v) => v ?? 0),
        temp: h.temperature_2m.map((v) => v ?? 0),
      };
      // Splice the observed "current" reading into the base hour so T+0 matches the live observation.
      if (r.current) {
        s.wind[baseIndex] = r.current.wind_speed_10m ?? s.wind[baseIndex];
        s.precip[baseIndex] = r.current.precipitation ?? s.precip[baseIndex];
        s.code[baseIndex] = r.current.weather_code ?? s.code[baseIndex];
        s.temp[baseIndex] = r.current.temperature_2m ?? s.temp[baseIndex];
      }
      series[`${p.kind}:${p.id}`] = s;
    });
    if (!Object.keys(series).length) throw new Error('Open-Meteo returned no data');
    const result = { status: 'LIVE', fetchedAt: Date.now(), startMs, baseIndex, series, version: CACHE_VERSION };
    storageSet(cacheKey, result);
    return result;
  } catch (err) {
    if (cacheOk) return { ...cached, status: 'CACHED', error: String(err.message || err) };
    return { ...syntheticWeather(network), error: String(err.message || err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Conditions at a sim time (hours after "now"), clamped to the 7-day forecast horizon.
 * Returns { hour, lead, beyond, timeMs, byNode: {id: {wind, precip, code, temp}}, byLane: {edgeId: {...}} }.
 */
export function weatherAt(w, simHours = 0) {
  if (!w?.series) return null;
  const first = Object.values(w.series)[0];
  const len = first?.wind?.length ?? 0;
  if (!len) return null;
  // Hours elapsed since the forecast was fetched also advance the base, so a cached forecast stays honest.
  const drift = Math.max(0, Math.floor((Date.now() - w.fetchedAt) / 3600000));
  const raw = w.baseIndex + drift + Math.floor(Math.max(0, simHours));
  const idx = Math.min(len - 1, raw);
  const byNode = {};
  const byLane = {};
  for (const [k, s] of Object.entries(w.series)) {
    const v = { wind: s.wind[idx], precip: s.precip[idx], code: s.code[idx], temp: s.temp[idx] };
    if (k.startsWith('node:')) byNode[k.slice(5)] = v;
    else byLane[k.slice(5)] = v;
  }
  return { hour: idx, lead: idx - w.baseIndex - drift, beyond: raw > len - 1, timeMs: (w.startMs ?? Date.now()) + idx * 3600000, byNode, byLane };
}

/* ─────────────────────────── Disruption model ─────────────────────────── */

export const DISRUPTION_KINDS = {
  CONGESTION: { label: 'Port congestion / strike', cls: '1', glyph: 'strike' },
  CLOSURE: { label: 'Closure / blockade', cls: '2', glyph: 'closure' },
  STORM: { label: 'Severe weather cell', cls: '3', glyph: 'storm' },
  FUEL: { label: 'Fuel price shock', cls: '4', glyph: 'fuel' },
};

let uid = 0;
export function newId(prefix = 'dz') {
  uid = (uid + 1) % 1e6;
  return `${prefix}${Date.now().toString(36).slice(-4)}${uid.toString(36)}`;
}

export function makeCongestion(nodeId, { delayHours = 72, surchargeUsd = 280, label, durationH = null, source = 'user', startedAt = 0 } = {}) {
  return { id: newId(), kind: 'CONGESTION', nodeId, delayHours, surchargeUsd, label: label ?? 'Berth congestion', durationH, source, startedAt };
}
export function makeClosure({ nodeId = null, edgeId = null, label, durationH = null, source = 'user', startedAt = 0 } = {}) {
  return { id: newId(), kind: 'CLOSURE', nodeId, edgeId, label: label ?? 'Corridor closed', durationH, source, startedAt };
}
export function makeStorm(center, radiusKm = 600, { severity = 0.55, label, durationH = null, source = 'user', startedAt = 0, drift = null } = {}) {
  return { id: newId(), kind: 'STORM', center: [...center], radiusKm, severity, label: label ?? 'Severe weather cell', durationH, source, startedAt, drift };
}

/** Fraction of an edge's length inside a circle (sampled every ≤ 40 km). */
export function edgeFractionInCircle(edge, center, radiusKm) {
  let inside = 0;
  let total = 0;
  const pts = edge.waypoints;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    let b = pts[i];
    // unwrap across the antimeridian for sampling
    if (Math.abs(b[0] - a[0]) > 180) b = [b[0] + (b[0] < a[0] ? 360 : -360), b[1]];
    const segKm = haversineKm(a, b);
    const n = Math.max(1, Math.ceil(segKm / 40));
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      let lng = a[0] + (b[0] - a[0]) * t;
      if (lng > 180) lng -= 360;
      if (lng < -180) lng += 360;
      const p = [lng, a[1] + (b[1] - a[1]) * t];
      const piece = segKm / n;
      total += piece;
      if (haversineKm(p, center) <= radiusKm) inside += piece;
    }
  }
  return total ? inside / total : 0;
}

/** Mode sensitivity to a storm cell (fractional slow-down at full severity). */
const STORM_SENSITIVITY = { MARITIME: 1, ROAD: 0.6, RAIL: 0.25 };

/** Fuel share of line-haul cost; fast mainline shipping and trucking are hit hardest. */
export function fuelShare(edge) {
  if (edge.mode === 'ROAD') return 0.42;
  if (edge.mode === 'MARITIME') return edge.baseSpeedKmh >= 30 ? 0.38 : 0.26;
  return 0.14;
}

/**
 * Folds disruptions + live weather + fuel shock into pathfinder modifiers.
 * @returns ctx { nodeMods, edgeMods, fuelMultiplier(edge), minFuelMultiplier, fuelShockPct, edgePenalty:null, weatherHits }
 */
export function compileContext(network, { disruptions = [], fuelShockPct = 0, weather = null, useWeather = true, excludedModes = [] } = {}) {
  const nodeMods = new Map();
  const edgeMods = new Map();
  const nodeMod = (id) => {
    if (!nodeMods.has(id)) nodeMods.set(id, { closed: false, delayHours: 0, surchargeUsd: 0, alerts: [] });
    return nodeMods.get(id);
  };
  const edgeMod = (id) => {
    if (!edgeMods.has(id)) edgeMods.set(id, { closed: false, speedFactor: 1, co2Factor: 1, delayHours: 0, surchargeUsd: 0, alerts: [] });
    return edgeMods.get(id);
  };
  const edgeById = new Map(network.edges.map((e) => [e.id, e]));
  const nodeById = new Map(network.nodes.map((n) => [n.id, n]));

  for (const d of disruptions) {
    if (d.kind === 'CONGESTION' && nodeById.has(d.nodeId)) {
      const m = nodeMod(d.nodeId);
      m.delayHours += d.delayHours;
      m.surchargeUsd += d.surchargeUsd;
      m.alerts.push({ kind: 'CONGESTION', text: `${d.label}: +${d.delayHours} h, +$${d.surchargeUsd}/TEU`, id: d.id });
    } else if (d.kind === 'CLOSURE') {
      if (d.nodeId && nodeById.has(d.nodeId)) {
        const m = nodeMod(d.nodeId);
        m.closed = true;
        m.alerts.push({ kind: 'CLOSURE', text: `${d.label}: impassable`, id: d.id });
      }
      if (d.edgeId && edgeById.has(d.edgeId)) {
        const m = edgeMod(d.edgeId);
        m.closed = true;
        m.alerts.push({ kind: 'CLOSURE', text: `${d.label}: impassable`, id: d.id });
      }
    } else if (d.kind === 'STORM') {
      for (const e of network.edges) {
        const f = edgeFractionInCircle(e, d.center, d.radiusKm);
        if (f <= 0) continue;
        const s = Math.min(0.85, d.severity * STORM_SENSITIVITY[e.mode]);
        if (s <= 0) continue;
        const factor = 1 / (1 - f + f / (1 - s));
        const m = edgeMod(e.id);
        m.speedFactor *= factor;
        m.co2Factor *= 1 + f * s * 0.6;
        m.alerts.push({ kind: 'STORM', text: `${d.label}: ${Math.round(f * 100)}% of leg inside cell, −${Math.round((1 - factor) * 100)}% speed`, id: d.id });
      }
    }
  }

  const weatherHits = [];
  if (useWeather && weather?.byLane) {
    for (const e of network.edges) {
      const lw = weather.byLane[e.id];
      if (!lw) continue;
      const imp = weatherImpact(lw);
      if (!imp.severe) continue;
      // Open-sea conditions act on the middle three-fifths of the passage.
      const factor = 1 / (0.4 + 0.6 / imp.maritime);
      if (factor >= 0.999) continue;
      const m = edgeMod(e.id);
      m.speedFactor *= factor;
      m.co2Factor *= 1 + (1 - factor) * 0.5;
      m.alerts.push({ kind: 'WEATHER', text: `Open-sea forecast: ${imp.reasons.join('; ')}`, id: `wxl-${e.id}` });
      weatherHits.push(e.id);
    }
  }
  if (useWeather && weather?.byNode) {
    for (const e of network.edges) {
      const ia = weatherImpact(weather.byNode[e.from]);
      const ib = weatherImpact(weather.byNode[e.to]);
      if (!ia.severe && !ib.severe) continue;
      const key = e.mode === 'MARITIME' ? 'maritime' : e.mode === 'ROAD' ? 'road' : 'rail';
      // Conditions at a terminal affect roughly the first / last fifth of the leg.
      const fa = ia.severe ? ia[key] : 1;
      const fb = ib.severe ? ib[key] : 1;
      const factor = 1 / (0.6 + 0.2 / fa + 0.2 / fb);
      if (factor >= 0.999) continue;
      const m = edgeMod(e.id);
      m.speedFactor *= factor;
      m.co2Factor *= 1 + (1 - factor) * 0.5;
      const reasons = [...(ia.severe ? ia.reasons.map((r) => `${nodeById.get(e.from).code} ${r}`) : []), ...(ib.severe ? ib.reasons.map((r) => `${nodeById.get(e.to).code} ${r}`) : [])];
      m.alerts.push({ kind: 'WEATHER', text: `Live meteo: ${reasons.join('; ')}`, id: `wx-${e.id}` });
      weatherHits.push(e.id);
    }
  }

  const shock = Math.max(-0.2, Math.min(1, fuelShockPct / 100));
  const fuelMultiplier = (edge) => 1 + shock * fuelShare(edge);
  const minFuelMultiplier = Math.min(...network.edges.map(fuelMultiplier));
  return { nodeMods, edgeMods, fuelShockPct: shock * 100, fuelMultiplier, minFuelMultiplier, edgePenalty: null, weatherHits, excludedModes: new Set(excludedModes) };
}

/* ─────────────────────────── One-click crisis presets ─────────────────────────── */

export const CRISIS_PRESETS = [
  {
    id: 'suez',
    key: '1',
    title: 'Suez Canal Blockage',
    short: 'Suez blocked',
    cls: '2',
    network: 'GLOBAL',
    origin: 'SHA',
    destination: 'RTM',
    blurb: 'A grounded ultra-large container ship closes the canal. Asia–Europe services must choose: Cape of Good Hope or the China–Europe rail land bridge.',
    build: () => ({
      disruptions: [makeClosure({ nodeId: 'SUZ', label: 'Suez Canal blocked (grounding)', source: 'preset', durationH: 144 })],
      fuelShockPct: 0,
    }),
  },
  {
    id: 'cyclone',
    key: '2',
    title: 'Indian Ocean Cyclone',
    short: 'Cyclone',
    cls: '3',
    network: 'GLOBAL',
    origin: 'SIN',
    destination: 'RTM',
    blurb: 'A severe cyclonic storm over the Arabian Sea slows every lane between Colombo, Salalah and the Gulf of Aden.',
    build: () => ({
      disruptions: [makeStorm([63.5, 12.5], 950, { severity: 0.7, label: 'Cyclone (Arabian Sea)', source: 'preset', durationH: 120, drift: [-0.06, 0.035] })],
      fuelShockPct: 0,
    }),
  },
  {
    id: 'mombasa',
    key: '3',
    title: 'Mombasa Port Berth Strike',
    short: 'Mombasa strike',
    cls: '1',
    network: 'EAFRICA',
    origin: 'IOA',
    destination: 'KLA',
    blurb: 'Dock workers down tools at Mombasa. Uganda-bound boxes can divert via Dar es Salaam, the Central Line and the Lake Victoria wagon ferry.',
    build: () => ({
      disruptions: [makeCongestion('MBA', { delayHours: 120, surchargeUsd: 420, label: 'Mombasa berth strike', source: 'preset', durationH: 168 })],
      fuelShockPct: 0,
    }),
  },
  {
    id: 'diesel',
    key: '4',
    title: 'Diesel +60% Fuel Shock',
    short: 'Diesel +60%',
    cls: '4',
    network: 'EAFRICA',
    origin: 'MBA',
    destination: 'DOD',
    blurb: 'Diesel jumps 60%. Trucking via Tanga loses its edge: Mombasa–Dodoma boxes shift to a coastal feeder and the Tanzania SGR.',
    build: () => ({ disruptions: [], fuelShockPct: 60 }),
  },
];

/* ─────────────────────────── Chaos generator (sandbox) ─────────────────────────── */

/** Draws a plausible random disruption for the sandbox's chaos mode. Probability ∝ congestionRisk. */
export function randomDisruption(network, simHours, rng = Math.random) {
  const roll = rng();
  if (roll < 0.45) {
    const pool = network.nodes.filter((n) => n.type !== 'CHOKEPOINT' || n.congestionRisk > 0.3);
    const weights = pool.map((n) => n.congestionRisk);
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = rng() * sum;
    const n = pool.find((_, i) => (r -= weights[i]) <= 0) ?? pool[0];
    const delay = Math.round(24 + rng() * 72);
    return makeCongestion(n.id, { delayHours: delay, surchargeUsd: Math.round(120 + delay * 2.2), label: `${n.name} ${rng() > 0.5 ? 'yard congestion' : 'labour action'}`, durationH: Math.round(48 + rng() * 120), source: 'chaos', startedAt: simHours });
  }
  if (roll < 0.85) {
    const sea = network.edges.filter((e) => e.mode === 'MARITIME');
    const e = sea[Math.floor(rng() * sea.length)];
    const p = e.waypoints[Math.floor(e.waypoints.length / 2)];
    const big = network.id === 'GLOBAL';
    return makeStorm(p, big ? 350 + rng() * 550 : 60 + rng() * 120, { severity: 0.35 + rng() * 0.4, label: big ? 'Tropical depression' : 'Squall line', durationH: Math.round(36 + rng() * 72), source: 'chaos', startedAt: simHours, drift: [(rng() - 0.5) * 0.08, (rng() - 0.5) * 0.05] });
  }
  const chokes = network.nodes.filter((n) => n.type === 'CHOKEPOINT' && n.baseDwellHours > 0);
  const n = chokes[Math.floor(rng() * chokes.length)] ?? network.nodes[0];
  return makeClosure({ nodeId: n.id, label: `${n.name} temporarily closed`, durationH: Math.round(24 + rng() * 48), source: 'chaos', startedAt: simHours });
}

/** Human description of where a disruption sits. */
export function describeTarget(d, network) {
  const nodeName = (id) => network.nodes.find((n) => n.id === id)?.name ?? id;
  if (d.kind === 'CONGESTION') return nodeName(d.nodeId);
  if (d.kind === 'CLOSURE') return d.nodeId ? nodeName(d.nodeId) : network.edges.find((e) => e.id === d.edgeId)?.label ?? d.edgeId;
  if (d.kind === 'STORM') return `${Math.abs(d.center[1]).toFixed(1)}°${d.center[1] >= 0 ? 'N' : 'S'} ${Math.abs(d.center[0]).toFixed(1)}°${d.center[0] >= 0 ? 'E' : 'W'} · r ${Math.round(d.radiusKm)} km`;
  return '';
}
