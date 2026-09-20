// ============================================================
// BiyaHERO — A* pathfinding over the on-device road graph
// ============================================================
// This is the offline, on-device routing tier: A* search over the
// nodes/edges graph shipped in laguna_routing.db (see RoutingDatabase.js),
// used when there's no signal for OSRM (BiyaHERO.js's "REAL ROAD ROUTING
// (OSRM) WITH OFFLINE FALLBACK" section). It sits BETWEEN the two existing
// tiers and doesn't replace either one:
//   1. OSRM (online, real road routing)      — unchanged, still tried first
//   2. *** A* over the local graph (this) *** — NEW: real, road-following
//      offline routing, used when OSRM is unreachable
//   3. Straight-line/curved approximation     — unchanged, still the final
//      fallback if the local graph is unavailable or the two points can't
//      be matched onto it
//
// The graph is large (hundreds of thousands of nodes/edges — too many to
// load into memory on a phone), so this never does a bulk SELECT * of
// either table. It leans entirely on the two indexes the db already ships
// with (idx_edges_from, idx_edges_to) to expand one node's neighbors at a
// time as A* visits it, and only ever scans a small lat/lng bounding box
// of the nodes table to snap a raw GPS coordinate onto the graph.
//
// Hazard-aware routing: this module has no idea what a "hazard" is — it
// just asks the caller, per edge, "how much should this edge cost right
// now?" via the optional `hazardWeightForEdge(edgeRow)` callback. BiyaHERO.js
// wires that up using the exact same `hazards` class / `routingweightmult()`
// multiplier already used elsewhere in the app (see hazard.js and the
// `hazards` class in BiyaHERO.js) — this file doesn't duplicate that logic,
// it just consumes it.
// ============================================================

