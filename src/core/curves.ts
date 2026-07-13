import { sampleFlow, type Flow } from './flow.ts'

// Gestalt "good continuation": bridge two anchors with a Hermite curve whose
// end tangents follow the stroke flow, so the bridge continues the strokes
// instead of cutting a straight chord. Falls back to the chord when flow is
// incoherent or the curve would bow out wildly.
export function curveBridge(x1: number, y1: number, x2: number, y2: number, flow: Flow | null): number[] {
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  let f1x = dx / len, f1y = dy / len, f2x = f1x, f2y = f1y
  if (flow) {
    const [ax, ay, c1] = sampleFlow(flow, x1, y1)
    const [bx, by, c2] = sampleFlow(flow, x2, y2)
    if (c1 > 0.25) { f1x = ax; f1y = ay; if (f1x * dx + f1y * dy < 0) { f1x = -f1x; f1y = -f1y } }
    if (c2 > 0.25) { f2x = bx; f2y = by; if (f2x * dx + f2y * dy < 0) { f2x = -f2x; f2y = -f2y } }
  }
  const K = Math.max(4, Math.min(16, Math.ceil(len / 2)))
  const pts: number[] = []
  let maxDev = 0
  for (let i = 0; i <= K; i++) {
    const t = i / K, t2 = t * t, t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2
    const px = h00 * x1 + h10 * len * f1x + h01 * x2 + h11 * len * f2x
    const py = h00 * y1 + h10 * len * f1y + h01 * y2 + h11 * len * f2y
    pts.push(px, py)
    // perpendicular deviation from the chord
    maxDev = Math.max(maxDev, Math.abs((px - x1) * (-dy / len) + (py - y1) * (dx / len)))
  }
  return maxDev > 0.6 * len ? [x1, y1, x2, y2] : pts
}
