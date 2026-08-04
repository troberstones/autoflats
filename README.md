# autoFlats

Auto flat-filling for line art. Load an image, get one flat color fill per region (each on its own layer), fix gaps interactively, export a layered PSD.

## Run

```
npm install
npm run dev     # open http://localhost:5173
npm test        # invariant tests, ~9s
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

     That unique color comes from a point *inside* the fill, not from its id. Ids are handed out by the segmenter and get reshuffled by any change to the settings, so an id-derived palette repainted the whole drawing every time a slider moved — which made it impossible to see what had actually changed. Keyed on a place, a fill that came out the same comes out the same color: nudging **Smoothing** on a 417-fill drawing down to 381 leaves 91% of the fills wearing exactly the color they had, and putting the slider back reproduces all 417 originals exactly. The point used is the fill's anchor rather than its centroid, because a ring and the hole inside it share a centroid and would come out identically colored — and because anchors are pixels inside disjoint regions, no two fills can ever be handed the same color by accident.
   - **Auto-merge leaks** — fill fragments whose shared border crosses open space *against* the stroke flow are merged automatically.
   - **Completion field** — score gap bridges with a stochastic completion field instead of heuristic endpoint pairing (see below). Tips are linked only where the field carries an unbroken contour between them, so suggestions are fewer but land squarely in real stroke breaks. Applies to **Suggest Gaps**.
   - **Auto-bridge gaps** — accept the suggested bridges automatically after each flat and re-flat. Every suggestion has already been proven to close a fill, so this is safe to leave on; it settles after a round or two, and ⌘Z undoes.
3b. **Palette.** The strip in the top bar is the quick pick: click a swatch to make it the current color *and* recolor the selected fill in one go, **+** adds the current color, ⌥-click or right-click drops one. **⋯** opens the editor:

   - A grid of 40 slots. Click an empty one to drop the current color into it; click a filled one to use it. To empty one: ⌥-click, right-click, or **press and hold** — the last of those is there because a tablet has neither ⌥ nor a right button, and a palette you can fill but not empty fills up. Emptying leaves a **hole** rather than shuffling everything up — position is meaning in a palette, skin in the top row and cloth in the next.
   - **R/G/B and H/S/L sliders** adjust the selected swatch (the one with the ring) live, in both directions — drag G and the hue follows, drag H and the channels follow. A whole drag is one ⌘Z, not one per pixel of travel.

   **Fills painted from a swatch stay attached to it.** Adjust the swatch — with the sliders, or by picking a new colour for it — and every fill painted from it follows, however many there are. That's the point of flatting from a palette: you change your mind about a tone, not about the forty places it was used. Colors taken from the well or the reference image are one-offs and don't join a swatch; ⌥-picking a fill's color picks up its link too, so the next thing you paint joins the same group. Emptying a swatch leaves its fills wearing the color they have and simply stops them following anything.

   **Recolors survive re-flatting**, like merges, deletions and groups — and for the same reason: each one is remembered as a *place* in the drawing (the fill's centroid, snapped to a pixel actually inside it) rather than as a region id, so a re-flat can find the area again and put the color back. Re-segmenting a drawing from 417 fills down to 381 keeps them. They replay last of all, after the shape fills, so a color lands on the regions as they finally are.
   - **from fills** rebuilds the palette from the colors already in the drawing, biggest areas first. **clear** empties every slot.
   - **download** writes a `.json`; **upload** reads it back, and also reads any file with `#rrggbb` in it — a GIMP or Krita `.gpl`, or a plain list.
   - The panel at the bottom is a **reference image**: paste (⌘V) or drop a photo, a color script, a frame of the film, and click or drag on it to pick colors straight out of it. Double-click sends the picked color to the first free slot. It's drawn on white, so a transparent PNG doesn't read as black.

   Palettes are saved between sessions, since a palette outlives the drawing it was built for.

   The **brush** — the recolor tool (`C`) is the bucket without the teeth: it paints a fill the current color and *never* carves a new fill out of the background the way the bucket does, so it's safe to sweep across a finished flat. **Shift-click** recolors every fill wearing that same color at once — the point of flatting from a palette is that a tone is shared, so changing your mind about it shouldn't mean hunting down forty regions. ⌥-click picks the color up instead.

