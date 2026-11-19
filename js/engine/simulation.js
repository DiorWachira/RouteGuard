/**
 * RouteGuard — live sandbox simulation.
 *
 * A simulated clock (sim-hours) drives cargo convoys through their planned legs. Each leg runs as a
 * state machine: DEPART (terminal call, transfer, queue, strike delay) → UNDERWAY (line-haul) →
 * ARRIVE (import call, final leg only). Whenever the disruption context changes, every convoy
 * re-evaluates the remainder of its plan from the next decision node:
 *   • remainder blocked            → re-plan with A* from that node (REROUTED) or HOLD / STRAND
 *   • a ≥ 7 % better plan exists   → re-plan (REROUTED)
 *   • otherwise                    → re-time the remainder (DELAYED if the ETA slips > 6 h)
 * Convoys steaming toward a node that has just closed hold position at sea until it reopens.
 */

import { astar, evaluatePath, scalarOf } from './pathfinder.js';
import { randomDisruption } from './disruptionEngine.js';
import { makeCode } from './iso6346.js';

export const SPEEDS = [2, 8, 24, 72]; // sim-hours per real second
const LOG_MAX = 160;
const REROUTE_GAIN = 0.07;

function unwrapCoords(coords) {
  const out = [coords[0].slice()];
  for (let i = 1; i < coords.length; i++) {
    let lng = coords[i][0];
    const prev = out[i - 1][0];
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    out.push([lng, coords[i][1]]);
  }
  return out;
}

function cumulative(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i][0] - coords[i - 1][0]) * Math.cos(((coords[i][1] + coords[i - 1][1]) / 2) * (Math.PI / 180));
    const dy = coords[i][1] - coords[i - 1][1];
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return cum;
}

export function pointAlong(coords, t) {
  const u = unwrapCoords(coords);
  const cum = cumulative(u);
  const total = cum[cum.length - 1] || 1;
  const target = Math.max(0, Math.min(1, t)) * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const f = (target - cum[i - 1]) / seg;
  let lng = u[i - 1][0] + (u[i][0] - u[i - 1][0]) * f;
  const lat = u[i - 1][1] + (u[i][1] - u[i - 1][1]) * f;
  const bearing = (Math.atan2(u[i][0] - u[i - 1][0], u[i][1] - u[i - 1][1]) * 180) / Math.PI;
  while (lng > 180) lng -= 360;
  while (lng < -180) lng += 360;
  return { coords: [lng, lat], bearing: (bearing + 360) % 360 };
}

