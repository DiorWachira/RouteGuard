/**
 * RouteGuard — application shell: state, recalculation pipeline, sandbox loop, map interaction,
 * URL-hash scenario sharing, manifest export, keyboard map, pilot guide and help drawer.
 */

import { NETWORKS, getNetwork, MODE_LABEL, NODE_TYPE_LABEL } from './data/corridorNetwork.js';
import { buildGraph, solveScenario, normaliseWeights, neutralContext } from './engine/pathfinder.js';
import {
  fetchLiveWeather, compileContext, CRISIS_PRESETS, DISRUPTION_KINDS, makeCongestion, makeClosure, makeStorm,
  describeTarget, beaufort, weatherLabel, weatherImpact,
} from './engine/disruptionEngine.js';
import { Sandbox, SPEEDS, fmtSimClock, fmtDuration } from './engine/simulation.js';
import { makeCode } from './engine/iso6346.js';
import { MapRenderer, placardSvg, MAP_THEMES } from './map/mapRenderer.js';
import { ParetoChart, legStrip } from './ui/telemetryCharts.js';
import { fmtTransit, fmtUsd, fmtCo2, fmtKm, fmtHoursShort, signed, escapeHtml, MODE_SHORT, countUp } from './ui/format.js';
import { Pilot, pilotSteps, FLAG_H } from './ui/pilot.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const PALETTES = ['day', 'dusk', 'night'];

/* ─────────────────────────────── State ─────────────────────────────── */

const state = {
  networkId: 'GLOBAL',
  origin: 'SHA',
  destination: 'RTM',
  weights: { time: 40, cost: 35, co2: 25 },
  fuelShockPct: 0,
  disruptions: [],
  useWeather: true,
  weather: null,
  palette: document.documentElement.getAttribute('data-palette') || 'night',
  tool: 'select',
  stormRadius: 600,
  selectedSig: null,
  hoverRoute: null,
  hover: null,
  hoverEdgeId: null,
  graph: null,
  ctx: neutralContext(),
  ctxVersion: 0,
  solution: null,
  plotStartedAt: 0,
  noticeNo: 1,
};

const sandbox = new Sandbox();
let renderer = null;
let pareto = null;
let pilot = null;
let lastPanelsAt = 0;
let lastDriftRecalc = 0;
let lastFrame = performance.now();
let lastSandboxVersion = -1;

/* ─────────────────────────────── Hash state ─────────────────────────────── */

function b64urlEncode(obj) {
  const s = unescape(encodeURIComponent(JSON.stringify(obj)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(s + '==='.slice((s.length + 3) % 4)))));
}

function encodeDisruption(d) {
  const o = { k: d.kind[0] + d.kind[1], l: d.label };
  if (d.nodeId) o.n = d.nodeId;
  if (d.edgeId) o.e = d.edgeId;
  if (d.kind === 'CONGESTION') Object.assign(o, { h: d.delayHours, s: d.surchargeUsd });
  if (d.kind === 'STORM') Object.assign(o, { c: d.center.map((v) => +v.toFixed(2)), r: Math.round(d.radiusKm), v: +d.severity.toFixed(2) });
  if (d.durationH != null) o.u = Math.round(d.durationH);
  return o;
}
function decodeDisruption(o) {
  const base = { label: o.l, durationH: o.u ?? null, source: 'link', startedAt: 0 };
  if (o.k === 'CO') return makeCongestion(o.n, { ...base, delayHours: o.h ?? 72, surchargeUsd: o.s ?? 250 });
  if (o.k === 'CL') return makeClosure({ ...base, nodeId: o.n ?? null, edgeId: o.e ?? null });
  if (o.k === 'ST') return makeStorm(o.c, o.r ?? 500, { ...base, severity: o.v ?? 0.55 });
  return null;
}

