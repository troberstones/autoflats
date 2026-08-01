# Roominess Fields for Flat Colouring of Line Art

**A draft technical paper, with an honest novelty assessment (see §9).**

---

## Abstract

Flat colouring — partitioning a hand-drawn line drawing into the regions an
artist would fill with solid colour — is the first and most tedious step of 2D
animation and comic production. The difficulty is not the partition itself but
the drawing: hand-drawn strokes have gaps, so any flood-based method leaks, and
the standard remedy (the trapped ball) trades leaks for fragmentation, needing
a radius, a minimum area, a sliver width and a texture-suppression heuristic to
be tuned per drawing.

We replace the radius ladder with a single scalar field. Pinning a membrane to
zero wherever there is ink and letting a uniform load push it down gives the
solution of a Poisson problem whose value at a point measures how much *room*
surrounds it. Room is quadratic in width, so a drawn area becomes a deep basin
while a break in a stroke becomes a shallow col between two basins. Segmenting
by the topology of this field — a watershed whose basins merge by topological
persistence — makes gap tolerance a consequence of geometry rather than a
parameter, and collapses four tuning knobs into one, expressed in pixels.

On seven production-style drawings the method reduces fill count by 2.5–4×
relative to a tuned trapped-ball pipeline (615→153 on the raw comparison) while
keeping the background a single region. We report the failure modes honestly,
including one we have characterised but not fixed.

---

## 1. Introduction

A flatting pass takes a line drawing and produces one solid-colour region per
area the colourist will later shade: each eye, each glove, each panel of
clothing, the background. In production these become separate layers, so the
requirement is not a plausible-looking segmentation but a *specific* one, and
errors are expensive in both directions — a leak merges two areas that must be
separately paintable, and over-segmentation buries the colourist in fragments.

The obstacle is that hand-drawn line work is not closed. Strokes overshoot,
undershoot, and break, and a break of two or three pixels is invisible at
working zoom but sufficient for a flood fill to pour an entire figure into the
background. Every practical system therefore needs a notion of "close enough to
count as closed", and the dominant one is the **trapped ball** [Zhang et al.
2009]: a disc of radius *r* cannot pass through a gap narrower than 2*r*, so
filling with a disc rather than a point tolerates gaps up to that width.

The trapped ball works, and we use it as our baseline, but it has a structural
cost. A single radius cannot both bridge the gaps in a silhouette and resolve
an eyelash, so implementations sweep radii from large to small; and because the
result is driven by flood order rather than by shape, it fragments busy regions
and needs a stack of cleanup stages afterwards — minimum-area absorption,
sliver merging, hatching suppression — each with its own threshold. In our own
implementation four sliders (gap radius, minimum region, sliver width,
declutter strength) all had to be retuned per drawing, and they interact.

We observe that all four are asking one question — *is this space a place, or
is it the gap between places?* — and that a single field answers it.

**Contributions.** (i) A formulation of flat-colouring gap tolerance as the
topology of the Poisson "torsion" field of the free space, calibrated so that
its value is in pixels and one threshold, in pixels, replaces four heuristic
parameters. (ii) Two decision rules that make the topology usable on real
drawings: an *ink-justification* test that keeps a watershed wall only where
the drawing supports one, and a *frame* rule that distinguishes open paper from
enclosed areas. (iii) A robust multigrid solver for the field on masks whose
thin channels do not survive coarsening. (iv) An honest evaluation, including a
characterised unfixed failure.

---

## 2. Related work

**Flat colouring and region extraction.** Trapped-ball segmentation was
introduced for cartoon vectorisation [Zhang et al. 2009] and remains the
standard region extractor for line art. LazyBrush [Sýkora et al. 2009] takes a
different route, treating flatting as a graph-cut labelling driven by coarse
user scribbles, which tolerates gaps by paying a boundary cost proportional to
ink; it is interactive by design, where we target an unattended first pass.
Fourey et al. [2018] give a fast semi-guided flat-colouring algorithm with an
explicit gap-closing step, shipped in G'MIC and widely used by practitioners.
Learning-based colourisation [Simo-Serra et al. 2016; Sasaki et al. 2017; Zhang
et al. 2018] addresses cleanup, gap inpainting and colour prediction with
CNNs; Sasaki et al. in particular detect and inpaint gaps directly. Our method
is classical and deterministic, which matters for a tool whose output is
hand-edited afterwards: the same drawing and the same sliders always give the
same regions.

