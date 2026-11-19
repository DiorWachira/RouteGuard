/**
 * RouteGuard — multimodal freight graph datasets.
 *
 * Two switchable presets:
 *   GLOBAL  — 31 nodes / 66 bidirectional corridors (Asia ⇄ Middle East ⇄ Africa ⇄ Europe ⇄ North America)
 *   EAFRICA — 22 nodes / 42 bidirectional corridors (Northern + Central corridors, SGR/MGR, Lake Victoria)
 *
 * Node schema:  { id, name, code, type, coords:[lng,lat], baseDwellHours, handlingCostUsd, congestionRisk, country }
 * Edge schema:  { id, from, to, mode, distanceKm, baseSpeedKmh, costPerTeuUsd, co2KgPerTeuKm,
 *                 waypoints:[[lng,lat],...], isChokepoint, capacityTeuWeek, label }
 *
 * Units: costPerTeuUsd is USD per TEU-kilometre; co2KgPerTeuKm is kg CO2e per TEU-kilometre.
 * distanceKm is derived from the waypoint geometry (great-circle sum × mode tortuosity ≥ 1), which keeps
 * the haversine A* heuristic admissible: no edge can be shorter than the straight line between its ends.
 */

export const MODES = Object.freeze({ MARITIME: 'MARITIME', RAIL: 'RAIL', ROAD: 'ROAD' });
export const NODE_TYPES = Object.freeze({ PORT: 'PORT', RAIL_HUB: 'RAIL_HUB', DRY_PORT: 'DRY_PORT', CHOKEPOINT: 'CHOKEPOINT' });

const EARTH_RADIUS_KM = 6371.0088;

export function haversineKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function polylineKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1], points[i]);
  return total;
}

/** Tortuosity: real corridors bend more than our simplified waypoints show. Always ≥ 1. */
const MODE_TAG = { MARITIME: 'M', RAIL: 'R', ROAD: 'T' };
const TORTUOSITY = { MARITIME: 1.04, RAIL: 1.09, ROAD: 1.12 };

/** Mode profiles: [baseSpeedKmh, costPerTeuKmUsd, co2KgPerTeuKm, capacityTeuWeek]. */
const PROFILE = {
  // Global
  SEA_MAINLINE: ['MARITIME', 31, 0.085, 0.055, 140000],
  SEA_TRANSPACIFIC: ['MARITIME', 33, 0.095, 0.058, 160000],
  SEA_FEEDER: ['MARITIME', 26, 0.21, 0.11, 22000],
  RAIL_CN_EU: ['RAIL', 38, 0.42, 0.16, 5200],
  RAIL_EU: ['RAIL', 45, 0.55, 0.06, 7000],
  RAIL_US: ['RAIL', 42, 0.38, 0.13, 9000],
  ROAD_EU: ['ROAD', 62, 1.65, 0.62, 6000],
  ROAD_US: ['ROAD', 66, 1.42, 0.64, 7500],
  ROAD_GCC: ['ROAD', 58, 1.2, 0.66, 3000],
  // East Africa
  SGR_KE: ['RAIL', 50, 1.05, 0.14, 7800],
  MGR: ['RAIL', 22, 0.9, 0.2, 1500],
  SGR_TZ: ['RAIL', 55, 1.0, 0.12, 5000],
  ROAD_KE: ['ROAD', 34, 2.1, 0.68, 9500],
  ROAD_TZ: ['ROAD', 31, 2.3, 0.7, 6000],
  ROAD_GL: ['ROAD', 28, 2.6, 0.72, 2400],
  LAKE_FERRY: ['MARITIME', 18, 1.1, 0.35, 900],
  COASTAL: ['MARITIME', 22, 0.35, 0.12, 12000],
};

function node(id, name, code, type, coords, baseDwellHours, handlingCostUsd, congestionRisk, country) {
  return { id, name, code, type, coords, baseDwellHours, handlingCostUsd, congestionRisk, country };
}

function buildEdges(nodes, defs) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return defs.map(([from, to, profileKey, mid, opts = {}]) => {
    const [mode, baseSpeedKmh, costPerTeuUsd, co2KgPerTeuKm, capacityTeuWeek] = PROFILE[profileKey];
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) throw new Error(`Corridor ${from}-${to} references an unknown node`);
    const waypoints = [a.coords, ...mid, b.coords];
    const distanceKm = Math.round(polylineKm(waypoints) * TORTUOSITY[mode]);
    const isChokepoint = Boolean(opts.chokepoint) || a.type === 'CHOKEPOINT' || b.type === 'CHOKEPOINT';
    return {
      id: `${from}-${to}-${MODE_TAG[mode]}`,
      from,
      to,
      mode,
      distanceKm,
      baseSpeedKmh: opts.speed ?? baseSpeedKmh,
      costPerTeuUsd: opts.cost ?? costPerTeuUsd,
      co2KgPerTeuKm: opts.co2 ?? co2KgPerTeuKm,
      waypoints,
      isChokepoint,
      capacityTeuWeek: opts.capacity ?? capacityTeuWeek,
      label: opts.label ?? `${a.name} – ${b.name}`,
      profile: profileKey,
    };
  });
}