function writeHash() {
  const w = state.weights;
  const parts = [
    'v=1',
    `n=${state.networkId}`,
    `o=${state.origin}`,
    `d=${state.destination}`,
    `w=${Math.round(w.time)}.${Math.round(w.cost)}.${Math.round(w.co2)}`,
    `f=${state.fuelShockPct}`,
    `wx=${state.useWeather ? 1 : 0}`,
  ];
  if (state.disruptions.length) parts.push(`h=${b64urlEncode(state.disruptions.map(encodeDisruption))}`);
  const hash = `#${parts.join('&')}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function readHash() {
  if (!location.hash || location.hash.length < 3) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  try {
    const n = p.get('n');
    if (n && NETWORKS[n]) state.networkId = n;
    const net = getNetwork(state.networkId);
    const ids = new Set(net.nodes.map((x) => x.id));
    state.origin = ids.has(p.get('o')) ? p.get('o') : net.defaultOrigin;
    state.destination = ids.has(p.get('d')) ? p.get('d') : net.defaultDestination;
    if (state.origin === state.destination) state.destination = net.defaultDestination;
    const w = (p.get('w') || '').split('.').map(Number);
    if (w.length === 3 && w.every((x) => isFinite(x) && x >= 0 && x <= 100)) state.weights = { time: w[0], cost: w[1], co2: w[2] };
    const f = Number(p.get('f'));
    if (isFinite(f)) state.fuelShockPct = Math.max(-20, Math.min(100, f));
    state.useWeather = p.get('wx') !== '0';
    state.disruptions = p.get('h') ? b64urlDecode(p.get('h')).map(decodeDisruption).filter(Boolean) : [];
    return true;
  } catch (err) {
    toast('Scenario link unreadable', 'The link’s hazard list could not be decoded, so a clean chart was loaded instead.', 'CLOSURE');
    return false;
  }
}

/* ─────────────────────────────── Toasts & announcer ─────────────────────────────── */

function announce(msg) {
  const a = $('#announcer');
  a.textContent = '';
  setTimeout(() => (a.textContent = msg), 30);
}

function placardHtml(kind, size = 26) {
  const css = getComputedStyle(document.body);
  const fill = css.getPropertyValue('--hazard').trim() || '#f26e40';
  const ink = css.getPropertyValue('--hazard-ink').trim() || '#120804';
  return `<span class="placard" aria-hidden="true" style="width:${size}px;height:${size}px">${placardSvg(kind, { fill, ink, size })}</span>`;
}

function toast(title, body, kind = null, { ms = 5200 } = {}) {
  const no = String(state.noticeNo++).padStart(4, '0');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${kind ? placardHtml(kind, 30) : '<span class="toast-ntm mono">NtM</span>'}<div><div class="toast-no mono">Notice to Mariners · No. ${no}</div><div class="toast-title">${escapeHtml(title)}</div>${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ''}</div><button type="button" class="icon-btn" aria-label="Dismiss notice">✕</button>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  const stack = $('#toasts');
  stack.prepend(el);
  while (stack.children.length > 3) stack.lastElementChild.remove();
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/* ─────────────────────────────── Recalculation pipeline ─────────────────────────────── */

function network() {
  return getNetwork(state.networkId);
}

function recompute({ fit = false, reason = null, quiet = false } = {}) {
  const net = network();
  if (!state.graph || state.graph.id !== net.id) state.graph = buildGraph(net);
  const prevSel = selectedRoute();
  state.ctx = compileContext(net, { disruptions: state.disruptions, fuelShockPct: state.fuelShockPct, weather: state.weather, useWeather: state.useWeather });
  state.ctxVersion++;
  const baselineCtx = compileContext(net, { disruptions: [], fuelShockPct: 0, weather: null, useWeather: false });
  state.solution = solveScenario(state.graph, state.origin, state.destination, state.weights, state.ctx, { baselineCtx });

  if (state.selectedSig && !state.solution.candidates.some((r) => r.signature === state.selectedSig)) {
    state.selectedSig = null;
    if (!quiet) toast('Plotted track withdrawn', 'The track you chose is no longer passable, so the optimal track is plotted again.', 'CLOSURE');
  }
  const sel = selectedRoute();
  if (sel && sel.signature !== prevSel?.signature) state.plotStartedAt = performance.now();

  sandbox.onContextChanged(state.graph, state.ctx, state.weights);
  renderPanels();
  renderHazards();
  writeHash();
  if (fit && sel && renderer) renderer.fitRoute(sel.path, 70);
  if (reason) announce(reason);
  return state.solution;
}

function selectedRoute() {
  const s = state.solution;
  if (!s) return null;
  if (state.selectedSig) return s.candidates.find((r) => r.signature === state.selectedSig) ?? s.optimal;
  return s.optimal;
}

function isDisrupted() {
  return state.disruptions.length > 0 || state.fuelShockPct !== 0 || (state.useWeather && state.ctx.weatherHits?.length > 0);
}

/* ─────────────────────────────── Panels ─────────────────────────────── */

function nodeName(id) {
  return state.graph?.nodes.get(id)?.name ?? id;
}

function renderPanels() {
  const sol = state.solution;
  const sel = selectedRoute();
  $('#solve-time').textContent = sol ? `${sol.candidates.length} routes · ${sol.computeMs.toFixed(1)} ms` : '—';

  // KPIs
  const base = sol?.baseline;
  const kTime = $('#k-time');
  const kCost = $('#k-cost');
  const kCo2 = $('#k-co2');
  if (sel) {
    countUp(kTime, sel.totals.hours, fmtTransit);
    countUp(kCost, sel.totals.cost, (v) => fmtUsd(v));
    countUp(kCo2, sel.totals.co2 / 1000, (v) => v.toFixed(2));
    const dT = base ? sel.totals.hours - base.totals.hours : null;
    const dC = base ? sel.totals.cost - base.totals.cost : null;
    const dE = base ? sel.totals.co2 - base.totals.co2 : null;
    setDelta('#d-time', dT, (v) => fmtHoursShort(v), 1);
    setDelta('#d-cost', dC, (v) => fmtUsd(v), 5);
    setDelta('#d-co2', dE, (v) => `${(v / 1000).toFixed(2)} t`, 5);
  } else {
    for (const el of [kTime, kCost, kCo2]) {
      el.textContent = '—';
      el.dataset.value = '';
    }
    for (const id of ['#d-time', '#d-cost', '#d-co2']) $(id).textContent = '';
  }
  $('#k-verdict').innerHTML = verdictHtml(sel);
  $('#kpis').classList.toggle('is-blocked', !sel);

  // Pareto
  pareto?.setData(sol?.candidates ?? [], sel, isDisrupted() ? base : null);
  $('#fig-caption').textContent = figCaption(sol, sel);
  $('#pareto-table').innerHTML = paretoTable(sol, sel);

  // Candidates
  const list = $('#cands');
  if (!sol || !sol.candidates.length) {
    list.innerHTML = `<li class="empty"><b>No passable route.</b> Every corridor into ${escapeHtml(nodeName(state.destination))} is closed. Remove a hazard in §3 or choose another destination.</li>`;
  } else {
    list.innerHTML = sol.candidates
      .slice(0, 7)
      .map((r, i) => {
        const tags = [...r.tags].filter((t) => t !== 'sweep');
        const isSel = r === sel;
        return `<li><button type="button" class="cand${isSel ? ' is-sel' : ''}" data-sig="${escapeHtml(r.signature)}" aria-pressed="${isSel}">
          <span class="cand-rank mono">${String(i + 1).padStart(2, '0')}</span>
          <span class="cand-main">
            <span class="cand-tags">${tags.map((t) => `<span class="tag tag--${t}">${t}</span>`).join('')}${r.efficient ? '<span class="tag tag--pareto">pareto</span>' : ''}</span>
            <span class="cand-via mono">${r.nodes.map(escapeHtml).join(' › ')}</span>
            ${legStrip(r, { height: 6 })}
          </span>
          <span class="cand-nums mono"><b>${fmtTransit(r.totals.hours)}</b><span>${fmtUsd(r.totals.cost)}</span><span>${fmtCo2(r.totals.co2)}</span></span>
        </button></li>`;
      })
      .join('');
  }

  // Legs
  if (!sel) {
    $('#leg-strip').innerHTML = '';
    $('#leg-list').innerHTML = '<li class="empty">No track plotted.</li>';
  } else {
    $('#leg-strip').innerHTML = legStrip(sel, { height: 14, showLabels: true });
    $('#leg-list').innerHTML = sel.legs
      .map((l, i) => {
        const b = l.breakdown;
        const alerts = l.alerts.map((a) => `<li class="alert alert--${a.kind.toLowerCase()}">${a.kind === 'WEATHER' ? '<span class="mono">WX</span>' : placardHtml(a.kind === 'CLOSURE' ? 'CLOSURE' : a.kind, 16)}<span>${escapeHtml(a.where ? `${a.where}: ${a.text}` : a.text)}</span></li>`).join('');
        return `<li class="leg">
          <span class="leg-wp mono">WP${String(i).padStart(2, '0')}</span>
          <div class="leg-main">
            <div class="leg-head"><span class="mode mode--${l.mode.toLowerCase()} mono">${MODE_SHORT[l.mode]}</span><b>${escapeHtml(nodeName(l.from))}</b><span class="arrow">→</span><b>${escapeHtml(nodeName(l.to))}</b></div>
            <div class="leg-sub">${escapeHtml(l.label)}${b.callKind === 'transfer' ? ' · <span class="mono">modal transfer</span>' : b.callKind === 'chokepoint' ? ' · <span class="mono">transit queue</span>' : ''}</div>
            <dl class="leg-nums mono">
              <div><dt>Dist</dt><dd>${fmtKm(l.distanceKm)}</dd></div>
              <div><dt>Run</dt><dd>${fmtHoursShort(b.travelH)}</dd></div>
              <div><dt>Call</dt><dd>${fmtHoursShort(b.departH + b.arriveH)}</dd></div>
              <div><dt>Cost</dt><dd>${fmtUsd(l.cost)}</dd></div>
              <div><dt>CO₂e</dt><dd>${fmtCo2(l.co2)}</dd></div>
            </dl>
            ${alerts ? `<ul class="alerts">${alerts}</ul>` : ''}
          </div>
        </li>`;
      })
      .join('');
  }
}

function setDelta(sel, v, fmt, threshold) {
  const el = $(sel);
  if (v == null || !isDisrupted()) {
    el.textContent = 'calm sea';
    el.className = 'kpi-delta mono is-calm';
    return;
  }
  el.textContent = Math.abs(v) < threshold ? '±0 vs calm' : `${signed(v, fmt)} vs calm`;
  el.className = `kpi-delta mono ${v > threshold ? 'is-worse' : v < -threshold ? 'is-better' : ''}`;
}

function verdictHtml(sel) {
  const sol = state.solution;
  if (!sel) return `<span class="v-bad">No passage</span><small>all corridors to ${escapeHtml(state.destination)} are blocked</small>`;
  if (!isDisrupted()) return '<span class="v-ok">Calm sea</span><small>no hazards on the chart</small>';
  const base = sol.baseline;
  const now = sol.baselineNow;
  const dT = base ? sel.totals.hours - base.totals.hours : 0;
  const dC = base ? sel.totals.cost - base.totals.cost : 0;
  const head = `${signed(dT, fmtHoursShort)} | ${signed(dC, (v) => fmtUsd(v))}/TEU`;
  if (!now) {
    const blocked = base?.legs.find((l) => state.ctx.nodeMods.get(l.to)?.closed || state.ctx.edgeMods.get(l.edgeId)?.closed);
    return `<span class="v-warn">${head}</span><small>Avoided blocked ${escapeHtml(blocked ? state.graph.nodes.get(blocked.to).name : 'corridor')}</small>`;
  }
  const trap = now.totals.hours - sel.totals.hours;
  if (now.signature !== sel.signature && trap > 1) return `<span class="v-warn">${head}</span><small>Avoided ${fmtHoursShort(trap)} trap on the old track</small>`;
  return `<span class="v-warn">${head}</span><small>${now.signature === sel.signature ? 'Old track still best; absorbing the delay' : 'Re-plotted around hazards'}</small>`;
}

function figCaption(sol, sel) {
  if (!sol?.candidates.length) return 'No candidate routes: the destination is unreachable under current hazards.';
  const eff = sol.candidates.filter((r) => r.efficient).length;
  const f = sol.fastest;
  const c = sol.cheapest;
  const g = sol.greenest;
  let txt = `${sol.candidates.length} candidates, ${eff} Pareto-efficient. Fastest ${fmtTransit(f.totals.hours)} (F), cheapest ${fmtUsd(c.totals.cost)} (\$), greenest ${fmtCo2(g.totals.co2)} (G).`;
  if (f !== c) {
    const premium = (f.totals.cost - c.totals.cost) / Math.max(1, c.totals.hours - f.totals.hours);
    if (isFinite(premium) && premium > 0) txt += ` Buying speed costs ${fmtUsd(premium * 24)}/TEU per day saved.`;
  }
  return txt;
}

function paretoTable(sol, sel) {
  if (!sol?.candidates.length) return '<p class="hint">No candidates.</p>';
  return `<table><thead><tr><th>Route</th><th>Transit</th><th>$/TEU</th><th>CO₂e</th><th>Pareto</th></tr></thead><tbody>${sol.candidates
    .map((r) => `<tr${r === sel ? ' class="is-sel"' : ''}><td>${[...r.tags].filter((t) => t !== 'sweep').join(', ') || 'sweep'}<br><span class="mono">${r.nodes.join('›')}</span></td><td>${fmtTransit(r.totals.hours)}</td><td>${fmtUsd(r.totals.cost)}</td><td>${fmtCo2(r.totals.co2)}</td><td>${r.efficient ? 'yes' : '—'}</td></tr>`)
    .join('')}</tbody></table>`;
}

function renderHazards() {
  const net = network();
  const list = $('#hazard-list');
  $('#hazard-count').textContent = String(state.disruptions.length + (state.fuelShockPct ? 1 : 0));
  const items = state.disruptions.map((d) => {
    const left = d.durationH != null ? d.startedAt + d.durationH - sandbox.simHours : null;
    const meta = d.kind === 'CONGESTION' ? `+${d.delayHours} h · +$${d.surchargeUsd}/TEU` : d.kind === 'STORM' ? `severity ${Math.round(d.severity * 100)}%` : 'impassable';
    return `<li class="hazard">
      ${placardHtml(d.kind, 28)}
      <div class="hz-main"><b>${escapeHtml(d.label)}</b><span class="mono">${escapeHtml(describeTarget(d, net))} · ${meta}</span>
      <span class="mono hz-time">${left != null ? `clears in ${fmtDuration(Math.max(0, left))}` : 'until removed'} · ${d.source}</span></div>
      <button type="button" class="icon-btn" data-remove="${d.id}" aria-label="Remove hazard: ${escapeHtml(d.label)}">✕</button>
    </li>`;
  });
  if (state.fuelShockPct) items.push(`<li class="hazard">${placardHtml('FUEL', 28)}<div class="hz-main"><b>Fuel price shock ${signed(state.fuelShockPct, (v) => `${v}%`)}</b><span class="mono">road ×${(1 + state.fuelShockPct / 100 * 0.42).toFixed(2)} · fast sea ×${(1 + state.fuelShockPct / 100 * 0.38).toFixed(2)} · rail ×${(1 + state.fuelShockPct / 100 * 0.14).toFixed(2)}</span></div><button type="button" class="icon-btn" data-remove="fuel" aria-label="Reset fuel shock">✕</button></li>`);
  list.innerHTML = items.length ? items.join('') : '<li class="empty">Clear sea. Use a crisis drill, a chart tool, or click a hub to inject trouble.</li>';
}

/* ─────────────────────────────── Sandbox panels ─────────────────────────────── */

function renderSandboxPanels(force = false) {
  $('#sim-clock').textContent = fmtSimClock(sandbox.simHours);
  if (!force && sandbox.version === lastSandboxVersion && performance.now() - lastPanelsAt < 400) return;
  lastPanelsAt = performance.now();
  lastSandboxVersion = sandbox.version;
  const ships = sandbox.shipments.filter((s) => s.phase !== 'done' || sandbox.simHours - s.deliveredAt < 72);
  $('#convoy-count').textContent = String(sandbox.active.length);
  const list = $('#convoy-list');
  if (!ships.length) list.innerHTML = '<li class="empty">No convoys at sea. Press <b>Dispatch convoy</b> or <kbd>D</kbd> to launch one on the plotted track.</li>';
  else {
    list.innerHTML = ships
      .slice(0, 8)
      .map((s) => {
        const late = s.eta - s.plannedEta;
        const prog = sandbox.progress(s);
        const leg = s.legs[Math.min(s.legIdx, s.legs.length - 1)];
        const where = s.phase === 'done' ? `delivered ${s.dest}` : s.phase === 'underway' ? `${MODE_SHORT[leg.mode]} ${leg.from}→${leg.to}` : s.phase === 'depart' ? `at ${leg.from}` : `discharging ${s.dest}`;
        return `<li><button type="button" class="convoy" data-convoy="${s.id}">
          <span class="plate" aria-label="Container ${s.code.compact}"><span class="plate-owner">${s.code.owner}</span><span class="plate-serial">${s.code.serial}</span><span class="plate-check">${s.code.check}</span></span>
          <span class="convoy-mid"><span class="status status--${s.status.toLowerCase()} mono">${s.status.replace('_', ' ')}</span><span class="mono convoy-where">${escapeHtml(where)}</span>
          <span class="convoy-bar"><i style="width:${(prog * 100).toFixed(1)}%"></i></span></span>
          <span class="convoy-eta mono">${s.phase === 'done' ? fmtSimClock(s.deliveredAt) : `ETA ${fmtSimClock(s.eta)}`}<small>${Math.abs(late) > 1 ? signed(late, fmtHoursShort) : 'on plan'}${s.reroutes ? ` · ${s.reroutes}× rerouted` : ''}</small></span>
        </button></li>`;
      })
      .join('');
  }
  const log = $('#deck-log');
  log.innerHTML = sandbox.log.length
    ? sandbox.log.slice(0, 40).map((e) => `<li class="log log--${e.kind}"><span class="mono log-t">${fmtSimClock(e.t)}</span><span>${escapeHtml(e.text)}</span></li>`).join('')
    : '<li class="empty">The log opens when the first convoy sails.</li>';
  renderHazards();
}

function setRunning(on) {
  sandbox.running = on;
  const b = $('#play');
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('is-on', on);
  $('.play-txt', b).textContent = on ? 'Pause' : 'Run';
  $('#console').classList.toggle('is-running', on);
}

function dispatchConvoy({ quiet = false } = {}) {
  const r = selectedRoute();
  if (!r) {
    toast('Cannot sail', 'No passable route is plotted.', 'CLOSURE');
    return null;
  }
  const s = sandbox.dispatch(r, state.graph);
  if (!quiet) announce(`Convoy ${s.code.compact} dispatched`);
  renderSandboxPanels(true);
  return s;
}

/* ─────────────────────────────── Disruption actions ─────────────────────────────── */

function addDisruption(d, { notice = true } = {}) {
  d.startedAt = sandbox.simHours;
  state.disruptions.push(d);
  sandbox.note('hazard', `Hazard: ${d.label} (${describeTarget(d, network())})`);
  const before = selectedRoute()?.signature;
  recompute({ reason: `${d.label} added` });
  const after = selectedRoute();
  if (notice) {
    const changed = before && after && before !== after.signature;
    toast(d.label, after ? (changed ? `Track re-plotted via ${after.nodes.slice(1, -1).join(' · ') || 'direct'} — ${fmtTransit(after.totals.hours)}, ${fmtUsd(after.totals.cost)}/TEU.` : `Plotted track holds; transit now ${fmtTransit(after.totals.hours)}.`) : 'No passable route remains.', d.kind);
  }
  renderSandboxPanels(true);
}

function removeDisruption(id) {
  if (id === 'fuel') {
    state.fuelShockPct = 0;
    $('#fuel').value = '0';
    updateFuelOut();
  } else {
    const d = state.disruptions.find((x) => x.id === id);
    state.disruptions = state.disruptions.filter((x) => x.id !== id);
    if (d) sandbox.note('clear', `Cleared: ${d.label}`);
  }
  recompute({ reason: 'Hazard removed' });
  renderSandboxPanels(true);
}

function applyPreset(p) {
  const switching = p.network !== state.networkId;
  if (switching) setNetwork(p.network, { origin: p.origin, destination: p.destination, silent: true });
  else {
    state.origin = p.origin;
    state.destination = p.destination;
    syncSelects();
  }
  state.disruptions = [];
  state.fuelShockPct = 0;
  state.selectedSig = null;
  recompute({ quiet: true });
  // Put a convoy on the calm-world plan first, so the crisis visibly forces it to re-plan.
  if (!sandbox.active.some((s) => s.origin === p.origin && s.dest === p.destination)) dispatchConvoy({ quiet: true });
  if (!reducedMotion && !sandbox.running) setRunning(true);
  const built = p.build();
  state.fuelShockPct = built.fuelShockPct;
  $('#fuel').value = String(state.fuelShockPct);
  updateFuelOut();
  for (const d of built.disruptions) {
    d.startedAt = sandbox.simHours;
    state.disruptions.push(d);
    sandbox.note('hazard', `Drill: ${d.label}`);
  }
  if (built.fuelShockPct) sandbox.note('hazard', `Drill: fuel ${signed(built.fuelShockPct, (v) => `${v}%`)}`);
  const sol = recompute({ fit: true, reason: `${p.title} applied` });
  const r = sol.optimal;
  toast(p.title, r ? `${p.blurb} Plotted: ${r.nodes.join(' › ')} · ${fmtTransit(r.totals.hours)} · ${fmtUsd(r.totals.cost)}/TEU.` : p.blurb, p.cls === '1' ? 'CONGESTION' : p.cls === '2' ? 'CLOSURE' : p.cls === '3' ? 'STORM' : 'FUEL', { ms: 8000 });
  $$('.crisis-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.preset === p.id));
  renderSandboxPanels(true);
}

/* ─────────────────────────────── Network / selects ─────────────────────────────── */

function setNetwork(id, { origin, destination, silent = false, disruptions = null, force = false } = {}) {
  const net = getNetwork(id);
  const changed = force || state.networkId !== net.id || state.graph?.id !== net.id;
  state.networkId = net.id;
  state.origin = origin ?? net.defaultOrigin;
  state.destination = destination ?? net.defaultDestination;
  state.selectedSig = null;
  state.graph = buildGraph(net);
  if (changed) {
    state.disruptions = disruptions ?? [];
    state.weather = null;
    const wasRunning = sandbox.running;
    sandbox.reset();
    setRunning(wasRunning);
    sandbox.note('info', `Chart changed to ${net.name}`);
    loadWeather();
  }
  buildSelects();
  $$('#network-switch button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.net === net.id)));
  renderer?.flyTo(net.view);
  if (!silent) {
    recompute({ reason: `${net.name} network` });
    renderSandboxPanels(true);
  }
}

function buildSelects() {
  const net = network();
  const groups = ['PORT', 'RAIL_HUB', 'DRY_PORT', 'CHOKEPOINT'];
  const opts = groups
    .map((g) => {
      const nodes = net.nodes.filter((n) => n.type === g).sort((a, b) => a.name.localeCompare(b.name));
      if (!nodes.length) return '';
      return `<optgroup label="${NODE_TYPE_LABEL[g]}s">${nodes.map((n) => `<option value="${n.id}">${escapeHtml(n.name)} · ${n.id}</option>`).join('')}</optgroup>`;
    })
    .join('');
  $('#origin').innerHTML = opts;
  $('#destination').innerHTML = opts;
  syncSelects();
}

function syncSelects() {
  $('#origin').value = state.origin;
  $('#destination').value = state.destination;
}

function setOD(origin, destination) {
  if (origin === destination) {
    toast('Same origin and destination', 'Pick two different hubs.', null);
    syncSelects();
    return;
  }
  state.origin = origin;
  state.destination = destination;
  state.selectedSig = null;
  syncSelects();
  recompute({ fit: true, reason: `Voyage ${origin} to ${destination}` });
}

/* ─────────────────────────────── Weights / fuel ─────────────────────────────── */

function updateWeightOutputs() {
  const n = normaliseWeights(state.weights);
  $('#o-time').textContent = `${Math.round(n.time * 100)}%`;
  $('#o-cost').textContent = `${Math.round(n.cost * 100)}%`;
  $('#o-co2').textContent = `${Math.round(n.co2 * 100)}%`;
  $('.trim-t').style.flexGrow = n.time;
  $('.trim-c').style.flexGrow = n.cost;
  $('.trim-e').style.flexGrow = n.co2;
  $('#weights-sum').textContent = `Σ w = ${(n.time + n.cost + n.co2).toFixed(2)} · w_t ${n.time.toFixed(2)} · w_c ${n.cost.toFixed(2)} · w_e ${n.co2.toFixed(2)}`;
  $('#w-time').value = String(state.weights.time);
  $('#w-cost').value = String(state.weights.cost);
  $('#w-co2').value = String(state.weights.co2);
  for (const id of ['w-time', 'w-cost', 'w-co2']) {
    const el = $(`#${id}`);
    el.style.setProperty('--fill', `${el.value}%`);
  }
  $$('#weight-presets .chip').forEach((c) => {
    const [t, cc, e] = c.dataset.w.split(',').map(Number);
    c.setAttribute('aria-pressed', String(t === +state.weights.time && cc === +state.weights.cost && e === +state.weights.co2));
  });
}

