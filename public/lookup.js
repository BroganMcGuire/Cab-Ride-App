/**
 * TrackLookup — converts a GPS lat/lng into ELR / Track ID / Mileage+Yards
 * using Network Rail's open (OGL-licensed) linear network model.
 *
 * Runs entirely client-side so it keeps working with no signal, as long as
 * the reference data has been fetched once (the service worker caches it).
 */
const TrackLookup = (() => {
  const R = 6371000; // Earth radius, m
  const CELL = 0.02; // ~2.2km grid cells (deg)

  let segments = null;    // raw records from track-links.json
  let waymarks = null;    // raw records from waymarks.json (real surveyed mileposts)
  let grid = null;        // Map("cellX,cellY" -> [segmentIndex,...])
  let waymarkGrid = null; // Map("cellX,cellY" -> [waymarkIndex,...])
  let ready = false;
  let loadPromise = null;
  let lat0Rad = 54 * Math.PI / 180; // mid-UK latitude for equirectangular scale

  function toXY([lon, lat]) {
    return [
      lon * Math.PI / 180 * Math.cos(lat0Rad) * R,
      lat * Math.PI / 180 * R,
    ];
  }

  function buildGrid(records, getLonLats) {
    const g = new Map();
    records.forEach((rec, idx) => {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const [lon, lat] of getLonLats(rec)) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      const x0 = Math.floor(minLon / CELL), x1 = Math.floor(maxLon / CELL);
      const y0 = Math.floor(minLat / CELL), y1 = Math.floor(maxLat / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = `${cx},${cy}`;
          if (!g.has(key)) g.set(key, []);
          g.get(key).push(idx);
        }
      }
    });
    return g;
  }

  function candidatesNear(g, lat, lng, radiusCells = 1) {
    const cx = Math.floor(lng / CELL), cy = Math.floor(lat / CELL);
    const out = new Set();
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        const list = g.get(`${cx + dx},${cy + dy}`);
        if (list) list.forEach((i) => out.add(i));
      }
    }
    return out;
  }

  async function load(dataUrl = '/data/track-links.json', waymarksUrl = '/data/waymarks.json') {
    if (ready) return true;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const [segRes, wmRes] = await Promise.all([
        fetch(dataUrl, { cache: 'force-cache' }),
        fetch(waymarksUrl, { cache: 'force-cache' }),
      ]);
      if (!segRes.ok) throw new Error('Failed to load track reference data');
      segments = await segRes.json();
      grid = buildGrid(segments, (seg) => seg.c);

      if (wmRes.ok) {
        waymarks = await wmRes.json();
        waymarkGrid = buildGrid(waymarks, (wm) => [[wm.lon, wm.lat]]);
      } else {
        waymarks = [];
        waymarkGrid = new Map();
      }
      ready = true;
      return true;
    })();
    return loadPromise;
  }

  // Distance from point P to segment AB (all in projected meters), plus
  // fraction [0,1] of the closest point along AB, and its distance-along length.
  function pointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const ddx = px - cx, ddy = py - cy;
    return { dist: Math.sqrt(ddx * ddx + ddy * ddy), t };
  }

  // Projects an arbitrary (px,py) onto a polyline (array of [x,y]), returning
  // the perpendicular distance and the cumulative distance-along the line.
  function projectOntoPolyline(xy, px, py) {
    let best = { dist: Infinity, cumBefore: 0, segLenAtBest: 0 };
    let cum = 0;
    for (let i = 0; i < xy.length - 1; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      const segLen = Math.hypot(bx - ax, by - ay);
      const r = pointToSegment(px, py, ax, ay, bx, by);
      if (r.dist < best.dist) {
        best = { dist: r.dist, cumBefore: cum, segLenAtBest: r.t * segLen };
      }
      cum += segLen;
    }
    best.totalLen = cum;
    best.distAlong = best.cumBefore + best.segLenAtBest;
    return best;
  }

  function milesToMilesYards(decimalMiles) {
    let miles = Math.floor(decimalMiles);
    let yards = Math.round((decimalMiles - miles) * 1760);
    if (yards >= 1760) { yards = 0; miles += 1; }
    if (yards < 0) { yards = 0; }
    return { miles, yards };
  }

  // Refine mileage using real surveyed mileposts (waymarks) on the same ELR,
  // bracketing the matched position along the same line. Falls back to the
  // coarse segment mFrom/mTo interpolation if no good bracket is found.
  function refineMileage(seg, segXY, distAlong, totalLen) {
    const fallback = seg.mFrom + (seg.mTo - seg.mFrom) * (totalLen > 0 ? distAlong / totalLen : 0);
    if (!waymarks || !waymarks.length) return { mileage: fallback, refined: false };

    // Gather same-ELR waymarks near this segment's bounding area.
    const candIdxs = new Set();
    // Sample a few points along the segment to cover its full extent in the grid search.
    const sampleCount = Math.min(6, segXY.__lonlat.length);
    for (let i = 0; i < sampleCount; i++) {
      const idx = Math.floor((i / (sampleCount - 1 || 1)) * (segXY.__lonlat.length - 1));
      const [lon, lat] = segXY.__lonlat[idx];
      candidatesNear(waymarkGrid, lat, lon, 1).forEach((c) => candIdxs.add(c));
    }

    let before = null, after = null;
    for (const idx of candIdxs) {
      const wm = waymarks[idx];
      if (wm.elr !== seg.elr) continue;
      const [wx, wy] = toXY([wm.lon, wm.lat]);
      const proj = projectOntoPolyline(segXY, wx, wy);
      if (proj.dist > 25) continue; // waymark isn't really on this digitized line
      if (proj.distAlong <= distAlong) {
        if (!before || proj.distAlong > before.distAlong) before = { ...proj, m: wm.m };
      } else {
        if (!after || proj.distAlong < after.distAlong) after = { ...proj, m: wm.m };
      }
    }

    if (before && after && after.distAlong > before.distAlong) {
      const frac = (distAlong - before.distAlong) / (after.distAlong - before.distAlong);
      return { mileage: before.m + (after.m - before.m) * frac, refined: true };
    }
    // Only one side available: extrapolate a short distance using the local
    // segment-level mileage/metre rate as a reasonable local slope.
    const rate = totalLen > 0 ? (seg.mTo - seg.mFrom) / totalLen : 0;
    if (before) return { mileage: before.m + rate * (distAlong - before.distAlong), refined: true };
    if (after) return { mileage: after.m + rate * (distAlong - after.distAlong), refined: true };
    return { mileage: fallback, refined: false };
  }

  /**
   * locate(lat, lng) -> { elr, trackId, trcode, mileageMiles, mileageYards, distanceM, refined }
   * distanceM is the perpendicular distance (metres) from the GPS point to the
   * matched track centreline — a rough confidence indicator. `refined` is true
   * when real milepost data was used to correct the mileage (typically accurate
   * to a few tens of yards); when false it's a coarser segment-level estimate.
   * Returns null if reference data isn't loaded yet or nothing is within range.
   */
  function locate(lat, lng, opts = {}) {
    const maxDistM = opts.maxDistM ?? 60;
    if (!ready) return null;
    const px = lng * Math.PI / 180 * Math.cos(lat0Rad) * R;
    const py = lat * Math.PI / 180 * R;

    const candidates = candidatesNear(grid, lat, lng, 1);
    if (!candidates.size) return null;

    let best = null;
    for (const idx of candidates) {
      const seg = segments[idx];
      const xy = seg.c.map(toXY);
      xy.__lonlat = seg.c;
      const r = projectOntoPolyline(xy, px, py);
      if (!best || r.dist < best.dist) best = { ...r, seg, xy };
    }
    if (!best || best.dist > maxDistM) return null;

    const { mileage, refined } = refineMileage(best.seg, best.xy, best.distAlong, best.totalLen);
    const { miles, yards } = milesToMilesYards(mileage);

    return {
      elr: best.seg.elr,
      trackId: best.seg.trid,
      trcode: best.seg.trcode,
      mileageMiles: miles,
      mileageYards: yards,
      distanceM: Math.round(best.dist * 10) / 10,
      refined,
    };
  }

  return { load, locate, isReady: () => ready };
})();
