/**
 * RouteGuard — MapLibre GL basemap + Deck.gl GPU overlay (MapboxOverlay, non-interleaved).
 *
 * Layer stack (bottom → top):
 *   storm cells (isobar rings) · corridors (by mode; roads dashed) · closed corridors · old-plan ghost
 *   · alternative tracks · plotted track casing + chart-magenta core · waypoint circles & numbers
 *   · hubs (chart-symbol glyphs) · hub codes · weather Beaufort flags · hazard placards (diamonds)
 *   · convoy chevrons + ISO 6346 serials
 *
 * Basemap: CARTO Dark Matter / Positron GL styles, recoloured at load into the ECDIS-style
 * Night / Dusk / Day palettes (IHO S-52 has day, dusk and night colour tables). If the style cannot be
 * fetched (offline / blocked) a local graticule chart is used so the simulator still runs.
 */

const STYLE_URLS = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
};

export const MAP_THEMES = {
  night: {
    base: 'dark',
    land: '#12151b',
    water: '#05080d',
    boundary: '#2a3140',
    labelOpacity: 0.55,
    ink: [226, 232, 240],
    inkDim: [120, 134, 156],
    casing: [5, 8, 13],
    magenta: [232, 92, 168],
    hazard: [242, 110, 64],
    hold: [242, 182, 64],
    modes: { MARITIME: [46, 159, 194], RAIL: [197, 130, 38], ROAD: [42, 170, 119] },
    corridorAlpha: 150,
    graticule: '#101722',
  },
  dusk: {
    base: 'dark',
    land: '#23242a',
    water: '#111a27',
    boundary: '#3b4354',
    labelOpacity: 0.7,
    ink: [236, 240, 246],
    inkDim: [150, 162, 182],
    casing: [17, 26, 39],
    magenta: [236, 104, 176],
    hazard: [246, 124, 76],
    hold: [244, 190, 80],
    modes: { MARITIME: [46, 159, 194], RAIL: [197, 130, 38], ROAD: [42, 170, 119] },
    corridorAlpha: 170,
    graticule: '#1b2636',
  },
  day: {
    base: 'light',
    land: '#e9e0c4',
    water: '#f6f8f6',
    boundary: '#b9ae8c',
    labelOpacity: 0.85,
    ink: [22, 27, 36],
    inkDim: [96, 104, 118],
    casing: [246, 248, 246],
    magenta: [163, 22, 110],
    hazard: [194, 65, 12],
    hold: [161, 98, 7],
    modes: { MARITIME: [29, 127, 163], RAIL: [176, 106, 18], ROAD: [26, 138, 94] },
    corridorAlpha: 190,
    graticule: '#e4e9e6',
  },
};

/* ───────────── Chart-symbol glyphs (white SVG, tinted on the GPU via IconLayer mask) ───────────── */

function svgUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
const GLYPHS = {
  PORT: svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="15" fill="none" stroke="#fff" stroke-width="5"/><circle cx="24" cy="24" r="5" fill="#fff"/></svg>'),
  RAIL_HUB: svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect x="9" y="9" width="30" height="30" fill="none" stroke="#fff" stroke-width="5"/><path d="M9 24h30" stroke="#fff" stroke-width="4"/></svg>'),
  DRY_PORT: svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect x="9" y="9" width="30" height="30" fill="none" stroke="#fff" stroke-width="5"/><rect x="19" y="19" width="10" height="10" fill="#fff"/></svg>'),
  CHOKEPOINT: svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><path d="M8 10 L24 24 L8 38 M40 10 L24 24 L40 38" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="square"/></svg>'),
  CHEVRON: svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><path d="M24 4 L40 42 L24 33 L8 42 Z" fill="#fff"/></svg>'),
};

