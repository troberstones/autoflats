import { sampleFlow, type Flow } from './flow.ts'
import { elasticaCurve } from './relatability.ts'

// Gestalt "good continuation": bridge two anchors with a Hermite curve whose
// end tangents follow the stroke flow, so the bridge continues the strokes
// instead of cutting a straight chord. Falls back to the chord when flow is
// incoherent or the curve would bow out wildly.
// Gestalt parallelism ("co-completion"): contours often come as parallel
// pairs (double-drawn edges). If an unbroken stroke runs parallel to the
// bridge — spanning the gap and continuing past both ends — borrow its shape:
// trace its perpendicular offsets and translate them onto the bridge.
export function coCompleteBridge(x1: number, y1: number, x2: number, y2: number,
  line: Uint8Array, W: number, H: number): number[] | null {
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (len < 8) return null
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux
  const K = Math.max(6, Math.min(20, Math.round(len / 2)))
  const at = (t: number, o: number): number => {
    const x = Math.round(x1 + ux * t * len + nx * o), y = Math.round(y1 + uy * t * len + ny * o)
    return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x
  }
  const maxOff = Math.min(20, Math.round(2.5 * len))
  for (let ao = 3; ao <= maxOff; ao++) {
    for (const o of [ao, -ao]) {
      let hits = 0
      for (let k = 0; k <= K; k++) {
        for (let e = -1; e <= 1; e++) {
          const i = at(k / K, o + e)
          if (i >= 0 && line[i]) { hits++; break }
        }
      }
      const pre = at(-0.15, o), post = at(1.15, o)
      if (hits / (K + 1) < 0.85 || pre < 0 || !line[pre] || post < 0 || !line[post]) continue
      // trace the partner's wobble and copy it across
      const pts: number[] = [x1, y1]
      let prev = o
      for (let k = 1; k < K; k++) {
        const t = k / K
        let fo = prev
        outer: for (let e = 0; e <= 3; e++) {
          for (const s of e ? [e, -e] : [0]) {
            const i = at(t, prev + s)
            if (i >= 0 && line[i]) { fo = prev + s; break outer }
          }
        }
        prev = fo
        pts.push(x1 + ux * t * len + nx * (fo - o), y1 + uy * t * len + ny * (fo - o))
      }
      pts.push(x2, y2)
      return pts
    }
  }
  return null
}

export function curveBridge(x1: number, y1: number, x2: number, y2: number, flow: Flow | null): number[] {
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  // tip tangents from the stroke flow, oriented along the chord (into the gap)
  let f1x = dx / len, f1y = dy / len, f2x = f1x, f2y = f1y
  if (flow) {
    const [ax, ay, c1] = sampleFlow(flow, x1, y1)
    const [bx, by, c2] = sampleFlow(flow, x2, y2)
    if (c1 > 0.25) { f1x = ax; f1y = ay; if (f1x * dx + f1y * dy < 0) { f1x = -f1x; f1y = -f1y } }
    if (c2 > 0.25) { f2x = bx; f2y = by; if (f2x * dx + f2y * dy < 0) { f2x = -f2x; f2y = -f2y } }
  }
  // minimal-elastica shape: A's into-gap tangent is f1; B's is -f2 (f2 points
  // along travel, so into-gap at B is its reverse). Bails to the chord itself
  // when even the best curve bows too far.
  return elasticaCurve(x1, y1, f1x, f1y, x2, y2, -f2x, -f2y)
}