**The Poisson field as a shape descriptor.** Solving `-∇²u = 1` with `u = 0` on
the boundary — the *torsion function* of the domain — as a shape representation
is due to Gorelick et al. [2004; 2006], who showed that it is smooth, robust to
boundary noise, and that its level sets and gradients yield part decomposition,
skeletons and local orientation. The mathematical properties we rely on are
older: for a convex planar domain, `√u` is concave [Makar-Limanov 1971], hence
`√u` has a single maximum; and `max u` scales with the square of the inradius.
**Our field is exactly this descriptor.** What we add is its use as a *gap
metric* for flat colouring, and the calibration `sag = √(8u)` that puts it in
pixel units (a channel of width *w* reads *w*; a disc of radius *R* reads
1.41*R*), which is what allows a single threshold in pixels to replace the four
heuristics.

**Watershed and hierarchical merging.** Watershed segmentation [Vincent and
Soille 1991] over-segments in proportion to the number of local extrema. The
standard cure is to merge basins by a saliency measure: *dynamics* [Grimaud
1992], geodesic saliency [Najman and Schmitt 1996], and the waterfall
[Beucher 1994]. Dynamics is exactly 0-dimensional topological persistence
[Edelsbrunner et al. 2002] and the same idea underlies persistence-based
clustering [Chazal et al. 2013]. **Our merge rule is dynamics.** The
contribution is not the rule but that persistence on *this* field has physical
units — a basin's persistence is how many pixels of width the area has that its
opening does not — so the threshold is meaningful rather than tuned.

**Contour completion.** For the gap closures we reuse established grouping
theory: relatability [Kellman and Shipley 1991] as the admissibility test for
joining two stroke tips, Euler elastica [Mumford 1994] to rank and shape the
join, and stochastic completion fields [Williams and Jacobs 1997] as an
optional high-precision alternative scorer.

**Numerics.** The field is solved with geometric multigrid [Brandt 1977;
Briggs et al. 2000]. Distance transforms use the chamfer method [Borgefors
1986] and thinning uses Zhang–Suen [1984].

> *Citation details in this draft are from memory and should be verified
> against the published records before submission.*

---

## 3. The roominess field

### 3.1 Formulation

Let `Ω ⊂ ℤ²` be the free space of the drawing — pixels not covered by ink —
and let the image frame be treated as ink. Solve

```
    -∇²u = 1   on Ω,        u = 0   on ∂Ω (ink and frame)
```

and report

```
    sag(p) = √(8 u(p)).
```

The physical reading is a membrane pinned wherever the artist put ink, sagging
under a uniform load. The constant 8 calibrates the field: for an infinite
channel of width *w* the solution is a parabola with `max u = w²/8`, so
`sag = w` exactly; for a disc of radius *R*, `max u = R²/4`, so
`sag = √2 · R`. Values are therefore in pixels and directly comparable to a
stroke width or a gap width.

### 3.2 Why not a distance transform

The distance transform is the obvious "how much room is here" field and it is
the wrong one. It is only C⁰, and its ridge set is the full medial axis, so
every bump on a silhouette spawns its own ridge and a limb shatters into one
basin per bump. The torsion field is smooth, and on a convex region `√u` is
concave [Makar-Limanov 1971] — exactly one maximum, no spurious ridges.

The decisive property for our purpose is the *quadratic* one. Room grows with
the square of width, so the contrast between a place and a passage is squared
too. A 40px-wide area next to a 6px break does not read as "40 versus 6" but as
a deep basin beside a shallow notch, and that margin is what lets one threshold
separate them across drawings whose scales differ.

### 3.3 Solver

We use a geometric multigrid V-cycle: red-black Gauss–Seidel smoothing (6
sweeps each side), full-weighting restriction, bilinear prolongation, and a
mask that is coarsened conservatively — a coarse cell is free only if *all* of
its children are, so ink thickens as we coarsen, which is the safe direction.

