/**
 * RouteGuard — "Take a pilot" first-run guide (coach marks).
 *
 * Maritime metaphor: a harbour pilot boards to con a ship through unfamiliar water. International Code
 * of Signals flag G ("I require a pilot") is the opt-in invitation; flag H ("I have a pilot on board")
 * is the persistent guide key. Each step is a pilot card tethered to its target by an electronic
 * bearing line (EBL) with a bearing readout, and the target sits in a cut-out veil with ECDIS-style
 * pick-report brackets. The veil is four panes around the hole, so the target stays clickable.
 *
 * NN/g found pushed tutorials can lower task success, so the guide is opt-in, shown once, dismissible,
 * and always reachable again from the header key, the help drawer or the G shortcut.
 */

import { screenBearing, escapeHtml } from './format.js';

const SEEN_KEY = 'routeguard.pilot.seen.v1';

function store(get, value) {
  try {
    if (get) return window.localStorage.getItem(SEEN_KEY);
    window.localStorage.setItem(SEEN_KEY, value);
  } catch {
    /* storage blocked: guide still works, it just may re-invite next visit */
  }
  return null;
}

export const FLAG_G = '<svg class="flag" viewBox="0 0 30 20" aria-hidden="true"><g>' + Array.from({ length: 6 }, (_, i) => `<rect x="${i * 5}" y="0" width="5" height="20" fill="${i % 2 ? '#1d4fa0' : '#f2c230'}"/>`).join('') + '</g><rect x="0.5" y="0.5" width="29" height="19" fill="none" stroke="currentColor" stroke-opacity=".35"/></svg>';
export const FLAG_H = '<svg class="flag" viewBox="0 0 30 20" aria-hidden="true"><rect width="15" height="20" fill="#f4f1ea"/><rect x="15" width="15" height="20" fill="#c8242b"/><rect x="0.5" y="0.5" width="29" height="19" fill="none" stroke="currentColor" stroke-opacity=".35"/></svg>';

function pennant(n) {
  return `<svg class="pennant" viewBox="0 0 44 22" aria-hidden="true"><path d="M1 1 L43 8 L43 14 L1 21 Z" fill="currentColor"/><text x="15" y="15" font-size="11" font-family="Martian Mono, monospace" font-weight="700" text-anchor="middle" fill="var(--panel)">${String(n).padStart(2, '0')}</text></svg>`;
}

export class Pilot {
  constructor({ steps, root = document.body, onEnd, announce } = {}) {
    this.steps = steps;
    this.root = root;
    this.onEnd = onEnd;
    this.announce = announce ?? (() => {});
    this.active = false;
    this.queue = [];
    this.idx = 0;
    this.raf = 0;
    this.lastFocus = null;
    this.#build();
  }

  get seen() {
    return store(true) === '1';
  }

  markSeen() {
    store(false, '1');
  }