/* ───────────────────────────── GLOBAL INTERMODAL NETWORK ───────────────────────────── */

const G_NODES = [
  node('SHA', 'Shanghai (Yangshan)', 'CNSHA', 'PORT', [122.07, 30.62], 30, 210, 0.35, 'CN'),
  node('BUS', 'Busan', 'KRPUS', 'PORT', [129.04, 35.08], 24, 190, 0.2, 'KR'),
  node('YTN', 'Shenzhen Yantian', 'CNYTN', 'PORT', [114.27, 22.57], 28, 200, 0.3, 'CN'),
  node('SIN', 'Singapore', 'SGSIN', 'PORT', [103.75, 1.27], 20, 180, 0.25, 'SG'),
  node('MAL', 'Strait of Malacca', 'XMAL', 'CHOKEPOINT', [98.6, 5.0], 2, 0, 0.2, '—'),
  node('CMB', 'Colombo', 'LKCMB', 'PORT', [79.84, 6.95], 26, 170, 0.3, 'LK'),
  node('NSA', 'Nhava Sheva', 'INNSA', 'PORT', [72.95, 18.95], 40, 175, 0.45, 'IN'),
  node('XIY', "Xi'an Int'l Trade Port", 'CNXIY', 'RAIL_HUB', [109.05, 34.4], 14, 95, 0.2, 'CN'),
  node('KHG', 'Khorgos Gateway', 'KZKHG', 'DRY_PORT', [80.3, 44.2], 20, 140, 0.35, 'KZ'),
  node('JEA', 'Jebel Ali', 'AEJEA', 'PORT', [55.03, 25.0], 22, 185, 0.25, 'AE'),
  node('HOR', 'Strait of Hormuz', 'XHOR', 'CHOKEPOINT', [56.45, 26.45], 2, 15, 0.4, '—'),
  node('SLL', 'Salalah', 'OMSLL', 'PORT', [54.0, 16.95], 24, 170, 0.25, 'OM'),
  node('BAB', 'Bab-el-Mandeb', 'XBAB', 'CHOKEPOINT', [43.4, 12.6], 2, 25, 0.55, '—'),
  node('DJI', 'Djibouti', 'DJJIB', 'PORT', [43.13, 11.6], 30, 180, 0.3, 'DJ'),
  node('SUZ', 'Suez Canal', 'XSUZ', 'CHOKEPOINT', [32.34, 30.6], 14, 45, 0.45, 'EG'),
  node('MBA', 'Mombasa', 'KEMBA', 'PORT', [39.67, -4.06], 72, 230, 0.55, 'KE'),
  node('DUR', 'Durban', 'ZADUR', 'PORT', [31.03, -29.87], 60, 220, 0.5, 'ZA'),
  node('CPT', 'Cape of Good Hope', 'XCPT', 'CHOKEPOINT', [18.47, -34.9], 0, 0, 0.3, '—'),
  node('PIR', 'Piraeus', 'GRPIR', 'PORT', [23.6, 37.94], 30, 175, 0.3, 'GR'),
  node('GIB', 'Strait of Gibraltar', 'XGIB', 'CHOKEPOINT', [-5.6, 35.95], 1, 0, 0.1, '—'),
  node('RTM', 'Rotterdam', 'NLRTM', 'PORT', [4.05, 51.95], 26, 195, 0.3, 'NL'),
  node('ANR', 'Antwerp-Bruges', 'BEANR', 'PORT', [4.3, 51.28], 28, 190, 0.3, 'BE'),
  node('HAM', 'Hamburg', 'DEHAM', 'PORT', [9.95, 53.54], 30, 200, 0.35, 'DE'),
  node('FXT', 'Felixstowe', 'GBFXT', 'PORT', [1.33, 51.95], 34, 210, 0.4, 'GB'),
  node('DUI', 'Duisburg Gateway', 'DEDUI', 'RAIL_HUB', [6.75, 51.43], 12, 85, 0.2, 'DE'),
  node('MLW', 'Małaszewicze', 'PLMLW', 'RAIL_HUB', [23.55, 52.05], 22, 130, 0.4, 'PL'),
  node('PAN', 'Panama Canal', 'XPAN', 'CHOKEPOINT', [-79.75, 9.15], 18, 60, 0.4, 'PA'),
  node('NYC', 'New York / Newark', 'USNYC', 'PORT', [-74.15, 40.68], 36, 260, 0.35, 'US'),
  node('SAV', 'Savannah', 'USSAV', 'PORT', [-81.1, 32.08], 30, 230, 0.3, 'US'),
  node('LAX', 'Los Angeles / Long Beach', 'USLAX', 'PORT', [-118.25, 33.74], 48, 270, 0.5, 'US'),
  node('CHI', 'Chicago Rail Hub', 'USCHI', 'RAIL_HUB', [-87.75, 41.8], 18, 110, 0.3, 'US'),
];