Textbook multigrid **diverges** on this problem. On real line art we measured
the maximum sag growing from ~200px to 855,010px by cycle 20, while the same
solver converged on synthetic discs and channels. The cause is the conservative
coarsening: a thin channel closes on the coarse grid, so the coarse operator
is not a coarse version of the fine problem and the correction it returns is
not merely inaccurate but wrong in sign along those channels.

The fix is to line-search the coarse correction. Given the prolonged correction
`e` and the fine residual `r`, we apply `u ← u + αe` with

```
    α = ⟨r, e⟩ / ⟨e, Ae⟩,
```

the step that minimises the **A-norm of the error**. Two details matter and
both cost a day if you get them wrong:

1. Minimising the *residual* 2-norm instead stalls at `α ≈ 0.08`. A coarse
   correction is supposed to *raise* the residual — post-smoothing removes it —
   so the residual norm is not the quantity being improved.
2. The prolonged correction must be allowed to taper where the coarse grid has
   nothing to say. Zeroing `e` under pinned coarse cells puts cliffs in it, and
   the line search then measures the cliffs rather than the correction.

With the line search the solver converges monotonically on every test drawing.
We fixed the divergence case as a regression test by storing the run-length
encoded mask of the one image that reproduces it (§7).

---

## 4. Segmentation

### 4.1 Persistence watershed

Quantise `sag` to 1/8 px, seed a basin at every local maximum (plateau-aware),
and flood in descending order using bucketed priority — the field is quantised,
so this is a linear-time watershed, not a heap. When two basins meet at a
contact of height *c*, merge them if

```
    persistence = min(peak_a, peak_b) − c   <   τ      (or < 0.3 · min peak)
```

Persistence is in pixels: it is the width the area has that its opening does
not. The relative term absorbs hatching and texture for free — a pocket between
two hatch strokes peaks a few px up and meets its neighbour nearly as high, so
its persistence is near zero.

**This single test does the work of gap radius, minimum region, sliver width
and declutter**, which is the practical claim of the paper.

### 4.2 Ink justification

Persistence alone will keep a wall in the middle of open paper wherever the
background happens to have a waist. We therefore test whether the drawing
supports a boundary: walk the ridge from the contact point in both directions
and require it to reach ink on both sides within a budget of `2·maxGap + 4`
pixels. A broken silhouette keeps its boundary — beating the trapped ball,
which would have leaked — while the seam between two lobes of open background
does not.

### 4.3 The frame rule

The membrane is pinned at the image frame exactly as it is on ink, which makes
"does this basin reach the frame?" a free signal. A basin that runs off the
edge is open paper; one that never does is enclosed by the drawing.

This matters because a drawn area meets the background through a *neck*, not
through a stroke gap. Two basins that both reach the frame merge at the plain
width allowance (`2·maxGap`); an enclosed basin gets 3× that. Without the
distinction, fingers opening onto the background through a 21px neck were
absorbed whole at an allowance of 16px.

We evaluated and rejected two alternatives. Raising the allowance globally
splits the sky into 3–8 pieces. A size guard (refuse to absorb a basin above
some fraction of the image) has no viable threshold: on our samples the smaller
side of a *correct* background merge is 5.5% of the image, while the incorrect
hair-into-background merges are 0.09–0.73% — the two populations do not
separate.

### 4.4 Pre-closing tight gaps (optional)

The watershed places a boundary on a **crest**, not across an opening. Where a
silhouette is broken, the crest runs inward along the shape's axis rather than
over the break, which both puts the wall in the wrong place and leaves the
area's basin merged with whatever floods in.

We therefore optionally seal unambiguous breaks *before* solving. Two open
stroke tips are joined when they are within `2·maxGap + 4` of each other, face
each other inside a 45° cone with ≤60° total bend [Kellman and Shipley 1991],
and have blank paper between them; candidates are ordered by elastica energy
[Mumford 1994] and one closure is allowed per tip. Closures are rasterised into
the segmentation mask only — never into the ink — so fills still expand across
them and the exported drawing is unchanged.

Two implementation details proved essential. First, tips are *skeleton* points,
sitting half a stroke deep in their own ink, so a chord between them always
begins and ends inked; a fixed 2px skip works only on hairlines, and on
6–12px strokes it rejected 4 of 7 genuine gaps as "already joined". Skipping
each end's own ink *run* instead is correct regardless of stroke width and end
geometry. Second, the usual spur filter (discard a tip whose skeleton forks
within a few steps) deletes one tip of a real gap, because the far side of the
break forks the skeleton right behind the tip; on our test image it left only
one tip on four of eight gaps.