/** IMDG-style hazard placard (diamond, symbol top, class number bottom corner). Not tinted. */
export function placardSvg(kind, { fill, ink, size = 56 } = {}) {
  const cls = { CONGESTION: '1', CLOSURE: '2', STORM: '3', FUEL: '4' }[kind] ?? '?';
  const sym = {
    // strike: two crossed cargo hooks → simplified as a stopped crane jib
    CONGESTION: '<path d="M18 31V17h14M32 17v5" stroke="INK" stroke-width="3" fill="none"/><path d="M15 31h20" stroke="INK" stroke-width="3"/><circle cx="32" cy="24" r="2" fill="INK"/>',
    // closure: bar across a channel
    CLOSURE: '<path d="M16 18v13M34 18v13" stroke="INK" stroke-width="3"/><path d="M13 24.5h24" stroke="INK" stroke-width="5"/>',
    // storm: cyclone glyph
    STORM: '<path d="M25 15c-6 0-9 4-9 8 0 5 4 8 9 8M25 33c6 0 9-4 9-8 0-5-4-8-9-8" stroke="INK" stroke-width="3" fill="none"/><circle cx="25" cy="24" r="2.5" fill="INK"/>',
    // fuel: drop
    FUEL: '<path d="M25 13c4 6 7 10 7 13a7 7 0 0 1-14 0c0-3 3-7 7-13z" fill="none" stroke="INK" stroke-width="3"/>',
  }[kind] ?? '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 50 50"><path d="M25 1.5 L48.5 25 L25 48.5 L1.5 25 Z" fill="${fill}" stroke="${ink}" stroke-width="2"/><path d="M25 5.5 L44.5 25 L25 44.5 L5.5 25 Z" fill="none" stroke="${ink}" stroke-width="1"/>${sym.replaceAll('INK', ink)}<text x="25" y="42" font-family="monospace" font-size="8" font-weight="700" text-anchor="middle" fill="${ink}">${cls}</text></svg>`;
  return svg;
}

function graticuleGeoJSON() {
  const features = [];
  for (let lng = -180; lng <= 180; lng += 15) {
    const coords = [];
    for (let lat = -80; lat <= 80; lat += 5) coords.push([lng, lat]);
    features.push({ type: 'Feature', properties: { kind: lng % 45 === 0 ? 'major' : 'minor' }, geometry: { type: 'LineString', coordinates: coords } });
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const coords = [];
    for (let lng = -180; lng <= 180; lng += 5) coords.push([lng, lat]);
    features.push({ type: 'Feature', properties: { kind: lat === 0 ? 'major' : 'minor' }, geometry: { type: 'LineString', coordinates: coords } });
  }
  return { type: 'FeatureCollection', features };
}

function fallbackStyle(t) {
  return {
    version: 8,
    name: 'RouteGuard offline chart',
    sources: { grat: { type: 'geojson', data: graticuleGeoJSON() } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': t.water } },
      { id: 'grat-minor', type: 'line', source: 'grat', filter: ['==', ['get', 'kind'], 'minor'], paint: { 'line-color': t.boundary, 'line-width': 0.5, 'line-opacity': 0.5 } },
      { id: 'grat-major', type: 'line', source: 'grat', filter: ['==', ['get', 'kind'], 'major'], paint: { 'line-color': t.boundary, 'line-width': 1, 'line-opacity': 0.8 } },
    ],
  };
}

const rgba = (c, a = 255) => [c[0], c[1], c[2], a];

