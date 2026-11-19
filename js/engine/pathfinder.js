/**
 * RouteGuard — multi-objective routing engine (no external graph libraries).
 *
 *  • BinaryMinHeap: indexed binary heap with O(log V) push / pop / decreaseKey.
 *  • Search state = (node, arrivalMode). Modal transfer penalties depend on how you arrived, so a plain
 *    node-keyed Dijkstra would be wrong; expanding (node × mode) keeps A* exact.
 *  • Scalarised objective:  J = w_t·H/Ĥ + w_c·C/Ĉ + w_e·E/Ê   with  w_t + w_c + w_e = 1
 *    where Ĥ, Ĉ, Ê are baseline network scales (mean undisrupted leg metrics).
 *  • Heuristic: h(n) = d_gc(n, goal) · [ w_t/(v_max·Ĥ) + w_c·c_min/Ĉ + w_e·e_min/Ê ]
 *    Every edge is at least its great-circle length, never faster than v_max, never cheaper per km
 *    than c_min and never cleaner than e_min, and all penalties are ≥ 0, so h is admissible and
 *    consistent (triangle inequality) and A* returns the scalarised optimum.
 *  • Alternatives: fastest / cheapest / greenest single-objective solves, edge-penalised re-solves
 *    (iterative penalty method for K diverse paths) and a sweep of the weight simplex, merged and
 *    filtered to the Pareto-efficient set over (hours, USD/TEU, kg CO₂e).
 */

import { haversineKm } from '../data/corridorNetwork.js';

/* ─────────────────────────────── Binary min-heap ─────────────────────────────── */

export class BinaryMinHeap {
  constructor() {
    this.keys = [];
    this.prio = [];
    this.pos = new Map();
  }
  get size() {
    return this.keys.length;
  }
  has(key) {
    return this.pos.has(key);
  }
  priorityOf(key) {
    const i = this.pos.get(key);
    return i === undefined ? undefined : this.prio[i];
  }
  push(key, priority) {
    if (this.pos.has(key)) {
      this.decreaseKey(key, priority);
      return;
    }
    this.keys.push(key);
    this.prio.push(priority);
    this.pos.set(key, this.keys.length - 1);
    this.#up(this.keys.length - 1);
  }
  pop() {
    if (!this.keys.length) return undefined;
    const top = { key: this.keys[0], priority: this.prio[0] };
    const lastKey = this.keys.pop();
    const lastPrio = this.prio.pop();
    this.pos.delete(top.key);
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.prio[0] = lastPrio;
      this.pos.set(lastKey, 0);
      this.#down(0);
    }
    return top;
  }
  /** Lowers the priority of an existing key; ignored if the new priority is not lower. */
  decreaseKey(key, priority) {
    const i = this.pos.get(key);
    if (i === undefined) return this.push(key, priority);
    if (priority >= this.prio[i]) return;
    this.prio[i] = priority;
    this.#up(i);
  }
  #swap(i, j) {
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
    [this.prio[i], this.prio[j]] = [this.prio[j], this.prio[i]];
    this.pos.set(this.keys[i], i);
    this.pos.set(this.keys[j], j);
  }
  #up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prio[p] <= this.prio[i]) break;
      this.#swap(i, p);
      i = p;
    }
  }
  #down(i) {
    const n = this.keys.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.prio[l] < this.prio[m]) m = l;
      if (r < n && this.prio[r] < this.prio[m]) m = r;
      if (m === i) return;
      this.#swap(i, m);
      i = m;
    }
  }
}

/* ─────────────────────────────── Graph model ─────────────────────────────── */

/** Modal transfer penalties: [hours, USD/TEU, kg CO₂e/TEU] for a lift between two modes. */
export const TRANSFER_PENALTY = {
  'MARITIME>RAIL': [10, 120, 9],
  'RAIL>MARITIME': [10, 120, 9],
  'MARITIME>ROAD': [6, 95, 7],
  'ROAD>MARITIME': [6, 95, 7],
  'RAIL>ROAD': [6, 80, 6],
  'ROAD>RAIL': [6, 80, 6],
};