function updateFuelOut() {
  const v = state.fuelShockPct;
  $('#o-fuel').textContent = v === 0 ? '±0%' : `${v > 0 ? '+' : '−'}${Math.abs(v)}%`;
  const el = $('#fuel');
  el.style.setProperty('--fill', `${((v + 20) / 120) * 100}%`);
}

/* ─────────────────────────────── Weather ─────────────────────────────── */

async function loadWeather({ force = false } = {}) {
  const net = network();
  const badge = $('#meteo-badge');
  badge.dataset.state = 'loading';
  $('#meteo-status').textContent = 'LOADING';
  $('#meteo-detail').textContent = `Open-Meteo · ${net.nodes.length} hubs`;
  if (force) {
    try {
      localStorage.removeItem(`routeguard.meteo.${net.id}`);
    } catch {
      /* ignore */
    }
  }
  const w = await fetchLiveWeather(net);
  if (state.networkId !== net.id) return;
  state.weather = w;
  const severe = net.nodes.filter((n) => weatherImpact(w.byNode[n.id]).severe).length;
  badge.dataset.state = w.status.toLowerCase();
  $('#meteo-status').textContent = w.status;
  const when = new Date(w.fetchedAt).toISOString().slice(11, 16);
  $('#meteo-detail').textContent = `${w.status === 'SYNTHETIC' ? 'offline model' : `Open-Meteo ${when} UTC`} · ${severe} severe hub${severe === 1 ? '' : 's'}`;
  badge.title = w.error ? `Weather fallback (${w.error}). Click to retry.` : 'Live Open-Meteo telemetry. Click to refresh.';
  recompute({ quiet: true });
  if (severe && state.useWeather) sandbox.note('hazard', `Meteo: ${severe} hub${severe === 1 ? '' : 's'} reporting severe conditions`);
}

