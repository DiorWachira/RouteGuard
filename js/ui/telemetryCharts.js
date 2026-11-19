/**
 * RouteGuard — telemetry graphics.
 *
 *  ParetoChart  High-DPI canvas trade-off plot: x = landed cost (USD/TEU), y = transit (days),
 *               bubble area ∝ CO₂e. The 2-D cost/time frontier is drawn as a staircase, the plotted
 *               (selected) route is chart magenta, efficient routes are solid, dominated ones hollow,
 *               and the undisrupted baseline is a cross so the disruption's shift is visible.
 *               Hover / focus shows a readout; click or Enter plots that route on the chart.
 *  legStrip     Proportional leg-by-leg strip (mode colour, call time hatched) reused in lists.
 */

import { fmtTransit, fmtUsd, fmtCo2, escapeHtml, MODE_SHORT } from './format.js';

const TAG_LETTER = { optimal: 'O', fastest: 'F', cheapest: '$', greenest: 'G' };

function css(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || '#888';
}

export class ParetoChart {
  constructor(canvas, { onHover, onSelect, readout } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHover = onHover;
    this.onSelect = onSelect;
    this.readout = readout;
    this.points = [];
    this.hoverIdx = -1;
    this.focusIdx = -1;
    this.data = { candidates: [], selected: null, baseline: null };
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.draw()) : null;
    this.ro?.observe(canvas.parentElement);
    canvas.addEventListener('mousemove', (e) => this.#pointer(e));
    canvas.addEventListener('mouseleave', () => this.#setHover(-1));
    canvas.addEventListener('click', (e) => {
      const i = this.#hit(e);
      if (i > -1) this.onSelect?.(this.points[i].route);
    });
    canvas.addEventListener('keydown', (e) => this.#key(e));
    canvas.addEventListener('blur', () => this.#setHover(-1));
  }

  setData(candidates, selected, baseline) {
    this.data = { candidates: candidates ?? [], selected, baseline };
    this.draw();
  }

  #layout() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(240, Math.floor(box.width));
    const h = Math.max(200, Math.round(w * 0.62));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    return { w, h, dpr, pad: { l: 50, r: 16, t: 14, b: 38 } };
  }

  draw() {
    const { candidates, selected, baseline } = this.data;
    const { w, h, dpr, pad } = this.#layout();
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const ink = css('--ink');
    const ink2 = css('--ink-2');
    const ink3 = css('--ink-3');
    const rule = css('--rule');
    const signal = css('--signal');
    const surface = css('--panel');
    const hazard = css('--hazard');
    const mono = '500 10px "Martian Mono", ui-monospace, monospace';

    const all = [...candidates];
    if (!all.length) {
      g.fillStyle = ink3;
      g.font = mono;
      g.textAlign = 'center';
      g.fillText('NO PASSABLE ROUTE TO PLOT', w / 2, h / 2);
      this.points = [];
      return;
    }
    const xs = all.map((r) => r.totals.cost);
    const ys = all.map((r) => r.totals.hours / 24);
    if (baseline) {
      xs.push(baseline.totals.cost);
      ys.push(baseline.totals.hours / 24);
    }
    const nice = (lo, hi) => {
      const span = Math.max(hi - lo, hi * 0.08, 1e-6);
      return [Math.max(0, lo - span * 0.12), hi + span * 0.12];
    };
    const [x0, x1] = nice(Math.min(...xs), Math.max(...xs));
    const [y0, y1] = nice(Math.min(...ys), Math.max(...ys));
    const X = (v) => pad.l + ((v - x0) / (x1 - x0)) * (w - pad.l - pad.r);
    const Y = (v) => h - pad.b - ((v - y0) / (y1 - y0)) * (h - pad.t - pad.b);
    const co2s = all.map((r) => r.totals.co2);
    const cMax = Math.max(...co2s);
    const R = (c) => 4 + Math.sqrt(c / cMax) * 11;

    // grid + axes (recessive)
    g.strokeStyle = rule;
    g.lineWidth = 1;
    g.font = mono;
    g.fillStyle = ink3;
    const ticks = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of ticks(y0, y1, 4)) {
      const y = Math.round(Y(v)) + 0.5;
      g.beginPath();
      g.moveTo(pad.l, y);
      g.lineTo(w - pad.r, y);
      g.stroke();
      g.fillText(`${v.toFixed(v < 10 ? 1 : 0)}d`, pad.l - 6, y);
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const v of ticks(x0, x1, 4)) {
      const x = Math.round(X(v)) + 0.5;
      g.beginPath();
      g.moveTo(x, pad.t);
      g.lineTo(x, h - pad.b);
      g.stroke();
      g.fillText(`$${Math.round(v / 10) * 10 >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)}`, x, h - pad.b + 6);
    }
    g.fillStyle = ink2;
    g.textAlign = 'left';
    g.fillText('LANDED COST  USD / TEU  →', pad.l, h - 14);
    g.save();
    g.translate(11, pad.t + 2);
    g.rotate(Math.PI / 2);
    g.textBaseline = 'middle';
    g.fillText('← TRANSIT  DAYS', 0, 0);
    g.restore();

    // 2-D cost/time frontier staircase
    const sorted = [...all].sort((a, b) => a.totals.cost - b.totals.cost);
    const front = [];
    let best = Infinity;
    for (const r of sorted) if (r.totals.hours < best - 1e-6) {
      front.push(r);
      best = r.totals.hours;
    }
    if (front.length > 1) {
      g.strokeStyle = ink2;
      g.setLineDash([3, 3]);
      g.beginPath();
      front.forEach((r, i) => {
        const x = X(r.totals.cost);
        const y = Y(r.totals.hours / 24);
        if (i === 0) g.moveTo(x, y);
        else {
          g.lineTo(x, Y(front[i - 1].totals.hours / 24));
          g.lineTo(x, y);
        }
      });
      g.stroke();
      g.setLineDash([]);
    }

    // baseline marker (undisrupted world)
    if (baseline) {
      const bx = X(baseline.totals.cost);
      const by = Y(baseline.totals.hours / 24);
      g.strokeStyle = hazard;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(bx - 5, by - 5);
      g.lineTo(bx + 5, by + 5);
      g.moveTo(bx + 5, by - 5);
      g.lineTo(bx - 5, by + 5);
      g.stroke();
      g.fillStyle = hazard;
      g.font = mono;
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText('CALM', bx + 7, by - 3);
    }

    // points: dominated first, then efficient, then selected on top
    this.points = all.map((r) => ({ route: r, x: X(r.totals.cost), y: Y(r.totals.hours / 24), r: R(r.totals.co2) }));
    const order = [...this.points].sort((a, b) => (a.route === selected) - (b.route === selected) || (a.route.efficient - b.route.efficient) || b.r - a.r);
    for (const p of order) {
      const isSel = p.route === selected;
      const isHover = this.points[this.hoverIdx] === p || this.points[this.focusIdx] === p;
      g.beginPath();
      g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      if (isSel) {
        g.fillStyle = signal;
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = surface;
        g.stroke();
      } else if (p.route.efficient) {
        g.fillStyle = ink;
        g.globalAlpha = 0.78;
        g.fill();
        g.globalAlpha = 1;
        g.lineWidth = 2;
        g.strokeStyle = surface;
        g.stroke();
      } else {
        g.lineWidth = 1.5;
        g.strokeStyle = ink2;
        g.stroke();
      }
      if (isHover) {
        g.beginPath();
        g.arc(p.x, p.y, p.r + 4, 0, Math.PI * 2);
        g.lineWidth = 1.5;
        g.strokeStyle = isSel ? signal : ink;
        g.stroke();
      }
      const letters = [...p.route.tags].map((t) => TAG_LETTER[t]).filter(Boolean).join('');
      if (letters) {
        g.font = '600 10px "Martian Mono", ui-monospace, monospace';
        g.fillStyle = isSel ? signal : ink2;
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(letters, p.x + p.r + 4, p.y);
      }
    }
  }

  #hit(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best = -1;
    let bestD = Infinity;
    this.points.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.y - y) - p.r;
      if (d < 8 && d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  #pointer(e) {
    const i = this.#hit(e);
    this.canvas.style.cursor = i > -1 ? 'pointer' : 'default';
    this.#setHover(i);
  }