/** Share of a pass-through call (same mode in and out) relative to a full terminal call. */
const PASS_THROUGH_DWELL = 0.35;
const PASS_THROUGH_HANDLING = 0.25;

export function buildGraph(network) {
  const nodes = new Map(network.nodes.map((n) => [n.id, n]));
  const edges = new Map(network.edges.map((e) => [e.id, e]));
  const adj = new Map(network.nodes.map((n) => [n.id, []]));
  for (const e of network.edges) {
    adj.get(e.from).push({ edge: e, to: e.to, reverse: false });
    if (!e.oneWay) adj.get(e.to).push({ edge: e, to: e.from, reverse: true });
  }
  let maxSpeed = 0;
  let sumH = 0;
  let sumC = 0;
  let sumE = 0;
  let minCostPerKm = Infinity;
  let minCo2PerKm = Infinity;
  for (const e of network.edges) {
    maxSpeed = Math.max(maxSpeed, e.baseSpeedKmh);
    minCostPerKm = Math.min(minCostPerKm, e.costPerTeuUsd);
    minCo2PerKm = Math.min(minCo2PerKm, e.co2KgPerTeuKm);
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    sumH += e.distanceKm / e.baseSpeedKmh + (a.baseDwellHours + b.baseDwellHours) / 2;
    sumC += e.distanceKm * e.costPerTeuUsd + (a.handlingCostUsd + b.handlingCostUsd) / 2;
    sumE += e.distanceKm * e.co2KgPerTeuKm;
  }
  const m = network.edges.length || 1;
  return {
    id: network.id,
    network,
    nodes,
    edges,
    adj,
    maxSpeed,
    minCostPerKm,
    minCo2PerKm,
    scales: { hours: sumH / m, cost: sumC / m, co2: sumE / m },
  };
}

/** An empty (undisrupted) context — the baseline world. */
export function neutralContext() {
  return {
    nodeMods: new Map(),
    edgeMods: new Map(),
    fuelShockPct: 0,
    fuelMultiplier: () => 1,
    minFuelMultiplier: 1,
    edgePenalty: null,
  };
}

/** Normalises raw slider weights so w_t + w_c + w_e = 1 (falls back to equal weights). */
export function normaliseWeights(w) {
  const t = Math.max(0, +w.time || 0);
  const c = Math.max(0, +w.cost || 0);
  const e = Math.max(0, +w.co2 || 0);
  const s = t + c + e;
  if (s <= 0) return { time: 1 / 3, cost: 1 / 3, co2: 1 / 3 };
  return { time: t / s, cost: c / s, co2: e / s };
}

/**
 * Metrics for leaving `fromId` along `edge` towards `toId`, having arrived at `fromId` by `prevMode`.
 * Includes the departure-side terminal call (origin call, transfer, chokepoint queue or pass-through)
 * and, when `toId` is the destination, the import-side terminal call.
 */