// Shared sea-lane fragments (lng, lat) — kept offshore so plotted tracks stay on water.
const MED_WEST = [[12.5, 37.0], [9.5, 37.6], [4.0, 37.5], [-1.0, 36.6], [-4.0, 36.1]];
const BISCAY_TO_DOVER = [[-7.5, 36.2], [-9.6, 37.5], [-10.0, 42.0], [-9.4, 44.0], [-5.6, 48.4], [-2.0, 49.9], [1.5, 51.05]];
const CHINA_COAST_SOUTH = [[122.6, 29.5], [121.0, 26.5], [119.8, 24.4], [117.5, 22.6]];
const SCS_SOUTH = [[113.0, 17.5], [110.5, 11.0], [107.0, 5.5], [104.6, 1.6]];
const RED_SEA_NORTHBOUND = [[42.5, 14.0], [40.5, 17.5], [38.0, 21.0], [35.8, 24.6], [34.0, 27.3], [33.0, 28.8], [32.55, 29.9]];
const TRANSATLANTIC_EAST = [[-73.5, 40.3], [-65.0, 41.0], [-50.0, 43.0], [-30.0, 47.0], [-12.0, 49.0], [-5.0, 49.6], [-1.0, 50.2], [1.5, 51.05]];
const CARIBBEAN_NORTH = [[-79.9, 9.5], [-78.5, 12.0], [-75.0, 16.5], [-74.2, 19.8]];
const WEST_AFRICA_NORTH = [[14.0, -30.0], [8.0, -18.0], [2.0, -5.0], [-8.0, 2.5], [-17.5, 12.0], [-18.5, 21.0], [-14.0, 29.5], [-9.5, 34.5]];