  #setHover(i) {
    if (i === this.hoverIdx) return;
    this.hoverIdx = i;
    this.draw();
    const p = this.points[i];
    this.onHover?.(p?.route ?? null);
    this.#readout(p);
  }

  #readout(p) {
    if (!this.readout) return;
    if (!p) {
      this.readout.hidden = true;
      return;
    }
    const r = p.route;
    const tags = [...r.tags].filter((t) => t !== 'sweep').map((t) => t.toUpperCase()).join(' · ') || 'SWEEP';
    this.readout.innerHTML = `<div class="ro-tags">${escapeHtml(tags)}${r.efficient ? ' · <b>PARETO</b>' : ' · dominated'}</div>
      <div class="ro-via">${r.nodes.map(escapeHtml).join(' › ')}</div>
      <dl><div><dt>Transit</dt><dd>${fmtTransit(r.totals.hours)}</dd></div><div><dt>Cost</dt><dd>${fmtUsd(r.totals.cost)}</dd></div><div><dt>CO₂e</dt><dd>${fmtCo2(r.totals.co2)}</dd></div></dl>
      <div class="ro-hint">Click to plot this track</div>`;
    this.readout.hidden = false;
    const box = this.canvas.parentElement.getBoundingClientRect();
    const rw = this.readout.offsetWidth || 200;
    const left = p.x + 14 + rw > box.width ? p.x - 14 - rw : p.x + 14;
    this.readout.style.left = `${Math.max(0, left)}px`;
    this.readout.style.top = `${Math.max(0, p.y - 20)}px`;
  }

  #key(e) {
    if (!this.points.length) return;
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      const order = this.points.map((p, i) => ({ p, i })).sort((a, b) => a.p.x - b.p.x);
      let k = order.findIndex((o) => o.i === this.focusIdx);
      k = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (k + 1) % order.length : (k - 1 + order.length) % order.length;
      this.focusIdx = order[k].i;
      this.hoverIdx = -1;
      this.draw();
      this.#readout(this.points[this.focusIdx]);
      this.onHover?.(this.points[this.focusIdx].route);
    } else if ((e.key === 'Enter' || e.key === ' ') && this.focusIdx > -1) {
      e.preventDefault();
      this.onSelect?.(this.points[this.focusIdx].route);
    }
  }
}