export function legMetrics(graph, edge, fromId, toId, prevMode, ctx, { isOrigin = false, isDest = false } = {}) {
  const from = graph.nodes.get(fromId);
  const to = graph.nodes.get(toId);
  const eMod = ctx.edgeMods.get(edge.id);
  const fMod = ctx.nodeMods.get(fromId);
  const tMod = ctx.nodeMods.get(toId);
  if (eMod?.closed || fMod?.closed || tMod?.closed) return null;

  const speedFactor = Math.min(1, eMod?.speedFactor ?? 1);
  const speed = edge.baseSpeedKmh * speedFactor;
  const travelH = edge.distanceKm / speed;
  const baseTravelH = edge.distanceKm / edge.baseSpeedKmh;

  // Departure-side terminal call
  let dwellH = 0;
  let handling = 0;
  let transferH = 0;
  let transferCost = 0;
  let transferCo2 = 0;
  let callKind = 'pass';
  const modeChange = prevMode && prevMode !== edge.mode;
  if (isOrigin) {
    dwellH = from.baseDwellHours;
    handling = from.handlingCostUsd;
    callKind = 'origin';
  } else if (modeChange) {
    const p = TRANSFER_PENALTY[`${prevMode}>${edge.mode}`];
    dwellH = from.baseDwellHours;
    handling = from.handlingCostUsd;
    [transferH, transferCost, transferCo2] = p;
    callKind = 'transfer';
  } else if (from.type === 'CHOKEPOINT') {
    dwellH = from.baseDwellHours;
    handling = from.handlingCostUsd;
    callKind = 'chokepoint';
  } else {
    dwellH = from.baseDwellHours * PASS_THROUGH_DWELL;
    handling = from.handlingCostUsd * PASS_THROUGH_HANDLING;
  }
  const nodeDelayH = fMod?.delayHours ?? 0;
  const nodeSurcharge = fMod?.surchargeUsd ?? 0;

  // Arrival-side (destination) terminal call
  let destDwellH = 0;
  let destHandling = 0;
  if (isDest) {
    destDwellH = to.baseDwellHours + (tMod?.delayHours ?? 0);
    destHandling = to.handlingCostUsd + (tMod?.surchargeUsd ?? 0);
  }

  const fuel = ctx.fuelMultiplier(edge);
  const lineHaulCost = edge.distanceKm * edge.costPerTeuUsd * fuel;
  const drag = eMod?.co2Factor ?? 1;
  const co2 = edge.distanceKm * edge.co2KgPerTeuKm * drag + transferCo2;
  const edgeDelayH = eMod?.delayHours ?? 0;
  const edgeSurcharge = eMod?.surchargeUsd ?? 0;

  const delayH = nodeDelayH + edgeDelayH + (travelH - baseTravelH);
  const hours = travelH + dwellH + transferH + nodeDelayH + edgeDelayH + destDwellH;
  const cost = lineHaulCost + handling + transferCost + nodeSurcharge + edgeSurcharge + destHandling;

  const alerts = [];
  if (fMod?.alerts) alerts.push(...fMod.alerts.map((a) => ({ ...a, where: from.name })));
  if (eMod?.alerts) alerts.push(...eMod.alerts);
  if (isDest && tMod?.alerts) alerts.push(...tMod.alerts.map((a) => ({ ...a, where: to.name })));

  return {
    hours,
    cost,
    co2,
    breakdown: {
      travelH,
      baseTravelH,
      dwellH: dwellH + destDwellH,
      departH: dwellH + transferH + nodeDelayH + edgeDelayH,
      arriveH: destDwellH,
      transferH,
      delayH,
      lineHaulCost,
      handling: handling + destHandling,
      transferCost,
      surcharge: nodeSurcharge + edgeSurcharge + (isDest ? tMod?.surchargeUsd ?? 0 : 0),
      fuelMultiplier: fuel,
      speedFactor,
      co2Drag: drag,
      callKind,
    },
    alerts,
  };
}

function scalarise(m, w, scales) {
  return (w.time * m.hours) / scales.hours + (w.cost * m.cost) / scales.cost + (w.co2 * m.co2) / scales.co2;
}

function heuristicFactory(graph, goalId, w, ctx) {
  const goal = graph.nodes.get(goalId).coords;
  const s = graph.scales;
  const perKm =
    w.time / (graph.maxSpeed * s.hours) +
    (w.cost * graph.minCostPerKm * ctx.minFuelMultiplier) / s.cost +
    (w.co2 * graph.minCo2PerKm) / s.co2;
  const cache = new Map();
  return (nodeId) => {
    let v = cache.get(nodeId);
    if (v === undefined) {
      v = haversineKm(graph.nodes.get(nodeId).coords, goal) * perKm;
      cache.set(nodeId, v);
    }
    return v;
  };
}

/**
 * Multi-objective A*. Returns a route object or null when the destination is unreachable.
 * opts.startMode lets a convoy already in transit re-plan from a mid-route node.
 */