3c. **The layers panel** sorts by a top-left sweep by default, so the list follows the drawing the way your eye reads it (largest-first is still in the dropdown). The sweep runs on each fill's *centroid*, not its bounding box — a horn or a strand of hair would otherwise sort by wherever its tip happens to point. Double-click a name to rename in place; **Enter** commits and jumps to the next fill, so a whole drawing can be named without the mouse. **Renumber** renames everything to Fill 1..N in the current order.

4. **Seeing what it did** (bottom bar, next to *Show extracted lines*):
   - **Sag field** — draw the rubber sheet itself instead of the fills: near-black where it's pinned to the ink, up through purple and red to pale yellow in the middle of the roomiest areas (log scale; the label says what full brightness is worth in pixels). A drawn area is visibly a basin, and a break in a stroke is visibly just a shallow notch between two of them — which is why the fills don't pour through it. Needs **Rubber sheet** to be up.
   - **Zebra** — cut that ramp into N flat bands, turning the sag field into a contour map. Each stripe is one step of roominess, so the spacing reads as slope: tight stripes are a wall falling away to the ink, a wide stripe is a plateau, closed rings mark a basin's peak, and a col shows up as the one stripe that pinches and pairs across an opening. Alternate bands are dimmed so neighbours never blend together. Bands are evenly spaced on the same log scale as the ramp — linear ones would put a whole figure's interior in a single stripe and spend the rest on open background. 0 = smooth ramp.
   - **Edits** — draw the edits the app remembers and replays after every re-flat: draw-merge strokes (green), deleted-fill markers (red ✖) and group lassos (yellow). Pick them with the marquee tool.
   - **Ridges** — outline the watershed lines between fills, the creases the sheet folds along. **White** where the ridge sits on ink: the artist drew that boundary. **Cyan** where it crosses blank paper: nothing is drawn there and the fills still don't mix, so every cyan dash is a gap that got closed for you. Works with or without the rubber sheet, so it's also the quickest way to see where the ordinary pipeline is holding a fill together.
