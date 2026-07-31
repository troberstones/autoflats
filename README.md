# autoFlats

Auto flat-filling for line art. Load an image, get one flat color fill per region (each on its own layer), fix gaps interactively, export a layered PSD.

## Run

```
npm install
npm run dev     # open http://localhost:5173
```

To host it anywhere else, **build first and serve `dist/`**:

```
npm run build
python3 -m http.server 8010 --directory dist
```

> **A plain static server pointed at the source directory will not work.**
> `index.html` loads `/src/main.ts`, and browsers cannot execute TypeScript —
> Python's `http.server` even labels `.ts` as `video/mp2t`, so the module is
> rejected outright. The page renders but no button does anything, because the
> script never ran. `npm run dev` compiles on the fly; `npm run build` compiles
> ahead of time. Either is fine; serving the raw sources is not.

Everything runs client-side, so `dist/` is a static bundle you can host as-is.
Needs a browser with module workers (Safari 15+, Chrome 80+, Firefox 114+).

## Use

1. **Open…** (or drag-drop) a line-art PNG. It auto-flats on load.
2. Fills extend to the middle of each stroke, so the line art overlays with no fringe. Toggle **Line opacity** to inspect.
3. Adjust and hit **Re-Flat** (keeps your colors, matched by overlap):
   - **Line threshold** — how dark a pixel must be to count as line (raise for faint sketch lines).
   - **Color reject** — saturation above this is ignored (drops colored underdrawings, e.g. red construction lines).
   - **Smoothing** — morphological closing of the line mask before segmentation; seals pinholes/texture in grainy strokes (exported line art is untouched).
   - **Skeletonize** — erode the line mask to a 1px centreline (Zhang-Suen) before filling, so gap size and stroke-width matching stop depending on how thick the artist drew, and fills grow right to the centreline. The overlaid/exported line art stays the original thick art.
   - **Gap size** — trapped-ball radius; gaps narrower than ~2× this won't leak.
   - **Rubber sheet** — an alternative to the trapped ball: hang the drawing like a sheet of rubber pinned wherever there's ink, let gravity pull, and take the sagging valleys as the fills (see below). Fewer, larger, more sensible fills — typically **a quarter of the fill count** on the samples here (615 → 153) with the figures grouped the way you'd group them by hand. The number is how far a valley must sag below its rim to count as a fill of its own, in pixels; raise it to merge more. 0 = off. Costs about 3× a trapped-ball flat, and it's cached, so only re-segmenting pays it.
   - **Min region** — smaller regions are absorbed into their biggest neighbor.
   - **Sliver width** — fills thinner than this *everywhere* (the space trapped between parallel/double strokes) merge into the area they open into. 0 disables.
   - **Declutter** — busy line work (hatching, folds, texture) doesn't enclose anything, but the segmenter still seeds a fill in every pocket between strokes; these fragments are ~76% of all fills yet under 10% of the picture. This absorbs them into the area they shade. Higher = more aggressive; 0 = off. Typically cuts the fill count by half to two-thirds.
   - **Colors** — assign fills from a palette of this many colors instead of a unique color each. Neighbouring fills never get the same color (graph coloring), so nothing visually merges. This groups the layers panel and makes one-layer-per-color export meaningful. 0 = unique color per fill.
   - **Auto-merge leaks** — fill fragments whose shared border crosses open space *against* the stroke flow are merged automatically.
   - **Completion field** — score gap bridges with a stochastic completion field instead of heuristic endpoint pairing (see below). Tips are linked only where the field carries an unbroken contour between them, so suggestions are fewer but land squarely in real stroke breaks. Applies to **Suggest Gaps**.
   - **Auto-bridge gaps** — accept the suggested bridges automatically after each flat and re-flat. Every suggestion has already been proven to close a fill, so this is safe to leave on; it settles after a round or two, and ⌘Z undoes.