export function astar(graph, originId, destId, weights, ctx, opts = {}) {
  if (!graph.nodes.has(originId) || !graph.nodes.has(destId)) return null;
  if (originId === destId) return null;
  const w = normaliseWeights(weights);
  const h = opts.useHeuristic === false ? () => 0 : heuristicFactory(graph, destId, w, ctx);
  const startMode = opts.startMode ?? null;
  const startKey = `${originId}|${startMode ?? '-'}`;
  const g = new Map([[startKey, 0]]);
  const parent = new Map();
  const closed = new Set();
  const heap = new BinaryMinHeap();
  heap.push(startKey, h(originId));
  let expanded = 0;
  const isMidRoute = Boolean(opts.startMode);

  while (heap.size) {
    const { key } = heap.pop();
    if (closed.has(key)) continue;
    closed.add(key);
    expanded++;
    const [nodeId, modeTag] = key.split('|');
    const prevMode = modeTag === '-' ? null : modeTag;
    if (nodeId === destId) return reconstruct(graph, parent, key, originId, ctx, w, expanded, startMode, isMidRoute);
    const gHere = g.get(key);
    for (const arc of graph.adj.get(nodeId)) {
      const isOrigin = nodeId === originId && !isMidRoute && prevMode === null;
      const isDest = arc.to === destId;
      const m = legMetrics(graph, arc.edge, nodeId, arc.to, prevMode, ctx, { isOrigin, isDest });
      if (!m) continue;
      let cost = scalarise(m, w, graph.scales);
      const pen = ctx.edgePenalty?.get(arc.edge.id);
      if (pen) cost *= pen;
      const nextKey = `${arc.to}|${arc.edge.mode}`;
      if (closed.has(nextKey)) continue;
      const tentative = gHere + cost;
      if (tentative < (g.get(nextKey) ?? Infinity)) {
        g.set(nextKey, tentative);
        parent.set(nextKey, { prev: key, arc });
        heap.push(nextKey, tentative + h(arc.to));
      }
    }
  }
  return null;
}

function reconstruct(graph, parent, endKey, originId, ctx, w, expanded, startMode, isMidRoute) {
  const arcs = [];
  let k = endKey;
  while (parent.has(k)) {
    const p = parent.get(k);
    arcs.push({ arc: p.arc, fromId: p.prev.split('|')[0] });
    k = p.prev;
  }
  arcs.reverse();
  const steps = arcs.map(({ arc, fromId }) => ({ edgeId: arc.edge.id, from: fromId, to: arc.to }));
  const route = evaluatePath(graph, steps, ctx, { startMode, midRoute: isMidRoute });
  if (route) {
    route.scalar = scalarise(route.totals, w, graph.scales);
    route.expanded = expanded;
  }
  return route;
}

/**
 * Evaluates an explicit path (list of {edgeId, from, to}) under a context. Returns null if any leg is
 * impassable. Used for baselines ("what would the old plan cost now?") and for convoy re-timing.
 */
export function evaluatePath(graph, steps, ctx, { startMode = null, midRoute = false } = {}) {
  if (!steps.length) return null;
  const legs = [];
  let prevMode = startMode;
  const totals = { hours: 0, cost: 0, co2: 0, distanceKm: 0 };
  const path = [];
  const destId = steps[steps.length - 1].to;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const edge = graph.edges.get(s.edgeId);
    if (!edge) return null;
    const m = legMetrics(graph, edge, s.from, s.to, prevMode, ctx, {
      isOrigin: i === 0 && !midRoute,
      isDest: s.to === destId && i === steps.length - 1,
    });
    if (!m) return null;
    const reverse = edge.from !== s.from;
    const coords = reverse ? [...edge.waypoints].reverse() : edge.waypoints;
    if (path.length) path.push(...coords.slice(1));
    else path.push(...coords);
    legs.push({
      index: i,
      edgeId: edge.id,
      from: s.from,
      to: s.to,
      mode: edge.mode,
      label: edge.label,
      distanceKm: edge.distanceKm,
      isChokepoint: edge.isChokepoint,
      coords,
      hours: m.hours,
      cost: m.cost,
      co2: m.co2,
      breakdown: m.breakdown,
      alerts: m.alerts,
    });
    totals.hours += m.hours;
    totals.cost += m.cost;
    totals.co2 += m.co2;
    totals.distanceKm += edge.distanceKm;
    prevMode = edge.mode;
  }
  const nodes = [steps[0].from, ...steps.map((s) => s.to)];
  return {
    signature: steps.map((s) => `${s.edgeId}>${s.to}`).join(','),
    steps,
    nodes,
    legs,
    totals,
    path,
    modes: [...new Set(legs.map((l) => l.mode))],
    tags: new Set(),
    scalar: 0,
  };
}