(function () {
  'use strict';

  const EARTH_RADIUS_M = 6371000;

  function toRad(deg) { return (deg * Math.PI) / 180; }

  function haversineM(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Distance from point p to the segment a→b, in meters. Uses a flat
  // equirectangular projection centered on p — road/hazard-matching scale
  // (tens to low-hundreds of meters) makes that error negligible, and it's
  // far cheaper than a proper great-circle segment distance for something
  // called this often.
  function pointToSegmentM(p, a, b) {
    const latRad = toRad(p.lat);
    const kx = 111320 * Math.cos(latRad);
    const ky = 110540;
    const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
    const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? (-ax * dx + -ay * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(cx, cy);
  }

  // ---------- Binary min-heap for A*'s open set ----------
  // Plain array + repeated sort/shift would be O(n log n) per pop on a
  // graph this size; this keeps push/pop at O(log n). Uses lazy deletion
  // (stale entries are just skipped via the `closed` set on pop) instead
  // of a full decrease-key, which is the standard, simple way to do this.
  class MinHeap {
    constructor() { this._items = []; }
    get size() { return this._items.length; }
    push(id, score) {
      this._items.push({ id, score });
      let i = this._items.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (this._items[parent].score <= this._items[i].score) break;
        [this._items[parent], this._items[i]] = [this._items[i], this._items[parent]];
        i = parent;
      }
    }
    pop() {
      if (!this._items.length) return undefined;
      const top = this._items[0];
      const last = this._items.pop();
      if (this._items.length) {
        this._items[0] = last;
        let i = 0;
        const n = this._items.length;
        for (;;) {
          let smallest = i;
          const l = i * 2 + 1, r = i * 2 + 2;
          if (l < n && this._items[l].score < this._items[smallest].score) smallest = l;
          if (r < n && this._items[r].score < this._items[smallest].score) smallest = r;
          if (smallest === i) break;
          [this._items[smallest], this._items[i]] = [this._items[i], this._items[smallest]];
          i = smallest;
        }
      }
      return top.id;
    }
  }

  async function runQuery(db, sql, params) {
    const res = await db.query(sql, params || []);
    return (res && res.values) || [];
  }

  // Snaps a raw lat/lng onto the nearest graph node. Expands the bounding
  // box outward a few times instead of scanning the whole nodes table —
  // the graph is a dense street-intersection mesh almost everywhere it
  // covers, so the first, smallest box usually already has candidates.
  async function findNearestNode(db, lat, lng) {
    const boxDegrees = [0.01, 0.03, 0.08, 0.2];
    for (const d of boxDegrees) {
      const rows = await runQuery(
        db,
        'SELECT id, lat, lng FROM nodes WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?',
        [lat - d, lat + d, lng - d, lng + d]
      );
      if (rows.length) {
        let best = null, bestDist = Infinity;
        for (const row of rows) {
          const dist = haversineM(lat, lng, row.lat, row.lng);
          if (dist < bestDist) { bestDist = dist; best = row; }
        }
        return best;
      }
    }
    return null;
  }

  // Finds the graph edge that passes closest to a point (used to tag a
  // reported hazard with the edge it actually sits on — see
  // matchHazardToEdge below). Only looks at edges touching the nearest
  // node, which is enough since a hazard report's GPS fix is already close
  // to *some* road.
  async function findNearestEdge(db, lat, lng, maxDistanceM) {
    const node = await findNearestNode(db, lat, lng);
    if (!node) return null;

    const [outgoing, incoming] = await Promise.all([
      runQuery(db, 'SELECT * FROM edges WHERE from_id = ?', [node.id]),
      runQuery(db, 'SELECT * FROM edges WHERE to_id = ?', [node.id])
    ]);
    const candidates = outgoing.concat(incoming);
    if (!candidates.length) return null;

    const nodeCache = new Map([[node.id, node]]);
    async function coordsFor(id) {
      if (nodeCache.has(id)) return nodeCache.get(id);
      const rows = await runQuery(db, 'SELECT id, lat, lng FROM nodes WHERE id = ?', [id]);
      const row = rows[0] || null;
      if (row) nodeCache.set(id, row);
      return row;
    }

    let best = null, bestDist = Infinity;
    for (const edge of candidates) {
      const a = await coordsFor(edge.from_id);
      const b = await coordsFor(edge.to_id);
      if (!a || !b) continue;

      let dist = Infinity;
      let geom = null;
      try { geom = edge.geometry ? JSON.parse(edge.geometry) : null; } catch (e) { geom = null; }

      if (Array.isArray(geom) && geom.length >= 2) {
        for (let i = 0; i < geom.length - 1; i++) {
          const p1 = { lat: geom[i][0], lng: geom[i][1] };
          const p2 = { lat: geom[i + 1][0], lng: geom[i + 1][1] };
          dist = Math.min(dist, pointToSegmentM({ lat, lng }, p1, p2));
        }
      } else {
        dist = pointToSegmentM({ lat, lng }, a, b);
      }

      if (dist < bestDist) { bestDist = dist; best = edge; }
    }

    if (!best) return null;
    if (maxDistanceM != null && bestDist > maxDistanceM) return null;
    return best.id;
  }

  // Best-effort: resolves a hazard report's lat/lng to the graph edge id
  // it sits on, so future A* routes can weight that specific edge instead
  // of just avoiding the general area. Returns null (never throws) if the
  // graph isn't loaded or nothing is close enough — callers treat that the
  // same as "this hazard hasn't been matched yet."
  async function matchHazardToEdge(db, lat, lng) {
    if (!db || lat == null || lng == null) return null;
    try {
      // 80m — generous enough for GPS drift, tight enough not to blame the
      // wrong parallel street for a hazard.
      return await findNearestEdge(db, lat, lng, 80);
    } catch (err) {
      console.warn('[BiyaHERO] A* hazard-edge matching failed:', err.message || err);
      return null;
    }
  }

  function edgeGeometryPoints(edge, fromNode, toNode) {
    let geom = null;
    try { geom = edge.geometry ? JSON.parse(edge.geometry) : null; } catch (e) { geom = null; }
    if (Array.isArray(geom) && geom.length) {
      return geom.map(([lat, lng]) => ({ lat, lng }));
    }
    const pts = [];
    if (fromNode) pts.push({ lat: fromNode.lat, lng: fromNode.lng });
    if (toNode) pts.push({ lat: toNode.lat, lng: toNode.lng });
    return pts;
  }

  // ---------- A* search ----------
  // origin/dest: { lat, lng }. Returns { pts, distanceM } (pts is an
  // ordered array of {lat,lng} tracing the real road geometry) or null if
  // no route could be found within the search budget (disconnected graph,
  // points too far outside the covered area, etc.) — callers fall back to
  // the existing curved approximation in that case, exactly as before this
  // feature existed.
  async function findRoute(db, origin, dest, options) {
    const opts = options || {};
    const hazardWeightForEdge = opts.hazardWeightForEdge;
    const maxExpansions = opts.maxExpansions || 25000;

    if (!db) return null;

    const startNode = await findNearestNode(db, origin.lat, origin.lng);
    const goalNode = await findNearestNode(db, dest.lat, dest.lng);
    if (!startNode || !goalNode) return null;
    if (startNode.id === goalNode.id) return null; // too close to be worth graph routing

    const nodeCoords = new Map([[startNode.id, startNode], [goalNode.id, goalNode]]);
    const gScore = new Map([[startNode.id, 0]]);
    const cameFrom = new Map(); // nodeId -> { from, edge }
    const closed = new Set();
    const open = new MinHeap();
    open.push(startNode.id, haversineM(startNode.lat, startNode.lng, goalNode.lat, goalNode.lng));

    let expansions = 0;

    while (open.size && expansions < maxExpansions) {
      const currentId = open.pop();
      if (closed.has(currentId)) continue;
      closed.add(currentId);
      expansions++;

      if (currentId === goalNode.id) {
        return reconstructPath(cameFrom, nodeCoords, currentId, gScore.get(currentId));
      }

      let neighbors;
      try {
        neighbors = await runQuery(db, 'SELECT * FROM edges WHERE from_id = ?', [currentId]);
      } catch (err) {
        console.warn('[BiyaHERO] A* edge lookup failed:', err.message || err);
        return null;
      }

      for (const edge of neighbors) {
        if (closed.has(edge.to_id)) continue;

        const hazardMult = hazardWeightForEdge ? (hazardWeightForEdge(edge) || 1) : 1;
        const baseCost = edge.weight != null ? edge.weight : (edge.base_weight != null ? edge.base_weight : (edge.length_m || 1));
        const stepCost = baseCost * hazardMult;

        const tentativeG = gScore.get(currentId) + stepCost;
        const knownG = gScore.has(edge.to_id) ? gScore.get(edge.to_id) : Infinity;
        if (tentativeG < knownG) {
          cameFrom.set(edge.to_id, { from: currentId, edge });
          gScore.set(edge.to_id, tentativeG);

          if (!nodeCoords.has(edge.to_id)) {
            const rows = await runQuery(db, 'SELECT id, lat, lng FROM nodes WHERE id = ?', [edge.to_id]);
            if (rows[0]) nodeCoords.set(edge.to_id, rows[0]);
          }
          const toNode = nodeCoords.get(edge.to_id);
          const h = toNode ? haversineM(toNode.lat, toNode.lng, goalNode.lat, goalNode.lng) : 0;
          open.push(edge.to_id, tentativeG + h);
        }
      }
    }

    return null; // exhausted the search budget without reaching the goal
  }

  function reconstructPath(cameFrom, nodeCoords, goalId, totalWeight) {
    const edgesUsed = [];
    let cur = goalId;
    while (cameFrom.has(cur)) {
      const step = cameFrom.get(cur);
      edgesUsed.push(step.edge);
      cur = step.from;
    }
    edgesUsed.reverse();

    const pts = [];
    let totalDistanceM = 0;
    edgesUsed.forEach(edge => {
      const fromNode = nodeCoords.get(edge.from_id);
      const toNode = nodeCoords.get(edge.to_id);
      const segPts = edgeGeometryPoints(edge, fromNode, toNode);
      segPts.forEach(p => pts.push(p));
      totalDistanceM += edge.length_m || 0;
    });

    if (pts.length < 2) return null;
    return { pts, distanceM: totalDistanceM, weight: totalWeight };
  }

  window.AStarRouter = {
    findRoute,
    matchHazardToEdge,
    // Exposed for reuse/testing — not needed by BiyaHERO.js's normal path.
    findNearestNode,
    findNearestEdge
  };
})();