const G_EDGE_DEFS = [
  // ── Maritime: East Asia
  ['SHA', 'BUS', 'SEA_FEEDER', [[123.5, 31.5], [127.0, 33.5]]],
  ['SHA', 'YTN', 'SEA_MAINLINE', [...CHINA_COAST_SOUTH, [114.6, 22.2]]],
  ['SHA', 'SIN', 'SEA_MAINLINE', [...CHINA_COAST_SOUTH, ...SCS_SOUTH]],
  ['YTN', 'SIN', 'SEA_MAINLINE', [[114.6, 21.8], ...SCS_SOUTH]],
  // ── Maritime: Indian Ocean
  ['SIN', 'MAL', 'SEA_MAINLINE', [[103.3, 1.25], [102.3, 2.2], [100.8, 3.0]]],
  ['MAL', 'CMB', 'SEA_MAINLINE', [[97.0, 6.0], [92.0, 6.2], [85.0, 5.8], [80.5, 5.6]]],
  ['CMB', 'NSA', 'SEA_FEEDER', [[79.4, 6.5], [76.5, 8.0], [74.5, 12.5], [72.6, 18.0]]],
  ['CMB', 'SLL', 'SEA_MAINLINE', [[79.6, 6.7], [75.0, 8.5], [65.0, 12.0], [56.0, 15.5]]],
  ['CMB', 'BAB', 'SEA_MAINLINE', [[79.6, 6.7], [70.0, 9.5], [60.0, 12.5], [51.0, 12.3], [45.5, 12.0]]],
  ['SLL', 'BAB', 'SEA_MAINLINE', [[54.0, 16.6], [52.0, 14.0], [48.0, 12.6], [45.0, 12.0]]],
  ['JEA', 'HOR', 'SEA_FEEDER', [[55.4, 25.6]]],
  ['HOR', 'SLL', 'SEA_MAINLINE', [[57.2, 25.8], [58.6, 24.0], [59.5, 22.5], [58.0, 19.0], [55.5, 16.6]]],
  ['HOR', 'NSA', 'SEA_FEEDER', [[57.5, 25.3], [60.0, 24.5], [66.0, 22.0], [71.0, 19.5]]],
  ['BAB', 'DJI', 'SEA_FEEDER', [[43.3, 12.0]]],
  ['MBA', 'BAB', 'SEA_MAINLINE', [[41.5, -3.0], [45.0, 0.5], [49.5, 6.0], [51.5, 11.0], [48.5, 12.2], [45.0, 12.0]]],
  ['MBA', 'SLL', 'SEA_MAINLINE', [[42.0, -2.5], [50.0, 6.0], [53.5, 13.0]]],
  ['MBA', 'CMB', 'SEA_MAINLINE', [[45.0, -2.5], [60.0, 0.0], [72.5, 1.0], [77.0, 5.0]]],
  ['DUR', 'MBA', 'SEA_MAINLINE', [[33.5, -28.0], [36.0, -24.5], [40.8, -18.0], [41.2, -12.5], [40.6, -8.0], [39.9, -4.3]]],
  // ── Maritime: Red Sea, Suez, Mediterranean
  ['BAB', 'SUZ', 'SEA_MAINLINE', RED_SEA_NORTHBOUND, { chokepoint: true }],
  ['SUZ', 'PIR', 'SEA_MAINLINE', [[32.32, 31.3], [31.0, 32.3], [27.5, 33.6], [24.5, 35.6], [24.0, 37.0]]],
  ['SUZ', 'GIB', 'SEA_MAINLINE', [[32.32, 31.3], [30.0, 32.6], [24.0, 34.3], [18.0, 35.5], ...MED_WEST]],
  ['PIR', 'GIB', 'SEA_MAINLINE', [[23.0, 36.5], [18.0, 36.5], ...MED_WEST]],
  // ── Maritime: North Europe
  ['GIB', 'RTM', 'SEA_MAINLINE', [...BISCAY_TO_DOVER, [3.0, 51.6]]],
  ['GIB', 'ANR', 'SEA_MAINLINE', [...BISCAY_TO_DOVER, [3.3, 51.45]]],
  ['GIB', 'HAM', 'SEA_MAINLINE', [...BISCAY_TO_DOVER, [3.5, 52.3], [6.5, 53.9], [8.3, 54.0]]],
  ['GIB', 'FXT', 'SEA_MAINLINE', [...BISCAY_TO_DOVER, [1.8, 51.6]]],
  ['RTM', 'FXT', 'SEA_FEEDER', [[3.0, 51.9]]],
  ['RTM', 'HAM', 'SEA_FEEDER', [[4.8, 53.0], [7.0, 53.9], [8.3, 54.0]]],
  ['RTM', 'ANR', 'SEA_FEEDER', [[3.4, 51.5]]],
  // ── Maritime: Cape of Good Hope bypass
  ['DUR', 'CPT', 'SEA_MAINLINE', [[30.0, -31.5], [26.0, -34.2], [22.0, -35.0]]],
  ['SIN', 'CPT', 'SEA_MAINLINE', [[104.6, 0.0], [107.0, -1.0], [106.6, -4.8], [105.85, -6.2], [102.0, -9.0], [80.0, -20.0], [55.0, -32.0], [35.0, -36.5]]],
  ['CMB', 'CPT', 'SEA_MAINLINE', [[78.0, 4.0], [70.0, -10.0], [50.0, -30.0], [35.0, -36.5]]],
  ['CPT', 'GIB', 'SEA_MAINLINE', WEST_AFRICA_NORTH],
  // ── Maritime: Pacific & Americas
  ['SHA', 'LAX', 'SEA_TRANSPACIFIC', [[125.0, 31.0], [131.5, 31.5], [140.0, 34.5], [155.0, 40.0], [175.0, 44.0], [-170.0, 45.0], [-150.0, 42.0], [-135.0, 37.0], [-122.0, 34.2]]],
  ['BUS', 'LAX', 'SEA_TRANSPACIFIC', [[130.5, 36.5], [135.0, 39.0], [139.8, 41.5], [141.6, 41.4], [150.0, 43.0], [170.0, 46.0], [-170.0, 47.0], [-150.0, 44.0], [-135.0, 38.0], [-122.0, 34.2]]],
  ['LAX', 'PAN', 'SEA_MAINLINE', [[-117.5, 32.0], [-113.5, 26.0], [-108.0, 20.0], [-100.0, 15.5], [-92.0, 13.0], [-85.5, 9.0], [-80.0, 7.5], [-79.55, 8.9]]],
  ['PAN', 'SAV', 'SEA_MAINLINE', [...CARIBBEAN_NORTH, [-74.0, 23.0], [-75.5, 26.0], [-77.5, 29.0], [-79.6, 30.5]]],
  ['PAN', 'NYC', 'SEA_MAINLINE', [...CARIBBEAN_NORTH, [-73.0, 24.0], [-72.0, 32.0], [-73.5, 39.5], [-74.05, 40.5]]],
  ['SAV', 'NYC', 'SEA_FEEDER', [[-80.0, 31.6], [-76.5, 34.0], [-75.0, 35.5], [-74.0, 38.5], [-74.05, 40.5]]],
  ['NYC', 'RTM', 'SEA_MAINLINE', [...TRANSATLANTIC_EAST, [3.0, 51.6]]],
  ['NYC', 'ANR', 'SEA_MAINLINE', [...TRANSATLANTIC_EAST, [3.3, 51.45]]],
  ['SAV', 'GIB', 'SEA_MAINLINE', [[-79.0, 31.5], [-60.0, 33.0], [-35.0, 35.5], [-15.0, 36.0], [-8.5, 36.0]]],
  ['NYC', 'GIB', 'SEA_MAINLINE', [[-73.0, 40.0], [-55.0, 39.0], [-30.0, 37.5], [-12.0, 36.3]]],
  // ── Rail: China–Europe land bridge
  ['SHA', 'XIY', 'RAIL_CN_EU', [[121.47, 31.23], [118.8, 32.05], [117.2, 34.2], [113.6, 34.75]]],
  ['YTN', 'XIY', 'RAIL_CN_EU', [[113.26, 23.13], [113.0, 28.2], [114.3, 30.6], [111.0, 33.5]]],
  ['XIY', 'KHG', 'RAIL_CN_EU', [[103.8, 36.06], [101.8, 36.6], [98.5, 39.7], [95.4, 41.1], [93.5, 42.8], [87.6, 43.8], [84.9, 44.4]]],
  ['KHG', 'MLW', 'RAIL_CN_EU', [[76.9, 43.25], [73.1, 49.8], [71.4, 51.2], [69.1, 54.9], [65.3, 55.45], [61.4, 55.15], [55.96, 54.74], [50.1, 53.2], [45.0, 53.2], [37.6, 55.75], [32.0, 54.8], [27.56, 53.9], [23.7, 52.1]]],
  ['MLW', 'DUI', 'RAIL_EU', [[21.0, 52.23], [17.0, 52.4], [13.4, 52.52], [11.6, 52.13], [9.73, 52.37], [7.6, 51.96]]],
  ['MLW', 'HAM', 'RAIL_EU', [[21.0, 52.23], [17.0, 52.4], [13.4, 52.52], [10.8, 53.3]]],
  ['DUI', 'RTM', 'RAIL_EU', [[6.1, 51.85], [5.1, 51.9]]],
  ['DUI', 'ANR', 'RAIL_EU', [[6.0, 51.2], [5.0, 51.2]]],
  ['DUI', 'HAM', 'RAIL_EU', [[7.6, 51.96], [9.0, 53.0]]],
  ['PIR', 'DUI', 'RAIL_EU', [[22.9, 40.64], [21.43, 42.0], [20.46, 44.82], [19.04, 47.5], [16.37, 48.21], [11.58, 48.14], [9.0, 49.5], [8.68, 50.11]], { speed: 34, cost: 0.6, co2: 0.09 }],
  // ── Rail: North America
  ['LAX', 'CHI', 'RAIL_US', [[-118.2, 34.05], [-117.3, 34.1], [-114.6, 35.0], [-111.65, 35.2], [-106.65, 35.08], [-103.2, 34.5], [-97.3, 37.7], [-94.6, 39.1], [-91.4, 40.6]]],
  ['CHI', 'NYC', 'RAIL_US', [[-86.0, 41.6], [-83.55, 41.65], [-81.7, 41.5], [-80.0, 40.44], [-77.0, 40.3], [-75.2, 40.0]]],
  ['SAV', 'CHI', 'RAIL_US', [[-83.6, 32.85], [-84.4, 33.75], [-85.3, 35.05], [-86.8, 36.16], [-86.15, 39.77]]],
  // ── Road
  ['RTM', 'ANR', 'ROAD_EU', [[4.45, 51.9], [4.5, 51.6]]],
  ['RTM', 'DUI', 'ROAD_EU', [[4.5, 51.9], [5.9, 51.98]]],
  ['ANR', 'DUI', 'ROAD_EU', [[5.5, 51.2], [6.0, 51.25]]],
  ['HAM', 'DUI', 'ROAD_EU', [[8.8, 53.08], [7.6, 51.96]]],
  ['MLW', 'DUI', 'ROAD_EU', [[21.0, 52.23], [16.9, 52.4], [13.4, 52.52], [10.5, 52.3], [7.6, 51.96]]],
  ['NYC', 'SAV', 'ROAD_US', [[-75.2, 40.0], [-76.6, 39.3], [-77.4, 37.5], [-78.6, 35.8], [-79.9, 34.2]]],
  ['NYC', 'CHI', 'ROAD_US', [[-75.5, 41.0], [-77.5, 41.1], [-80.6, 41.1], [-83.55, 41.65], [-86.0, 41.6]]],
  ['LAX', 'CHI', 'ROAD_US', [[-117.3, 34.1], [-114.6, 35.0], [-111.65, 35.2], [-106.65, 35.08], [-101.8, 35.2], [-97.5, 35.5], [-94.5, 37.1], [-90.2, 38.6]]],
  ['SAV', 'CHI', 'ROAD_US', [[-84.4, 33.75], [-85.3, 35.05], [-86.8, 36.16], [-86.15, 39.77]]],
  ['JEA', 'SLL', 'ROAD_GCC', [[55.6, 24.2], [56.5, 22.9], [56.0, 20.0], [54.6, 17.6]]],
];