/** Pareto filter: a route is efficient if no other route is ≤ on all three objectives and < on one. */
export function paretoFront(routes) {
  const eps = 1e-6;
  return routes.filter((a) =>
    !routes.some((b) => {
      if (a === b) return false;
      const le = b.totals.hours <= a.totals.hours + eps && b.totals.cost <= a.totals.cost + eps && b.totals.co2 <= a.totals.co2 + eps;
      const lt = b.totals.hours < a.totals.hours - eps || b.totals.cost < a.totals.cost - eps || b.totals.co2 < a.totals.co2 - eps;
      return le && lt;
    }),
  );
}

/** Weight simplex grid (step 1/n) for sweeping the scalarisation. */
export function simplexGrid(n = 5) {
  const pts = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) pts.push({ time: i / n, cost: j / n, co2: (n - i - j) / n });
  return pts;
}

/**
 * Solves a full scenario: optimal weighted route, fastest, cheapest, greenest, K edge-penalised
 * alternates, the simplex sweep and the undisrupted baseline used for deltas.
 */
export function solveScenario(graph, originId, destId, weights, ctx, { k = 4, baselineCtx = neutralContext() } = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const byKey = new Map();
  const add = (route, tag) => {
    if (!route) return null;
    const existing = byKey.get(route.signature);
    if (existing) {
      existing.tags.add(tag);
      return existing;
    }
    route.tags.add(tag);
    byKey.set(route.signature, route);
    return route;
  };

  const optimal = add(astar(graph, originId, destId, weights, ctx), 'optimal');
  const fastest = add(astar(graph, originId, destId, { time: 1, cost: 0, co2: 0 }, ctx), 'fastest');
  const cheapest = add(astar(graph, originId, destId, { time: 0, cost: 1, co2: 0 }, ctx), 'cheapest');
  const greenest = add(astar(graph, originId, destId, { time: 0, cost: 0, co2: 1 }, ctx), 'greenest');

  // Edge-penalised K-shortest-path search (iterative penalty method) for diverse alternates.
  const alternates = [];
  if (optimal) {
    const penalty = new Map();
    let last = optimal;
    for (let i = 0; i < k * 2 && alternates.length < k; i++) {
      for (const leg of last.legs) penalty.set(leg.edgeId, (penalty.get(leg.edgeId) ?? 1) * 1.6);
      const penCtx = { ...ctx, edgePenalty: penalty };
      const alt = astar(graph, originId, destId, weights, penCtx);
      if (!alt) break;
      // Re-evaluate under the unpenalised context so totals are honest.
      const honest = evaluatePath(graph, alt.steps, ctx);
      if (!honest) break;
      honest.scalar = scalarOf(graph, honest, weights);
      const before = byKey.has(honest.signature);
      const added = add(honest, 'alternate');
      if (!before) alternates.push(added);
      last = honest;
    }
  }

  // Sweep the weight simplex to trace the Pareto frontier.
  for (const wv of simplexGrid(5)) add(astar(graph, originId, destId, wv, ctx), 'sweep');

  const candidates = [...byKey.values()];
  for (const r of candidates) r.scalar = scalarOf(graph, r, weights);
  const pareto = new Set(paretoFront(candidates));
  for (const r of candidates) r.efficient = pareto.has(r);
  candidates.sort((a, b) => a.scalar - b.scalar);

  // Baseline: what this O/D costs in an undisrupted world, and what the old plan costs now.
  const baseline = astar(graph, originId, destId, weights, baselineCtx);
  const baselineNow = baseline ? evaluatePath(graph, baseline.steps, ctx) : null;

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { optimal, fastest, cheapest, greenest, alternates, candidates, baseline, baselineNow, computeMs: t1 - t0 };
}

export function scalarOf(graph, route, weights) {
  return scalarise(route.totals, normaliseWeights(weights), graph.scales);
}
