#!/usr/bin/env python3
"""Precompute PyRCH demo instances for demo/pyrch/.

The website is static, so the browser cannot run the C++ solver.  This script
builds a batch of random heterogeneous-routing instances, solves each one with
the real PyRCH solver, and dumps instance + solution geometry as JSON that the
demo page just plays back.

Scenario
--------
A square field crossed by a river with a single bridge, plus a couple of rocky
patches.  Three robots start and end at the depot:

  drone   flies straight over everything, medium speed
  wheeled fast, but road-bound: cannot enter rocks and needs the bridge
  legged  slow, walks over rocks, still needs the bridge

Targets inside a rocky patch can only be served by the drone or the legged
robot (an assignment constraint).  Costs are travel *times* (path length over
speed), so PyRCH's min-max objective is exactly the fleet makespan.

Usage:  python tools/gen_pyrch_demo.py --count 40 --out demo/pyrch/data
"""
from __future__ import annotations

import argparse
import heapq
import json
import math
import random
import time
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import pyrch

W = 100.0  # field is [0, W] x [0, W]

CLASSES = [
    # key, label, speed (units of distance per unit of time)
    ("drone", "Drone", 1.10),
    ("wheeled", "Wheeled", 1.55),
    ("legged", "Legged", 0.85),
]
SPEED = {k: s for k, _, s in CLASSES}
BIG = 1.0e5  # cost for a (class, target) pair that is not allowed anyway

Pt = Tuple[float, float]
Poly = List[Pt]


# ────────────────────────── geometry helpers ──────────────────────────


def dist(a: Pt, b: Pt) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def point_in_poly(p: Pt, poly: Poly) -> bool:
    x, y = p
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xin:
                inside = not inside
    return inside


def point_in_any(p: Pt, polys: Sequence[Poly]) -> bool:
    return any(point_in_poly(p, q) for q in polys)


def dist_to_poly(p: Pt, poly: Poly) -> float:
    """Distance from p to the polygon boundary (0 if p is inside)."""
    if point_in_poly(p, poly):
        return 0.0
    best = float("inf")
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        vx, vy = b[0] - a[0], b[1] - a[1]
        L2 = vx * vx + vy * vy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2))
        best = min(best, dist(p, (a[0] + t * vx, a[1] + t * vy)))
    return best


def _orient(a: Pt, b: Pt, c: Pt) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_cross(p1: Pt, p2: Pt, p3: Pt, p4: Pt) -> bool:
    """True only for a proper crossing (endpoint touching does not count)."""
    d1, d2 = _orient(p3, p4, p1), _orient(p3, p4, p2)
    d3, d4 = _orient(p1, p2, p3), _orient(p1, p2, p4)
    eps = 1e-9
    return ((d1 > eps and d2 < -eps) or (d1 < -eps and d2 > eps)) and (
        (d3 > eps and d4 < -eps) or (d3 < -eps and d4 > eps)
    )


def visible(p: Pt, q: Pt, polys: Sequence[Poly]) -> bool:
    for poly in polys:
        n = len(poly)
        for i in range(n):
            if segments_cross(p, q, poly[i], poly[(i + 1) % n]):
                return False
    if not polys:
        return True
    mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
    return not point_in_any(mid, polys)


def signed_area(poly: Poly) -> float:
    s = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return s / 2


MARGIN = 1.7  # obstacles are inflated by this much before planning


def convex_hull(pts: Sequence[Pt]) -> Poly:
    """Monotone chain hull. Convex rocks keep the chord between two adjacent
    graph nodes from grazing a vertex that pokes out between them."""
    p = sorted(set(pts))
    if len(p) < 3:
        return list(p)

    def half(seq):
        out: List[Pt] = []
        for q in seq:
            while len(out) >= 2 and _orient(out[-2], out[-1], q) <= 0:
                out.pop()
            out.append(q)
        return out[:-1]

    return half(p) + half(p[::-1])