  #build() {
    const veil = document.createElement('div');
    veil.className = 'pilot-veil';
    veil.hidden = true;
    veil.innerHTML = '<div class="pv pv-t"></div><div class="pv pv-b"></div><div class="pv pv-l"></div><div class="pv pv-r"></div><div class="pilot-ring"><i></i><i></i><i></i><i></i></div><svg class="pilot-ebl" aria-hidden="true"><line/><circle r="3.5"/><text></text></svg>';
    const card = document.createElement('section');
    card.className = 'pilot-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', 'pilot-title');
    card.hidden = true;
    card.innerHTML = `
      <header class="pilot-head"><span class="pilot-pennant"></span><span class="pilot-count mono"></span><button type="button" class="icon-btn pilot-x" aria-label="Close guide (Esc)">✕</button></header>
      <h3 class="pilot-title" id="pilot-title"></h3>
      <div class="pilot-body"></div>
      <div class="pilot-scale" aria-hidden="true"><div class="pilot-scale-fill"></div></div>
      <footer class="pilot-foot"><span class="pilot-keys mono">← → Esc</span><button type="button" class="btn btn--ghost pilot-back">Back</button><button type="button" class="btn btn--primary pilot-next">Next</button></footer>`;
    const invite = document.createElement('section');
    invite.className = 'pilot-invite';
    invite.setAttribute('role', 'dialog');
    invite.setAttribute('aria-labelledby', 'pilot-invite-title');
    invite.hidden = true;
    invite.innerHTML = `
      <div class="pilot-invite-flag">${FLAG_G}<span class="mono">CODE G</span></div>
      <div><h3 id="pilot-invite-title">Take a pilot aboard?</h3>
      <p>A <span class="pilot-n">13</span>-step passage through RouteGuard: plot a route, trigger a crisis, and watch the convoys reroute. About two minutes.</p>
      <div class="row"><button type="button" class="btn btn--primary" data-pilot="start">Embark pilot</button><button type="button" class="btn btn--ghost" data-pilot="later">Not now</button></div></div>`;
    this.root.append(veil, card, invite);
    this.veil = veil;
    this.card = card;
    this.invite = invite;
    card.querySelector('.pilot-x').addEventListener('click', () => this.stop('closed'));
    card.querySelector('.pilot-back').addEventListener('click', () => this.go(this.idx - 1));
    card.querySelector('.pilot-next').addEventListener('click', () => (this.idx >= this.queue.length - 1 ? this.stop('finished') : this.go(this.idx + 1)));
    invite.querySelector('[data-pilot="start"]').addEventListener('click', () => {
      this.hideInvite();
      this.start();
    });
    invite.querySelector('[data-pilot="later"]').addEventListener('click', () => {
      this.hideInvite();
      this.markSeen();
      this.announce('Guide dismissed. Press G or the Pilot key any time.');
    });
    this.keyHandler = (e) => this.#key(e);
  }

  maybeInvite(delay = 1200) {
    if (this.seen) return false;
    setTimeout(() => {
      if (this.active || this.seen) return;
      this.invite.hidden = false;
      requestAnimationFrame(() => this.invite.classList.add('is-in'));
      this.invite.querySelector('[data-pilot="start"]').focus({ preventScroll: true });
      this.inviteKey = (e) => {
        if (e.key === 'Escape') {
          this.hideInvite();
          this.markSeen();
        }
      };
      document.addEventListener('keydown', this.inviteKey);
    }, delay);
    return true;
  }

  hideInvite() {
    this.invite.classList.remove('is-in');
    this.invite.hidden = true;
    if (this.inviteKey) document.removeEventListener('keydown', this.inviteKey);
  }

  start(filter = null, at = 0) {
    this.hideInvite();
    this.markSeen();
    this.queue = filter ? this.steps.filter((s) => s.group === filter) : this.steps.slice();
    if (!this.queue.length) return;
    this.active = true;
    this.lastFocus = document.activeElement;
    this.veil.hidden = false;
    this.card.hidden = false;
    document.body.classList.add('pilot-on');
    document.addEventListener('keydown', this.keyHandler, true);
    const loop = () => {
      if (!this.active) return;
      this.#position();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.go(at);
  }

  stop(reason = 'closed') {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.veil.hidden = true;
    this.card.hidden = true;
    document.body.classList.remove('pilot-on');
    document.removeEventListener('keydown', this.keyHandler, true);
    this.current?.after?.();
    this.announce(reason === 'finished' ? 'Pilot disembarked. Reopen the guide with the Pilot key or G.' : 'Guide closed.');
    this.onEnd?.(reason);
    if (this.lastFocus?.focus) this.lastFocus.focus({ preventScroll: true });
  }

  async go(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.current?.after?.();
    this.idx = i;
    const step = this.queue[i];
    this.current = step;
    try {
      await step.before?.();
    } catch {
      /* a failed preparation step should never trap the user */
    }
    this.target = await this.#waitFor(step.target);
    if (this.target) this.#scrollIntoView(this.target);
    const n = i + 1;
    const N = this.queue.length;
    this.card.querySelector('.pilot-pennant').innerHTML = pennant(n);
    this.card.querySelector('.pilot-count').textContent = `PILOT · ${String(n).padStart(2, '0')} / ${String(N).padStart(2, '0')}`;
    this.card.querySelector('.pilot-title').textContent = step.title;
    this.card.querySelector('.pilot-body').innerHTML = step.body;
    this.card.querySelector('.pilot-scale-fill').style.width = `${(n / N) * 100}%`;
    this.card.querySelector('.pilot-scale').style.setProperty('--ticks', N);
    this.card.querySelector('.pilot-back').disabled = i === 0;
    this.card.querySelector('.pilot-next').textContent = i === N - 1 ? 'Disembark' : 'Next';
    this.announce(`Step ${n} of ${N}: ${step.title}`);
    this.card.classList.remove('is-in');
    void this.card.offsetWidth;
    this.card.classList.add('is-in');
    this.#position();
    this.card.querySelector('.pilot-next').focus({ preventScroll: true });
  }

  #waitFor(sel) {
    const find = () => (typeof sel === 'function' ? sel() : document.querySelector(sel));
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const el = find();
        if (el && el.getClientRects().length) return resolve(el);
        if (performance.now() - t0 > 3000) return resolve(null);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  #scrollIntoView(el) {
    const header = document.querySelector('.bridge-bar');
    const headH = header ? header.getBoundingClientRect().height : 0;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    if (r.top < headH + 8) window.scrollBy({ top: r.top - headH - 16 });
    else if (r.bottom > window.innerHeight - 8 && r.height < window.innerHeight - headH) window.scrollBy({ top: r.bottom - window.innerHeight + 24 });
  }

  #position() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;
    let r = this.target?.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) r = { left: vw / 2, top: vh / 2, width: 0, height: 0, right: vw / 2, bottom: vh / 2 };
    const hole = {
      x: Math.max(0, r.left - pad),
      y: Math.max(0, r.top - pad),
      w: Math.min(vw, r.width + pad * 2),
      h: Math.min(vh, r.height + pad * 2),
    };
    const [t, b, l, rr] = this.veil.querySelectorAll('.pv');
    t.style.cssText = `left:0;top:0;width:100%;height:${hole.y}px`;
    b.style.cssText = `left:0;top:${hole.y + hole.h}px;width:100%;height:${Math.max(0, vh - hole.y - hole.h)}px`;
    l.style.cssText = `left:0;top:${hole.y}px;width:${hole.x}px;height:${hole.h}px`;
    rr.style.cssText = `left:${hole.x + hole.w}px;top:${hole.y}px;width:${Math.max(0, vw - hole.x - hole.w)}px;height:${hole.h}px`;
    const ring = this.veil.querySelector('.pilot-ring');
    ring.style.cssText = `left:${hole.x}px;top:${hole.y}px;width:${hole.w}px;height:${hole.h}px`;

    // Card placement
    const card = this.card;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const docked = vw < 640;
    card.classList.toggle('is-docked', docked);
    let x;
    let y;
    if (docked) {
      const targetLow = hole.y + hole.h / 2 > vh / 2;
      x = 8;
      y = targetLow ? 8 + (document.querySelector('.bridge-bar')?.getBoundingClientRect().height ?? 0) : vh - ch - 8;
      card.classList.toggle('dock-top', targetLow);
    } else {
      const gap = 28;
      const fits = {
        right: hole.x + hole.w + gap + cw < vw - 8,
        left: hole.x - gap - cw > 8,
        bottom: hole.y + hole.h + gap + ch < vh - 8,
        top: hole.y - gap - ch > 8,
      };
      const pref = this.current?.placement ?? 'right';
      const order = [pref, 'right', 'left', 'bottom', 'top'];
      const side = order.find((s) => fits[s]) ?? 'over';
      if (side === 'right') [x, y] = [hole.x + hole.w + gap, hole.y + hole.h / 2 - ch / 2];
      else if (side === 'left') [x, y] = [hole.x - gap - cw, hole.y + hole.h / 2 - ch / 2];
      else if (side === 'bottom') [x, y] = [hole.x + hole.w / 2 - cw / 2, hole.y + hole.h + gap];
      else if (side === 'top') [x, y] = [hole.x + hole.w / 2 - cw / 2, hole.y - gap - ch];
      else [x, y] = [vw - cw - 16, vh - ch - 16];
      x = Math.min(Math.max(8, x), vw - cw - 8);
      y = Math.min(Math.max(8, y), vh - ch - 8);
    }
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;

    // EBL: from nearest card edge point to the target centre, with a bearing readout.
    const svg = this.veil.querySelector('.pilot-ebl');
    const tc = { x: hole.x + hole.w / 2, y: hole.y + hole.h / 2 };
    const cx = Math.min(Math.max(tc.x, x), x + cw);
    const cy = Math.min(Math.max(tc.y, y), y + ch);
    const inside = cx === tc.x && cy === tc.y;
    const edge = { x: Math.min(Math.max(tc.x, hole.x), hole.x + hole.w), y: Math.min(Math.max(tc.y, hole.y), hole.y + hole.h) };
    const target = Math.hypot(cx - tc.x, cy - tc.y) > 40 ? { x: (edge.x + tc.x) / 2, y: (edge.y + tc.y) / 2 } : tc;
    svg.setAttribute('width', vw);
    svg.setAttribute('height', vh);
    const line = svg.querySelector('line');
    const dot = svg.querySelector('circle');
    const text = svg.querySelector('text');
    const show = !inside && !docked && Math.hypot(cx - target.x, cy - target.y) > 12;
    svg.style.display = show ? '' : 'none';
    if (show) {
      line.setAttribute('x1', cx);
      line.setAttribute('y1', cy);
      line.setAttribute('x2', target.x);
      line.setAttribute('y2', target.y);
      dot.setAttribute('cx', target.x);
      dot.setAttribute('cy', target.y);
      const brg = screenBearing({ x: cx, y: cy }, target);
      text.textContent = `BRG ${String(Math.round(brg) % 360).padStart(3, '0')}°`;
      text.setAttribute('x', (cx + target.x) / 2 + 6);
      text.setAttribute('y', (cy + target.y) / 2 - 6);
    }
  }

  #key(e) {
    if (!this.active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.stop('closed');
    } else if (e.key === 'ArrowRight' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      e.stopPropagation();
      if (this.idx >= this.queue.length - 1) this.stop('finished');
      else this.go(this.idx + 1);
    } else if (e.key === 'ArrowLeft' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      e.stopPropagation();
      this.go(this.idx - 1);
    } else if (e.key === 'Tab' && this.card.contains(document.activeElement)) {
      const f = [...this.card.querySelectorAll('button:not([disabled])')];
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
  }
}

