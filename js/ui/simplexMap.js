/**
 * RouteGuard — Fig. 2 "Decision regions on the weight simplex".
 *
 * Every point of the triangle is a weight mix (w_t, w_c, w_e) with w_t + w_c + w_e = 1. The map is
 * tessellated into N² small triangles; for each one RouteGuard runs A* at the cell's centroid weights
 * and fills the cell by the winning route. Contiguous cells form decision regions, outlined where the
 * winner changes, so you can see exactly how far the weights must move before the plan flips.
 *
 *  • The plotted route's region is chart magenta (the signal colour's single job); other regions use
 *    ink hatch patterns and letters, never extra hues, so identity is not carried by colour alone.
 *  • The current weights are a lubber-line crosshair; click or drag anywhere to set new weights.
 *  • Keyboard: ↑ more time, ← more cost, → more carbon (5 % steps); readout is announced on focus.
 *  • Winners depend only on network, O/D and hazards, never on the current weights, so the map is
 *    recomputed lazily (chunked, cancellable) only when those change.
 */

import { astar } from '../engine/pathfinder.js';
import { escapeHtml, fmtTransit, fmtUsd, fmtCo2 } from './format.js';

const N = 12;
const LETTERS = 'ABCDEFGHIJKLMNOP';
const SQRT3_2 = Math.sqrt(3) / 2;

function css(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || '#888';
}

function makePattern(ctx, kind, ink, dpr) {
  const s = Math.round(8 * dpr);
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d');
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.lineWidth = Math.max(1, dpr);
  g.globalAlpha = 0.55;
  if (kind === 0) {
    g.globalAlpha = 0.16;
    g.fillRect(0, 0, s, s);
  } else if (kind === 1 || kind === 5) {
    g.beginPath();
    g.moveTo(0, s);
    g.lineTo(s, 0);
    g.moveTo(-s / 2, s / 2);
    g.lineTo(s / 2, -s / 2);
    g.moveTo(s / 2, s * 1.5);
    g.lineTo(s * 1.5, s / 2);
    g.stroke();
  }
  if (kind === 2 || kind === 5) {
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(s, s);
    g.moveTo(-s / 2, s / 2);
    g.lineTo(s / 2, s * 1.5);
    g.moveTo(s / 2, -s / 2);
    g.lineTo(s * 1.5, s / 2);
    g.stroke();
  } else if (kind === 3) {
    g.beginPath();
    g.arc(s / 2, s / 2, Math.max(1, dpr * 1.1), 0, Math.PI * 2);
    g.fill();
  } else if (kind === 4) {
    g.beginPath();
    g.moveTo(0, s / 2);
    g.lineTo(s, s / 2);
    g.stroke();
  }
  return ctx.createPattern(c, 'repeat');
}

