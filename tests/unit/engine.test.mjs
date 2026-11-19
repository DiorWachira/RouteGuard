import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORKS, haversineKm } from '../../js/data/corridorNetwork.js';
import { BinaryMinHeap, buildGraph, astar, neutralContext, solveScenario, evaluatePath, paretoFront, normaliseWeights } from '../../js/engine/pathfinder.js';
import { compileContext, makeClosure, makeCongestion, makeStorm, beaufort, CRISIS_PRESETS, edgeFractionInCircle } from '../../js/engine/disruptionEngine.js';
import { checkDigit, isValid, makeCode } from '../../js/engine/iso6346.js';
import { Sandbox } from '../../js/engine/simulation.js';

test('networks meet the size brief and reference valid nodes', () => {
  const g = NETWORKS.GLOBAL;
  const e = NETWORKS.EAFRICA;
  assert.ok(g.nodes.length >= 28, `global nodes ${g.nodes.length}`);
  assert.ok(g.edges.length >= 65, `global edges ${g.edges.length}`);
  assert.ok(e.nodes.length >= 16, `ea nodes ${e.nodes.length}`);
  assert.ok(e.edges.length >= 32, `ea edges ${e.edges.length}`);
  for (const net of [g, e]) {
    const ids = new Set(net.nodes.map((n) => n.id));
    assert.equal(ids.size, net.nodes.length, 'unique node ids');
    assert.equal(new Set(net.edges.map((x) => x.id)).size, net.edges.length, 'unique edge ids');
    for (const ed of net.edges) {
      assert.ok(ids.has(ed.from) && ids.has(ed.to));
      const straight = haversineKm(net.nodes.find((n) => n.id === ed.from).coords, net.nodes.find((n) => n.id === ed.to).coords);
      assert.ok(ed.distanceKm >= straight, `${ed.id} shorter than great circle`);
    }
  }
});

test('binary heap pops in priority order and supports decreaseKey', () => {
  const h = new BinaryMinHeap();
  const vals = Array.from({ length: 200 }, (_, i) => ({ k: `k${i}`, p: Math.sin(i * 7.1) * 100 }));
  for (const v of vals) h.push(v.k, v.p);
  h.decreaseKey('k10', -1000);
  assert.equal(h.pop().key, 'k10');
  let last = -Infinity;
  while (h.size) {
    const { priority } = h.pop();
    assert.ok(priority >= last);
    last = priority;
  }
});

test('A* equals Dijkstra (h = 0) on random O/D pairs and weights', () => {
  for (const net of Object.values(NETWORKS)) {
    const graph = buildGraph(net);
    const ctx = compileContext(net, { fuelShockPct: 30, disruptions: [makeStorm(net.nodes[3].coords, 500)] });
    for (let i = 0; i < 40; i++) {
      const a = net.nodes[(i * 7) % net.nodes.length].id;
      const b = net.nodes[(i * 13 + 5) % net.nodes.length].id;
      if (a === b) continue;
      const w = normaliseWeights({ time: (i % 5) + 0.1, cost: ((i * 3) % 7) + 0.1, co2: ((i * 11) % 4) + 0.1 });
      const r1 = astar(graph, a, b, w, ctx);
      const r2 = astar(graph, a, b, w, ctx, { useHeuristic: false });
      assert.ok(r1 && r2, `${a}->${b} reachable`);
      assert.ok(Math.abs(r1.scalar - r2.scalar) < 1e-9, `${net.id} ${a}->${b}: ${r1.scalar} vs ${r2.scalar}`);
      assert.ok(r1.expanded <= r2.expanded);
    }
  }
});