/* ───────────────────────── EAST AFRICA NORTHERN CORRIDOR DEEP-DIVE ───────────────────────── */

const E_NODES = [
  node('IOA', 'Mainline Relay · Indian Ocean', 'XIOA', 'CHOKEPOINT', [41.2, -5.2], 0, 0, 0.1, '—'),
  node('MBA', 'Mombasa Port', 'KEMBA', 'PORT', [39.65, -4.05], 84, 240, 0.6, 'KE'),
  node('MRK', 'Mariakani', 'KEMRK', 'RAIL_HUB', [39.47, -3.86], 2, 20, 0.15, 'KE'),
  node('VOI', 'Voi', 'KEVOI', 'RAIL_HUB', [38.56, -3.39], 3, 30, 0.15, 'KE'),
  node('NBO', 'Nairobi ICD', 'KENBO', 'DRY_PORT', [36.89, -1.33], 30, 160, 0.45, 'KE'),
  node('NVS', 'Naivasha ICD (SGR)', 'KENVS', 'DRY_PORT', [36.42, -0.92], 20, 130, 0.3, 'KE'),
  node('NKU', 'Nakuru', 'KENUU', 'RAIL_HUB', [36.07, -0.3], 6, 40, 0.2, 'KE'),
  node('ELD', 'Eldoret ICD', 'KEEDL', 'DRY_PORT', [35.27, 0.52], 14, 90, 0.25, 'KE'),
  node('KSM', 'Kisumu Port', 'KEKIS', 'PORT', [34.74, -0.1], 18, 110, 0.3, 'KE'),
  node('MLB', 'Malaba Border', 'KEMLB', 'CHOKEPOINT', [34.28, 0.64], 30, 85, 0.6, 'KE/UG'),
  node('BSA', 'Busia Border', 'KEBSA', 'CHOKEPOINT', [34.09, 0.46], 22, 85, 0.5, 'KE/UG'),
  node('KLA', 'Kampala ICD', 'UGKLA', 'DRY_PORT', [32.58, 0.32], 20, 140, 0.35, 'UG'),
  node('PBL', 'Port Bell', 'UGPBL', 'PORT', [32.65, 0.29], 14, 90, 0.25, 'UG'),
  node('KTN', 'Katuna / Gatuna Border', 'UGKTN', 'CHOKEPOINT', [30.0, -1.4], 16, 70, 0.45, 'UG/RW'),
  node('KGL', 'Kigali (Masaka ICD)', 'RWKGL', 'DRY_PORT', [30.17, -1.99], 18, 150, 0.35, 'RW'),
  node('RSM', 'Rusumo Border', 'TZRSM', 'CHOKEPOINT', [30.78, -2.38], 14, 70, 0.4, 'TZ/RW'),
  node('ISK', 'Isaka Dry Port', 'TZISK', 'DRY_PORT', [32.92, -3.89], 20, 110, 0.35, 'TZ'),
  node('MWZ', 'Mwanza South Port', 'TZMWZ', 'PORT', [32.9, -2.53], 16, 95, 0.3, 'TZ'),
  node('DOD', 'Dodoma', 'TZDOD', 'RAIL_HUB', [35.74, -6.17], 6, 45, 0.2, 'TZ'),
  node('MOR', 'Morogoro', 'TZMOR', 'RAIL_HUB', [37.66, -6.82], 4, 35, 0.15, 'TZ'),
  node('DAR', 'Dar es Salaam', 'TZDAR', 'PORT', [39.29, -6.83], 72, 225, 0.55, 'TZ'),
  node('TNG', 'Tanga Port', 'TZTGT', 'PORT', [39.11, -5.07], 30, 160, 0.3, 'TZ'),
];

