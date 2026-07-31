# autoFlats — Development Guide

Handoff document for future work. Pairs with [README.md](README.md) (user-facing)
and the source comments. Written 2026-07-13.

## What this is

A local, dependency-light web app that loads line art, auto-generates flat
colour fills (one region per area), tolerates broken/gappy line work, lets the
user fix gaps and fills interactively, and exports a layered PSD. Fills extend
to the middle of each stroke so the original line art overlays with no fringe.

## Platform & running

- **Vite + TypeScript + HTML Canvas, no UI framework.** Chosen for reliable
  cross-platform UI and instant iteration.
- **One runtime dependency: `ag-psd`** (pure-JS PSD writer). Dev deps: vite, typescript.
- Heavy work runs in a **Web Worker** ([src/worker.ts](src/worker.ts)) on typed arrays.
- `npm run dev` → http://localhost:5173. `npm run build` typechecks + bundles.

```
npm install
npm run dev
```

## Module map

```
index.html            menu bar, left toolbar, right layers panel, bottom sliders, canvas
src/
  main.ts             app controller: state, worker orchestration, tools, undo, export wiring
  state.ts            Doc model (image/ink/core/labels/regions/strokes), palette + colour utils
  worker.ts           off-thread: segment(), carve, cluster, gaps; stage caches; GPU dispatch
  ui/canvasView.ts    zoom/pan viewport, render (fills + line overlay + barriers + suggestions)
  core/
    ink.ts            line extraction -> ink density (0..255); alpha-only + colour rejection
    morphology.ts     chamfer distance transform, morphological closing/despeckle, skeletonize
    trappedBall.ts    multi-radius trapped-ball segmentation + pocket labelling
    expand.ts         growLabels(): bucketed-Dijkstra multi-source growth (soft watershed)
    regions.ts        tiny-region absorption, id compaction, background detection
    slivers.ts        merge corridor slivers (space between parallel strokes)
    fronts.ts         region-collision analysis: auto-merge leaks + bridge suggestions
    flow.ts           stroke-orientation field (structure tensor at 1/4 res)
    relatability.ts   Kellman-Shipley relatability gate + Euler elastica energy/shape
    completionField.ts stochastic completion field (Williams & Jacobs): u*v closure
    curves.ts         curved (Hermite) + co-completion (parallel-partner) bridge shapes
    gaps.ts           skeleton-endpoint gap suggestions (fallback source)
    gpuGrow.ts        WebGPU chamfer-relaxation growth (optional, self-falling-back)
    psd.ts            layered PSD export via ag-psd (canvas-free, plain ImageData)
```

## The fill pipeline (order matters)

Runs in `segment()` + the `flat` handler of [worker.ts](src/worker.ts). Each stage
is deliberately separable so parameter changes only re-run what they invalidate.

1. **Ink extraction** ([ink.ts](src/core/ink.ts)) — `darkness × alpha`, gated by
   saturation so colored underdrawings (e.g. Lineart6 red) are rejected. Handles
   alpha-only PNGs (Lineart1). Output: `ink` 0..255.
2. **Line mask** ([main.ts](src/main.ts) `currentLineMask`) — threshold ink →
   binary; morphological **closing + despeckle** (Smoothing slider); OR in user
   **barriers**; optionally **skeletonize** to 1px centreline (Skeletonize toggle).
3. **Trapped-ball segmentation** ([trappedBall.ts](src/core/trappedBall.ts)) — a ball
   of radius r can't pass a gap narrower than ~2r. Descending radii seed where the
   ball fits (`dist > r`) and grow back r, so large safe areas fill first, small
   details last, and nothing floods the image. Leftover free pixels attach to the
   nearest **connected** region; only enclosed pockets become new regions.
4. **Line-centre expansion** ([expand.ts](src/core/expand.ts)) — all labels grow
   simultaneously in chamfer-distance order (bucketed Dijkstra, 8-conn). Fronts
   meet at the medial axis → fills reach stroke centres. **Soft watershed:** growth
   pays a cost to cross dark pixels (`cost: ink`), so boundaries snap to faint
   sub-threshold remnants and the darkest ridge, not the geometric midpoint.
5. **Region finalize** ([regions.ts](src/core/regions.ts)) — absorb regions below
   Min-region into the neighbour sharing the most boundary; compact ids; detect
   background (touches canvas border).
6. **Sliver merge** ([slivers.ts](src/core/slivers.ts)) — regions thin everywhere
   (trapped between parallel strokes) merge into the area they open into.
7. **Flow field** ([flow.ts](src/core/flow.ts)) — structure tensor of the ink at
   1/4 res → per-pixel stroke tangent + coherence. Cached by ink.
8. **Front analysis** ([fronts.ts](src/core/fronts.ts)) — for each adjacent region
   pair, measure how much shared border is in open space (far from line). Open +
   *against* flow → **auto-merge** (leak fragment). Open + *along* flow / narrow
   throat → **bridge suggestion**, anchored on the line pixels flanking the
   narrowest point, width- and flow-checked, virtual-bridge split-tested.