export function pilotSteps(app) {
  const step = (o) => ({ placement: 'right', group: 'all', ...o });
  return [
    step({ group: 'chart', target: '#map', placement: 'left', title: 'This is your passage chart', body: '<p>Every line is a freight corridor: <b class="k k-sea">sea</b>, <b class="k k-rail">rail</b> and <b class="k k-road">road</b> (dashed). Thicker lines carry more TEU per week. Hover any hub or corridor for its live readout.</p>' }),
    step({ group: 'plan', target: '#voyage', title: 'Set the voyage', body: '<p>Pick a network, an origin and a destination. You can also click a hub on the chart and choose <i>Set origin</i> or <i>Set destination</i>.</p>' }),
    step({ group: 'plan', target: '#weights', title: 'Tell the router what matters', body: '<p>Three weights for time, landed cost and carbon. They are normalised to sum to 100%, so the router minimises one blended score with multi-objective A*.</p>' }),
    step({ group: 'chart', target: '#kpis', placement: 'left', title: 'The magenta track is the plan', body: '<p>Chart magenta marks what navigators must act on, so it is reserved for the plotted route. These readouts give its transit time, $/TEU and tonnes of CO₂e, plus the change against a calm, undisrupted world.</p>' }),
    step({ group: 'telemetry', target: '#pareto-wrap', placement: 'left', title: 'Read the trade-off', body: '<p>Each bubble is a candidate route. Further left is cheaper, lower is faster, and a bigger bubble emits more carbon. Solid bubbles are Pareto-efficient. Hover for a readout, then click to plot one.</p>' }),
    step({ group: 'chart', target: '#crisis', placement: 'bottom', title: 'Trigger a crisis', body: '<p>Each placard is a one-click scenario, keys <kbd>1</kbd>–<kbd>4</kbd>. Try <b>Suez Canal Blockage</b> and watch the track re-plot around the closure.</p>', before: () => app.ensureDesktopPanels?.() }),
    step({ group: 'chart', target: '#tools', placement: 'right', title: 'Make your own trouble', body: '<p>Choose a tool, then click the chart. <b>Storm</b> drops a weather cell, <b>Strike</b> congests a hub, and <b>Close</b> blocks a hub or corridor. You can also click any hub for a menu.</p>' }),
    step({ group: 'plan', target: '#hazards', title: 'Hazards on the chart', body: '<p>Every active disruption is listed here with its placard and time left. The fuel slider runs from −20% to +100%. Live Open-Meteo wind and rain at each hub also feed the router.</p>' }),
    step({ group: 'sandbox', target: '#console', placement: 'top', title: 'Run the sandbox', body: '<p>Start the clock with <kbd>Space</kbd>, dispatch convoys with <kbd>D</kbd>, and turn on <b>Chaos</b> for random strikes and storms. Convoys re-plan themselves at the next hub when trouble appears ahead.</p>', before: () => app.ensureSandboxDemo?.() }),
    step({ group: 'sandbox', target: '#convoys', placement: 'left', title: 'Convoys & deck log', body: '<p>Each convoy carries a valid ISO 6346 container number; the boxed digit is the check digit. The deck log records every dispatch, hold, reroute and delivery in sim time.</p>' }),
    step({ group: 'telemetry', target: '#legs', placement: 'left', title: 'Leg by leg', body: '<p>The plotted route broken into legs: mode, distance, hours and cost for each, with weather and disruption alerts on the leg they affect.</p>' }),
    step({ group: 'plan', target: '#share', title: 'Share the scenario', body: '<p>The whole scenario lives in the URL: voyage, weights and hazards. Copy the link, or download a JSON route manifest.</p>' }),
    step({ group: 'all', target: '#guide-key', placement: 'bottom', title: 'Pilot disembarks', body: '<p>Flag <b>H</b> means “pilot on board”. Press this key or <kbd>G</kbd> to rerun the guide, and <kbd>?</kbd> opens help, shortcuts and the glossary. Fair winds.</p>' }),
  ].map((s, i) => ({ ...s, id: `p${i + 1}`, body: s.body.replace(/\{(\w+)\}/g, (_, k) => escapeHtml(app[k] ?? '')) }));
}
