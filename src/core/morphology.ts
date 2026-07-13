// Zhang-Suen thinning to a 1px 8-connected skeleton (returns a new mask).
// Erodes strokes to their centreline so downstream stages see uniform 1px
// lines — gap size and width matching stop depending on how thick the artist
// drew, and fills grow up to the centreline (no fringe). A 4-connected flood
// cannot cross an 8-connected skeleton, so it remains a valid barrier.
export function skeletonize(mask: Uint8Array, W: number, H: number): Uint8Array {
  const sk = mask.slice()
  for (let x = 0; x < W; x++) { sk[x] = 0; sk[(H - 1) * W + x] = 0 }
  for (let y = 0; y < H; y++) { sk[y * W] = 0; sk[y * W + W - 1] = 0 }
  let cand: number[] = []
  for (let i = 0; i < sk.length; i++) if (sk[i]) cand.push(i)
  for (let iter = 0; iter < 300 && cand.length; iter++) {
    const next = new Set<number>()
    let removed = false
    for (let phase = 0; phase < 2; phase++) {
      const del: number[] = []
      for (const i of cand) {
        if (!sk[i]) continue
        const p2 = sk[i - W], p3 = sk[i - W + 1], p4 = sk[i + 1], p5 = sk[i + W + 1],
              p6 = sk[i + W], p7 = sk[i + W - 1], p8 = sk[i - 1], p9 = sk[i - W - 1]
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
        if (B < 2 || B > 6) continue
        let A = 0
        if (!p2 && p3) A++; if (!p3 && p4) A++; if (!p4 && p5) A++; if (!p5 && p6) A++
        if (!p6 && p7) A++; if (!p7 && p8) A++; if (!p8 && p9) A++; if (!p9 && p2) A++
        if (A !== 1) continue
        if (phase === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue }
        else { if (p2 * p4 * p8 || p2 * p6 * p8) continue }
        del.push(i)
      }
      for (const i of del) {
        sk[i] = 0
        removed = true
        for (const d of [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1]) if (sk[i + d]) next.add(i + d)
      }
    }
    if (!removed) break
    cand = [...next]
  }
  return sk
}

// Morphological closing (radius r px) + despeckle: seals pinholes and ragged
// texture in grainy strokes, drops isolated specks. Superset of the input
// line pixels is guaranteed.
export function smoothMask(line: Uint8Array, W: number, H: number, r: number, despeckle = 12): Uint8Array {
  const N = W * H
  let m = line
  if (r > 0) {
    const d1 = distanceTransform(line, W, H)
    const dil = new Uint8Array(N)
    for (let i = 0; i < N; i++) if (d1[i] <= 3 * r) dil[i] = 1
    const inv = new Uint8Array(N)
    for (let i = 0; i < N; i++) inv[i] = dil[i] ? 0 : 1
    const d2 = distanceTransform(inv, W, H)
    m = new Uint8Array(N)
    for (let i = 0; i < N; i++) if (d2[i] > 3 * r || line[i]) m[i] = 1
  } else if (despeckle > 0) {
    m = line.slice()
  }
  if (despeckle > 0) {
    // remove tiny isolated line components (dust); fills flow under the dots anyway
    const seen = new Uint8Array(N)
    const stack: number[] = []
    for (let s = 0; s < N; s++) {
      if (!m[s] || seen[s]) continue
      stack.length = 0
      stack.push(s)
      seen[s] = 1
      const comp: number[] = [s]
      while (stack.length) {
        const p = stack.pop()!
        const x = p % W, y = (p / W) | 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const qx = x + dx, qy = y + dy
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue
          const q = qy * W + qx
          if (m[q] && !seen[q]) { seen[q] = 1; stack.push(q); if (comp.length <= despeckle) comp.push(q) }
        }
      }
      if (comp.length <= despeckle) for (const p of comp) m[p] = 0
    }
  }
  return m
}

// Chamfer 3-4 distance transform. mask: 1 = obstacle (dist 0).
// Returned distances are in units of 3 ≈ 1 pixel.
export function distanceTransform(mask: Uint8Array, W: number, H: number): Int32Array {
  const INF = 1 << 29
  const d = new Int32Array(W * H)
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      let v = d[i]
      if (v === 0) continue
      if (x > 0 && d[i - 1] + 3 < v) v = d[i - 1] + 3
      if (y > 0) {
        if (d[i - W] + 3 < v) v = d[i - W] + 3
        if (x > 0 && d[i - W - 1] + 4 < v) v = d[i - W - 1] + 4
        if (x < W - 1 && d[i - W + 1] + 4 < v) v = d[i - W + 1] + 4
      }
      d[i] = v
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x
      let v = d[i]
      if (v === 0) continue
      if (x < W - 1 && d[i + 1] + 3 < v) v = d[i + 1] + 3
      if (y < H - 1) {
        if (d[i + W] + 3 < v) v = d[i + W] + 3
        if (x < W - 1 && d[i + W + 1] + 4 < v) v = d[i + W + 1] + 4
        if (x > 0 && d[i + W - 1] + 4 < v) v = d[i + W - 1] + 4
      }
      d[i] = v
    }
  }
  return d
}