export class MapRenderer {
  constructor(container, { theme = 'night', view, onHover, onClick, onStatus } = {}) {
    this.container = container;
    this.themeName = theme;
    this.t = MAP_THEMES[theme];
    this.onHover = onHover;
    this.onClick = onClick;
    this.onStatus = onStatus ?? (() => {});
    this.state = null;
    this.basemap = 'loading';
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.placardCache = new Map();

    if (!window.maplibregl || !window.deck) {
      this.failed = true;
      this.onStatus('fault', 'Map libraries failed to load (CDN blocked?)');
      return;
    }

    this.map = new window.maplibregl.Map({
      container,
      style: STYLE_URLS[this.t.base],
      center: view?.center ?? [40, 25],
      zoom: view?.zoom ?? 1.5,
      minZoom: 0.6,
      maxZoom: 11,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      renderWorldCopies: true,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new window.maplibregl.ScaleControl({ unit: 'metric', maxWidth: 110 }), 'top-right');

    this.overlay = new window.deck.MapboxOverlay({ interleaved: false, layers: [], useDevicePixels: true });
    this.map.addControl(this.overlay);

    this.styleTimer = setTimeout(() => {
      if (this.basemap === 'loading') this.#useFallback('Basemap timed out');
    }, 9000);
    this.map.on('style.load', () => this.#onStyleLoad());
    this.map.on('error', (e) => {
      const msg = String(e?.error?.message || '');
      if (this.basemap === 'loading' && /style|Failed to fetch|NetworkError|404|403/i.test(msg)) this.#useFallback(msg);
    });

    this.map.on('mousemove', (e) => this.#handlePointer(e, 'hover'));
    this.map.on('mouseout', () => this.onHover?.(null));
    this.map.on('click', (e) => this.#handlePointer(e, 'click'));
  }

  #useFallback(reason) {
    if (this.basemap === 'fallback') return;
    this.basemap = 'fallback';
    clearTimeout(this.styleTimer);
    this.map.setStyle(fallbackStyle(this.t));
    this.onStatus('fallback', reason);
  }

  #onStyleLoad() {
    if (this.basemap !== 'fallback') {
      this.basemap = 'carto';
      clearTimeout(this.styleTimer);
      this.onStatus('carto', 'CARTO vector basemap');
    }
    this.#recolourBasemap();
    this.map.resize();
  }

  /** Re-tints CARTO layers into the active Night / Dusk / Day palette. */
  #recolourBasemap() {
    const t = this.t;
    const style = this.map.getStyle();
    if (!style?.layers) return;
    for (const layer of style.layers) {
      const id = layer.id;
      try {
        if (layer.type === 'background') this.map.setPaintProperty(id, 'background-color', t.land);
        else if (layer.type === 'fill' && /water/i.test(id)) this.map.setPaintProperty(id, 'fill-color', t.water);
        else if (layer.type === 'line' && /water|river/i.test(id)) this.map.setPaintProperty(id, 'line-color', t.water);
        else if (layer.type === 'fill' && /land|park|green|wood|building|aeroway|urban|ice|glacier/i.test(id)) this.map.setPaintProperty(id, 'fill-color', t.land);
        else if (layer.type === 'line' && /boundary|admin/i.test(id)) {
          this.map.setPaintProperty(id, 'line-color', t.boundary);
        } else if (layer.type === 'line' && /road|rail|tunnel|bridge|highway/i.test(id)) this.map.setLayoutProperty(id, 'visibility', 'none');
        else if (layer.type === 'symbol') {
          if (/poi|housenum|road|highway|shield|rail|aeroway/i.test(id)) this.map.setLayoutProperty(id, 'visibility', 'none');
          else this.map.setPaintProperty(id, 'text-opacity', t.labelOpacity);
        }
      } catch {
        /* some generated layers reject paint props — safe to skip */
      }
    }
  }

  setTheme(name) {
    if (!MAP_THEMES[name] || this.failed) return;
    const prevBase = this.t.base;
    this.themeName = name;
    this.t = MAP_THEMES[name];
    this.placardCache.clear();
    if (this.basemap === 'fallback') this.map.setStyle(fallbackStyle(this.t));
    else if (prevBase !== this.t.base) this.map.setStyle(STYLE_URLS[this.t.base]);
    else this.#recolourBasemap();
    if (this.state) this.render(this.state);
  }

  flyTo(view, opts = {}) {
    if (this.failed) return;
    const { center, zoom } = view;
    if (this.reducedMotion || opts.instant) this.map.jumpTo({ center, zoom });
    else this.map.flyTo({ center, zoom, speed: 1.4, curve: 1.3, essential: false });
  }

  fitRoute(path, padding = 60) {
    if (this.failed || !path?.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // unwrap for antimeridian-spanning routes
    let prev = path[0][0];
    for (const [lng0, lat] of path) {
      let lng = lng0;
      while (lng - prev > 180) lng -= 360;
      while (lng - prev < -180) lng += 360;
      prev = lng;
      minX = Math.min(minX, lng); maxX = Math.max(maxX, lng); minY = Math.min(minY, lat); maxY = Math.max(maxY, lat);
    }
    const rect = this.container.getBoundingClientRect();
    const pad = Math.min(padding, rect.width / 6, rect.height / 6);
    this.map.fitBounds([[minX, minY], [maxX, maxY]], { padding: pad, duration: this.reducedMotion ? 0 : 900, maxZoom: 6.5 });
  }

  #handlePointer(e, kind) {
    if (!this.overlay) return;
    let info = null;
    try {
      info = this.overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 7, layerIds: ['convoys', 'placards', 'hubs', 'track-core', 'alt-tracks', 'corridors', 'corridors-road', 'closed'] });
    } catch {
      info = null;
    }
    const payload = info?.object ? { layer: info.layer.id, object: info.object, x: e.point.x, y: e.point.y, lngLat: [e.lngLat.lng, e.lngLat.lat] } : { layer: null, object: null, x: e.point.x, y: e.point.y, lngLat: [e.lngLat.lng, e.lngLat.lat] };
    this.map.getCanvas().style.cursor = payload.object ? 'pointer' : this.state?.tool && this.state.tool !== 'select' ? 'crosshair' : '';
    if (kind === 'hover') this.onHover?.(payload);
    else this.onClick?.(payload);
  }

  /** Per-vertex timestamps (0–1000, by unwrapped distance) for the draw-on plotting animation. */
  #stamps(route) {
    if (this.stampCache?.sig === route.signature) return this.stampCache.stamps;
    const p = route.path;
    const cum = [0];
    let prev = p[0][0];
    let prevLng = p[0][0];
    for (let i = 1; i < p.length; i++) {
      let lng = p[i][0];
      while (lng - prevLng > 180) lng -= 360;
      while (lng - prevLng < -180) lng += 360;
      const dx = (lng - prevLng) * Math.cos((p[i][1] * Math.PI) / 180);
      const dy = p[i][1] - p[i - 1][1];
      cum.push(cum[i - 1] + Math.hypot(dx, dy));
      prevLng = lng;
      prev = lng;
    }
    void prev;
    const total = cum[cum.length - 1] || 1;
    const stamps = cum.map((c) => (c / total) * 1000);
    this.stampCache = { sig: route.signature, stamps };
    return stamps;
  }

  /** Stable data arrays per (network, context version) so GPU attributes are not rebuilt every frame. */
  #memo(s) {
    const key = `${s.network.id}|${s.ctxVersion}`;
    if (this.memoKey === key) return this.memoData;
    const net = s.network;
    const closedEdgeIds = new Set();
    const closedNodeIds = new Set();
    for (const [id, m] of s.ctx.edgeMods) if (m.closed) closedEdgeIds.add(id);
    for (const [id, m] of s.ctx.nodeMods) if (m.closed) closedNodeIds.add(id);
    for (const e of net.edges) if (closedNodeIds.has(e.from) || closedNodeIds.has(e.to)) closedEdgeIds.add(e.id);
    this.memoKey = key;
    this.memoData = {
      closedEdgeIds,
      closedNodeIds,
      edgesSolid: net.edges.filter((e) => e.mode !== 'ROAD' && !closedEdgeIds.has(e.id)),
      edgesRoad: net.edges.filter((e) => e.mode === 'ROAD' && !closedEdgeIds.has(e.id)),
      edgesClosed: net.edges.filter((e) => closedEdgeIds.has(e.id)),
      hubs: this.hubsFor?.id === net.id ? this.hubsFor.hubs : (this.hubsFor = { id: net.id, hubs: net.nodes.map((n) => ({ ...n, __kind: 'node' })) }).hubs,
    };
    return this.memoData;
  }

  #placard(kind) {
    const key = `${kind}`;
    if (!this.placardCache.has(key)) {
      const t = this.t;
      const fill = `rgb(${t.hazard.join(',')})`;
      const ink = this.themeName === 'day' ? '#fff8ef' : '#120804';
      this.placardCache.set(key, { url: svgUrl(placardSvg(kind, { fill, ink, size: 64 })), width: 64, height: 64, id: `pl-${kind}-${this.themeName}` });
    }
    return this.placardCache.get(key);
  }

  /**
   * Renders the full scene. `s` = { network, graph, solution, selectedKey, disruptions, ctx, weather,
   *   convoys, origin, destination, hover, now(ms), tool }
   */
  render(s) {
    this.state = s;
    if (this.failed || !this.overlay) return;
    const D = window.deck;
    const t = this.t;
    const pulse = this.reducedMotion ? 0.5 : (Math.sin((s.now ?? 0) / 420) + 1) / 2;
    const net = s.network;
    const nodeById = s.graph.nodes;
    const selected = s.selectedRoute;
    const routeEdgeIds = new Set(selected?.legs.map((l) => l.edgeId) ?? []);
    const hoverEdge = s.hoverEdgeId ?? null;

    const { closedNodeIds, edgesSolid, edgesRoad, edgesClosed, hubs } = this.#memo(s);
    const slowed = (e) => (s.ctx.edgeMods.get(e.id)?.speedFactor ?? 1) < 0.97;
    const width = (e) => 0.8 + Math.max(0, Math.log10(e.capacityTeuWeek / 800)) * 0.9;
    const excluded = new Set(s.excludedModes ?? []);
    const edgeColor = (e) => {
      const c = t.modes[e.mode];
      if (excluded.has(e.mode)) return rgba(c, 38);
      const a = routeEdgeIds.has(e.id) ? 90 : t.corridorAlpha;
      return rgba(c, e.id === hoverEdge ? 255 : slowed(e) ? Math.min(255, a + 50) : a);
    };
    const corridorCommon = {
      getPath: (e) => e.waypoints,
      getColor: edgeColor,
      getWidth: (e) => (e.id === hoverEdge ? width(e) + 2.5 : width(e)),
      widthUnits: 'pixels',
      widthMinPixels: 1,
      capRounded: true,
      jointRounded: true,
      wrapLongitude: true,
      pickable: true,
      updateTriggers: { getColor: [hoverEdge, selected?.signature, this.themeName, s.ctxVersion, [...excluded].join()], getWidth: [hoverEdge] },
    };

    const storms = s.disruptions.filter((d) => d.kind === 'STORM');
    const stormRings = [];
    for (const d of storms) for (const f of [1, 0.66, 0.33]) stormRings.push({ d, f });

    const candidates = (s.solution?.candidates ?? []).filter((r) => r !== selected).slice(0, 4);
    const ghost = s.solution?.baseline && selected && s.solution.baseline.signature !== selected.signature && s.disrupted ? s.solution.baseline : null;

    const routeNodes = selected ? selected.nodes.map((id, i) => ({ id, i, node: nodeById.get(id) })) : [];

    // Hazard placards
    const placards = [];
    for (const d of s.disruptions) {
      let pos = null;
      if (d.kind === 'STORM') pos = d.center;
      else if (d.nodeId) pos = nodeById.get(d.nodeId)?.coords;
      else if (d.edgeId) {
        const e = s.graph.edges.get(d.edgeId);
        if (e) pos = e.waypoints[Math.floor(e.waypoints.length / 2)];
      }
      if (pos) placards.push({ ...d, __kind: 'hazard', position: pos });
    }
    const hazardNodes = s.disruptions.filter((d) => d.nodeId).map((d) => ({ d, position: nodeById.get(d.nodeId)?.coords })).filter((x) => x.position);

    // Live weather: Beaufort flags at severe hubs
    const wxFlags = [];
    if (s.wx && s.useWeather) {
      const flag = (w) => (w.wind > 45 ? `F${s.beaufort(w.wind).force}` : w.code >= 95 ? 'TS' : 'RA');
      const severe = (w) => w && (w.wind > 45 || w.code >= 95 || w.precip >= 4);
      for (const n of net.nodes) {
        const w = s.wx.byNode[n.id];
        if (severe(w)) wxFlags.push({ coords: n.coords, text: flag(w), offset: [16, -12] });
      }
      for (const e of net.edges) {
        const w = s.wx.byLane?.[e.id];
        if (severe(w)) wxFlags.push({ coords: e.waypoints[Math.floor(e.waypoints.length / 2)], text: `≈${flag(w)}`, offset: [0, -10] });
      }
    }
    // Declutter: at low zoom only label hubs that matter right now.
    const lowZoom = (s.zoom ?? 3) < (net.id === 'GLOBAL' ? 2.6 : 6.1);
    const keyHubs = new Set([s.origin, s.destination, ...(selected?.nodes ?? []), ...s.disruptions.map((d) => d.nodeId).filter(Boolean)]);
    if (s.hover?.object?.id) keyHubs.add(s.hover.object.id);
    const codeKey = `${net.id}|${lowZoom}|${[...keyHubs].join()}`;
    if (this.codeKey !== codeKey) {
      this.codeKey = codeKey;
      this.codeData = lowZoom ? net.nodes.filter((n) => keyHubs.has(n.id)) : net.nodes;
    }

    const statusColor = (st) => (st === 'HOLDING' || st === 'STRANDED' ? t.hold : st === 'DELIVERED' ? t.inkDim : t.ink);

    const layers = [
      new D.ScatterplotLayer({
        id: 'storm-cells',
        data: stormRings,
        getPosition: (r) => r.d.center,
        getRadius: (r) => r.d.radiusKm * 1000 * r.f * (r.f === 1 ? 0.97 + pulse * 0.05 : 1),
        radiusUnits: 'meters',
        stroked: true,
        filled: true,
        getFillColor: (r) => rgba(t.hazard, r.f === 1 ? 26 : 14),
        getLineColor: (r) => rgba(t.hazard, r.f === 1 ? 150 + pulse * 80 : 110),
        lineWidthUnits: 'pixels',
        getLineWidth: (r) => (r.f === 1 ? 1.5 : 1),
        wrapLongitude: true,
        updateTriggers: { getRadius: [pulse], getLineColor: [pulse, this.themeName], getFillColor: [this.themeName] },
      }),
      new D.PathLayer({ id: 'corridors', data: edgesSolid, ...corridorCommon }),
      new D.PathLayer({
        id: 'corridors-road',
        data: edgesRoad,
        ...corridorCommon,
        getDashArray: [3, 2],
        dashJustified: true,
        extensions: [new D.PathStyleExtension({ dash: true })],
      }),
      new D.PathLayer({
        id: 'closed',
        data: edgesClosed,
        getPath: (e) => e.waypoints,
        getColor: rgba(t.hazard, 220),
        getWidth: 2,
        widthUnits: 'pixels',
        wrapLongitude: true,
        pickable: true,
        getDashArray: [1.5, 2],
        dashJustified: true,
        extensions: [new D.PathStyleExtension({ dash: true })],
        updateTriggers: { getColor: [this.themeName] },
      }),
      ghost &&
        new D.PathLayer({
          id: 'ghost',
          data: [ghost],
          getPath: (r) => r.path,
          getColor: rgba(t.hazard, 170),
          getWidth: 2,
          widthUnits: 'pixels',
          wrapLongitude: true,
          getDashArray: [1, 3],
          dashJustified: true,
          extensions: [new D.PathStyleExtension({ dash: true })],
          updateTriggers: { getColor: [this.themeName] },
        }),
      new D.PathLayer({
        id: 'alt-tracks',
        data: candidates,
        getPath: (r) => r.path,
        getColor: (r) => rgba(t.ink, s.hoverRoute === r.signature ? 230 : 110),
        getWidth: (r) => (s.hoverRoute === r.signature ? 3 : 1.6),
        widthUnits: 'pixels',
        wrapLongitude: true,
        pickable: true,
        getDashArray: [6, 4],
        dashJustified: true,
        extensions: [new D.PathStyleExtension({ dash: true })],
        updateTriggers: { getColor: [s.hoverRoute, this.themeName], getWidth: [s.hoverRoute] },
      }),
      selected &&
        new D.PathLayer({
          id: 'track-casing',
          data: [selected],
          getPath: (r) => r.path,
          getColor: rgba(t.casing, 235),
          getWidth: 8,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          wrapLongitude: true,
          updateTriggers: { getColor: [this.themeName] },
        }),
      selected &&
        s.plotProgress < 1 &&
        new D.TripsLayer({
          id: 'track-plot',
          data: [selected],
          getPath: (r) => r.path,
          getTimestamps: (r) => this.#stamps(r),
          currentTime: s.plotProgress * 1000,
          trailLength: 1000,
          fadeTrail: false,
          getColor: rgba(t.magenta),
          getWidth: 3.5,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          wrapLongitude: true,
          updateTriggers: { getColor: [this.themeName], getTimestamps: [selected.signature] },
        }),
      selected &&
        s.plotProgress >= 1 &&
        new D.PathLayer({
          id: 'track-core',
          data: [selected],
          getPath: (r) => r.path,
          getColor: rgba(t.magenta),
          getWidth: 3.5,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          wrapLongitude: true,
          pickable: true,
          updateTriggers: { getColor: [this.themeName] },
        }),
      new D.ScatterplotLayer({
        id: 'waypoints',
        data: routeNodes,
        getPosition: (r) => r.node.coords,
        getRadius: (r) => (r.i === 0 || r.i === routeNodes.length - 1 ? 9 : 7),
        radiusUnits: 'pixels',
        stroked: true,
        filled: true,
        getFillColor: rgba(t.casing, 255),
        getLineColor: rgba(t.magenta),
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        updateTriggers: { getFillColor: [this.themeName], getLineColor: [this.themeName] },
      }),
      new D.ScatterplotLayer({
        id: 'hazard-rings',
        data: hazardNodes,
        getPosition: (r) => r.position,
        getRadius: (r) => 13 + pulse * 9,
        radiusUnits: 'pixels',
        stroked: true,
        filled: false,
        getLineColor: rgba(t.hazard, 120 + (1 - pulse) * 120),
        lineWidthUnits: 'pixels',
        getLineWidth: 1.5,
        updateTriggers: { getRadius: [pulse], getLineColor: [pulse, this.themeName] },
      }),
      new D.IconLayer({
        id: 'hubs',
        data: hubs,
        getPosition: (n) => n.coords,
        getIcon: (n) => ({ url: GLYPHS[n.type], width: 48, height: 48, mask: true, id: `g-${n.type}` }),
        getSize: (n) => (n.id === s.origin || n.id === s.destination ? 20 : s.hover?.object?.id === n.id ? 20 : n.type === 'CHOKEPOINT' ? 12 : 14),
        sizeUnits: 'pixels',
        getColor: (n) => (closedNodeIds.has(n.id) ? rgba(t.hazard) : n.id === s.origin || n.id === s.destination ? rgba(t.magenta) : rgba(t.ink, 235)),
        pickable: true,
        updateTriggers: { getSize: [s.origin, s.destination, s.hover?.object?.id], getColor: [s.origin, s.destination, this.themeName, s.ctxVersion] },
      }),
      new D.TextLayer({
        id: 'hub-codes',
        data: this.codeData,
        getPosition: (n) => n.coords,
        getText: (n) => n.id,
        getSize: (n) => (n.id === s.origin || n.id === s.destination ? 12 : 10),
        sizeUnits: 'pixels',
        getPixelOffset: [0, 15],
        getColor: (n) => (n.id === s.origin || n.id === s.destination ? rgba(t.magenta) : rgba(t.inkDim, 230)),
        fontFamily: '"Martian Mono", ui-monospace, monospace',
        fontWeight: 600,
        characterSet: 'auto',
        outlineWidth: 3,
        outlineColor: rgba(t.casing, 255),
        fontSettings: { sdf: true, radius: 6, buffer: 6 },
        updateTriggers: { getColor: [s.origin, s.destination, this.themeName], getSize: [s.origin, s.destination] },
      }),
      new D.TextLayer({
        id: 'waypoint-numbers',
        data: routeNodes.filter((r) => r.i > 0 && r.i < routeNodes.length - 1),
        getPosition: (r) => r.node.coords,
        getText: (r) => `WP${String(r.i).padStart(2, '0')}`,
        getSize: 9,
        sizeUnits: 'pixels',
        getPixelOffset: [0, -16],
        getColor: rgba(t.magenta),
        fontFamily: '"Martian Mono", ui-monospace, monospace',
        fontWeight: 600,
        characterSet: 'auto',
        outlineWidth: 3,
        outlineColor: rgba(t.casing, 255),
        fontSettings: { sdf: true, radius: 6, buffer: 6 },
        updateTriggers: { getColor: [this.themeName] },
      }),
      new D.TextLayer({
        id: 'wx-flags',
        data: wxFlags,
        getPosition: (r) => r.coords,
        getText: (r) => r.text,
        getSize: 10,
        sizeUnits: 'pixels',
        getPixelOffset: (r) => r.offset,
        getColor: rgba(t.hazard),
        fontFamily: '"Martian Mono", ui-monospace, monospace',
        fontWeight: 700,
        characterSet: 'auto',
        outlineWidth: 3,
        outlineColor: rgba(t.casing, 255),
        fontSettings: { sdf: true, radius: 6, buffer: 6 },
        updateTriggers: { getColor: [this.themeName] },
      }),
      new D.IconLayer({
        id: 'placards',
        data: placards,
        getPosition: (d) => d.position,
        getIcon: (d) => this.#placard(d.kind),
        getSize: 30,
        sizeUnits: 'pixels',
        getPixelOffset: (d) => (d.kind === 'STORM' ? [0, 0] : [0, -26]),
        pickable: true,
        wrapLongitude: true,
        updateTriggers: { getIcon: [this.themeName] },
      }),
      s.convoyPath?.length > 1 &&
        new D.PathLayer({
          id: 'convoy-track',
          data: [{ path: s.convoyPath }],
          getPath: (d) => d.path,
          getColor: rgba(t.ink, 220),
          getWidth: 2.5,
          widthUnits: 'pixels',
          wrapLongitude: true,
          getDashArray: [4, 3],
          dashJustified: true,
          extensions: [new D.PathStyleExtension({ dash: true })],
          updateTriggers: { getColor: [this.themeName] },
        }),
      s.selectedConvoy &&
        new D.ScatterplotLayer({
          id: 'convoy-ring',
          data: [s.selectedConvoy],
          getPosition: (c) => c.coords,
          getRadius: 15 + pulse * 3,
          radiusUnits: 'pixels',
          stroked: true,
          filled: false,
          getLineColor: rgba(t.ink, 230),
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          updateTriggers: { getRadius: [pulse], getLineColor: [this.themeName] },
        }),
      new D.IconLayer({
        id: 'convoys',
        data: s.convoys,
        getPosition: (c) => c.coords,
        getIcon: () => ({ url: GLYPHS.CHEVRON, width: 48, height: 48, mask: true, id: 'chev' }),
        getAngle: (c) => (c.phase === 'underway' ? -c.bearing : 0),
        getSize: (c) => (s.hover?.object?.id === c.id ? 22 : 16),
        sizeUnits: 'pixels',
        getColor: (c) => rgba(statusColor(c.status)),
        pickable: true,
        updateTriggers: { getColor: [this.themeName, s.sandboxVersion], getSize: [s.hover?.object?.id] },
      }),
      new D.TextLayer({
        id: 'convoy-codes',
        data: s.convoys,
        getPosition: (c) => c.coords,
        getText: (c) => c.code.serial.slice(2),
        getSize: 9,
        sizeUnits: 'pixels',
        getPixelOffset: [12, 10],
        getTextAnchor: 'start',
        getColor: (c) => rgba(statusColor(c.status), 230),
        fontFamily: '"Martian Mono", ui-monospace, monospace',
        fontWeight: 600,
        characterSet: 'auto',
        outlineWidth: 3,
        outlineColor: rgba(t.casing, 255),
        fontSettings: { sdf: true, radius: 6, buffer: 6 },
        updateTriggers: { getColor: [this.themeName, s.sandboxVersion] },
      }),
    ].filter(Boolean);

    this.overlay.setProps({ layers });
  }

  resize() {
    this.map?.resize();
  }
}