### 4.5 Manual barriers

User-drawn gap closures are pinned into the membrane exactly like ink, so their
width is not free: every pixel of width is a pixel of roominess taken from the
areas either side. We rasterise them one pixel wide, 8-connected, which is
sufficient because the trapped ball steps 4-connected and the sag flood, though
8-connected, refuses a diagonal step when both orthogonal cells are ink —
exactly the staircase a Bresenham line presents.

---

## 5. Results

Seven drawings: five clean line arts, one rough with a coloured underdrawing,
one crop. All comparisons are against our own trapped-ball pipeline with its
four parameters tuned per image.

**Fill count** (fewer, more coherent fills is the goal). Raw segmenter output,
no cleanup stages on either side: 615→153, 396→129, 530→132. With each
pipeline's full cleanup: 455→147, 264→123, 198→77, 419→123, 275→140, 105→46.

**Area lost to the background** — pixels the trapped ball fills that the sag
method calls background, i.e. figures being swallowed. Before and after the
frame rule of §4.3, with the background remaining exactly one region in every
case:

| Drawing | before | after |
|---|---|---|
| Lineart1 | 2.61% | 0.89% |
| Lineart2 | 1.57% | 0.26% |
| Lineart3 | 5.27% | 0.67% |
| Lineart4 | 2.37% | 1.71% |
| Lineart4_crop | 1.93% | 0.58% |
| Lineart5 | 0.43% | 0.40% |
| Lineart6 | 0.19% | 0.19% |

**Parameter collapse.** With the sheet enabled, sliver width moves the result by
0–2 fills, and automatic leak merging finds 0–1 leaks where it finds 7–30 in the
trapped-ball pipeline. Both are redundant, as predicted. Declutter is *not*
redundant (still worth up to 22 fills on busy drawings) and neither is the
completion-field option, which behaves identically in both modes; we report
this rather than claiming a cleaner result than we measured.

**Parameter sensitivity.** On a case where a horn fails to segment, we swept
line threshold × gap size × τ. The horn's fate is decided by threshold (survives
at ≤14%, lost at ≥16%) and τ (survives at ≤4px), while gap size is *inert*:
8→32 never flips it and changes the total fill count by ±1. This is structural —
in sag mode the gap slider only sets the width allowance and the ridge-walk
budget, and this basin's opening (10.4px) is already inside the allowance.

**Barrier width.** A 3px manual barrier costs the neighbouring basin ~0.9px of
peak sag regardless of the basin's size (7.62→6.72 on a 7px-wide half,
11.44→10.57 on an 11px, 19.08→18.23 on a 19px) — precisely the pixel it eats
on each side. Small absolutely; 12% of a narrow sliver, which is where hand
closures usually are.

**Tight closures.** On a synthetic test sheet of circles and horns with eight
deliberate breaks, the closure pass found 0 gaps before the two fixes of §4.4
and 3 after, including the one producing a visible notch.

**Cost.** About 3× a trapped-ball flat, CPU only; the field is cached, so only
re-segmentation pays it. The GPU path used by the trapped-ball pipeline is not
reachable in sag mode.

---

## 6. Limitations and failure modes

**Tapering shapes are invisible to the field.** A horn on one sample merged into
the background with persistence *exactly zero*. Measuring it explains why, and
the explanation is structural rather than numerical: the horn's peak sag
(18.28px) occurs at the very pixel where it opens onto the background — the
shape tapers monotonically inward from its own mouth, so it has no excess width
anywhere.

This is not a quantisation artefact and not a tuning failure. Flooding the
superlevel set `{sag ≥ t}` from the horn's peak reaches the background's peak at
*every* level from 18.28px down to 2px: the horn is never a connected component
of any superlevel set. It is therefore not a feature of the field's topology at
all, and **no attribute-based hierarchy can recover it** — not dynamics, not
area or volume extinction [Vachier and Meyer 1995], not persistent homology of
the superlevel filtration. We tested this before implementing such a hierarchy,
and abandoned it on the evidence.