9. **Bridge shaping** ([curves.ts](src/core/curves.ts)) — each suggestion becomes a
   polyline: parallel-partner **co-completion** if a stroke spans the gap, else a
   flow-curved **Hermite** (good continuation), else the chord.

`finalizeRegions` returns `RegionInfo[]`; `main.ts` builds `Region[]` with palette
colours and layer state.

## Gestalt gap closing

Gap suggestion is grounded in vision science rather than ad-hoc thresholds. The
mapping from gestalt principle to computation:

| Principle | Model | Where |
|---|---|---|
| Good continuation | Kellman-Shipley **relatability**: smooth, monotonic, bend ≤90°, no inflection | [relatability.ts](src/core/relatability.ts) |
| — shape/ranking | Euler **elastica** `∫(1+βκ²)ds` | [relatability.ts](src/core/relatability.ts), [curves.ts](src/core/curves.ts) |
| Proximity | random-walk decay per step | [completionField.ts](src/core/completionField.ts) |
| Closure | **product** of forward × backward fields (`C = u·v`) | [completionField.ts](src/core/completionField.ts) |
| Similarity | stroke-width matching at anchors | [fronts.ts](src/core/fronts.ts), [gaps.ts](src/core/gaps.ts) |
| Parallelism | co-completion from a partner stroke; field superposition | [curves.ts](src/core/curves.ts) |

**Relatability** is the gate: it replaced a pair of one-sided collinearity
dot-checks that admitted S-curves (inflected links human vision never
completes). Elastica energy then ranks survivors — straighter beats bendier at
equal distance — and shapes the drawn bridge.

**The completion field** ([completionField.ts](src/core/completionField.ts)) is the
principled engine. A directed random walk on `(x, y, θ)`: particles advect along
their heading (continuation), diffuse in θ (gradual turning), and decay
(proximity). A forward field `u` is emitted from tips-as-sources and a backward
field `v` from tips-as-sinks; **`C = Σ_θ u·v` is closure for free** — a ray into
the void has high `u` but ~zero `v`, so it scores nothing. Solved by iterative
relaxation (same shape as [gpuGrow.ts](src/core/gpuGrow.ts)).

Three non-obvious implementation constraints, each of which broke it once:

1. **Half res, not quarter.** Gaps are 8-20px. At ¼ res an 8px gap is 2 cells and
   the ink dilation from downsampling seals it completely — the field reads zero
   everywhere and no bridge is ever proposed.
2. **Sparse storage.** A dense `K×W×H` volume at half res is ~90MB *per field*
   (×4 fields). Only a band around stroke tips is relaxed, stored via a compact
   `idx` map (half-res cell → compact index, or −1).
3. **Skip ink when scoring, don't zero it.** Tips come from the *skeleton*, so a
   thick stroke buries the ends of every candidate path in ink cells where the
   field cannot exist. Scoring those as 0 rejects every real bridge. `sampleC`
   returns −1 for "no field cell" (distinct from a genuine 0) and `pathSupport`
   skips them. Support is the **minimum** over the free interior, not the mean:
   closure demands an unbroken contour, and a wall mid-gap must not be averaged
   away.

Support is sharply bimodal on real art (~2.0 for genuine completions vs ~1e-4 for
noise), so the threshold is not delicate. The field is high-precision /
low-recall — it proposes far fewer bridges than the heuristic pairing, but they
land squarely in real stroke breaks. It is therefore an **opt-in toggle**
("Completion field") on Suggest Gaps, not the default; region-collision fronts
remain the primary suggestion source.

*Not done:* a WGSL kernel for the field. The sparse active-cell layout does not
map cleanly onto a dense GPU grid, and ~1.1s at 5.6MP is acceptable for an
explicit action. Revisit only if the field becomes a live/auto stage.

## Data model ([state.ts](src/state.ts))

- `Doc.core` — trapped-ball labels (before growth into line pixels).
- `Doc.labels` — full labels after expansion (what you see/export).
- `Doc.regions[id]` — `{id, color, name, visible, parent, area, isBg}`.
  **`parent` is a region-level union-find** for merges: `doc.root(id)` resolves it,
  `doc.rootLut()` builds a label→root LUT, `doc.roots()` lists merged roots.
  Rendering/export always go through the root, so merges are non-destructive/undoable.
- `Doc.strokes` — barrier pen strokes (draw/erase); rasterized to `barrierMask`,
  which counts as line for segmentation but is never rendered/exported.
- Undo is a stack of `{undo()}` closures; heavy (segmentation-snapshot) ops are
  capped to the last 3 to bound memory.

## Tools ([main.ts](src/main.ts))

Pan (V) · Fill/recolor 🪣 (B: recolor a fill, or carve a new fill from background;
Alt-click eyedrop; Random checkbox) · Barrier pen 🖊 (G) · Barrier eraser 🧽 (E) ·
Merge ⧉ (M: click two regions) · Draw-merge 🧲 (D: stroke from a fill, everything
crossed merges into it). Gap suggestions: Tab/Shift-Tab cycle, Enter/click bridge,
Accept All. Cluster Small merges small open-bordered fills.

## Interactivity infrastructure

