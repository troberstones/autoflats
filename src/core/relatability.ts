// Gestalt "good continuation", formalized. Kellman & Shipley's *relatability*:
// two stroke tips are perceptually linkable iff a smooth, MONOTONIC curve that
// bends through <= ~90 deg connects them. Among relatable pairs the perceived
// completion is the minimal-energy curve (Euler's elastica, E = INT 1 + b k^2 ds).
// We use both facts: relatable() gates which endpoint pairs may bridge, and the
// elastica energy ranks/shapes the survivors. This replaces the old pair of
// one-sided collinearity dot-checks, which admitted S-curves (inflected links
// that human vision never completes) and ranked purely by proximity.
//
// Tangents are UNIT vectors pointing OUT of each stroke tip, into the gap.

// Curvature weight in the elastica energy (length units). Higher => straighter
// completions preferred more strongly over shorter-but-kinked ones. Ranking is
// relative, so the exact value only balances proximity vs. bend.
export const BETA = 30

export interface Relatability { ok: boolean; energy: number; bend: number }

export function relatable(
  ax: number, ay: number, atx: number, aty: number,
  bx: number, by: number, btx: number, bty: number,
  coneCos = 0.5, maxBendDeg = 90,
): Relatability {
  const fail: Relatability = { ok: false, energy: Infinity, bend: Math.PI }
  const rx = bx - ax, ry = by - ay
  const d = Math.hypot(rx, ry)
  if (d < 1e-3) return fail
  const ux = rx / d, uy = ry / d
  // monotonic progress: each tip must head toward the other (no backtracking)
  const a = atx * ux + aty * uy        // A's tangent projected onto A->B
  const b = -(btx * ux + bty * uy)     // B's tangent projected onto B->A
  if (a < coneCos || b < coneCos) return fail
  // no inflection: both tips must curve to the SAME side of the chord. Opposite
  // signs => the smooth link would be an S, which is not relatable.
  const crossA = ux * aty - uy * atx
  const crossB = ux * bty - uy * btx
  if (crossA * crossB < 0) return fail
  // total bend of the connecting arc = turn at A + turn at B
  const thA = Math.acos(Math.min(1, a))
  const thB = Math.acos(Math.min(1, b))
  const bend = thA + thB
  if (bend > maxBendDeg * Math.PI / 180) return fail
  // elastica proxy (kappa ~ theta/d): length + curvature cost
  const energy = d + BETA * (thA * thA + thA * thB + thB * thB) / d
  return { ok: true, energy, bend }
}

// Discrete elastica energy of a polyline [x0,y0,x1,y1,...]: total length plus a
// curvature penalty summed over interior turning angles. Used to rank/shape
// concrete bridge paths (curved vs. chord).
export function elasticaEnergy(poly: number[], beta = BETA): number {
  const n = poly.length >> 1
  if (n < 2) return Infinity
  let len = 0
  for (let i = 1; i < n; i++) len += Math.hypot(poly[2 * i] - poly[2 * i - 2], poly[2 * i + 1] - poly[2 * i - 1])
  let curv = 0
  for (let i = 1; i < n - 1; i++) {
    const ax = poly[2 * i] - poly[2 * i - 2], ay = poly[2 * i + 1] - poly[2 * i - 1]
    const bx = poly[2 * i + 2] - poly[2 * i], by = poly[2 * i + 3] - poly[2 * i + 1]
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1
    let c = (ax * bx + ay * by) / (la * lb)
    c = c < -1 ? -1 : c > 1 ? 1 : c
    const th = Math.acos(c)
    curv += th * th / ((la + lb) / 2)
  }
  return len + beta * curv
}

// Minimal-elastica completion between two tips with known tangents (unit, into
// the gap). Builds a Hermite whose end tangents follow the strokes, searching
// handle lengths for the lowest-energy shape; returns the chord if even the
// best curve bows too hard (energy >> chord length).
export function elasticaCurve(
  ax: number, ay: number, atx: number, aty: number,
  bx: number, by: number, btx: number, bty: number, K = 0,
): number[] {
  const len = Math.hypot(bx - ax, by - ay) || 1
  if (!K) K = Math.max(4, Math.min(16, Math.ceil(len / 2)))
  // travel-direction tangents: leave A along its outward tangent, arrive at B
  // heading A->B (the reverse of B's outward-into-gap tangent)
  const t0x = atx, t0y = aty, t1x = -btx, t1y = -bty
  let best: number[] = [ax, ay, bx, by], bestE = len
  for (const h of [0.4, 0.6, 0.8, 1.0, 1.2]) {
    const m = h * len
    const pts: number[] = []
    for (let i = 0; i <= K; i++) {
      const t = i / K, t2 = t * t, t3 = t2 * t
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2
      pts.push(h00 * ax + h10 * m * t0x + h01 * bx + h11 * m * t1x,
               h00 * ay + h10 * m * t0y + h01 * by + h11 * m * t1y)
    }
    const e = elasticaEnergy(pts)
    if (e < bestE) { bestE = e; best = pts }
  }
  // reject a wild bow: keep the curve only if it stays near the chord's cost
  return bestE > 1.5 * len ? [ax, ay, bx, by] : best
}