The recovery has to come from ink rather than from the field, which is what the
pre-closing pass of §4.4 provides: the horn's base is a genuine 8.1px stroke
break with tips on both sides, and closing it makes the horn an enclosed pocket
with a maximum of its own. It was being rejected by three degrees of bend (the
join needs 63°, the limit was 60°); at 70° the horn becomes an 889px fill and
the sample's swallowed area falls from 0.53% to 0.24%, with no sample losing
more than +2 fills and none splitting its background.

**The general limitation stands, however.** The torsion field measures width and
persistence measures *excess* width, so any shape attached to its neighbour at
its own widest point — horns, antennae, tails, tapered fingers — is invisible to
the field and depends entirely on ink evidence to be recovered. Where no tip
pair spans the opening, it will be lost.

**Crest placement.** Even when a gapped area is correctly separated, the wall
lands on the crest rather than across the opening (§4.4). The pre-closing pass
addresses the cases where two tips face each other; where they do not — a break
against a curve, a T-junction — the wall still cuts inward.

**No external baseline.** We compare against our own trapped-ball implementation
only. We have not compared against LazyBrush, Fourey et al., or any learned
method, and we have run no user study. Fill count and swallowed area are
proxies for colourist effort, not measurements of it.

**Scale.** Seven drawings from one production style.

---

## 7. Implementation

Browser application: TypeScript, no framework, `ag-psd` as the only runtime
dependency, segmentation in a Web Worker, layered PSD export. The invariant test
suite (19 tests) asserts structural properties rather than numbers — every pixel
has a label, the core is empty on ink, region areas tile the free space, ids are
compact, something is background — after a GPU buffer-usage bug silently
produced a zero label map that still reported a plausible fill count. The
multigrid divergence case is pinned by a stored RLE mask, because no synthetic
input and no crop of the real one reproduces it.

---

## 8. Conclusion

Treating the free space of a drawing as a loaded membrane turns gap tolerance
from a parameter into a geometric consequence, and collapses four tuning knobs
into one threshold expressed in pixels. The remaining errors are, encouragingly,
*placement* errors rather than *membership* errors: the method increasingly
knows which areas exist, and gets the exact line between them wrong.

---

## 9. Novelty assessment — read this first

**The approach is not novel enough to stand as a SIGGRAPH paper.** Specifically:

- **The field is not new.** `-∇²u = 1, u|∂Ω = 0` as a shape descriptor is
  Gorelick et al. [2004, 2006], including the observations that it is smooth,
  noise-robust, and encodes part structure. Anyone who knows that paper will
  recognise the rubber sheet immediately.
- **The merge rule is not new.** Merging watershed basins by persistence is
  Grimaud's dynamics [1992], re-derived many times since; the topological
  framing is Edelsbrunner et al. [2002].
- **The task is not new**, and it has both a strong classical baseline [Zhang et
  al. 2009; Sýkora et al. 2009; Fourey et al. 2018] and an active learned line
  of work [Sasaki et al. 2017; Zhang et al. 2018] that we do not compare
  against.
- **The contour-completion machinery is entirely borrowed** [Kellman and
  Shipley 1991; Williams and Jacobs 1997; Mumford 1994].

What is genuinely ours is the *combination and calibration*: applying the
torsion field to flatting, scaling it to pixels so persistence has units, the
frame/enclosure asymmetry, the ink-justification test, and the multigrid line
search that makes the solve survive coarsening-hostile masks. That is a real
engineering contribution and the parameter-collapse result is a genuine
usability claim — but reviewers would read it as "known descriptor + known
merge rule applied to a known task", and the evaluation (7 images, no external
baseline, no user study) would not carry it.

**Realistic options.**

1. **Technical brief / short paper** (SIGGRAPH Technical Briefs, NPAR /
   Expressive, GI). The parameter-collapse claim is well-suited: one threshold
   in pixels replacing four heuristics, with the ablations we already have.
2. **Make the evaluation the contribution.** Compare against LazyBrush, Fourey
   et al., and a learned baseline on a public set, and run a colourist study
   measuring *time to a usable flat*, not fill counts. If the sheet wins on
   human time, that is publishable regardless of component novelty.
