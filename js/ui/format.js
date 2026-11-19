/** Formatting helpers shared by the HUD, charts and manifest. */

export function fmtTransit(h) {
  if (h == null || !isFinite(h)) return '—';
  const d = Math.floor(h / 24);
  const r = Math.round(h - d * 24);
  if (d === 0) return `${r} h`;
  return `${d} d ${String(r).padStart(2, '0')} h`;
}

export function fmtHoursShort(h) {
  if (h == null || !isFinite(h)) return '—';
  if (Math.abs(h) >= 48) return `${(h / 24).toFixed(1)} d`;
  return `${h.toFixed(Math.abs(h) < 10 ? 1 : 0)} h`;
}

export function fmtUsd(v, { decimals = 0 } = {}) {
  if (v == null || !isFinite(v)) return '—';
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}`;
}

export function fmtCo2(kg) {
  if (kg == null || !isFinite(kg)) return '—';
  return kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${Math.round(kg)} kg`;
}

export function fmtKm(km) {
  if (km == null || !isFinite(km)) return '—';
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

export function signed(v, fmt) {
  if (v == null || !isFinite(v)) return '—';
  if (Math.abs(v) < 1e-9) return `±${fmt(0)}`;
  return `${v > 0 ? '+' : '−'}${fmt(Math.abs(v))}`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const MODE_SHORT = { MARITIME: 'SEA', RAIL: 'RAIL', ROAD: 'ROAD' };

/** Compass bearing (deg, north = 0) between two screen points. */
export function screenBearing(from, to) {
  const deg = (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Animated count-up of a number inside an element (respects reduced motion). */
export function countUp(el, to, format, { ms = 520 } = {}) {
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const from = Number(el.dataset.value);
  el.dataset.value = String(to);
  if (reduce || !isFinite(from) || !isFinite(to) || from === to) {
    el.textContent = format(to);
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - k) ** 3;
    el.textContent = format(from + (to - from) * e);
    if (k < 1 && el.dataset.value === String(to)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