def offset_vertices(poly: Poly, eps: float = 0.5) -> List[Pt]:
    """Polygon corners pushed outward, used as visibility-graph nodes."""
    p = poly if signed_area(poly) > 0 else poly[::-1]  # make CCW
    n = len(p)
    out: List[Pt] = []
    for i in range(n):
        prv, cur, nxt = p[i - 1], p[i], p[(i + 1) % n]
        nx, ny = 0.0, 0.0
        for a, b in ((prv, cur), (cur, nxt)):
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dy) or 1.0
            nx += dy / L  # outward normal of a CCW polygon
            ny += -dx / L
        L = math.hypot(nx, ny) or 1.0
        out.append((cur[0] + eps * nx / L, cur[1] + eps * ny / L))
    return out


# ────────────────────────── shortest paths ──────────────────────────


class VisGraph:
    """Visibility graph over the given points plus the obstacle corners."""

    def __init__(self, points: Sequence[Pt], obstacles: Sequence[Poly]):
        self.n_pts = len(points)
        corners = [v for poly in obstacles for v in offset_vertices(poly)]
        self.nodes: List[Pt] = list(points) + [c for c in corners if not point_in_any(c, obstacles)]
        self.obstacles = list(obstacles)
        n = len(self.nodes)
        self.adj: List[List[Tuple[int, float]]] = [[] for _ in range(n)]
        for i in range(n):
            for j in range(i + 1, n):
                if visible(self.nodes[i], self.nodes[j], self.obstacles):
                    w = dist(self.nodes[i], self.nodes[j])
                    self.adj[i].append((j, w))
                    self.adj[j].append((i, w))

    def paths_from(self, src: int) -> Tuple[List[float], List[int]]:
        n = len(self.nodes)
        d = [float("inf")] * n
        prev = [-1] * n
        d[src] = 0.0
        pq = [(0.0, src)]
        while pq:
            du, u = heapq.heappop(pq)
            if du > d[u] + 1e-12:
                continue
            for v, w in self.adj[u]:
                nd = du + w
                if nd < d[v] - 1e-12:
                    d[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        return d, prev

    def all_pairs(self) -> Tuple[List[List[float]], List[List[int]]]:
        ds, prevs = [], []
        for i in range(self.n_pts):
            d, prev = self.paths_from(i)
            ds.append(d)
            prevs.append(prev)
        return ds, prevs

    def polyline(self, prev: List[int], src: int, dst: int) -> List[Pt]:
        chain = []
        cur = dst
        while cur != -1:
            chain.append(self.nodes[cur])
            if cur == src:
                break
            cur = prev[cur]
        return chain[::-1]


# ────────────────────────── instance generation ──────────────────────────


def make_river(rng: random.Random) -> Tuple[List[Poly], Poly, List[Pt], float]:
    """A wavy vertical band split in two by a bridge gap."""
    cx = rng.uniform(42.0, 58.0)
    amp = rng.uniform(4.0, 9.0)
    freq = rng.uniform(0.030, 0.048)
    phase = rng.uniform(0, 2 * math.pi)
    hw = rng.uniform(5.5, 7.0)

    ys = [-8.0 + i * (W + 16.0) / 16 for i in range(17)]
    center = [(cx + amp * math.sin(freq * y + phase), y) for y in ys]

    by = rng.uniform(28.0, 72.0)
    gap = 6.0
    lo = max(1, min(i for i, (_, y) in enumerate(center) if y > by - gap) - 1)
    hi = min(len(ys) - 2, max(i for i, (_, y) in enumerate(center) if y < by + gap) + 1)

    def band(seg: List[Pt]) -> Poly:
        left = [(x - hw, y) for x, y in seg]
        right = [(x + hw, y) for x, y in seg]
        return left + right[::-1]

    polys = [band(center[: lo + 1]), band(center[hi:])]
    # the bridge is decoration, but it has to land exactly on the gap: build it
    # from the two river ends instead of from the centreline sampled at ``by``
    (xlo, ylo), (xhi, yhi) = center[lo], center[hi]
    pad = 1.4
    bridge = [
        (xlo - hw - pad, ylo),
        (xlo + hw + pad, ylo),
        (xhi + hw + pad, yhi),
        (xhi - hw - pad, yhi),
    ]
    return polys, bridge, center, hw


def make_rocks(rng: random.Random, river: List[Poly]) -> List[Poly]:
    rocks: List[Poly] = []
    tries = 0
    want = rng.choice([2, 2, 3])
    while len(rocks) < want and tries < 400:
        tries += 1
        cxr = rng.uniform(16.0, 84.0)
        cyr = rng.uniform(16.0, 84.0)
        r = rng.uniform(9.0, 13.0)
        c = (cxr, cyr)
        if min(dist_to_poly(c, p) for p in river) < r + 9.0:
            continue
        if any(dist(c, (sum(x for x, _ in q) / len(q), sum(y for _, y in q) / len(q))) < 30.0 for q in rocks):
            continue
        k = 9
        poly = []
        for i in range(k):
            a = 2 * math.pi * i / k + rng.uniform(-0.12, 0.12)
            rr = r * rng.uniform(0.78, 1.18)
            poly.append((cxr + rr * math.cos(a), cyr + rr * math.sin(a)))
        rocks.append(convex_hull(poly))
    return rocks


def sample_targets(
    rng: random.Random, river: List[Poly], rocks: List[Poly], depot: Pt, n_open: int, n_rock: int
) -> Tuple[List[Pt], List[int]]:
    pts: List[Pt] = []
    zone: List[int] = []  # 0 = open ground, 1 = inside rocks

    for _ in range(n_rock):
        for _ in range(300):
            poly = rng.choice(rocks)
            cxr = sum(x for x, _ in poly) / len(poly)
            cyr = sum(y for _, y in poly) / len(poly)
            a = rng.uniform(0, 2 * math.pi)
            rr = rng.uniform(0.15, 0.55)
            p = (cxr + rr * 12 * math.cos(a), cyr + rr * 12 * math.sin(a))
            if not point_in_poly(p, poly):
                continue
            if any(dist(p, q) < 11.0 for q in pts):
                continue
            pts.append(p)
            zone.append(1)
            break

    guard = 0
    while len(pts) < n_open + n_rock and guard < 6000:
        guard += 1
        p = (rng.uniform(6.0, W - 6.0), rng.uniform(6.0, W - 6.0))
        if min(dist_to_poly(p, q) for q in river) < 5.0:
            continue
        if rocks and min(dist_to_poly(p, q) for q in rocks) < 4.5:
            continue
        if dist(p, depot) < 13.0 or any(dist(p, q) < 12.0 for q in pts):
            continue
        pts.append(p)
        zone.append(0)
    return pts, zone


def build_instance(seed: int) -> Dict:
    rng = random.Random(seed * 7919 + 13)
    river, bridge, center, hw = make_river(rng)
    rocks = make_rocks(rng, river)

    # depot on open ground, left of the river
    for _ in range(4000):
        depot = (rng.uniform(8.0, 32.0), rng.uniform(20.0, 80.0))
        if min(dist_to_poly(depot, q) for q in river) > 8.0 and (
            not rocks or min(dist_to_poly(depot, q) for q in rocks) > 7.0
        ):
            break

    n_rock = min(3, max(2, len(rocks)))
    targets, zone = sample_targets(rng, river, rocks, depot, n_open=15, n_rock=n_rock)

    pts: List[Pt] = [depot] + targets
    zones: List[int] = [0] + zone
    return {
        "river": river,
        "bridge": bridge,
        "rocks": rocks,
        "pts": pts,
        "zones": zones,
    }


# ────────────────────────── solving ──────────────────────────


def route_geometry(
    path: Sequence[int], graphs: Dict[str, VisGraph], prevs: Dict[str, List[List[int]]], cls: str
) -> Tuple[List[Pt], List[float], float]:
    """Concatenate leg polylines; also return cumulative length at each stop."""
    poly: List[Pt] = []
    stops: List[float] = [0.0]
    total = 0.0
    g = graphs[cls]
    for a, b in zip(path, path[1:]):
        if cls == "drone":
            leg = [g.nodes[a], g.nodes[b]]
        else:
            leg = g.polyline(prevs[cls][a], a, b)
        for k in range(len(leg) - 1):
            total += dist(leg[k], leg[k + 1])
        poly = poly[:-1] + leg if poly else list(leg)
        stops.append(total)
    return poly, stops, total


def solve_instance(inst: Dict, time_limit: float) -> Dict:
    pts: List[Pt] = inst["pts"]
    zones: List[int] = inst["zones"]
    n = len(pts)
    river: List[Poly] = inst["river"]
    rocks: List[Poly] = inst["rocks"]

    # Plan against inflated obstacles. A visibility graph routes a path exactly
    # through the corners it bends around, so planning on the true polygon makes
    # detours graze the boundary -- legal, but it reads as cutting straight
    # through the rocks at the demo's stroke width.
    grown = {id(q): offset_vertices(q, MARGIN) for q in river + rocks}
    infl_river = [grown[id(q)] for q in river]
    infl_rocks = [grown[id(q)] for q in rocks]
    obstacles = {"drone": [], "legged": infl_river, "wheeled": infl_river + infl_rocks}
    graphs: Dict[str, VisGraph] = {}
    prevs: Dict[str, List[List[int]]] = {}
    costs: Dict[str, List[List[float]]] = {}

    for cls, _, spd in CLASSES:
        g = VisGraph(pts, obstacles[cls])
        ds, pv = g.all_pairs()
        graphs[cls], prevs[cls] = g, pv
        m = [[0.0] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                d = ds[i][j]
                blocked = cls == "wheeled" and (zones[i] == 1 or zones[j] == 1)
                m[i][j] = BIG if (blocked or math.isinf(d)) else d / spd
        costs[cls] = m

    for cls, _, _ in CLASSES:
        for i in range(1, n):
            if cls == "wheeled" and zones[i] == 1:
                continue  # a rock target is off limits to the wheeled robot anyway
            if costs[cls][0][i] >= BIG:
                return {"status": "unreachable", "cls": cls, "node": i}

    planner = pyrch.Planner()
    planner.add_depot(0, x=pts[0][0], y=pts[0][1])
    for i in range(1, n):
        planner.add_target(i, x=pts[i][0], y=pts[i][1])
    for aid, (cls, _, _) in enumerate(CLASSES):
        planner.add_agent(agent_id=aid, agent_type=cls, start_node=0, end_node=0)
        planner.set_cost_matrix(cls, costs[cls])
    for i in range(1, n):
        if zones[i] == 1:
            planner.add_assignment(i, ["drone", "legged"])
    planner.set_options(return_to_end=True, objective="min_max", time_limit=time_limit)

    problem = planner.problem
    options = problem.options()
    t0 = time.perf_counter()
    solver = pyrch.Solver(problem, options)
    solver.solve()
    wall = time.perf_counter() - t0
    result = solver.get_result()
    history = solver.get_result_process()

    def pack(paths, times) -> Dict:
        routes = []
        for aid, (cls, label, spd) in enumerate(CLASSES):
            path = [int(v) for v in paths.get(aid, [])]
            if not path:
                path = [0]
            if path[0] != 0:
                path = [0] + path
            if path[-1] != 0:
                path = path + [0]
            poly, stops, total = route_geometry(path, graphs, prevs, cls)
            routes.append(
                {
                    "agent": aid,
                    "cls": cls,
                    "path": path,
                    "poly": [[round(x, 2), round(y, 2)] for x, y in poly],
                    "stops": [round(s, 2) for s in stops],
                    "length": round(total, 2),
                    "time": round(total / spd, 2),
                    "solver_time": round(float(times.get(aid, 0.0)), 3),
                }
            )
        return {"routes": routes, "makespan": round(max(r["time"] for r in routes), 2)}

    best = pack(result.paths, result.times)

    anytime = []
    first = None
    seen = float("inf")
    for t, res in history:
        mc = max([float(v) for v in res.times.values()] or [0.0])
        if mc < seen - 1e-9:
            seen = mc
            anytime.append({"t": round(float(t), 4), "makespan": round(mc, 2)})
            if first is None:
                first = pack(res.paths, res.times)

    return {
        "status": "success" if result.paths else "failed",
        "solve_time": round(wall, 3),
        "timeout": bool(result.timeout),
        "best": best,
        "first": first or best,
        "anytime": anytime,
        "expanded": int(result.n_expanded),
    }


def instance_json(seed: int, inst: Dict, sol: Dict) -> Dict:
    def r2(poly):
        return [[round(x, 2), round(y, 2)] for x, y in poly]

    return {
        "seed": seed,
        "world": W,
        "terrain": {
            "river": [r2(p) for p in inst["river"]],
            "bridge": r2(inst["bridge"]),
            "rocks": [r2(p) for p in inst["rocks"]],
        },
        "depot": [round(inst["pts"][0][0], 2), round(inst["pts"][0][1], 2)],
        "targets": [
            {
                "id": i,
                "x": round(inst["pts"][i][0], 2),
                "y": round(inst["pts"][i][1], 2),
                "rock": bool(inst["zones"][i]),
            }
            for i in range(1, len(inst["pts"]))
        ],
        "agents": [
            {"id": i, "cls": cls, "label": label, "speed": spd}
            for i, (cls, label, spd) in enumerate(CLASSES)
        ],
        "solution": sol["best"],
        "first_solution": sol["first"],
        "anytime": sol["anytime"],
        "stats": {
            "solve_time": sol["solve_time"],
            "timeout": sol["timeout"],
            "expanded": sol["expanded"],
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=40)
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--time-limit", type=float, default=3.0)
    ap.add_argument("--out", type=Path, default=Path("demo/pyrch/data"))
    ap.add_argument("--min-stops", type=int, default=2, help="skip instances where a robot is nearly idle")
    ap.add_argument("--max-slack", type=float, default=0.40, help="skip instances that are badly unbalanced")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    seeds: List[int] = []
    for seed in range(args.start, args.start + args.count):
        inst = build_instance(seed)
        sol = solve_instance(inst, args.time_limit)
        if sol["status"] == "unreachable":
            print(f"seed {seed}: node {sol['node']} unreachable for {sol['cls']}, skipped")
            continue
        if sol["status"] != "success":
            print(f"seed {seed}: FAILED, skipped")
            continue
        payload = instance_json(seed, inst, sol)
        rts = payload["solution"]["routes"]
        ms = payload["solution"]["makespan"]
        # Result.times occasionally has no entry for an agent that Result.paths
        # gave a route to, which silently drops that robot from the min-max
        # objective. Don't ship a plan whose own cost we cannot reproduce.
        drift = max(
            abs(r["time"] - r["solver_time"])
            for r in payload["solution"]["routes"] + payload["first_solution"]["routes"]
        )
        if drift > 0.05:
            print(f"seed {seed}: solver cost disagrees with geometry by {drift:.2f}, skipped")
            continue
        if min(len(r["path"]) - 2 for r in rts) < args.min_stops:
            print(f"seed {seed}: a robot is idle, skipped")
            continue
        if (ms - min(r["time"] for r in rts)) / ms > args.max_slack:
            print(f"seed {seed}: unbalanced, skipped")
            continue
        (args.out / f"{seed:04d}.json").write_text(json.dumps(payload, separators=(",", ":")))
        seeds.append(seed)
        per = " ".join(f"{r['cls'][:3]}={r['time']:.0f}" for r in payload["solution"]["routes"])
        print(f"seed {seed:4d}  makespan={ms:7.2f}  {per}  ({sol['solve_time']:.2f}s)")

    (args.out / "manifest.json").write_text(
        json.dumps(
            {
                "seeds": seeds,
                "generated": time.strftime("%Y-%m-%d"),
                "pyrch": pyrch.__version__,
                "classes": [{"cls": c, "label": l, "speed": s} for c, l, s in CLASSES],
            },
            separators=(",", ":"),
        )
    )
    print(f"wrote {len(seeds)} instances to {args.out}")


if __name__ == "__main__":
    main()