export class Sandbox {
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.simHours = 0;
    this.running = false;
    this.speed = 8;
    this.shipments = [];
    this.log = [];
    this.autoDispatch = false;
    this.autoEvery = 36;
    this.lastAuto = 0;
    this.chaos = false;
    this.nextChaosAt = 30;
    this.serial = 4200 + Math.floor(this.rng() * 500);
    this.version = 0;
    this.stats = { dispatched: 0, delivered: 0, onTime: 0, delayH: 0, reroutes: 0, holds: 0, co2Kg: 0, costUsd: 0, teuKm: 0, transitH: 0 };
  }

  note(kind, text, ref = null) {
    this.log.unshift({ t: this.simHours, kind, text, ref });
    if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
    this.version++;
  }

  get active() {
    return this.shipments.filter((s) => s.phase !== 'done');
  }

  /** Launches a convoy along a computed route. */
  dispatch(route, graph, { label = null } = {}) {
    if (!route) return null;
    const code = makeCode(this.serial++);
    const s = {
      id: code.compact,
      code,
      origin: route.nodes[0],
      dest: route.nodes[route.nodes.length - 1],
      legs: route.legs.map((l) => ({ ...l })),
      legIdx: 0,
      phase: 'depart',
      phaseElapsed: 0,
      departedAt: this.simHours,
      plannedHours: route.totals.hours,
      plannedEta: this.simHours + route.totals.hours,
      eta: this.simHours + route.totals.hours,
      status: 'ON_TRACK',
      reroutes: 0,
      holdReason: null,
      deliveredAt: null,
      costUsd: route.totals.cost,
      co2Kg: route.totals.co2,
      label,
    };
    this.shipments.unshift(s);
    this.stats.dispatched++;
    if (this.shipments.length > 14) {
      const idx = this.shipments.findIndex((x, i) => i > 6 && x.phase === 'done');
      if (idx > -1) this.shipments.splice(idx, 1);
    }
    const o = graph.nodes.get(s.origin);
    const d = graph.nodes.get(s.dest);
    this.note('dispatch', `${code.owner} ${code.serial} ${code.check} dispatched ${o.code} → ${d.code}, ETA ${fmtDuration(route.totals.hours)}`, s.id);
    return s;
  }

  #phaseDuration(s) {
    const leg = s.legs[s.legIdx];
    if (!leg) return 0;
    if (s.phase === 'depart') return leg.breakdown.departH;
    if (s.phase === 'underway') return leg.breakdown.travelH;
    if (s.phase === 'arrive') return leg.breakdown.arriveH;
    return 0;
  }

  #remainingHours(s) {
    if (s.phase === 'done') return 0;
    let rem = Math.max(0, this.#phaseDuration(s) - s.phaseElapsed);
    const leg = s.legs[s.legIdx];
    if (s.phase === 'depart') rem += leg.breakdown.travelH + leg.breakdown.arriveH;
    else if (s.phase === 'underway') rem += leg.breakdown.arriveH;
    for (let i = s.legIdx + 1; i < s.legs.length; i++) rem += s.legs[i].hours;
    return rem;
  }

  #advanceShipment(s, dt, graph) {
    if (s.phase === 'done' || s.holdReason) return;
    let left = dt;
    let guard = 0;
    while (left > 0 && s.phase !== 'done' && guard++ < 64) {
      const dur = this.#phaseDuration(s);
      const need = dur - s.phaseElapsed;
      if (need > left) {
        s.phaseElapsed += left;
        left = 0;
        break;
      }
      left -= Math.max(0, need);
      s.phaseElapsed = 0;
      const last = s.legIdx === s.legs.length - 1;
      if (s.phase === 'depart') s.phase = 'underway';
      else if (s.phase === 'underway') {
        if (last) s.phase = 'arrive';
        else {
          s.legIdx++;
          s.phase = 'depart';
        }
      } else if (s.phase === 'arrive') {
        s.phase = 'done';
        s.status = 'DELIVERED';
        s.deliveredAt = this.simHours - left;
        const late = s.deliveredAt - s.plannedEta;
        const st = this.stats;
        st.delivered++;
        if (late <= 12) st.onTime++;
        st.delayH += Math.max(0, late);
        st.transitH += s.deliveredAt - s.departedAt;
        for (const l of s.legs) {
          st.co2Kg += l.co2;
          st.costUsd += l.cost;
          st.teuKm += l.distanceKm;
        }
        const d = graph.nodes.get(s.dest);
        this.note('deliver', `${s.code.owner} ${s.code.serial} ${s.code.check} delivered at ${d.code} after ${fmtDuration(s.deliveredAt - s.departedAt)}${Math.abs(late) > 1 ? ` (${late > 0 ? '+' : '−'}${fmtDuration(Math.abs(late))} vs plan)` : ', on plan'}`, s.id);
      }
    }
  }

  /**
   * Advances the clock. Returns events for the owner (expired disruption ids, chaos spawn, storm drift).
   */
  tick(dtSec, { graph, network, disruptions }) {
    const events = { expired: [], spawned: null, drifted: false, advanced: 0 };
    if (!this.running || !graph) return events;
    const dt = Math.min(dtSec, 0.25) * this.speed;
    this.simHours += dt;
    events.advanced = dt;
    for (const s of this.shipments) this.#advanceShipment(s, dt, graph);
    for (const s of this.active) s.eta = this.simHours + this.#remainingHours(s);

    for (const d of disruptions) {
      if (d.durationH != null && this.simHours >= d.startedAt + d.durationH) events.expired.push(d.id);
      if (d.kind === 'STORM' && d.drift) {
        d.center = [d.center[0] + d.drift[0] * dt, d.center[1] + d.drift[1] * dt];
        events.drifted = true;
      }
    }
    if (this.autoDispatch && this.simHours - this.lastAuto >= this.autoEvery) {
      this.lastAuto = this.simHours;
      events.autoDispatch = true;
    }
    if (this.chaos && this.simHours >= this.nextChaosAt) {
      this.nextChaosAt = this.simHours + 30 + this.rng() * 60;
      const live = disruptions.filter((d) => d.source === 'chaos').length;
      if (live < 4) events.spawned = randomDisruption(network, this.simHours, this.rng);
    }
    return events;
  }

  /** Re-time / re-route every convoy after the disruption context changed. */
  onContextChanged(graph, ctx, weights) {
    for (const s of this.active) {
      if (s.phase === 'arrive') continue;
      const i = s.legIdx;
      const leg = s.legs[i];
      if (!leg || !graph.edges.has(leg.edgeId)) continue; // convoy belongs to another network

      // Decide where the convoy can next make a decision.
      let fromIdx;
      let decisionNode;
      let prevMode;
      let midRoute = true;
      if (s.phase === 'underway') {
        const toMod = ctx.nodeMods.get(leg.to);
        const edgeMod = ctx.edgeMods.get(leg.edgeId);
        if (toMod?.closed || edgeMod?.closed) {
          if (!s.holdReason) {
            s.holdReason = toMod?.closed ? `${graph.nodes.get(leg.to).name} closed ahead` : 'corridor closed ahead';
            s.status = 'HOLDING';
            this.stats.holds++;
            this.note('hold', `${s.code.owner} ${s.code.serial} ${s.code.check} holding position — ${s.holdReason}`, s.id);
          }
          continue;
        }
        if (s.holdReason) {
          this.note('resume', `${s.code.owner} ${s.code.serial} ${s.code.check} resumes passage`, s.id);
          s.holdReason = null;
        }
        // Re-time the current line-haul leg (storms can slow a leg already underway).
        const cur = evaluatePath(graph, [{ edgeId: leg.edgeId, from: leg.from, to: leg.to }], ctx, { startMode: i > 0 ? s.legs[i - 1].mode : null, midRoute: i > 0 });
        if (cur) {
          const frac = leg.breakdown.travelH ? s.phaseElapsed / leg.breakdown.travelH : 0;
          leg.breakdown = { ...leg.breakdown, travelH: cur.legs[0].breakdown.travelH, arriveH: leg.breakdown.arriveH };
          s.phaseElapsed = frac * leg.breakdown.travelH;
        }
        fromIdx = i + 1;
        decisionNode = leg.to;
        prevMode = leg.mode;
        if (fromIdx >= s.legs.length) continue;
      } else {
        fromIdx = i;
        decisionNode = leg.from;
        prevMode = i > 0 ? s.legs[i - 1].mode : s.startMode ?? null;
        midRoute = i > 0 || Boolean(s.startMode);
      }

      const remainingSteps = s.legs.slice(fromIdx).map((l) => ({ edgeId: l.edgeId, from: l.from, to: l.to }));
      const current = evaluatePath(graph, remainingSteps, ctx, { startMode: prevMode, midRoute });
      const best = astar(graph, decisionNode, s.dest, weights, ctx, midRoute ? { startMode: prevMode ?? 'MARITIME' } : {});
      const fresh = best ? evaluatePath(graph, best.steps, ctx, { startMode: prevMode, midRoute }) : null;

      let next = current;
      if (!current && !fresh) {
        if (s.status !== 'STRANDED') {
          s.status = 'STRANDED';
          s.holdReason = s.phase === 'underway' ? null : 'no passable route';
          this.note('hold', `${s.code.owner} ${s.code.serial} ${s.code.check} stranded at ${graph.nodes.get(decisionNode).code} — no passable route`, s.id);
        }
        if (s.phase !== 'underway') continue;
        continue;
      }
      if (s.status === 'STRANDED') {
        s.holdReason = null;
        s.status = 'DELAYED';
        this.note('resume', `${s.code.owner} ${s.code.serial} ${s.code.check} cleared to proceed from ${graph.nodes.get(decisionNode).code}`, s.id);
      }
      const curScore = current ? scalarOf(graph, current, weights) : Infinity;
      const freshScore = fresh ? scalarOf(graph, fresh, weights) : Infinity;
      if (fresh && (!current || (freshScore < curScore * (1 - REROUTE_GAIN) && fresh.signature !== current.signature))) {
        next = fresh;
        s.reroutes++;
        this.stats.reroutes++;
        s.status = 'REROUTED';
        const saved = current ? current.totals.hours - fresh.totals.hours : null;
        const via = fresh.nodes.slice(1, -1).map((id) => graph.nodes.get(id).code).join(' · ') || 'direct';
        this.note('reroute', `${s.code.owner} ${s.code.serial} ${s.code.check} rerouted at ${graph.nodes.get(decisionNode).code} via ${via}${current ? ` (${saved >= 0 ? 'saves' : 'costs'} ${fmtDuration(Math.abs(saved))})` : ' — previous plan blocked'}`, s.id);
      }
      // Splice the new remainder into the plan, keeping progress within the current phase.
      const keep = s.legs.slice(0, fromIdx);
      s.legs = [...keep, ...next.legs.map((l, k) => ({ ...l, index: fromIdx + k }))];
      if (s.phase === 'depart') s.phaseElapsed = Math.min(s.phaseElapsed, s.legs[i].breakdown.departH);
    }
    for (const s of this.active) {
      s.eta = this.simHours + this.#remainingHours(s);
      if (s.status === 'ON_TRACK' && s.eta - s.plannedEta > 6) s.status = 'DELAYED';
    }
    this.version++;
  }

  /** Current convoy positions for rendering. */
  positions(graph) {
    const out = [];
    for (const s of this.shipments) {
      if (s.phase === 'done' && this.simHours - s.deliveredAt > 24) continue;
      const leg = s.legs[Math.min(s.legIdx, s.legs.length - 1)];
      let p;
      if (s.phase === 'underway') {
        const f = leg.breakdown.travelH ? s.phaseElapsed / leg.breakdown.travelH : 1;
        p = pointAlong(leg.coords, f);
      } else if (s.phase === 'depart') {
        p = { coords: graph.nodes.get(leg.from).coords, bearing: 0 };
      } else {
        p = { coords: graph.nodes.get(s.dest).coords, bearing: 0 };
      }
      out.push({ id: s.id, code: s.code, coords: p.coords, bearing: p.bearing, status: s.status, phase: s.phase, mode: leg.mode, shipment: s });
    }
    return out;
  }

  /** Coordinates still ahead of a convoy: rest of the current leg, then every remaining leg. */
  remainingPath(s, graph) {
    if (!s || s.phase === 'done') return [];
    const leg = s.legs[Math.min(s.legIdx, s.legs.length - 1)];
    const out = [];
    if (s.phase === 'underway') {
      const t = leg.breakdown.travelH ? s.phaseElapsed / leg.breakdown.travelH : 1;
      const u = unwrapCoords(leg.coords);
      const cum = cumulative(u);
      const total = cum[cum.length - 1] || 1;
      out.push(pointAlong(leg.coords, t).coords);
      for (let i = 0; i < u.length; i++) if (cum[i] / total > t) out.push(leg.coords[i]);
    } else if (s.phase === 'depart') {
      out.push(...leg.coords);
    } else {
      out.push(graph.nodes.get(s.dest).coords);
    }
    for (let i = s.legIdx + 1; i < s.legs.length; i++) out.push(...s.legs[i].coords.slice(1));
    return out;
  }

  progress(s) {
    const total = s.eta - s.departedAt;
    if (s.phase === 'done') return 1;
    return total > 0 ? Math.min(1, (this.simHours - s.departedAt) / total) : 0;
  }
}

export function fmtDuration(h) {
  if (!isFinite(h)) return '—';
  const sign = h < 0 ? '−' : '';
  const a = Math.abs(h);
  if (a < 48) return `${sign}${a.toFixed(a < 10 ? 1 : 0)} h`;
  const d = Math.floor(a / 24);
  const r = Math.round(a - d * 24);
  return `${sign}${d} d ${r} h`;
}

export function fmtSimClock(h) {
  const d = Math.floor(h / 24);
  const hh = Math.floor(h - d * 24);
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `D+${String(d).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