5. **Gaps**: suggestions appear right after flatting (and via **Suggest Gaps**) — orange/white segments anchored where region collisions squeeze through actual line breaks, direction-checked against the stroke flow field. **Tab / Shift-Tab** cycles through them (view jumps to each), **Enter** or a click bridges the focused one, **Accept All Gaps** takes everything. Bridges are invisible barriers — they constrain fills but are never exported. The pencil draws them by hand; the eraser removes them.
6. **Tools** (drawn as 16x16 pixel icons, one bitmap each — see [icons.ts](src/ui/icons.ts)): **trash** delete fill (X): click a fill to remove it — it stops rendering and is left out of the PSD (⌘Z restores) · **lasso** group fills (R): lasso *around* a set of fills, or drag a stroke *through* them; they export as a named PSD folder. **Both survive re-flatting** — a group is remembered as the shape you drew, so membership is recomputed against the new fills each time. · **hand** pan (Space) · **bucket** fill/recolor (click a fill = recolor with current color, or a random color if **Random** is checked; click background = carve a new fill; Alt-click = pick color) · **brush** recolor (C): recolor only, never carves — Shift-click takes every fill sharing that color (see 3b) · **two panes** merge two regions (click one, then click the target it merges into; a rubber band follows the cursor, and Esc, right-click or a click off the canvas cancels) · **magnet** draw merge (D): stroke from a fill and everything the stroke crosses merges into it. **Both merges survive re-flatting**, remembered as the points you clicked or the stroke you drew rather than as the region ids they hit · **polygon** shape fill (F): draw a closed shape and it becomes a fill in the current color, on top of whatever was under it — for the areas the segmenter cannot see, and it survives re-flatting like the other edits · **marquee** select edits (S): click a remembered edit or drag a box around several, Shift-click to add, **Delete** to remove them (Esc clears). Removing a ✖ marker un-deletes that fill and removing a lasso ungroups on the spot; removing a merge (either kind) needs a Re-Flat to take effect, because the two fills it joined no longer have a boundary to restore. ⌘Z undo.
7. **Export PSD** — white background at the bottom, fills in the middle, line art on top. The dropdown next to the button picks how fills become layers:
   - **one layer per color** — all the fills sharing a color land on a single layer. The usual flatting deliverable; combine with the **Colors** slider (or just recolor by hand first).
   - **one layer per fill** — every fill stays independently editable, but they're nested in a group folder per color, so Photoshop shows a handful of folders instead of hundreds of loose layers.
   - **single flat layer** — everything merged onto one layer.

   Hidden fills are kept as hidden layers in per-fill mode, and left out entirely in the merged modes (where you couldn't turn them back on). Above the per-fill layers sits **Flats (merged)** — every fill on one layer with the background left out, transparent behind the figure, which is the layer you actually paint on once the flatting is right. Layers come out in the order the panel shows them.

   **Watercolor** replaces the flat colour with a wash. Each layer is still its own fill, so a single region can be restyled in Photoshop, and it's generated rather than painted over — the same drawing always exports the same painting, and previews the same one.

   It's a simulation, not a filter. The first version multiplied each fill by three noise fields — a distance-based rim, grain, blotches — and looked like exactly that: flat colour with something laid over it. The rim gave it away, because pigment doesn't gather at a constant distance from an outline. It gathers where the water stopped.

   So this runs the water. What darkens an edge is **drying**: water leaves fastest at the rim, the pigment already stranded there pins the edge in place, and water flows outward to replace what evaporated — leaving its pigment behind when it goes. That's the coffee-ring effect (Deegan et al., *Nature* 389, 1997), and it's the same mechanism in a coffee cup and in a wash. A shallow-water height field evaporates, flow follows the gradient of a potential solved from the evaporation, pigment rides along, and whatever a cell is still holding dries where it stands. The dark irregular rim, the pale swept centre, granulation settling into the tooth of the paper, the hard line where a patch dried early — none of those are drawn. They fall out, which is the whole reason to run one.

   **⋯** next to the checkbox opens the settings: **Wetness** (how long the water runs), **Edge** (the excess evaporation at the rim, which is what pulls the flow outward), **Granulation** (how much the paper steers the water and holds the pigment) and **Bloom** (how unevenly the brush was loaded, which decides where the backruns land). Plus a **Preview on canvas** switch for when you want the wash in the file but the flats on screen.

   The numbers follow the slider and the wash follows a moment after it stops — a re-run is a few hundred milliseconds, so running it on every input event would just queue the drag up behind itself. Two things keep it that cheap. The flow is simulated at 256px on the long side and scaled up, because the structures that matter are large and it's the paper tooth that's fine — that goes on at full resolution afterwards. And the whole thing depends only on the *shape* of the fills, so it's computed once and cached: a fill's colour enters at the very end, through a 256-entry table, and recolouring under a wash is as fast as without one.

   That table is Beer-Lambert rather than a multiply: at density 1 you get exactly the colour you picked, and above it the *same pigment absorbing more light*, so pooling darkens and saturates together. A multiply just slides everything toward grey, and that grey rim was most of why the first attempt looked like mud.

   A wash costs a full-size textured image per layer, so a drawing with three hundred fills makes a PSD that may not open. Past **Max layers** in that panel (default 30) you get the count and a choice: it warns, it doesn't clamp. If you want the wash on a busy drawing, switch to *one layer per color* first — that's the same painting at a tenth of the layers.

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

## Tablet / touch

Touch is navigation only — one finger pans, and two fingers pinch to zoom and
twist to rotate at the same time — and it never activates a tool. A finger is too imprecise to place a barrier or pick a region,
and a stray palm would otherwise draw. Use a pen (which arrives as a separate
pointer type) or a mouse for the tools; both behave exactly as they always did.

The layout tracks the window: the control bar wraps to as many rows as it needs
and scrolls past a third of the height rather than squeezing the canvas, the
layers panel scales with the viewport, and heights use dvh so nothing hides
behind Safari's chrome. Rotation is view-only — it never touches the image or
the export — and Fit resets it.

## Credits

Tool icons are pixel-art sets, used as drawn:

- [Pixelarticons](https://pixelarticons.com) by halfmage — MIT — the hand,
  pencil, overlapping squares, bin, chain, shapes, swatch and marquee.
- [Streamline Pixel](https://icon-sets.iconify.design/streamline-pixel/) by
  Streamline — [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — the
  paint can, the rubber and the magnet, which Pixelarticons does not draw.

They sit on different grids (24 and 32), so each icon keeps its own viewBox and
the browser scales whole pixels rather than one set being resampled onto the
other's grid.