- **Cancellable worker:** a superseding request calls `cancelWork()`, which
  `terminate()`s and respawns the worker — instant abort, no queue pile-up.
- **Stage caches (worker-side):** `segCache` keyed by a `segKey` string
  (dims|thr|smooth|gap|sat|strokesVersion|skel) — postprocess-only changes
  (Min-region, Sliver, Auto-merge) skip re-segmentation. `flowCache` keyed by ink.
  **If you add a parameter that affects segmentation, add it to `segKey` in both
  the full-res and preview `postMessage` calls in main.ts, or the cache goes stale.**
- **Quarter-res live preview:** while a slider drags with Auto-reflat on,
  `runPreviewFlat()` runs the whole pipeline at 1/4 res (~16× faster), colours
  matched to current fills by overlap; the full-res pass lands after the drag settles.
- **GPU growth (optional):** [gpuGrow.ts](src/core/gpuGrow.ts) does stages 3-4's
  growth as ping-pong chamfer relaxation. Gated behind the GPU checkbox (only shown
  when `navigator.gpu` exists), skips <2MP, and **permanently falls back to CPU on
  any failure**. NOT yet validated on real hardware — verify in Chrome before trusting.

## Known tradeoffs & gotchas

- **Full flat ≈ 1.5–3s at 5.6MP** (CPU). Soft watershed adds ~10%. The ¼-res
  preview hides this during tuning; GPU should cut it hard once verified.
- **Skeletonize** retracts open stroke *tips* inward ~half the stroke width, so a
  given visual gap reads larger in skeleton space → may leak; nudge Gap size up. Off
  by default.
- **Too many layers** — the current 1-region-1-layer model yields 200–470 regions
  per sample. This is the top open problem (see below).
- Browser-preview MCP and the Chrome bridge were both unavailable in the build
  environment, so all validation was **headless** (see Testing). Do a real
  in-browser pass when possible, especially for the GPU path and PSD-in-Photoshop.

## Testing

No unit-test framework. Validation is a **headless harness** that runs the real
core modules against the sample images:

- Convert samples to raw RGBA once: `ffmpeg -i Lineart2.png -f rawvideo -pix_fmt rgba out.rgba`.
- Run the pipeline with Node's TS stripping:
  `node --experimental-transform-types test.ts` (import core modules with explicit
  `.ts` extensions; `allowImportingTsExtensions` is on in tsconfig).
- The harness prints region/background/max-fill/merge/gap counts per image and
  renders coloured flats to PNG for visual inspection. Scripts live in the session
  scratchpad (`test.ts`, `testskel.ts`, `testpsd.ts`) — recreate as needed.
- PSD round-trips are checked by `ag-psd`'s `readPsd` and by rendering with macOS
  `sips -s format png out.psd`.
- **Health checks after any pipeline change:** background stays one bounded region
  (no whole-image leak), max non-bg fill stays small, no explosion of tiny regions,
  fills reach stroke centres (render with line layer off — adjacent fills should
  abut with no seam).

## Top open problem: too many layers

1 region = 1 layer produces far too many layers for a usable PSD (a character has
~20–40 real colour areas, we emit hundreds). **Recommended package, in priority
order (design already scoped, not yet implemented):**

1. **Per-colour export mode** — group regions sharing a fill colour into one layer.
   Add export modes: Per colour (default) / Single flat layer / Per region (current).
   Biggest single win; matches real flatting deliverables. Touches [psd.ts](src/core/psd.ts)
   (`rootOf` LUT → group by colour instead of by root) and the export menu.
2. **Palette quantization** — a Colors slider (K≈8–32) assigning from a fixed
   K-colour palette so regions pre-collapse into K groups before any manual work.
   Touches palette assignment in `runFlat`/[state.ts](src/state.ts).
3. **Colour-grouped layers panel** — one collapsible row per colour with a count +
   bulk recolor/hide/merge, so the panel is short regardless of region count. Touches
   `rebuildPanel` in [main.ts](src/main.ts).
4. **PSD layer folders** — if per-region is kept, nest by colour in group folders
   (ag-psd supports group layers) so Photoshop shows a few folders not hundreds.

These are largely independent; 1+2+3 is the recommended set.

## Ideas discussed but not built

Ordered by value-for-effort (from the gap-handling brainstorm):

- **Figure/ground shape priors** — score region solidity/tortuosity to rank
  auto-merges and to surface *uncertain* regions as user attention targets.
- **Learned closure** — a small U-Net predicting per-pixel gap probability, trained
  on synthetic erasures of clean line art, run via ONNX Runtime WebGPU. The only
  approach that learns style-specific conventions; costs the lightweight-deps goal,
  so make it an optional model file.
- **Local recompute** — a barrier stroke only affects the regions it touches;
  re-segment a padded bbox and splice for ~50ms edits instead of a full reflat.

## Commit history (this project's arc)

`git log --oneline` — each feature landed as one reviewable commit. The baseline
commit bundles the initial app; subsequent commits are cancellable-worker/memo,
live preview, soft watershed, curved bridges, width matching, co-completion, GPU
growth, and skeletonize. Read the messages for the rationale behind each.