/* ─────────────────────────────── Map interaction ─────────────────────────────── */

function hoverCardHtml(h) {
  const o = h.object;
  const net = network();
  if (h.layer === 'hubs') {
    const w = state.weather?.byNode?.[o.id];
    const m = state.ctx.nodeMods.get(o.id);
    const bf = w ? beaufort(w.wind) : null;
    return `<div class="hc-kicker mono">${NODE_TYPE_LABEL[o.type]} · ${o.code}</div><div class="hc-title">${escapeHtml(o.name)}</div>
      <dl class="hc-grid mono"><div><dt>Dwell</dt><dd>${o.baseDwellHours} h</dd></div><div><dt>Handling</dt><dd>${fmtUsd(o.handlingCostUsd)}</dd></div><div><dt>Cong. risk</dt><dd>${Math.round(o.congestionRisk * 100)}%</dd></div>
      ${w ? `<div><dt>Air</dt><dd>${w.temp?.toFixed?.(1) ?? w.temp}°C</dd></div><div><dt>Wind</dt><dd>${Math.round(w.wind)} km/h · F${bf.force}</dd></div><div><dt>Sky</dt><dd>${escapeHtml(weatherLabel(w.code))}</dd></div>` : ''}</dl>
      ${w ? `<div class="hc-wx mono">${state.weather.status} METEO · ${escapeHtml(bf.name)}${w.precip ? ` · ${w.precip} mm` : ''}</div>` : ''}
      ${m?.alerts?.length ? `<ul class="hc-alerts">${m.alerts.map((a) => `<li>${escapeHtml(a.text)}</li>`).join('')}</ul>` : ''}
      <div class="hc-hint mono">Click for actions</div>`;
  }
  if (h.layer === 'corridors' || h.layer === 'corridors-road' || h.layer === 'closed') {
    const m = state.ctx.edgeMods.get(o.id);
    const sf = m?.speedFactor ?? 1;
    return `<div class="hc-kicker mono"><span class="mode mode--${o.mode.toLowerCase()}">${MODE_SHORT[o.mode]}</span> corridor${o.isChokepoint ? ' · chokepoint' : ''}</div><div class="hc-title">${escapeHtml(o.label)}</div>
      <dl class="hc-grid mono"><div><dt>Distance</dt><dd>${fmtKm(o.distanceKm)}</dd></div><div><dt>Speed</dt><dd>${Math.round(o.baseSpeedKmh * sf)} km/h${sf < 0.99 ? ` (−${Math.round((1 - sf) * 100)}%)` : ''}</dd></div><div><dt>Rate</dt><dd>$${o.costPerTeuUsd.toFixed(2)}/TEU·km</dd></div>
      <div><dt>CO₂e</dt><dd>${(o.co2KgPerTeuKm * 1000).toFixed(0)} g/TEU·km</dd></div><div><dt>Capacity</dt><dd>${o.capacityTeuWeek.toLocaleString('en-US')} TEU/wk</dd></div><div><dt>Run</dt><dd>${fmtHoursShort(o.distanceKm / (o.baseSpeedKmh * sf))}</dd></div></dl>
      ${m?.closed ? '<div class="hc-wx mono is-bad">CLOSED</div>' : ''}${m?.alerts?.length ? `<ul class="hc-alerts">${m.alerts.map((a) => `<li>${escapeHtml(a.text)}</li>`).join('')}</ul>` : ''}<div class="hc-hint mono">Click for actions</div>`;
  }
  if (h.layer === 'convoys') {
    const s = o.shipment;
    return `<div class="hc-kicker mono">Convoy · ${s.status.replace('_', ' ')}</div><div class="hc-title"><span class="plate"><span class="plate-owner">${s.code.owner}</span><span class="plate-serial">${s.code.serial}</span><span class="plate-check">${s.code.check}</span></span></div>
      <dl class="hc-grid mono"><div><dt>Voyage</dt><dd>${s.origin} → ${s.dest}</dd></div><div><dt>ETA</dt><dd>${fmtSimClock(s.eta)}</dd></div><div><dt>vs plan</dt><dd>${signed(s.eta - s.plannedEta, fmtHoursShort)}</dd></div><div><dt>Leg</dt><dd>${MODE_SHORT[o.mode]} ${s.legIdx + 1}/${s.legs.length}</dd></div><div><dt>Reroutes</dt><dd>${s.reroutes}</dd></div><div><dt>Phase</dt><dd>${s.phase}</dd></div></dl>${s.holdReason ? `<div class="hc-wx mono is-bad">${escapeHtml(s.holdReason)}</div>` : ''}`;
  }
  if (h.layer === 'placards') {
    const left = o.durationH != null ? o.startedAt + o.durationH - sandbox.simHours : null;
    return `<div class="hc-kicker mono">Hazard class ${DISRUPTION_KINDS[o.kind].cls} · ${DISRUPTION_KINDS[o.kind].label}</div><div class="hc-title">${escapeHtml(o.label)}</div><div class="hc-wx mono">${escapeHtml(describeTarget(o, net))}${left != null ? ` · clears in ${fmtDuration(Math.max(0, left))}` : ''}</div><div class="hc-hint mono">Click to remove</div>`;
  }
  if (h.layer === 'track-core' || h.layer === 'alt-tracks') {
    return `<div class="hc-kicker mono">${h.layer === 'track-core' ? 'Plotted track' : 'Alternate track'}</div><div class="hc-title mono">${o.nodes.join(' › ')}</div><dl class="hc-grid mono"><div><dt>Transit</dt><dd>${fmtTransit(o.totals.hours)}</dd></div><div><dt>Cost</dt><dd>${fmtUsd(o.totals.cost)}</dd></div><div><dt>CO₂e</dt><dd>${fmtCo2(o.totals.co2)}</dd></div></dl>${h.layer === 'alt-tracks' ? '<div class="hc-hint mono">Click to plot</div>' : ''}`;
  }
  return '';
}