const E_EDGE_DEFS = [
  // ── Rail: Kenya SGR (Mombasa–Nairobi–Naivasha)
  ['MBA', 'MRK', 'SGR_KE', [[39.55, -3.95]], { label: 'SGR Mombasa – Mariakani' }],
  ['MRK', 'VOI', 'SGR_KE', [[39.0, -3.6]], { label: 'SGR Mariakani – Voi' }],
  ['VOI', 'NBO', 'SGR_KE', [[38.17, -2.69], [37.6, -2.15], [37.08, -1.75]], { label: 'SGR Voi – Nairobi' }],
  ['NBO', 'NVS', 'SGR_KE', [[36.7, -1.35], [36.6, -1.15]], { label: 'SGR Phase 2A Nairobi – Naivasha' }],
  // ── Rail: metre-gauge links
  ['NVS', 'MLB', 'MGR', [[36.25, -0.6], [36.07, -0.3], [35.75, 0.0], [35.27, 0.52], [34.8, 0.6]], { label: 'MGR Naivasha – Malaba' }],
  ['NVS', 'KSM', 'MGR', [[36.07, -0.3], [35.6, -0.2], [35.2, -0.25]], { label: 'MGR Kisumu branch' }],
  ['MLB', 'KLA', 'MGR', [[34.18, 0.69], [33.6, 0.45], [33.2, 0.43]], { label: 'MGR Tororo – Kampala' }],
  // ── Rail: Tanzania Central Corridor
  ['DAR', 'MOR', 'SGR_TZ', [[38.8, -6.85], [38.2, -6.8]], { label: 'TZ SGR Dar – Morogoro' }],
  ['MOR', 'DOD', 'SGR_TZ', [[37.0, -6.5], [36.4, -6.3]], { label: 'TZ SGR Morogoro – Dodoma' }],
  ['DOD', 'ISK', 'MGR', [[34.6, -5.7], [32.8, -5.02]], { label: 'Central Line Dodoma – Tabora – Isaka' }],
  ['ISK', 'MWZ', 'MGR', [[33.42, -3.66], [33.0, -3.0]], { label: 'Central Line Isaka – Mwanza' }],
  // ── Road: Northern Corridor (A109 / A104)
  ['MBA', 'MRK', 'ROAD_KE', [[39.58, -3.98]], { label: 'A109 Mombasa – Mariakani' }],
  ['MRK', 'VOI', 'ROAD_KE', [[39.05, -3.66]], { label: 'A109 Mariakani – Voi' }],
  ['VOI', 'NBO', 'ROAD_KE', [[38.2, -2.75], [37.65, -2.2], [37.15, -1.8]], { label: 'A109 Voi – Nairobi' }],
  ['NBO', 'NVS', 'ROAD_KE', [[36.6, -1.1]], { label: 'A104 Nairobi – Naivasha' }],
  ['NBO', 'NKU', 'ROAD_KE', [[36.65, -1.1], [36.43, -0.75]], { label: 'A104 Nairobi – Nakuru' }],
  ['NVS', 'NKU', 'ROAD_KE', [[36.3, -0.6]], { label: 'A104 Naivasha – Nakuru' }],
  ['NKU', 'ELD', 'ROAD_KE', [[35.75, 0.05]], { label: 'A104 Nakuru – Eldoret' }],
  ['ELD', 'MLB', 'ROAD_KE', [[34.85, 0.58]], { label: 'A104 Eldoret – Malaba' }],
  ['ELD', 'BSA', 'ROAD_KE', [[34.75, 0.5], [34.56, 0.57]], { label: 'Eldoret – Bungoma – Busia' }],
  ['NKU', 'KSM', 'ROAD_KE', [[35.4, -0.2], [35.0, -0.2]], { label: 'B1 Nakuru – Kisumu' }],
  ['KSM', 'BSA', 'ROAD_KE', [[34.4, 0.15]], { label: 'Kisumu – Busia' }],
  ['MBA', 'TNG', 'ROAD_TZ', [[39.4, -4.6]], { label: 'Lunga Lunga coastal road' }],
  // ── Road: Uganda / Rwanda / Tanzania
  ['MLB', 'KLA', 'ROAD_GL', [[33.6, 0.5], [33.2, 0.45]], { label: 'Malaba – Jinja – Kampala' }],
  ['BSA', 'KLA', 'ROAD_GL', [[33.6, 0.42], [33.2, 0.4]], { label: 'Busia – Kampala' }],
  ['KLA', 'PBL', 'ROAD_GL', [], { label: 'Kampala – Port Bell spur' }],
  ['KLA', 'KTN', 'ROAD_GL', [[31.75, -0.3], [30.65, -0.6], [29.98, -1.25]], { label: 'Kampala – Masaka – Mbarara – Katuna' }],
  ['KTN', 'KGL', 'ROAD_GL', [[30.06, -1.7]], { label: 'Gatuna – Kigali' }],
  ['DAR', 'MOR', 'ROAD_TZ', [[38.75, -6.75]], { label: 'A7 Dar – Morogoro' }],
  ['MOR', 'DOD', 'ROAD_TZ', [[36.9, -6.6]], { label: 'B129 Morogoro – Dodoma' }],
  ['DOD', 'ISK', 'ROAD_TZ', [[34.6, -5.5], [33.4, -4.5]], { label: 'Dodoma – Singida – Isaka' }],
  ['ISK', 'RSM', 'ROAD_GL', [[32.0, -3.4], [31.2, -2.85]], { label: 'Isaka – Nyakanazi – Rusumo' }],
  ['RSM', 'KGL', 'ROAD_GL', [[30.5, -2.15]], { label: 'Rusumo – Kigali' }],
  ['TNG', 'MOR', 'ROAD_TZ', [[38.6, -5.6], [38.0, -6.3]], { label: 'Tanga – Segera – Morogoro' }],
  // ── Maritime: Indian Ocean feeders & coastal
  ['IOA', 'MBA', 'COASTAL', [[40.4, -4.5], [39.75, -4.08]], { label: 'Mainline relay – Mombasa' }],
  ['IOA', 'TNG', 'COASTAL', [[40.3, -4.8], [39.5, -4.85], [39.2, -5.0]], { label: 'Mainline relay – Tanga' }],
  ['IOA', 'DAR', 'COASTAL', [[40.3, -6.4], [40.0, -6.6], [39.5, -6.75]], { label: 'Mainline relay – Dar es Salaam' }],
  ['MBA', 'TNG', 'COASTAL', [[39.75, -4.4], [39.4, -4.85]], { label: 'Coastal Mombasa – Tanga' }],
  ['TNG', 'DAR', 'COASTAL', [[39.05, -5.6], [39.05, -6.2]], { label: 'Zanzibar Channel' }],
  // ── Maritime: Lake Victoria wagon ferries
  ['KSM', 'PBL', 'LAKE_FERRY', [[34.4, -0.25], [34.0, -0.35], [33.5, -0.15], [33.0, 0.05]], { label: 'Lake Victoria ferry Kisumu – Port Bell' }],
  ['KSM', 'MWZ', 'LAKE_FERRY', [[34.2, -0.4], [33.7, -1.2], [33.1, -2.0]], { label: 'Lake Victoria ferry Kisumu – Mwanza' }],
  ['MWZ', 'PBL', 'LAKE_FERRY', [[32.8, -1.6], [32.85, -0.6], [32.75, 0.1]], { label: 'Lake Victoria ferry Mwanza – Port Bell' }],
];