3. ~~**Push the theory.**~~ *Tested and withdrawn.* An earlier draft argued that
   the zero-persistence failure meant the quantised watershed was the wrong
   discretisation, and that a Morse–Smale / persistent-homology treatment would
   fix it. Measurement (§6) refutes this: the shape is not a feature of the
   field's topology at any level, so no reformulation of the hierarchy — however
   principled — can produce it. The honest statement is the one now in §6: the
   field has a structural blind spot for tapering shapes, and ink-based closure
   is the only recovery. Stating a limitation precisely is worth more here than
   dressing it up as future work.

My recommendation is (1) now, and (2) if you want a full paper.

---

## References

- Beucher, S. 1994. Watershed, hierarchical segmentation and waterfall
  algorithm. *ISMM*.
- Borgefors, G. 1986. Distance transformations in digital images. *CVGIP* 34(3).
- Brandt, A. 1977. Multi-level adaptive solutions to boundary-value problems.
  *Mathematics of Computation* 31.
- Briggs, W. L., Henson, V. E., McCormick, S. F. 2000. *A Multigrid Tutorial*,
  2nd ed. SIAM.
- Chazal, F., Guibas, L. J., Oudot, S. Y., Skraba, P. 2013. Persistence-based
  clustering in Riemannian manifolds. *JACM* 60(6).
- Edelsbrunner, H., Letscher, D., Zomorodian, A. 2002. Topological persistence
  and simplification. *Discrete & Computational Geometry* 28.
- Fourey, S., Tschumperlé, D., Revoy, D. 2018. A fast and efficient semi-guided
  algorithm for flat coloring line-arts. *VMV*.
- Gorelick, L., Galun, M., Sharon, E., Basri, R., Brandt, A. 2004/2006. Shape
  representation and classification using the Poisson equation. *CVPR* /
  *IEEE TPAMI* 28(12).
- Grimaud, M. 1992. A new measure of contrast: the dynamics. *SPIE Image
  Algebra and Morphological Image Processing III*.
- Kellman, P. J., Shipley, T. F. 1991. A theory of visual interpolation in
  object perception. *Cognitive Psychology* 23(2).
- Makar-Limanov, L. 1971. Solution of Dirichlet's problem for the equation
  Δu = −1 in a convex region. *Mathematical Notes* 9.
- Mumford, D. 1994. Elastica and computer vision. In *Algebraic Geometry and
  its Applications*.
- Najman, L., Schmitt, M. 1996. Geodesic saliency of watershed contours and
  hierarchical segmentation. *IEEE TPAMI* 18(12).
- Sasaki, K., Iizuka, S., Simo-Serra, E., Ishikawa, H. 2017. Joint gap detection
  and inpainting of line drawings. *CVPR*.
- Simo-Serra, E., Iizuka, S., Sasaki, K., Ishikawa, H. 2016. Learning to
  simplify: fully convolutional networks for rough sketch cleanup.
  *ACM TOG (SIGGRAPH)* 35(4).
- Sýkora, D., Dingliana, J., Collins, S. 2009. LazyBrush: flexible painting tool
  for hand-drawn cartoons. *Computer Graphics Forum (Eurographics)* 28(2).
- Vachier, C., Meyer, F. 1995. Extinction value: a new measurement of
  persistence. *IEEE Workshop on Nonlinear Signal and Image Processing*.
- Vincent, L., Soille, P. 1991. Watersheds in digital spaces: an efficient
  algorithm based on immersion simulations. *IEEE TPAMI* 13(6).
- Williams, L. R., Jacobs, D. W. 1997. Stochastic completion fields: a neural
  model of illusory contour shape and salience. *Neural Computation* 9(4).
- Zhang, L., Li, C., Wong, T.-T., Ji, Y., Liu, C. 2018. Two-stage sketch
  colorization. *ACM TOG (SIGGRAPH Asia)* 37(6).
- Zhang, S.-H., Chen, T., Zhang, Y.-F., Hu, S.-M., Martin, R. R. 2009.
  Vectorizing cartoon animations. *IEEE TVCG* 15(4).
- Zhang, T. Y., Suen, C. Y. 1984. A fast parallel algorithm for thinning digital
  patterns. *CACM* 27(3).