function placeCard(el, x, y) {
  const area = $('.chart-area').getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = x + 16;
  let top = y + 16;
  if (left + w > area.width - 8) left = x - w - 16;
  if (top + h > area.height - 70) top = y - h - 16;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

function onMapHover(h) {
  const card = $('#hover-card');
  state.hover = h && h.object ? h : null;
  state.hoverEdgeId = h?.object && ['corridors', 'corridors-road', 'closed'].includes(h.layer) ? h.object.id : null;
  if (!h?.object || !$('#pick-card').hidden) {
    card.hidden = true;
    return;
  }
  const html = hoverCardHtml(h);
  if (!html) {
    card.hidden = true;
    return;
  }
  card.innerHTML = html;
  card.hidden = false;
  placeCard(card, h.x, h.y);
}

function closePick() {
  $('#pick-card').hidden = true;
}

function openPick(h, actions, title) {
  const el = $('#pick-card');
  el.innerHTML = `<div class="pc-head"><span class="hc-kicker mono">${escapeHtml(title.kicker)}</span><button type="button" class="icon-btn" data-pick="close" aria-label="Close">✕</button></div><div class="hc-title">${escapeHtml(title.name)}</div><div class="pc-actions">${actions.map((a, i) => `<button type="button" class="pc-btn${a.danger ? ' is-danger' : ''}" data-pick="${i}">${a.icon ? placardHtml(a.icon, 18) : '<span class="pc-dot"></span>'}<span>${escapeHtml(a.label)}</span></button>`).join('')}</div>`;
  el.hidden = false;
  $('#hover-card').hidden = true;
  placeCard(el, h.x, h.y);
  el.onclick = (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const k = b.dataset.pick;
    closePick();
    if (k !== 'close') actions[Number(k)].run();
  };
  el.querySelector('.pc-btn')?.focus({ preventScroll: true });
}

function onMapClick(h) {
  closePick();
  const o = h?.object;
  const tool = state.tool;
  if (tool === 'storm') {
    addDisruption(makeStorm(h.lngLat, state.stormRadius, { label: 'Storm cell (user)', durationH: 96 }));
    return;
  }
  if (!o) return;
  if (h.layer === 'hubs') {
    if (tool === 'strike') return addDisruption(makeCongestion(o.id, { delayHours: 72, surchargeUsd: 300, label: `${o.name} strike`, durationH: 120 }));
    if (tool === 'closure') return addDisruption(makeClosure({ nodeId: o.id, label: `${o.name} closed`, durationH: 96 }));
    const isClosed = state.ctx.nodeMods.get(o.id)?.closed;
    openPick(h, [
      { label: 'Set as origin', run: () => setOD(o.id, state.destination === o.id ? state.origin : state.destination) },
      { label: 'Set as destination', run: () => setOD(state.origin === o.id ? state.destination : state.origin, o.id) },
      { label: 'Inject strike · +72 h, +$300/TEU', icon: 'CONGESTION', run: () => addDisruption(makeCongestion(o.id, { delayHours: 72, surchargeUsd: 300, label: `${o.name} strike`, durationH: 120 })) },
      { label: 'Severe congestion · +120 h', icon: 'CONGESTION', run: () => addDisruption(makeCongestion(o.id, { delayHours: 120, surchargeUsd: 450, label: `${o.name} gridlock`, durationH: 168 })) },
      isClosed
        ? { label: 'Reopen hub', run: () => state.disruptions.filter((d) => d.kind === 'CLOSURE' && d.nodeId === o.id).forEach((d) => removeDisruption(d.id)) }
        : { label: 'Close / blockade hub', icon: 'CLOSURE', danger: true, run: () => addDisruption(makeClosure({ nodeId: o.id, label: `${o.name} closed`, durationH: 96 })) },
      { label: `Storm cell here · ${state.stormRadius} km`, icon: 'STORM', run: () => addDisruption(makeStorm(o.coords, state.stormRadius, { label: `Storm near ${o.name}`, durationH: 96 })) },
    ], { kicker: `${NODE_TYPE_LABEL[o.type]} · ${o.code}`, name: o.name });
    return;
  }
  if (['corridors', 'corridors-road', 'closed'].includes(h.layer)) {
    if (tool === 'closure') return addDisruption(makeClosure({ edgeId: o.id, label: `${o.label} closed`, durationH: 96 }));
    if (tool === 'strike') return toast('Strike needs a hub', 'Strikes and congestion apply to hubs. Click a port or terminal.', null);
    const closed = state.disruptions.filter((d) => d.kind === 'CLOSURE' && d.edgeId === o.id);
    openPick(h, [
      closed.length
        ? { label: 'Reopen corridor', run: () => closed.forEach((d) => removeDisruption(d.id)) }
        : { label: 'Close corridor', icon: 'CLOSURE', danger: true, run: () => addDisruption(makeClosure({ edgeId: o.id, label: `${o.label} closed`, durationH: 96 })) },
      { label: `Storm cell on corridor · ${state.stormRadius} km`, icon: 'STORM', run: () => addDisruption(makeStorm(h.lngLat, state.stormRadius, { label: `Storm on ${o.label}`, durationH: 96 })) },
    ], { kicker: `${MODE_LABEL[o.mode]} corridor`, name: o.label });
    return;
  }
  if (h.layer === 'placards') return removeDisruption(o.id);
  if (h.layer === 'alt-tracks') {
    plotRoute(o.signature);
    return;
  }
  if (h.layer === 'convoys') {
    renderer?.map.easeTo({ center: o.coords, duration: reducedMotion ? 0 : 600 });
  }
}

function plotRoute(sig) {
  const opt = state.solution?.optimal;
  state.selectedSig = opt && opt.signature === sig ? null : sig;
  state.plotStartedAt = performance.now();
  renderPanels();
  writeHash();
  const r = selectedRoute();
  announce(`Plotted ${r.nodes.join(', ')}`);
}

function setTool(tool) {
  state.tool = tool;
  $$('#tools .tool').forEach((b) => {
    const on = b.dataset.tool === tool;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('#storm-opt').hidden = tool !== 'storm';
  $('.chart-area').dataset.tool = tool;
  closePick();
}

/* ─────────────────────────────── Palette ─────────────────────────────── */

function setPalette(p, { persist = true } = {}) {
  if (!PALETTES.includes(p)) return;
  state.palette = p;
  document.documentElement.setAttribute('data-palette', p);
  $$('.palette-switch button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.palette === p)));
  $('meta[name="theme-color"]').setAttribute('content', p === 'day' ? '#f6f8f6' : p === 'dusk' ? '#111a27' : '#05080d');
  if (persist) {
    try {
      localStorage.setItem('routeguard.palette', p);
    } catch {
      /* ignore */
    }
  }
  renderer?.setTheme(p);
  $('#lg-placard').innerHTML = placardHtml('CONGESTION', 16);
  renderPanels();
  renderHazards();
  renderSandboxPanels(true);
}

/* ─────────────────────────────── Manifest ─────────────────────────────── */

function manifest() {
  const net = network();
  const sol = state.solution;
  const sel = selectedRoute();
  const legOut = (r) =>
    r?.legs.map((l, i) => ({
      waypoint: `WP${String(i).padStart(2, '0')}`,
      from: { id: l.from, name: nodeName(l.from), unlocode: state.graph.nodes.get(l.from).code },
      to: { id: l.to, name: nodeName(l.to), unlocode: state.graph.nodes.get(l.to).code },
      mode: l.mode,
      corridor: l.label,
      distanceKm: l.distanceKm,
      hours: { total: +l.hours.toFixed(2), lineHaul: +l.breakdown.travelH.toFixed(2), terminal: +(l.breakdown.departH + l.breakdown.arriveH).toFixed(2), transfer: +l.breakdown.transferH.toFixed(2) },
      costUsdPerTeu: +l.cost.toFixed(2),
      co2KgPerTeu: +l.co2.toFixed(1),
      alerts: l.alerts.map((a) => a.text),
    })) ?? null;
  const totals = (r) => (r ? { hours: +r.totals.hours.toFixed(2), days: +(r.totals.hours / 24).toFixed(2), costUsdPerTeu: +r.totals.cost.toFixed(2), co2KgPerTeu: +r.totals.co2.toFixed(1), distanceKm: r.totals.distanceKm } : null);
  const code = makeCode(Math.floor(Date.now() / 1000) % 1e6);
  return {
    manifest: 'RouteGuard route manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    scenarioUrl: location.href,
    container: { iso6346: code.compact, owner: code.owner, serial: code.serial, checkDigit: code.check },
    network: { id: net.id, name: net.name },
    voyage: { origin: state.origin, destination: state.destination },
    weights: normaliseWeights(state.weights),
    fuelShockPct: state.fuelShockPct,
    weather: state.weather ? { status: state.weather.status, fetchedAt: new Date(state.weather.fetchedAt).toISOString(), applied: state.useWeather } : null,
    disruptions: state.disruptions.map((d) => ({ kind: d.kind, label: d.label, target: describeTarget(d, net), ...encodeDisruption(d) })),
    plotted: sel ? { tags: [...sel.tags], pareto: sel.efficient, nodes: sel.nodes, totals: totals(sel), legs: legOut(sel) } : null,
    baselineCalm: sol?.baseline ? { nodes: sol.baseline.nodes, totals: totals(sol.baseline) } : null,
    candidates: sol?.candidates.map((r) => ({ tags: [...r.tags], pareto: r.efficient, nodes: r.nodes, modes: r.legs.map((l) => l.mode), totals: totals(r) })) ?? [],
    sandbox: { simClock: fmtSimClock(sandbox.simHours), convoys: sandbox.shipments.map((s) => ({ container: s.code.compact, status: s.status, origin: s.origin, destination: s.dest, departed: fmtSimClock(s.departedAt), eta: fmtSimClock(s.eta), reroutes: s.reroutes })) },
    solveMs: sol ? +sol.computeMs.toFixed(2) : null,
  };
}

function downloadManifest() {
  const data = JSON.stringify(manifest(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `routeguard-${state.origin}-${state.destination}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Manifest exported', `${a.download} · ${selectedRoute()?.legs.length ?? 0} legs, ${state.disruptions.length} hazards.`, null);
}

async function copyLink() {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Scenario link copied', 'Anyone with the link gets this exact voyage, weights and hazard set.', null);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = location.href;
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('Scenario link copied', 'Anyone with the link gets this exact voyage, weights and hazard set.', null);
    } catch {
      toast('Copy blocked', 'Your browser blocked clipboard access. Copy the address bar instead.', null);
    }
    ta.remove();
  }
}

/* ─────────────────────────────── Help drawer ─────────────────────────────── */

let helpReturn = null;
function openHelp() {
  const h = $('#help');
  if (!h.hidden) return;
  helpReturn = document.activeElement;
  h.hidden = false;
  requestAnimationFrame(() => h.classList.add('is-open'));
  $('.help-sheet [data-close]', h).focus();
}
function closeHelp() {
  const h = $('#help');
  if (h.hidden) return;
  h.classList.remove('is-open');
  setTimeout(() => (h.hidden = true), reducedMotion ? 0 : 220);
  helpReturn?.focus?.({ preventScroll: true });
}

/* ─────────────────────────────── Frame loop ─────────────────────────────── */

function frame(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (sandbox.running && state.graph) {
    const ev = sandbox.tick(dt, { graph: state.graph, network: network(), disruptions: state.disruptions });
    if (ev.expired.length) {
      for (const id of ev.expired) {
        const d = state.disruptions.find((x) => x.id === id);
        if (d) {
          sandbox.note('clear', `Cleared: ${d.label}`);
          toast(`${d.label} has cleared`, 'Corridor penalties lifted; routes re-optimised.', null, { ms: 3800 });
        }
      }
      state.disruptions = state.disruptions.filter((d) => !ev.expired.includes(d.id));
      recompute({ quiet: true });
      if (!state.disruptions.length) $$('.crisis-btn').forEach((b) => b.classList.remove('is-active'));
    }
    if (ev.spawned) addDisruption(ev.spawned);
    if (ev.autoDispatch) dispatchConvoy({ quiet: true });
    if (ev.drifted && now - lastDriftRecalc > 700) {
      lastDriftRecalc = now;
      recompute({ quiet: true });
    }
    renderSandboxPanels();
  }
  if (renderer && state.solution) {
    renderer.render({
      network: network(),
      graph: state.graph,
      solution: state.solution,
      selectedRoute: selectedRoute(),
      disruptions: state.disruptions,
      ctx: state.ctx,
      ctxVersion: state.ctxVersion,
      weather: state.weather,
      useWeather: state.useWeather,
      beaufort,
      convoys: sandbox.positions(state.graph),
      sandboxVersion: sandbox.version,
      origin: state.origin,
      destination: state.destination,
      hover: state.hover,
      hoverEdgeId: state.hoverEdgeId,
      hoverRoute: state.hoverRoute,
      disrupted: isDisrupted(),
      tool: state.tool,
      now,
      plotProgress: reducedMotion ? 1 : Math.min(1, (now - state.plotStartedAt) / 900),
    });
  }
  requestAnimationFrame(frame);
}

/* ─────────────────────────────── Wiring ─────────────────────────────── */

function buildChrome() {
  // Crisis drills
  $('#crisis-row').innerHTML = CRISIS_PRESETS.map((p) => `<button type="button" class="crisis-btn" data-preset="${p.id}" title="${escapeHtml(p.blurb)} (key ${p.key})"><span class="cb-placard" data-kind="${p.cls}"></span><span class="cb-text"><span class="cb-title">${escapeHtml(p.title)}</span><span class="cb-short">${escapeHtml(p.short)}</span><span class="cb-meta mono">${p.network === 'GLOBAL' ? 'Global' : 'East Africa'} · ${p.origin}→${p.destination} · key ${p.key}</span></span></button>`).join('');
  const kindOf = { 1: 'CONGESTION', 2: 'CLOSURE', 3: 'STORM', 4: 'FUEL' };
  const paintPlacards = () => $$('.cb-placard').forEach((el) => (el.innerHTML = placardHtml(kindOf[el.dataset.kind], 30)));
  paintPlacards();
  $('#crisis-row').addEventListener('click', (e) => {
    const b = e.target.closest('.crisis-btn');
    if (b) applyPreset(CRISIS_PRESETS.find((p) => p.id === b.dataset.preset));
  });

  // Network switch
  $('#network-switch').innerHTML = Object.values(NETWORKS).map((n) => `<button type="button" role="radio" data-net="${n.id}" aria-checked="${n.id === state.networkId}"><span>${n.short}</span><small class="mono">${n.nodes.length} hubs · ${n.edges.length} links</small></button>`).join('');
  $('#network-switch').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.net !== state.networkId) setNetwork(b.dataset.net);
  });

  // Speed
  $('#speed').innerHTML = SPEEDS.map((s) => `<button type="button" role="radio" data-speed="${s}" aria-checked="${s === sandbox.speed}" title="${s} sim-hours per second">${s}×</button>`).join('');
  $('#speed').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    sandbox.speed = Number(b.dataset.speed);
    $$('#speed button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  });

  $('#flag-h').innerHTML = FLAG_H;

  // Selects
  $('#origin').addEventListener('change', (e) => setOD(e.target.value, state.destination));
  $('#destination').addEventListener('change', (e) => setOD(state.origin, e.target.value));
  $('#swap-od').addEventListener('click', () => setOD(state.destination, state.origin));

  // Weights
  let wTimer = 0;
  for (const [id, key] of [['w-time', 'time'], ['w-cost', 'cost'], ['w-co2', 'co2']]) {
    $(`#${id}`).addEventListener('input', (e) => {
      state.weights[key] = Number(e.target.value);
      state.selectedSig = null;
      updateWeightOutputs();
      cancelAnimationFrame(wTimer);
      wTimer = requestAnimationFrame(() => recompute({ quiet: true }));
    });
  }
  $('#weight-presets').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const [t, c, co2] = b.dataset.w.split(',').map(Number);
    state.weights = { time: t, cost: c, co2 };
    state.selectedSig = null;
    updateWeightOutputs();
    recompute({ reason: `${b.textContent} weights` });
  });

  // Fuel / weather / hazards
  $('#fuel').addEventListener('input', (e) => {
    state.fuelShockPct = Number(e.target.value);
    updateFuelOut();
    cancelAnimationFrame(wTimer);
    wTimer = requestAnimationFrame(() => recompute({ quiet: true }));
  });
  $('#fuel').addEventListener('change', () => {
    if (state.fuelShockPct) sandbox.note('hazard', `Fuel shock set to ${signed(state.fuelShockPct, (v) => `${v}%`)}`);
  });
  $('#use-weather').addEventListener('change', (e) => {
    state.useWeather = e.target.checked;
    recompute({ reason: state.useWeather ? 'Live weather applied' : 'Live weather ignored' });
  });
  $('#hazard-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) removeDisruption(b.dataset.remove);
  });
  $('#clear-hazards').addEventListener('click', () => {
    state.disruptions = [];
    state.fuelShockPct = 0;
    $('#fuel').value = '0';
    updateFuelOut();
    $$('.crisis-btn').forEach((b) => b.classList.remove('is-active'));
    sandbox.note('clear', 'All hazards cleared');
    recompute({ reason: 'All hazards cleared' });
    renderSandboxPanels(true);
  });

  // Share
  $('#copy-link').addEventListener('click', copyLink);
  $('#download-manifest').addEventListener('click', downloadManifest);

  // Candidates & convoys
  $('#cands').addEventListener('click', (e) => {
    const b = e.target.closest('.cand');
    if (b) plotRoute(b.dataset.sig);
  });
  $('#cands').addEventListener('mouseover', (e) => {
    const b = e.target.closest('.cand');
    state.hoverRoute = b ? b.dataset.sig : null;
  });
  $('#cands').addEventListener('mouseleave', () => (state.hoverRoute = null));
  $('#convoy-list').addEventListener('click', (e) => {
    const b = e.target.closest('.convoy');
    if (!b) return;
    const p = sandbox.positions(state.graph).find((x) => x.id === b.dataset.convoy);
    if (p && renderer) renderer.map.easeTo({ center: p.coords, zoom: Math.max(renderer.map.getZoom(), state.networkId === 'GLOBAL' ? 3 : 6), duration: reducedMotion ? 0 : 700 });
  });

  // Tools
  $('#tools').addEventListener('click', (e) => {
    const b = e.target.closest('.tool');
    if (b) setTool(b.dataset.tool);
  });
  $('#storm-radius').addEventListener('input', (e) => {
    state.stormRadius = Number(e.target.value);
    $('#o-storm').textContent = `${state.stormRadius} km`;
  });

  // Console
  $('#play').addEventListener('click', () => setRunning(!sandbox.running));
  $('#dispatch').addEventListener('click', () => dispatchConvoy());
  $('#auto-dispatch').addEventListener('change', (e) => {
    sandbox.autoDispatch = e.target.checked;
    sandbox.lastAuto = sandbox.simHours - sandbox.autoEvery;
    sandbox.note('info', `Auto-dispatch ${e.target.checked ? 'on: one convoy every 36 sim-hours' : 'off'}`);
    if (e.target.checked && !sandbox.running) setRunning(true);
  });
  $('#chaos').addEventListener('change', (e) => {
    sandbox.chaos = e.target.checked;
    sandbox.nextChaosAt = sandbox.simHours + 6;
    sandbox.note('info', `Chaos mode ${e.target.checked ? 'on: random strikes, storms and closures' : 'off'}`);
    if (e.target.checked && !sandbox.running) setRunning(true);
    toast(e.target.checked ? 'Chaos mode engaged' : 'Chaos mode off', e.target.checked ? 'Expect random strikes, storms and closures every few sim-days. Convoys will re-plan on their own.' : 'No new random hazards will spawn.', e.target.checked ? 'STORM' : null);
  });
  $('#reset-sim').addEventListener('click', () => {
    const wasRunning = sandbox.running;
    sandbox.reset();
    setRunning(wasRunning);
    $('#auto-dispatch').checked = false;
    $('#chaos').checked = false;
    state.disruptions = state.disruptions.filter((d) => d.source !== 'chaos');
    $$('#speed button').forEach((x) => x.setAttribute('aria-checked', String(Number(x.dataset.speed) === sandbox.speed)));
    sandbox.note('info', 'Sandbox reset');
    recompute({ quiet: true });
    renderSandboxPanels(true);
  });

  // Palette
  $('.palette-switch').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setPalette(b.dataset.palette);
  });

  // Meteo badge
  $('#meteo-badge').addEventListener('click', () => loadWeather({ force: true }));

  // Help & guide
  $('#help-key').addEventListener('click', openHelp);
  $('#help').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeHelp();
    const t = e.target.closest('[data-tour]');
    if (t) {
      closeHelp();
      setTimeout(() => pilot.start(t.dataset.tour === 'all' ? null : t.dataset.tour), 240);
    }
  });
  $('#help').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const f = $$('#help button');
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  $('#guide-key').addEventListener('click', () => pilot.start());

  // Keyboard map
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    const typing = /INPUT|SELECT|TEXTAREA/.test(tag) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
    if (e.key === 'Escape') {
      closePick();
      closeHelp();
      if (state.tool !== 'select') setTool('select');
      return;
    }
    if (typing || pilot?.active) return;
    if (e.key === '?') {
      e.preventDefault();
      openHelp();
    } else if (!$('#help').hidden) {
      return;
    } else if (e.key === 'g' || e.key === 'G') pilot.start();
    else if (e.key === ' ' && !/BUTTON/.test(tag)) {
      e.preventDefault();
      setRunning(!sandbox.running);
    } else if (e.key === 'd' || e.key === 'D') dispatchConvoy();
    else if (/^[1-4]$/.test(e.key)) applyPreset(CRISIS_PRESETS[Number(e.key) - 1]);
    else if (e.key === 's' || e.key === 'S') setTool('select');
    else if (e.key === 'f' || e.key === 'F') selectedRoute() && renderer?.fitRoute(selectedRoute().path, 70);
    else if (e.key === 't' || e.key === 'T') setPalette(PALETTES[(PALETTES.indexOf(state.palette) + 1) % PALETTES.length]);
  });
  document.addEventListener('click', (e) => {
    if (!$('#pick-card').hidden && !e.target.closest('#pick-card') && !e.target.closest('#map')) closePick();
  });
  window.addEventListener('hashchange', () => {
    const before = `${state.networkId}|${state.origin}|${state.destination}`;
    const prevNet = state.networkId;
    if (readHash()) {
      if (prevNet !== state.networkId) setNetwork(state.networkId, { origin: state.origin, destination: state.destination, silent: true, disruptions: state.disruptions, force: true });
      buildSelects();
      updateWeightOutputs();
      $('#fuel').value = String(state.fuelShockPct);
      updateFuelOut();
      $('#use-weather').checked = state.useWeather;
      recompute({ fit: before !== `${state.networkId}|${state.origin}|${state.destination}` });
    }
  });
}