export class SimplexMap {
  constructor(canvas, { onPick, readout, legend, announce } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPick = onPick;
    this.readout = readout;
    this.legendEl = legend;
    this.announce = announce ?? (() => {});
    this.cells = [];
    this.regions = [];
    this.weights = { time: 0.4, cost: 0.35, co2: 0.25 };
    this.selectedSig = null;
    this.key = null;
    this.token = 0;
    this.busy = false;
    this.hoverPt = null;
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.draw()) : null;
    this.ro?.observe(canvas.parentElement);
    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => {
      const w = this.#weightsAt(e);
      if (!w) return;
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.#pick(w);
    });
    canvas.addEventListener('pointermove', (e) => {
      const w = this.#weightsAt(e, !dragging);
      this.hoverPt = w;
      if (dragging && w) this.#pick(w);
      this.#showReadout(w);
      this.draw();
    });
    const end = () => (dragging = false);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      this.hoverPt = null;
      this.#showReadout(null);
      this.draw();
    });
    canvas.addEventListener('keydown', (e) => this.#key(e));
    canvas.addEventListener('focus', () => this.#showReadout(this.weights));
    canvas.addEventListener('blur', () => this.#showReadout(null));
  }

  /** Set current weights (raw or normalised) — only redraws the marker. */
  setWeights(w) {
    const s = (w.time + w.cost + w.co2) || 1;
    this.weights = { time: w.time / s, cost: w.cost / s, co2: w.co2 / s };
    this.draw();
    if (!this.hoverPt) this.#showReadout(null);
  }

  setSelected(sig) {
    if (sig === this.selectedSig) return;
    this.selectedSig = sig;
    this.draw();
    this.#legend();
  }

  /**
   * Recomputes decision regions when (network, O/D, hazard context) changes. Chunked so the UI never
   * blocks; a newer call cancels an older one.
   */
  compute(graph, origin, destination, ctx, key) {
    if (key === this.key) return;
    this.key = key;
    const token = ++this.token;
    this.busy = true;
    this.canvas.parentElement.classList.add('is-computing');
    const cells = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - i; j++) {
        // "up" cell
        cells.push({ v: [[i, j], [i + 1, j], [i, j + 1]] });
        // "down" cell
        if (i + j < N - 1) cells.push({ v: [[i + 1, j], [i, j + 1], [i + 1, j + 1]] });
      }
    }
    const routes = new Map();
    let k = 0;
    const step = () => {
      if (token !== this.token) return;
      const t0 = performance.now();
      while (k < cells.length && performance.now() - t0 < 10) {
        const c = cells[k++];
        const a = (c.v[0][0] + c.v[1][0] + c.v[2][0]) / (3 * N); // time
        const b = (c.v[0][1] + c.v[1][1] + c.v[2][1]) / (3 * N); // cost
        const w = { time: a, cost: b, co2: Math.max(0, 1 - a - b) };
        const r = astar(graph, origin, destination, w, ctx);
        c.sig = r?.signature ?? null;
        if (r && !routes.has(r.signature)) routes.set(r.signature, r);
      }
      if (k < cells.length) {
        setTimeout(step, 0);
        return;
      }
      this.cells = cells;
      const counts = new Map();
      for (const c of cells) if (c.sig) counts.set(c.sig, (counts.get(c.sig) ?? 0) + 1);
      this.regions = [...counts.entries()]
        .sort((x, y) => y[1] - x[1])
        .map(([sig, n], idx) => ({ sig, share: n / cells.length, letter: LETTERS[idx] ?? '?', pattern: idx, route: routes.get(sig) }));
      this.busy = false;
      this.canvas.parentElement.classList.remove('is-computing');
      this.draw();
      this.#legend();
      if (!this.hoverPt) this.#showReadout(null);
    };
    setTimeout(step, 0);
  }

  #geom() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(240, Math.floor(box.width));
    const h = Math.round(w * 0.78);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.patterns = null;
    }
    const side = Math.min(w - 56, (h - 44) / SQRT3_2);
    const cx = w / 2;
    const top = 24;
    const T = { x: cx, y: top };
    const C = { x: cx - side / 2, y: top + side * SQRT3_2 };
    const E = { x: cx + side / 2, y: top + side * SQRT3_2 };
    return { w, h, dpr, T, C, E };
  }

  #pt(G, a, b) {
    const c = 1 - a - b;
    return { x: a * G.T.x + b * G.C.x + c * G.E.x, y: a * G.T.y + b * G.C.y + c * G.E.y };
  }

  draw() {
    const G = this.#geom();
    const g = this.ctx;
    g.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    g.clearRect(0, 0, G.w, G.h);
    const ink = css('--ink');
    const ink2 = css('--ink-2');
    const ink3 = css('--ink-3');
    const signal = css('--signal');
    const panel = css('--panel');
    const rule = css('--rule-strong');
    if (!this.patterns || this.patternInk !== ink2) {
      this.patterns = [0, 1, 2, 3, 4, 5].map((k) => makePattern(g, k, ink2, G.dpr));
      this.patternInk = ink2;
    }
    const regionBySig = new Map(this.regions.map((r) => [r.sig, r]));

    // Cells
    for (const c of this.cells) {
      const p = c.v.map(([i, j]) => this.#pt(G, i / N, j / N));
      g.beginPath();
      g.moveTo(p[0].x, p[0].y);
      g.lineTo(p[1].x, p[1].y);
      g.lineTo(p[2].x, p[2].y);
      g.closePath();
      const r = regionBySig.get(c.sig);
      if (!c.sig) {
        g.fillStyle = panel;
      } else if (c.sig === this.selectedSig) {
        g.globalAlpha = 0.42;
        g.fillStyle = signal;
      } else {
        g.fillStyle = this.patterns[(r?.pattern ?? 0) % 6];
      }
      g.fill();
      g.globalAlpha = 1;
      // hairline seam fill to avoid anti-alias gaps
      g.strokeStyle = g.fillStyle;
      g.lineWidth = 0.6;
      if (c.sig === this.selectedSig) g.globalAlpha = 0.42;
      g.stroke();
      g.globalAlpha = 1;
    }

    // Region boundaries: shared edges whose two cells have different winners.
    if (this.cells.length) {
      const edges = new Map();
      for (const c of this.cells) {
        for (let e = 0; e < 3; e++) {
          const a = c.v[e];
          const b = c.v[(e + 1) % 3];
          const key = [a.join(','), b.join(',')].sort().join('|');
          const list = edges.get(key) ?? [];
          list.push(c.sig);
          edges.set(key, list);
        }
      }
      g.strokeStyle = ink;
      g.lineWidth = 1.5;
      g.beginPath();
      for (const [key, sigs] of edges) {
        if (sigs.length === 2 && sigs[0] !== sigs[1]) {
          const [a, b] = key.split('|').map((s) => s.split(',').map(Number));
          const p = this.#pt(G, a[0] / N, a[1] / N);
          const q = this.#pt(G, b[0] / N, b[1] / N);
          g.moveTo(p.x, p.y);
          g.lineTo(q.x, q.y);
        }
      }
      g.stroke();
    }

    // Frame + graduations every 20 %
    g.strokeStyle = rule;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(G.T.x, G.T.y);
    g.lineTo(G.C.x, G.C.y);
    g.lineTo(G.E.x, G.E.y);
    g.closePath();
    g.stroke();
    g.strokeStyle = ink3;
    for (let q = 1; q < 5; q++) {
      const f = q / 5;
      for (const [a, b] of [
        [f, 1 - f],
        [0, f],
        [1 - f, 0],
      ]) {
        const p = this.#pt(G, a, b);
        g.beginPath();
        g.arc(p.x, p.y, 1.4, 0, Math.PI * 2);
        g.fillStyle = ink3;
        g.fill();
      }
    }

    // Region letters at region centroids
    g.font = '600 10px "Martian Mono", ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const r of this.regions) {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const c of this.cells) {
        if (c.sig !== r.sig) continue;
        const a = (c.v[0][0] + c.v[1][0] + c.v[2][0]) / (3 * N);
        const b = (c.v[0][1] + c.v[1][1] + c.v[2][1]) / (3 * N);
        const p = this.#pt(G, a, b);
        sx += p.x;
        sy += p.y;
        n++;
      }
      if (!n || r.share < 0.02) continue;
      const x = sx / n;
      const y = sy / n;
      g.fillStyle = panel;
      g.fillRect(x - 8, y - 8, 16, 16);
      g.strokeStyle = r.sig === this.selectedSig ? signal : ink2;
      g.lineWidth = 1;
      g.strokeRect(x - 7.5, y - 7.5, 15, 15);
      g.fillStyle = r.sig === this.selectedSig ? signal : ink;
      g.fillText(r.letter, x, y + 0.5);
    }

    // Vertex labels
    g.font = '600 9.5px "Martian Mono", ui-monospace, monospace';
    g.fillStyle = ink2;
    g.textBaseline = 'bottom';
    g.fillText('TIME 100%', G.T.x, G.T.y - 6);
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillText('COST', G.C.x - 4, G.C.y + 7);
    g.textAlign = 'right';
    g.fillText('CARBON', G.E.x + 4, G.E.y + 7);

    // Current weights: lubber-line crosshair
    const m = this.#pt(G, this.weights.time, this.weights.cost);
    g.strokeStyle = panel;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(m.x, m.y, 7, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = ink;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(m.x, m.y, 7, 0, Math.PI * 2);
    g.moveTo(m.x - 12, m.y);
    g.lineTo(m.x - 3, m.y);
    g.moveTo(m.x + 3, m.y);
    g.lineTo(m.x + 12, m.y);
    g.moveTo(m.x, m.y - 12);
    g.lineTo(m.x, m.y - 3);
    g.moveTo(m.x, m.y + 3);
    g.lineTo(m.x, m.y + 12);
    g.stroke();

    // Hover ghost
    if (this.hoverPt) {
      const h = this.#pt(G, this.hoverPt.time, this.hoverPt.cost);
      g.strokeStyle = ink2;
      g.setLineDash([2, 2]);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(h.x, h.y, 6, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }

    if (this.busy) {
      g.fillStyle = ink3;
      g.font = '500 9px "Martian Mono", ui-monospace, monospace';
      g.textAlign = 'right';
      g.textBaseline = 'top';
      g.fillText('MAPPING…', G.w - 4, 4);
    }
  }

  /** Screen point → barycentric weights; null when outside (unless clamp). */
  #weightsAt(e, strict = false) {
    const G = this.#geom();
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { T, C, E } = G;
    const det = (C.y - E.y) * (T.x - E.x) + (E.x - C.x) * (T.y - E.y);
    let a = ((C.y - E.y) * (x - E.x) + (E.x - C.x) * (y - E.y)) / det;
    let b = ((E.y - T.y) * (x - E.x) + (T.x - E.x) * (y - E.y)) / det;
    let c = 1 - a - b;
    const outside = a < -0.04 || b < -0.04 || c < -0.04;
    if (strict && outside) return null;
    a = Math.max(0, a);
    b = Math.max(0, b);
    c = Math.max(0, c);
    const s = a + b + c || 1;
    return { time: a / s, cost: b / s, co2: c / s };
  }

  #winnerAt(w) {
    if (!this.cells.length || !w) return null;
    const i = w.time * N;
    const j = w.cost * N;
    const fi = Math.min(N - 1, Math.floor(i));
    const fj = Math.min(N - 1 - fi, Math.floor(j));
    const up = i - fi + (j - fj) <= 1;
    const want = up ? `${fi},${fj}|${fi + 1},${fj}|${fi},${fj + 1}` : `${fi + 1},${fj}|${fi},${fj + 1}|${fi + 1},${fj + 1}`;
    const c = this.cells.find((x) => x.v.map((v) => v.join(',')).join('|') === want);
    return this.regions.find((r) => r.sig === c?.sig) ?? null;
  }

  #pick(w) {
    const q = { time: Math.round(w.time * 100), cost: Math.round(w.cost * 100), co2: 0 };
    q.co2 = Math.max(0, 100 - q.time - q.cost);
    cancelAnimationFrame(this.pickRaf);
    this.pickRaf = requestAnimationFrame(() => this.onPick?.(q));
  }

  #showReadout(w) {
    if (!this.readout) return;
    // Below-the-figure readout: shows the hovered mix, or the current mix when idle.
    if (!w) w = this.weights;
    const r = this.#winnerAt(w);
    const pct = (v) => `${Math.round(v * 100)}%`;
    this.readout.innerHTML = `<div class="ro-tags">w<sub>t</sub> ${pct(w.time)} · w<sub>c</sub> ${pct(w.cost)} · w<sub>e</sub> ${pct(w.co2)}</div>${
      r ? `<div class="ro-via"><b>${r.letter}</b> ${r.route.nodes.map(escapeHtml).join(' › ')}</div><dl><div><dt>Transit</dt><dd>${fmtTransit(r.route.totals.hours)}</dd></div><div><dt>Cost</dt><dd>${fmtUsd(r.route.totals.cost)}</dd></div><div><dt>CO₂e</dt><dd>${fmtCo2(r.route.totals.co2)}</dd></div></dl><div class="ro-hint">${w === this.weights ? 'Current mix · hover to explore, click or drag to set' : 'Click or drag to set these weights'}</div>` : '<div class="ro-hint">Mapping regions…</div>'
    }`;
    this.readout.hidden = false;
  }

  #legend() {
    if (!this.legendEl) return;
    if (!this.regions.length) {
      this.legendEl.innerHTML = this.busy ? '' : '<li class="empty">No passable route at any weight mix.</li>';
      return;
    }
    this.legendEl.innerHTML = this.regions
      .slice(0, 6)
      .map(
        (r) => `<li class="${r.sig === this.selectedSig ? 'is-sel' : ''}"><span class="sx-swatch sx-p${r.pattern % 6}${r.sig === this.selectedSig ? ' sx-sel' : ''}" aria-hidden="true"></span><b class="mono">${r.letter}</b><span class="mono sx-via">${r.route.nodes.map(escapeHtml).join(' › ')}</span><span class="mono sx-share">${Math.round(r.share * 100)}%</span></li>`,
      )
      .join('');
  }

  #key(e) {
    const step = 0.05;
    const w = { ...this.weights };
    const bump = (k) => {
      const others = ['time', 'cost', 'co2'].filter((x) => x !== k);
      const room = Math.min(step, 1 - w[k]);
      const sum = w[others[0]] + w[others[1]];
      if (sum <= 0 || room <= 0) return;
      w[k] += room;
      for (const o of others) w[o] = Math.max(0, w[o] - (room * w[o]) / sum);
    };
    if (e.key === 'ArrowUp') bump('time');
    else if (e.key === 'ArrowLeft') bump('cost');
    else if (e.key === 'ArrowRight') bump('co2');
    else if (e.key === 'ArrowDown') {
      // move away from time, toward the cost/carbon edge
      const room = Math.min(step, w.time);
      const sum = w.cost + w.co2 || 1;
      w.time -= room;
      w.cost += (room * (w.cost || 0.5)) / (sum || 1);
      w.co2 = Math.max(0, 1 - w.time - w.cost);
    } else return;
    e.preventDefault();
    this.#pick(w);
    this.weights = w;
    this.#showReadout(w);
    const r = this.#winnerAt(w);
    if (r) this.announce(`Weights ${Math.round(w.time * 100)} ${Math.round(w.cost * 100)} ${Math.round(w.co2 * 100)}: region ${r.letter}`);
    this.draw();
  }
}