/** Proportional leg strip: one segment per leg, mode-coloured, call time hatched. */
export function legStrip(route, { height = 8, showLabels = false } = {}) {
  if (!route) return '<div class="strip strip--empty"></div>';
  const total = route.totals.hours || 1;
  const segs = route.legs
    .map((l) => {
      const callH = l.breakdown.departH + l.breakdown.arriveH;
      const wCall = (callH / total) * 100;
      const wRun = (l.breakdown.travelH / total) * 100;
      const alert = l.alerts.length ? ' has-alert' : '';
      return `<span class="seg seg--call${alert}" style="width:${wCall.toFixed(3)}%" title="${escapeHtml(l.from)} call ${callH.toFixed(0)} h"></span><span class="seg seg--${l.mode.toLowerCase()}${alert}" style="width:${wRun.toFixed(3)}%" title="${escapeHtml(l.label)} · ${MODE_SHORT[l.mode]} ${l.breakdown.travelH.toFixed(0)} h">${showLabels && wRun > 9 ? `<i>${MODE_SHORT[l.mode]}</i>` : ''}</span>`;
    })
    .join('');
  return `<div class="strip" style="--h:${height}px" role="img" aria-label="Leg time split: ${route.legs.map((l) => `${MODE_SHORT[l.mode]} ${Math.round(l.hours)} hours`).join(', ')}">${segs}</div>`;
}