export const NETWORKS = {
  GLOBAL: {
    id: 'GLOBAL',
    name: 'Global Intermodal',
    short: 'Global',
    nodes: G_NODES,
    edges: buildEdges(G_NODES, G_EDGE_DEFS),
    defaultOrigin: 'SHA',
    defaultDestination: 'RTM',
    view: { center: [42, 26], zoom: 1.45 },
    bounds: [[-125, -40], [145, 58]],
  },
  EAFRICA: {
    id: 'EAFRICA',
    name: 'East Africa Northern Corridor',
    short: 'East Africa',
    nodes: E_NODES,
    edges: buildEdges(E_NODES, E_EDGE_DEFS),
    defaultOrigin: 'IOA',
    defaultDestination: 'KLA',
    view: { center: [35.4, -2.9], zoom: 5.3 },
    bounds: [[29.5, -7.4], [41.8, 1.2]],
  },
};

export function getNetwork(id) {
  return NETWORKS[id] ?? NETWORKS.GLOBAL;
}

export const MODE_LABEL = { MARITIME: 'Maritime', RAIL: 'Rail', ROAD: 'Road' };
export const NODE_TYPE_LABEL = { PORT: 'Port', RAIL_HUB: 'Rail hub', DRY_PORT: 'Dry port', CHOKEPOINT: 'Chokepoint' };