function init() {
  const fromLink = readHash();
  state.graph = buildGraph(network());
  buildChrome();
  buildSelects();
  $$('#network-switch button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.net === state.networkId)));
  updateWeightOutputs();
  $('#fuel').value = String(state.fuelShockPct);
  updateFuelOut();
  $('#use-weather').checked = state.useWeather;
  $('#lg-placard').innerHTML = placardHtml('CONGESTION', 16);

  pareto = new ParetoChart($('#pareto'), {
    readout: $('#pareto-readout'),
    onHover: (r) => (state.hoverRoute = r?.signature ?? null),
    onSelect: (r) => plotRoute(r.signature),
  });

  // Warm-up rose ticks
  const ticks = $('.warmup-rose .ticks');
  ticks.innerHTML = Array.from({ length: 36 }, (_, i) => {
    const a = (i * 10 * Math.PI) / 180;
    const r1 = i % 9 === 0 ? 44 : 49;
    return `<line x1="${60 + Math.sin(a) * r1}" y1="${60 - Math.cos(a) * r1}" x2="${60 + Math.sin(a) * 54}" y2="${60 - Math.cos(a) * 54}"/>`;
  }).join('');

  renderer = new MapRenderer($('#map'), {
    theme: state.palette,
    view: network().view,
    onHover: onMapHover,
    onClick: onMapClick,
    onStatus: (kind, msg) => {
      if (kind === 'carto' || kind === 'fallback') $('#warmup').classList.add('is-done');
      if (kind === 'fallback') toast('Offline chart', `Vector basemap unavailable (${msg}). Using a graticule chart; routing still works.`, null);
      if (kind === 'fault') {
        $('#warmup').classList.add('is-done');
        const f = $('#fault');
        f.hidden = false;
        f.innerHTML = `<div class="fault-card"><span class="mono">CHART DISPLAY FAULT</span><h3>The map engine did not load</h3><p>${escapeHtml(msg)}. The routing engine, telemetry and sandbox still work in the panels. Check your connection or content blocker, then reload.</p><button type="button" class="btn btn--primary" onclick="location.reload()">Reload</button></div>`;
      }
    },
  });
  if (renderer.failed) renderer = null;
  setPalette(state.palette, { persist: false });

  recompute({ quiet: true });
  if ((fromLink || window.innerWidth < 980) && renderer && selectedRoute()) setTimeout(() => renderer.fitRoute(selectedRoute().path, 50), 400);
  renderSandboxPanels(true);
  loadWeather();

  // Live sandbox from the first second: one convoy at sea, clock running (not under reduced motion).
  dispatchConvoy({ quiet: true });
  if (!reducedMotion) setRunning(true);

  pilot = new Pilot({
    steps: pilotSteps({
      ensureSandboxDemo: () => {
        if (!sandbox.active.length) dispatchConvoy({ quiet: true });
      },
    }),
    announce,
  });
  pilot.maybeInvite(1400);

  requestAnimationFrame(frame);
  window.routeguard = { state, sandbox, recompute, selectedRoute, manifest, pilot, renderer };
}

init();