test('Suez closure forces a structural reroute away from SUZ', () => {
  const net = NETWORKS.GLOBAL;
  const graph = buildGraph(net);
  const w = { time: 0.4, cost: 0.4, co2: 0.2 };
  const base = astar(graph, 'SHA', 'RTM', w, neutralContext());
  assert.ok(base.nodes.includes('SUZ'), `baseline via ${base.nodes.join(' ')}`);
  const ctx = compileContext(net, { disruptions: [makeClosure({ nodeId: 'SUZ' })] });
  const r = astar(graph, 'SHA', 'RTM', w, ctx);
  assert.ok(r && !r.nodes.includes('SUZ'), `rerouted via ${r?.nodes.join(' ')}`);
  assert.equal(evaluatePath(graph, base.steps, ctx), null, 'old plan is impassable');
});

test('Mombasa strike diverts Kampala cargo through the Central Corridor', () => {
  const net = NETWORKS.EAFRICA;
  const graph = buildGraph(net);
  const preset = CRISIS_PRESETS.find((p) => p.id === 'mombasa');
  const { disruptions } = preset.build();
  const w = { time: 0.5, cost: 0.3, co2: 0.2 };
  const base = astar(graph, 'IOA', 'KLA', w, neutralContext());
  assert.ok(base.nodes.includes('MBA'));
  const r = astar(graph, 'IOA', 'KLA', w, compileContext(net, { disruptions }));
  assert.ok(!r.nodes.includes('MBA'), `strike route ${r.nodes.join(' ')}`);
});

test('scenario solve returns tagged candidates and a non-empty Pareto front', () => {
  const net = NETWORKS.GLOBAL;
  const graph = buildGraph(net);
  const s = solveScenario(graph, 'SHA', 'RTM', { time: 0.34, cost: 0.33, co2: 0.33 }, compileContext(net, {}));
  assert.ok(s.optimal && s.fastest && s.greenest && s.cheapest);
  assert.ok(s.candidates.length >= 3, `candidates ${s.candidates.length}`);
  assert.ok(paretoFront(s.candidates).length >= 1);
  assert.ok(s.fastest.totals.hours <= s.optimal.totals.hours + 1e-9);
  assert.ok(s.greenest.totals.co2 <= s.optimal.totals.co2 + 1e-9);
  assert.ok(s.computeMs < 250, `solve took ${s.computeMs} ms`);
});

test('storm intersection and Beaufort bands', () => {
  const e = NETWORKS.GLOBAL.edges.find((x) => x.id === 'BAB-SUZ-M');
  assert.ok(edgeFractionInCircle(e, [38, 21], 300) > 0.2);
  assert.equal(edgeFractionInCircle(e, [0, -60], 300), 0);
  assert.equal(beaufort(0).force, 0);
  assert.equal(beaufort(50).force, 7);
  assert.equal(beaufort(130).force, 12);
});

test('ISO 6346 check digits', () => {
  assert.equal(checkDigit('CSQU305438'), 3);
  assert.ok(isValid('CSQU3054383'));
  assert.ok(!isValid('CSQU3054384'));
  const c = makeCode(4217);
  assert.ok(isValid(c.compact));
});

test('sandbox convoy delivers, and holds/reroutes when a chokepoint closes ahead', () => {
  const net = NETWORKS.GLOBAL;
  const graph = buildGraph(net);
  const w = { time: 0.5, cost: 0.3, co2: 0.2 };
  let ctx = compileContext(net, {});
  const sb = new Sandbox({ rng: () => 0.5 });
  const route = astar(graph, 'SHA', 'RTM', w, ctx);
  const s = sb.dispatch(route, graph);
  sb.running = true;
  sb.speed = 72;
  // run until it is past Singapore but before Suez
  let guard = 0;
  while (!s.legs.slice(0, s.legIdx).some((l) => l.to === 'SIN') && guard++ < 5000) sb.tick(0.25, { graph, network: net, disruptions: [] });
  ctx = compileContext(net, { disruptions: [makeClosure({ nodeId: 'SUZ' })] });
  sb.onContextChanged(graph, ctx, w);
  const remaining = s.legs.slice(s.legIdx).map((l) => l.to);
  assert.ok(!remaining.includes('SUZ') || s.status === 'HOLDING', `remaining ${remaining.join(' ')} status ${s.status}`);
  guard = 0;
  while (s.phase !== 'done' && guard++ < 20000) sb.tick(0.25, { graph, network: net, disruptions: [] });
  assert.equal(s.status === 'HOLDING' ? 'HOLDING' : s.phase, s.status === 'HOLDING' ? 'HOLDING' : 'done');
  assert.ok(sb.log.length >= 2);
});