4. **Gaps**: suggestions appear right after flatting (and via **Suggest Gaps**) — orange/white segments anchored where region collisions squeeze through actual line breaks, direction-checked against the stroke flow field. **Tab / Shift-Tab** cycles through them (view jumps to each), **Enter** or a click bridges the focused one, **Accept All Gaps** takes everything. Bridges are invisible barriers — they constrain fills but are never exported. The 🖊 barrier pen draws them by hand; 🧽 erases.
5. **Tools**: 🗑 delete fill (X): click a fill to remove it — it stops rendering and is left out of the PSD (⌘Z restores) · 🔗 group fills (R): lasso *around* a set of fills, or drag a stroke *through* them; they export as a named PSD folder. **Both survive re-flatting** — a group is remembered as the shape you drew, so membership is recomputed against the new fills each time. · ✋ pan (Space) · 🪣 fill/recolor (click a fill = recolor with current color, or a random color if **Random** is checked; click background = carve a new fill; Alt-click = pick color) · ⧉ merge two regions (click-click) · 🖌 draw merge (D): stroke from a fill and everything the stroke crosses merges into it. ⌘Z undo.
6. **Export PSD** — white background at the bottom, fills in the middle, line art on top. The dropdown next to the button picks how fills become layers:
   - **one layer per color** — all the fills sharing a color land on a single layer. The usual flatting deliverable; combine with the **Colors** slider (or just recolor by hand first).
   - **one layer per fill** — every fill stays independently editable, but they're nested in a group folder per color, so Photoshop shows a handful of folders instead of hundreds of loose layers.
   - **single flat layer** — everything merged onto one layer.

   Hidden fills are kept as hidden layers in per-fill mode, and left out entirely in the merged modes (where you couldn't turn them back on).

## How it works

- **Ink extraction** ([src/core/ink.ts](src/core/ink.ts)) — dark + desaturated = line; handles alpha-only PNGs and colored underdrawings.
- **Trapped-ball segmentation** ([src/core/trappedBall.ts](src/core/trappedBall.ts)) — a ball of radius r can't pass a gap narrower than 2r; descending radii fill large areas safely, then small details, so nothing floods the whole image.
- **Rubber sheet, optional** ([src/core/membrane.ts](src/core/membrane.ts), [src/core/sag.ts](src/core/sag.ts)) — pin a membrane to the frame wherever there's ink and let gravity pull it down. How far it sags is a Poisson problem, and sag grows with the *square* of how much room there is, so a drawn area becomes a deep valley while a break in a stroke becomes a shallow col between two valleys. Flood downhill from every low point: basins are the fills, and a basin survives only if it sags more than a threshold below the col where it meets its neighbour. That single test does the work of gap size, min region, sliver width and declutter at once — hatching pockets are shallow, so they dissolve into the surface they shade for free. A col too wide for the trapped ball is only kept as a boundary if the ridge running through it reaches ink at both ends, so a genuine broken silhouette stays closed while the seam between two lobes of open background does not.
- **Line-center expansion** ([src/core/expand.ts](src/core/expand.ts)) — regions grow into line pixels simultaneously and meet at the stroke's medial axis.
- **Declutter** ([src/core/declutter.ts](src/core/declutter.ts)) — a fill that is small *and* squeezed between strokes *and* sitting in an inky neighbourhood is shading, not a drawn area, so it's absorbed into the surface it shades. Touching fragments collapse together first, so a whole hatched patch merges as one unit.
- **Gap suggestions** ([src/core/gaps.ts](src/core/gaps.ts), [src/core/fronts.ts](src/core/fronts.ts)) — region-collision fronts and skeleton endpoints propose bridges; each must match stroke widths, follow the flow field, and survive a virtual-bridge split test. Bridges are flow-curved Hermite paths ([src/core/curves.ts](src/core/curves.ts)), shaped by a parallel partner stroke when one spans the gap.
- **Gestalt grounding** ([src/core/relatability.ts](src/core/relatability.ts)) — candidate bridges must be *relatable* in the Kellman-Shipley sense (smooth, monotonic, bending no more than ~90°, no inflection), and are ranked and shaped by Euler elastica energy, so straighter completions win over kinked ones.
- **Completion field (optional)** ([src/core/completionField.ts](src/core/completionField.ts)) — a stochastic completion field (Williams & Jacobs): oriented particles diffuse from stroke tips, and bridging is scored by the product of the forward and backward fields. That product *is* closure — a stroke pointing into empty space scores nothing, while two tips facing each other across a gap light up. High precision, fewer suggestions; enable with the **Completion field** checkbox.
- **Closure & simplicity** ([src/core/closure.ts](src/core/closure.ts)) — every candidate bridge must actually *close* something: drawing it has to split one fill into two parts of real size. And only the simplest set survives — when several candidates cross the same leak, the first one wins and the rest are dropped as redundant. This removes 65–80% of raw candidates, so what you review is short and each entry is worth a click.
- **GPU (optional)** ([src/core/gpuGrow.ts](src/core/gpuGrow.ts)) — WebGPU iterative relaxation for the growth stages, automatic CPU fallback.
- Segmentation runs in a Web Worker; the only runtime dependency is [ag-psd](https://github.com/Agamnentzar/ag-psd) for PSD writing.