test('congestion raises transit time on the baseline path', () => {
  const net = NETWORKS.EAFRICA;
  const graph = buildGraph(net);
  const base = astar(graph, 'IOA', 'NBO', { time: 1, cost: 0, co2: 0 }, neutralContext());
  const ctx = compileContext(net, { disruptions: [makeCongestion('MBA', { delayHours: 48 })] });
  const again = evaluatePath(graph, base.steps, ctx);
  assert.ok(again.totals.hours > base.totals.hours + 47);
});

test('forecast: weatherAt advances with sim time and lane storms slow sea legs', async () => {
  const { weatherAt, weatherPoints } = await import('../../js/engine/disruptionEngine.js');
  const net = NETWORKS.GLOBAL;
  const pts = weatherPoints(net);
  assert.equal(pts.filter((p) => p.kind === 'lane').length, net.edges.filter((e) => e.mode === 'MARITIME').length);
  const series = {};
  for (const p of pts) {
    const calm = Array.from({ length: 168 }, () => 10);
    const wind = p.kind === 'lane' && p.id === 'CMB-BAB-M' ? calm.map((v, h) => (h >= 48 ? 95 : v)) : calm;
    series[`${p.kind}:${p.id}`] = { wind, precip: calm.map(() => 0), code: calm.map(() => 2), temp: calm.map(() => 25) };
  }
  const w = { fetchedAt: Date.now(), startMs: Date.now(), baseIndex: 0, series };
  const now = weatherAt(w, 0);
  const later = weatherAt(w, 60);
  assert.equal(now.byLane['CMB-BAB-M'].wind, 10);
  assert.equal(later.byLane['CMB-BAB-M'].wind, 95);
  assert.equal(later.lead, 60);
  assert.ok(weatherAt(w, 500).beyond);
  const calmCtx = compileContext(net, { weather: now });
  const stormCtx = compileContext(net, { weather: later });
  assert.equal(calmCtx.edgeMods.get('CMB-BAB-M'), undefined);
  assert.ok(stormCtx.edgeMods.get('CMB-BAB-M').speedFactor < 0.9);
});

test('mode constraints: excluding rail removes the land bridge, and all routes respect it', () => {
  const net = NETWORKS.GLOBAL;
  const graph = buildGraph(net);
  const ctx = compileContext(net, { disruptions: [makeClosure({ nodeId: 'SUZ' })], excludedModes: ['RAIL'] });
  const s = solveScenario(graph, 'SHA', 'RTM', { time: 1, cost: 0, co2: 0 }, ctx);
  assert.ok(s.candidates.length > 0);
  for (const r of s.candidates) assert.ok(r.legs.every((l) => l.mode !== 'RAIL'), r.nodes.join(' '));
  assert.ok(!s.fastest.nodes.includes('XIY'));
});

test('diesel drill shifts Mombasa–Dodoma off the road', () => {
  const net = NETWORKS.EAFRICA;
  const graph = buildGraph(net);
  const p = CRISIS_PRESETS.find((x) => x.id === 'diesel');
  const w = { time: 40, cost: 35, co2: 25 };
  const roadKm = (r) => r.legs.filter((l) => l.mode === 'ROAD').reduce((a, l) => a + l.distanceKm, 0);
  const calm = astar(graph, p.origin, p.destination, w, compileContext(net, {}));
  const shock = astar(graph, p.origin, p.destination, w, compileContext(net, p.build()));
  assert.ok(roadKm(shock) < roadKm(calm), `${roadKm(calm)} -> ${roadKm(shock)}`);
});
