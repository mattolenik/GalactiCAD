"""SFCC — Stratified Feature-Conforming Contouring, illustrated.

A 2D walkthrough of the meshing pipeline described in
docs/sfcc-meshing-algorithm.md, using a square-union-circle CSG scene.
Render:  manim -qm sfcc_illustration.py SFCC
"""

from pathlib import Path

from manim import *
import numpy as np

ASSETS = Path(__file__).parent / "assets"


def load_render(name, height=4.0):
    """Real gcad render if present, placeholder rect otherwise (pre-asset dev)."""
    p = ASSETS / name
    if p.exists():
        return ImageMobject(str(p)).scale_to_fit_height(height)
    ph = Rectangle(width=height * 0.85, height=height, color=GREY_D, stroke_width=2,
                   fill_color=GREY_E, fill_opacity=0.25)
    ph.add(Text(name, font_size=18, color=GREY_B))
    return ph

# ---------------------------------------------------------------- geometry
SQ_C = np.array([-0.8, 0.0])
SQ_H = 1.5
CI_C = np.array([1.5, 0.3])
CI_R = 1.6


def f_box(x, y):
    dx, dy = abs(x - SQ_C[0]) - SQ_H, abs(y - SQ_C[1]) - SQ_H
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    return np.hypot(ax, ay) + min(max(dx, dy), 0.0)


def f_circ(x, y):
    return np.hypot(x - CI_C[0], y - CI_C[1]) - CI_R


def f_union(x, y):
    return min(f_box(x, y), f_circ(x, y))


def P(x, y):
    return np.array([x, y, 0.0])


# seam points: circle crossing the square's carrier lines
SEAM_TOP = P(CI_C[0] - np.sqrt(CI_R**2 - (SQ_C[1] + SQ_H - CI_C[1]) ** 2), SQ_C[1] + SQ_H)
SEAM_RIGHT = P(SQ_C[0] + SQ_H, CI_C[1] - np.sqrt(CI_R**2 - (SQ_C[0] + SQ_H - CI_C[0]) ** 2))
# over-traced candidates that the CSG trim kills (on carrier extensions / hidden)
DEAD_TOP = P(CI_C[0] + np.sqrt(CI_R**2 - (SQ_C[1] + SQ_H - CI_C[1]) ** 2), SQ_C[1] + SQ_H)
DEAD_RIGHT = P(SQ_C[0] + SQ_H, CI_C[1] + np.sqrt(CI_R**2 - (SQ_C[0] + SQ_H - CI_C[0]) ** 2))

CORNER_TL = P(SQ_C[0] - SQ_H, SQ_C[1] + SQ_H)
CORNER_BL = P(SQ_C[0] - SQ_H, SQ_C[1] - SQ_H)
CORNER_BR = P(SQ_C[0] + SQ_H, SQ_C[1] - SQ_H)
CORNER_TR = P(SQ_C[0] + SQ_H, SQ_C[1] + SQ_H)  # swallowed by the circle

LIVE_FEATURES = [SEAM_TOP, SEAM_RIGHT, CORNER_TL, CORNER_BL, CORNER_BR]


def union_outline(n_arc=64):
    """Boundary polyline of box ∪ circle, CCW."""
    a1 = np.arctan2(SEAM_RIGHT[1] - CI_C[1], SEAM_RIGHT[0] - CI_C[0])  # ≈ -120°
    a2 = np.arctan2(SEAM_TOP[1] - CI_C[1], SEAM_TOP[0] - CI_C[0])  # ≈ +131°
    pts = [SEAM_TOP, CORNER_TL, CORNER_BL, CORNER_BR, SEAM_RIGHT]
    for t in np.linspace(a1, a2, n_arc)[1:]:
        pts.append(P(CI_C[0] + CI_R * np.cos(t), CI_C[1] + CI_R * np.sin(t)))
    return pts


def union_shape(**kw):
    m = Polygon(*union_outline(), **kw)
    return m


# ------------------------------------------------------------- quadtree
ROOT_C = np.array([0.4, 0.1])
ROOT_H = 3.6


def cell_crosses(cx, cy, h):
    vals = [f_union(cx + sx * h, cy + sy * h) for sx in (-1, -0.5, 0, 0.5, 1) for sy in (-1, -0.5, 0, 0.5, 1)]
    return min(vals) < 0.0 < max(vals) or min(abs(v) for v in vals) < 0.45 * h


def near_feature(cx, cy, h):
    return any(max(abs(p[0] - cx), abs(p[1] - cy)) < 1.55 * h for p in LIVE_FEATURES)


def quadtree_leaves(base_depth=3, feat_depth=5):
    leaves = []

    def rec(cx, cy, h, d):
        if not cell_crosses(cx, cy, h) and d >= 1:
            leaves.append((cx, cy, h, d, "empty"))
            return
        limit = feat_depth if near_feature(cx, cy, h) else base_depth
        if d >= limit:
            kind = "feat" if (cell_crosses(cx, cy, h) and near_feature(cx, cy, h * 0.9)) else (
                "surf" if cell_crosses(cx, cy, h) else "empty")
            leaves.append((cx, cy, h, d, kind))
            return
        q = h / 2
        for sx in (-1, 1):
            for sy in (-1, 1):
                rec(cx + sx * q, cy + sy * q, q, d + 1)

    rec(ROOT_C[0], ROOT_C[1], ROOT_H, 0)
    return leaves


def cell_square(cx, cy, h, **kw):
    return Square(side_length=2 * h, **kw).move_to(P(cx, cy))


# --------------------------------------------- ch1d: torture-test slides
# (asset base name, caption lines) — captions carry each scene's operator
# inventory and export stats, filled from the actual export runs.
TORTURE = [
    ("torture_bracket", [
        "part 1 — a bracket: 3-way rounded union, a chamfer-blended",
        "200° twisted rib, a domed hard intersect, 7 hard subtracts —",
        "71,210 triangles, manifold-clean, 0 failed cells"]),
    ("torture_knob", [
        "part 2 — a knob: lathe body ∪ 220°-twisted star fins (rounded),",
        "hard envelope intersect, chamfer-blended ring groove, hard hex",
        "socket, smooth-intersect crown — 125,382 triangles, manifold-clean"]),
    ("torture_housing", [
        "part 3 — a housing: rounded cylinder tee, a square→12-gon loft",
        "flange, chamfered cone port, 8 hard subtracts hollowing it out —",
        "98,020 triangles, manifold-clean, 0 failed cells"]),
    ("torture_mess1", [
        "mess 1 — 11 primitives, every blend mode in the book: round,",
        "chamfer, stairs, columns unions + subtracts, a 270° twisted star,",
        "a hard sphere trim — 134,330 triangles, still manifold-clean"]),
    ("torture_mess2", [
        "mess 2 — 10 primitives: lathe vase, stairs/chamfer/round blends,",
        "cone spike, hard trim, a 400°-twisted ribbon slapped on last —",
        "111,636 triangles, manifold-clean, 0 failed cells"]),
]

# ---------------------------------------------------------------- scene
CAP_KW = dict(font_size=26, color=GREY_A)
HEAD_KW = dict(font_size=34, weight=BOLD)


class SFCC(Scene):
    def caption(self, *lines, pos=DOWN * 3.2, **kw):
        opts = {**CAP_KW, **kw}
        grp = VGroup(*[Text(t, **opts) for t in lines]).arrange(DOWN, buff=0.12).move_to(pos)
        if grp.width > 13.4:
            grp.scale_to_fit_width(13.4)
        if grp.get_bottom()[1] < -3.82:
            grp.shift(UP * (-3.82 - grp.get_bottom()[1]))
        return grp

    def set_header(self, text):
        new = Text(text, **HEAD_KW).to_edge(UP, buff=0.3)
        if getattr(self, "_header", None) is not None:
            self.play(ReplacementTransform(self._header, new), run_time=0.6)
        else:
            self.play(FadeIn(new, shift=DOWN * 0.2), run_time=0.6)
        self._header = new

    def swap_caption(self, new, old=None, rt=0.5):
        anims = [FadeIn(new)]
        if old is not None:
            anims.append(FadeOut(old))
        self.play(*anims, run_time=rt)
        return new

    def construct(self):
        self._header = None
        self.ch1_title()
        self.ch1a_sdf_cad()
        self.ch1b_problem()
        self.ch1b2_narrow()
        self.ch1c_feature_aware()
        self.ch1d_torture()
        self.ch2_input()
        self.ch3_features()
        self.ch3b_featureset()
        self.ch3c_blends()
        self.ch4_octree()
        self.ch5_contour()
        self.ch5b_provenance()
        self.ch6_mesh()
        self.ch7_audits()

    # ---------------------------------------------------------- chapter 1
    def ch1_title(self):
        t1 = Text("SFCC", font_size=96, weight=BOLD, color=BLUE_B)
        t2 = Text("Stratified Feature-Conforming Contouring", font_size=40)
        t3 = Text("implicit CSG scene  →  certified, feature-exact mesh",
                  font_size=28, color=GREY_A)
        grp = VGroup(t1, t2, t3).arrange(DOWN, buff=0.4)
        self.play(FadeIn(t1, scale=1.2), run_time=1.0)
        self.play(Write(t2), run_time=1.2)
        self.play(FadeIn(t3, shift=UP * 0.2), run_time=0.8)
        self.wait(2.6)

        stages = ["Scene JSON", "S1 features", "S2 octree", "S3 contour + mesh", "S4 audits"]
        chips = VGroup()
        for s in stages:
            txt = Text(s, font_size=22)
            box = SurroundingRectangle(txt, corner_radius=0.12, buff=0.18,
                                       color=BLUE_D, stroke_width=2)
            chips.add(VGroup(box, txt))
        arrows = VGroup()
        chips.arrange(RIGHT, buff=0.55)
        for a, b in zip(chips[:-1], chips[1:]):
            arrows.add(Arrow(a.get_right(), b.get_left(), buff=0.06,
                             stroke_width=3, max_tip_length_to_length_ratio=0.4, color=GREY_B))
        pipeline = VGroup(chips, arrows).move_to(DOWN * 2.6).scale_to_fit_width(12.5)
        self.play(grp.animate.shift(UP * 0.8), run_time=0.5)
        self.play(LaggedStart(*[FadeIn(c, shift=RIGHT * 0.2) for c in chips],
                              *[GrowArrow(a) for a in arrows], lag_ratio=0.1), run_time=1.6)
        self.wait(3.2)
        self.play(FadeOut(grp), FadeOut(pipeline), run_time=0.7)

    # ---------------------------------------------------------- chapter 1a
    def ch1a_sdf_cad(self):
        self.set_header("CAD with signed distance fields")
        img = load_render("box_crop.png", 4.6).move_to(P(-3.5, 0.55))
        cap = self.caption("a solid modeled as one function:  f(p) = signed distance to the",
                           "surface — negative inside, zero on the surface, positive outside")
        self.play(FadeIn(img), FadeIn(cap), run_time=1.0)
        self.wait(4.0)

        code = make_card("sdf_box — the entire representation", BLUE_B, [
            "fn sdf_box(p, b):",
            "  q = abs(p) − b",
            "  return length(max(q, 0)) + min(max(q.x, q.y, q.z), 0)",
            "ask it about any point p and it answers —",
            "that is the whole interface",
        ], width=7.0).move_to(P(3.2, 0.7))
        self.play(FadeIn(code, shift=RIGHT * 0.3), run_time=0.8)
        self.wait(4.6)

        kick = make_card("but where are the vertices?", RED_B, [
            "this box has 8 corners at exact x, y, z locations",
            "f_box never states them: no vertex list, no edge list,",
            "no face list exists anywhere in the model",
            "the field can confirm a point lies ON the surface —",
            "it can never tell you where the corners ARE",
        ], width=7.0).move_to(P(3.2, 0.7))
        qmarks = VGroup(*[Text("?", font_size=34, weight=BOLD, color=YELLOW).move_to(m)
                          for m in [img.get_top() + DOWN * 0.02,
                                    img.get_bottom() + UP * 0.02,
                                    np.array([img.get_right()[0] - 0.06,
                                              img.get_top()[1] - 0.75 * img.height, 0])]])
        cap2 = self.caption("an SDF tells you that a surface is there —",
                            "never where its features are")
        self.play(FadeOut(code), FadeIn(kick, shift=RIGHT * 0.3),
                  FadeOut(cap), FadeIn(cap2), run_time=0.7)
        self.play(LaggedStart(*[FadeIn(q, scale=1.6) for q in qmarks], lag_ratio=0.25),
                  run_time=1.0)
        self.wait(5.2)

        mesh_s = load_render("box_mesh_solid_crop.png", 3.6).move_to(P(-0.55, 0.55))
        mesh_w = load_render("box_mesh_crop.png", 3.6).move_to(P(2.9, 0.55))
        ml1 = Text("solid", font_size=20, color=GREY_A).next_to(mesh_s, DOWN, buff=0.15)
        ml2 = Text("wireframe", font_size=20, color=GREY_A).next_to(mesh_w, DOWN, buff=0.15)
        arr = Arrow(P(-3.1, 0.55), P(-2.45, 0.55), color=GREY_B, stroke_width=4,
                    max_tip_length_to_length_ratio=0.35)
        alab = Text("SFCC", font_size=22, weight=BOLD, color=RED_B)\
            .next_to(arr, UP, buff=0.15)
        cap3 = self.caption("this video: SFCC closes that gap — here is the mesh it actually",
                            "exports from that field: every corner and edge is a known, exact",
                            "vertex, not a reconstruction; the rest is how")
        self.play(FadeOut(kick), FadeOut(qmarks), FadeOut(cap2),
                  img.animate.scale_to_fit_height(3.6).move_to(P(-4.9, 0.55)),
                  run_time=0.8)
        self.play(FadeIn(mesh_s), FadeIn(mesh_w), FadeIn(ml1), FadeIn(ml2),
                  GrowArrow(arr), FadeIn(alab), FadeIn(cap3), run_time=1.0)
        self.wait(6.0)
        self.play(FadeOut(Group(img, mesh_s, mesh_w, ml1, ml2, arr, alab)),
                  FadeOut(cap3), run_time=0.7)

    # ---------------------------------------------------------- chapter 1b
    def ch1b_problem(self):
        self.set_header("Meshing it: sampled extraction (marching cubes, DC, MDC)")
        C = np.array([-0.2, 0.15, 0.0])
        half = 2.1
        K = C + np.array([0.25, -0.35, 0.0])
        n1, n2 = wedge_normals()

        def fw(x, y):
            return wedge_f(x, y, K, n1, n2)

        panel = Square(side_length=2 * half, color=GREY_B, stroke_width=2.5).move_to(C)
        A = ray_to_box(K, (-1.0, 0.5), C, half)
        B = ray_to_box(K, (0.95, 0.62), C, half)
        bnd = VMobject(color=WHITE, stroke_width=4).set_points_as_corners([A, K, B])
        cap = self.caption("a CAD solid is an implicit surface — the zero set of f(p) —",
                           "with perfectly sharp creases where its faces meet")
        self.play(FadeIn(cap), Create(panel), Create(bnd), run_time=1.2)
        self.wait(3.6)

        cap2 = self.caption("a sampled extractor (marching cubes & friends) only sees f at",
                            "lattice points: each cell joins its edge crossings with a chord —",
                            "and the chord always cuts the corner")
        self.swap_caption(cap2, cap)
        st = ms_stage(fw, C, half, 1, K)
        self.play(Create(st[1]), FadeIn(st[2]), run_time=1.0)
        self.wait(4.4)

        cap3 = self.caption("refining shrinks the error, but the crease never appears —",
                            "the mesh is chamfered at every resolution")
        self.swap_caption(cap3, cap2)
        for n in (2, 4):
            st2 = ms_stage(fw, C, half, n, K)
            self.play(ReplacementTransform(st, st2), run_time=1.1)
            self.wait(1.1)
            st = st2
        self.wait(3.4)

        # dual contouring's answer, and its fragility
        step = 2 * half / 4
        i = int((K[0] - (C[0] - half)) / step)
        j = int((K[1] - (C[1] - half)) / step)
        x0, y0 = C[0] - half + i * step, C[1] - half + j * step
        crs = cell_ms_crossings(fw, x0, y0, step)
        hl = Square(side_length=step, color=WHITE, stroke_width=3.5)\
            .move_to(P(x0 + step / 2, y0 + step / 2))
        arrows = VGroup()
        for p in crs:
            nrm = n1 if p[0] < K[0] else n2
            arrows.add(Arrow(p, p + 0.75 * nrm, buff=0, stroke_width=3.5,
                             max_tip_length_to_length_ratio=0.3, color=GREEN_B))
        cap4 = self.caption("dual contouring (DC / MDC): estimate normals at the crossings,",
                            "detect the crease, place a QEF-minimizing vertex — the edge is",
                            "reconstructed from samples every time, never known")
        self.swap_caption(cap4, cap3)
        self.play(Create(hl), *[GrowArrow(a) for a in arrows], run_time=1.0)
        qdot = Dot(K, radius=0.1, color=YELLOW)
        esc = P(x0 + 1.55 * step, y0 - 0.55 * step)
        self.play(FadeIn(qdot), run_time=0.4)
        self.wait(0.8)
        trail = DashedLine(K, esc, color=YELLOW, stroke_width=2.5, dash_length=0.1)
        qlbl = Text("?  clamp? snap?", font_size=24, color=YELLOW).next_to(esc, DOWN, buff=0.15)
        self.play(qdot.animate.move_to(esc), Create(trail), run_time=1.1)
        self.play(FadeIn(qlbl), run_time=0.4)
        self.wait(4.6)
        self.play(FadeOut(VGroup(panel, bnd, st, hl, arrows, qdot, trail, qlbl)),
                  FadeOut(cap4), run_time=0.8)

    # ---------------------------------------------------------- chapter 1b2
    def ch1b2_narrow(self):
        self.set_header("Where reconstruction collapses: a narrow triangle")
        C = np.array([-0.2, 0.35, 0.0])
        half = 2.3
        K = C + np.array([-1.95, 0.13, 0.0])
        nu, nl = narrow_flanks()

        def fw(x, y):
            return narrow_f(x, y, K, nu, nl)

        panel = Square(side_length=2 * half, color=GREY_B, stroke_width=2.5).move_to(C)
        t = np.tan(7 * DEGREES)
        A = ray_to_box(K, (1.0, t), C, half)
        B = ray_to_box(K, (1.0, -t), C, half)
        tri = VMobject(color=WHITE, stroke_width=3.5).set_points_as_corners([A, K, B])
        cap = self.caption("a thin rib, a knife edge — a 14° wedge; CAD is full of these")
        self.play(FadeIn(cap), Create(panel), Create(tri), run_time=1.1)
        self.wait(3.4)

        st = narrow_stage(fw, C, half, 6, K, nu, nl)
        cap2 = self.caption("sample it: at this resolution the tip does not exist — no lattice",
                            "point falls inside it, so no cell even knows there is material")
        self.swap_caption(cap2, cap)
        self.play(Create(st), run_time=1.0)
        self.wait(4.6)

        cap3 = self.caption("2× finer: a tip appears — a full cell short, at the wrong angle;",
                            "2× again: closer, but the true apex is still never produced")
        self.swap_caption(cap3, cap2)
        for n in (12, 24):
            st2 = narrow_stage(fw, C, half, n, K, nu, nl)
            self.play(ReplacementTransform(st, st2), run_time=1.1)
            self.wait(1.4)
            st = st2
        self.wait(3.0)

        cap4 = self.caption("DC / MDC fare no better here: the two flank normals are nearly",
                            "parallel, so crease detection drowns in sampling noise and the",
                            "QEF goes ill-conditioned — the edge is guessed, not solved")
        self.swap_caption(cap4, cap3)
        self.wait(5.6)

        cap5 = self.caption("this is what makes raw SDFs unusable for CAD: edges locate datums,",
                            "mates, chamfers — a model whose edges are estimates is inadequate",
                            "at any resolution")
        self.swap_caption(cap5, cap4)
        self.wait(5.6)
        self.play(FadeOut(VGroup(panel, tri, st)), FadeOut(cap5), run_time=0.8)

    # ---------------------------------------------------------- chapter 1c
    def ch1c_feature_aware(self):
        self.set_header("Feature-aware: carry the shape twice")
        img = load_render("box_crop.png", 4.2).move_to(P(-3.7, 0.6))
        card = make_card("two representations, one shape", GREEN_B, [
            "implicit:   f_box(p) — for queries",
            "analytic:   8 corners (exact xyz) · 12 edge segments",
            "· 6 face planes — for truth",
            "now the vertices exist as data, not merely as places",
            "where f happens to vanish",
        ], width=6.9).move_to(P(3.2, 0.65))
        cap = self.caption("so define the primitive analytically as well — the SDF keeps",
                           "its modeling power, the features keep their identity")
        self.play(FadeIn(img), FadeIn(card, shift=RIGHT * 0.3), FadeIn(cap), run_time=1.0)
        self.wait(5.4)

        # operator stack: twist, then stretch — both representations transform
        img2 = load_render("box_twisted_crop.png", 5.2).move_to(P(-1.25, 0.45))
        img3 = load_render("box_twisted_stretched_crop.png", 5.6).move_to(P(1.5, 0.45))
        ar1 = Arrow(P(-2.85, 0.5), P(-2.05, 0.5), color=GREY_B, stroke_width=4,
                    max_tip_length_to_length_ratio=0.4)
        ar2 = Arrow(P(-0.25, 0.5), P(0.55, 0.5), color=GREY_B, stroke_width=4,
                    max_tip_length_to_length_ratio=0.4)
        al1 = Text("twist(800°)", font_size=20, color=YELLOW_C)\
            .next_to(ar1, UP, buff=0.18).shift(LEFT * 0.35)
        al2 = Text("stretch", font_size=20, color=YELLOW_C).next_to(ar2, UP, buff=0.18)
        cap2 = self.caption("every operator transforms BOTH: twist maps the field",
                            "p → R(θ·p.y)·p — and maps each straight edge to an exact helix")
        self.play(FadeOut(card), FadeOut(cap),
                  img.animate.scale_to_fit_height(3.0).move_to(P(-4.9, 0.5)),
                  run_time=0.8)
        self.play(FadeIn(img2), FadeIn(cap2), GrowArrow(ar1), FadeIn(al1), run_time=1.0)
        self.wait(5.4)

        cap3 = self.caption("then stretch it: transforms stack — the final feature curves are",
                            "closed forms of the whole composition (twist + stretch), exact,",
                            "never re-estimated from samples")
        self.swap_caption(cap3, cap2)
        self.play(FadeIn(img3), GrowArrow(ar2), FadeIn(al2), run_time=1.0)
        self.wait(5.6)

        m1s = load_render("box_mesh_solid_crop.png", 2.6).move_to(P(-4.05, 0.5))
        m1w = load_render("box_mesh_crop.png", 2.6).move_to(P(-1.7, 0.5))
        m2s = load_render("box_twisted_mesh_solid_crop.png", 5.0).move_to(P(0.45, 0.45))
        m2w = load_render("box_twisted_mesh_crop.png", 5.0).move_to(P(1.85, 0.45))
        m3s = load_render("box_twisted_stretched_mesh_solid_crop.png", 5.2).move_to(P(3.6, 0.45))
        m3w = load_render("box_twisted_stretched_mesh_crop.png", 5.2).move_to(P(4.65, 0.45))
        meshes = Group(m1s, m1w, m2s, m2w, m3s, m3w)
        mlegend = Text("each pair: solid · wireframe", font_size=18, color=GREY_B)\
            .move_to(P(0.2, 3.0))
        capm = self.caption("and these are the actual SFCC meshes of all three: the helical",
                            "creases are vertex chains sampled on the exact analytic helices,",
                            "the cap rims exact — nothing here was detected from samples")
        self.play(FadeOut(Group(img, img2, img3, ar1, ar2, al1, al2)),
                  FadeIn(meshes), FadeIn(mlegend),
                  FadeOut(cap3), FadeIn(capm), run_time=1.0)
        self.wait(6.2)

        csg = load_render("csg_seam_crop.png", 3.2).move_to(P(-4.6, 0.5))
        csgm_s = load_render("csg_seam_mesh_solid_crop.png", 3.2).move_to(P(0.0, 0.5))
        csgm_w = load_render("csg_seam_mesh_crop.png", 3.2).move_to(P(4.6, 0.5))
        clabels = VGroup(
            Text("SDF", font_size=20, color=GREY_A).move_to(P(-4.6, 2.45)),
            Text("mesh — solid", font_size=20, color=GREY_A).move_to(P(0.0, 2.45)),
            Text("mesh — wireframe", font_size=20, color=GREY_A).move_to(P(4.6, 2.45)))
        cap4 = self.caption("CSG works the same way: booleans create seams — computed exactly",
                            "on the analytic carriers, trimmed where a shape swallows an edge —",
                            "complex SDF geometry, without ever losing the underlying shape")
        self.play(FadeOut(meshes), FadeOut(mlegend), FadeOut(capm),
                  FadeIn(Group(csg, csgm_s, csgm_w)), FadeIn(clabels),
                  FadeIn(cap4), run_time=0.9)
        self.wait(6.0)

        cap4b = self.caption("and its SFCC mesh: the seam is meshed by edge cells — in-cell",
                             "crease polylines strung between exact pins — the seam∧edge",
                             "junctions are exact corner vertices, the swallowed edge simply gone")
        self.swap_caption(cap4b, cap4)
        self.wait(5.8)

        cap5 = self.caption("that is the idea — but does it survive abuse?",
                            "five torture tests before we open the pipeline")
        self.swap_caption(cap5, cap4b)
        self.wait(3.6)
        self.play(FadeOut(Group(csg, csgm_s, csgm_w, clabels)), FadeOut(cap5), run_time=0.8)

    # ---------------------------------------------------------- chapter 1d
    def ch1d_torture(self):
        self.set_header("Torture tests — SFCC under abuse")

        def cell(name, x):
            m = load_render(name, 3.9)
            if m.width > 4.25:
                m.scale_to_fit_width(4.25)
            return m.move_to(P(x, 0.35))

        labels = VGroup(
            Text("SDF", font_size=20, color=GREY_A).move_to(P(-4.6, 2.62)),
            Text("mesh — solid", font_size=20, color=GREY_A).move_to(P(0.0, 2.62)),
            Text("mesh — wireframe", font_size=20, color=GREY_A).move_to(P(4.6, 2.62)))
        self.play(FadeIn(labels), run_time=0.5)
        prev = None
        for base, lines in TORTURE:
            trio = Group(cell(f"{base}_crop.png", -4.6),
                         cell(f"{base}_mesh_solid_crop.png", 0.0),
                         cell(f"{base}_mesh_crop.png", 4.6))
            cap = self.caption(*lines)
            anims = [FadeIn(trio), FadeIn(cap)]
            if prev is not None:
                anims += [FadeOut(prev[0]), FadeOut(prev[1])]
            self.play(*anims, run_time=0.9)
            self.wait(6.4)
            prev = (trio, cap)
        capx = self.caption("five abusive trees, five certified manifold meshes —",
                            "now the pipeline, walked in 2D cross-section")
        self.play(FadeOut(prev[0]), FadeOut(prev[1]), FadeIn(capx), run_time=0.8)
        self.wait(3.8)
        self.play(FadeOut(labels), FadeOut(capx), run_time=0.7)

    # ---------------------------------------------------------- chapter 2
    def ch2_input(self):
        self.set_header("The input: a signed-distance CSG tree")

        sq = Square(side_length=2 * SQ_H, color=TEAL, stroke_width=3).move_to(P(*SQ_C))
        ci = Circle(radius=CI_R, color=ORANGE, stroke_width=3).move_to(P(*CI_C))
        self.play(Create(sq), Create(ci), run_time=1.2)

        cap = self.caption("two primitives:  f_box(p)   and   f_circle(p)")
        self.play(FadeIn(cap), run_time=0.5)
        self.wait(2.2)

        solid = union_shape(color=BLUE_E, fill_color=BLUE_E, fill_opacity=0.55, stroke_width=0)
        cap2 = self.caption("union  ⇒  f(p) = min(f_box, f_circle)      inside ⇔ f < 0")
        self.play(FadeIn(solid), run_time=0.9)
        self.swap_caption(cap2, cap)

        inside = Text("f < 0", font_size=30, color=BLUE_B).move_to(P(-0.6, 0.0))
        outside = Text("f > 0", font_size=30, color=GREY_B).move_to(P(-4.5, 2.2))
        self.play(FadeIn(inside), FadeIn(outside), run_time=0.6)
        self.wait(2.8)

        cap3 = self.caption("no precomputed samples, no Hermite data —",
                            "the kernel queries f, ∇f, interval bounds, and owners on demand")
        self.swap_caption(cap3, cap2)
        self.wait(3.8)

        self.mob_scene = VGroup(sq, ci, solid)
        self.play(FadeOut(inside), FadeOut(outside), FadeOut(cap3), run_time=0.6)

    # ---------------------------------------------------------- chapter 3
    def ch3_features(self):
        self.set_header("S1 — Symbolic feature compilation (no QEF, nothing sampled)")
        sq, ci, solid = self.mob_scene

        # carriers: unbounded analytic surfaces
        carriers = VGroup()
        for y in (SQ_C[1] + SQ_H, SQ_C[1] - SQ_H):
            carriers.add(DashedLine(P(-6.5, y), P(6.5, y), stroke_width=2, color=TEAL_E))
        for x in (SQ_C[0] + SQ_H, SQ_C[0] - SQ_H):
            carriers.add(DashedLine(P(x, -3.4), P(x, 3.4), stroke_width=2, color=TEAL_E))
        carrier_ci = DashedVMobject(Circle(radius=CI_R, color=ORANGE, stroke_width=2)
                                    .move_to(P(*CI_C)), num_dashes=48)
        cap = self.caption("strata: smooth patches, each on an unbounded analytic carrier",
                           "(planes, spheres, cylinders, cones, ruled sheets)")
        self.play(FadeIn(cap), Create(carriers), Create(carrier_ci),
                  sq.animate.set_stroke(opacity=0.35), ci.animate.set_stroke(opacity=0.35),
                  run_time=1.5)
        self.wait(3.6)

        # seam tracing: over-traced carrier-pair loci
        cap2 = self.caption("seam tracing: march the locus { f_A = 0 } ∩ { f_B = 0 } on carrier pairs",
                            "— deliberately over-traced onto carrier extensions")
        cands = VGroup(*[Dot(p, radius=0.09, color=YELLOW, fill_opacity=0)
                        .set_stroke(YELLOW, width=3)
                         for p in (SEAM_TOP, SEAM_RIGHT, DEAD_TOP, DEAD_RIGHT)])
        self.swap_caption(cap2, cap)
        self.play(LaggedStart(*[GrowFromCenter(d) for d in cands], lag_ratio=0.25), run_time=1.2)
        self.wait(3.6)

        # how the tracer actually marches
        tr = tracer_inset(P(4.0, 1.4))
        cap2b = self.caption("how: seed points from a coarse grid over the pair's overlap box",
                             "are Newton-projected onto the locus, then marched along the",
                             "carrier-pair tangent ∇f_A × ∇f_B, Newton-corrected every step")
        self.swap_caption(cap2b, cap2)
        self.play(FadeIn(tr[0]), FadeIn(tr[1]), Create(tr[2]), FadeIn(tr[3]), run_time=1.0)
        self.play(LaggedStart(*[FadeIn(s) for s in tr[4]], lag_ratio=0.18), run_time=2.6)
        self.wait(3.6)
        cap2c = self.caption("the step adapts to the turn (err ≈ h·θ/8), halves on a failed",
                             "correction or a sharp turn, and stops at tangency, loop closure,",
                             "or a hard cap — overshooting past the real solid is fine")
        self.swap_caption(cap2c, cap2b)
        self.wait(4.4)
        self.play(FadeOut(tr), run_time=0.6)

        # CSG trim
        cap3 = self.caption("CSG trim — a point is alive iff:  |f_tree| ≤ surface_tol,",
                            "carriers genuinely creased, and both flanks survive probing")
        self.swap_caption(cap3, cap2c)
        dead = VGroup(cands[2], cands[3])
        crosses = VGroup(*[Cross(scale_factor=0.14).move_to(d) for d in dead])
        self.play(FadeIn(crosses), run_time=0.5)
        self.wait(1.8)
        self.play(FadeOut(dead), FadeOut(crosses), run_time=0.6)

        live_seams = VGroup(*[Dot(p, radius=0.09, color=RED) for p in (SEAM_TOP, SEAM_RIGHT)])
        self.play(FadeOut(cands[0]), FadeOut(cands[1]), FadeIn(live_seams), run_time=0.7)

        # native corners; one swallowed by the union
        natives = VGroup(*[Dot(p, radius=0.09, color=PURPLE_A)
                           for p in (CORNER_TL, CORNER_BL, CORNER_BR)])
        swallowed = Dot(CORNER_TR, radius=0.09, color=PURPLE_A)
        cap4 = self.caption("native modeled corners join the feature set …",
                            "… but the corner swallowed by the union is trimmed away too")
        self.swap_caption(cap4, cap3)
        self.play(LaggedStart(*[GrowFromCenter(d) for d in natives], lag_ratio=0.2),
                  GrowFromCenter(swallowed), run_time=1.0)
        self.wait(0.8)
        sw_cross = Cross(scale_factor=0.14).move_to(swallowed)
        self.play(FadeIn(sw_cross), run_time=0.4)
        self.play(FadeOut(swallowed), FadeOut(sw_cross), run_time=0.6)
        self.wait(2.2)

        cap5 = self.caption("surviving: two boolean seam features + three native corners —",
                            "so what exactly did S1 just build?")
        self.swap_caption(cap5, cap4)
        self.wait(4.0)

        self.play(FadeOut(carriers), FadeOut(carrier_ci), FadeOut(cap5),
                  sq.animate.set_stroke(opacity=0.0), ci.animate.set_stroke(opacity=0.0),
                  run_time=0.8)
        self.features = VGroup(live_seams, natives)

    # ---------------------------------------------------------- chapter 3b
    def ch3b_featureset(self):
        self.set_header("S1 output — the feature set: strata, curves, corners")
        shift = LEFT * 2.3
        world = VGroup(self.mob_scene, self.features)
        self.play(world.animate.shift(shift), run_time=0.8)

        a1 = np.arctan2(SEAM_RIGHT[1] - CI_C[1], SEAM_RIGHT[0] - CI_C[0])
        a2 = np.arctan2(SEAM_TOP[1] - CI_C[1], SEAM_TOP[0] - CI_C[0])
        strata_hl = VGroup(
            Line(CORNER_TL, SEAM_TOP, stroke_width=6, color=TEAL_B),
            Line(CORNER_BL, CORNER_TL, stroke_width=6, color=GREEN_B),
            Line(CORNER_BR, CORNER_BL, stroke_width=6, color=BLUE_B),
            Line(SEAM_RIGHT, CORNER_BR, stroke_width=6, color=PURPLE_B),
            Arc(radius=CI_R, start_angle=a1, angle=a2 - a1,
                arc_center=P(*CI_C), stroke_width=6, color=ORANGE),
        ).shift(shift)

        card_pos = P(3.95, 0.45)
        c1 = make_card("STRATA — smooth patches on carriers", TEAL_B, [
            "one stratum = one smooth patch of one primitive,",
            "carried by an unbounded analytic surface:",
            "box → 6 planes      cylinder → mantle + 2 caps",
            "sphere → 1      cone → mantle + base",
            "twisted extrude / loft sides → ruled sheets",
            "each exposes  f(p) · exact normal · project · κ bound",
        ]).move_to(card_pos)
        cap = self.caption("in this flat demo: 4 line carriers + 1 circle carrier,",
                           "each colored patch is one stratum", pos=DOWN * 3.35)
        self.play(FadeIn(c1, shift=RIGHT * 0.3), FadeIn(cap), run_time=0.8)
        self.play(LaggedStart(*[Create(s) for s in strata_hl], lag_ratio=0.2), run_time=1.8)
        self.wait(5.4)

        c2 = make_card("CURVES — the 1D crease loci", YELLOW_C, [
            "—   Segment: a box edge (exact line)",
            "○   Circle: a cylinder cap rim (exact arc)",
            "~   Traced: a boolean seam — a polyline of samples",
            "Newton-projected onto  { f_A = 0 } ∩ { f_B = 0 }",
            "every curve stores its two adjacent strata,",
            "and the corner ids at its ends (−1 = free end)",
        ]).move_to(card_pos)
        cap2 = self.caption("(a 3D crease curve shows up as a point in this 2D demo —",
                            "the red seams here would be traced curves in 3D)", pos=DOWN * 3.35)
        self.play(FadeOut(c1), FadeIn(c2, shift=RIGHT * 0.3),
                  FadeOut(cap), FadeIn(cap2), run_time=0.7)
        self.play(*[Indicate(d, color=RED, scale_factor=1.7) for d in self.features[0]],
                  run_time=1.4)
        self.wait(5.8)

        c3 = make_card("CORNERS — where curves meet", RED_B, [
            "exact position + (curve, end) wiring + incident strata",
            "box → 8 corners (valence 3) · cone apex → valence 0",
            "here: c₁ = (0.44, 1.50) — where the box's top",
            "carrier meets the circle carrier",
        ]).move_to(card_pos)
        lbl = Text("c₁", font_size=26, color=RED_B).next_to(SEAM_TOP + shift, UP, buff=0.15)
        cap3 = self.caption("compiled once, before any refinement — S2 and S3 only read it;",
                            "every feature vertex in the mesh is an evaluation of these objects",
                            pos=DOWN * 3.35)
        self.play(FadeOut(c2), FadeIn(c3, shift=RIGHT * 0.3),
                  FadeOut(cap2), FadeIn(cap3), run_time=0.7)
        self.play(FadeIn(lbl),
                  *[Indicate(d, color=PURPLE_A, scale_factor=1.7) for d in self.features[1]],
                  run_time=1.4)
        self.wait(5.4)

        self.play(FadeOut(c3), FadeOut(lbl), FadeOut(strata_hl), FadeOut(cap3),
                  world.animate.shift(-shift), run_time=0.8)

    # ---------------------------------------------------------- chapter 3c
    def ch3c_blends(self):
        self.set_header("Smooth CSG — when a fillet meets a sharp edge")
        bg = Rectangle(width=13.9, height=5.9, stroke_width=1.5, color=GREY_B,
                       fill_color=BLACK, fill_opacity=0.95).move_to(UP * 0.32)
        hard = load_render("csg_seam_crop.png", 4.1).move_to(P(-3.3, 0.4))
        smooth = load_render("smooth_union_crop.png", 4.1).move_to(P(3.3, 0.4))
        lh = Text("union", font_size=24, color=GREY_A).next_to(hard, UP, buff=0.18)
        ls = Text("smooth union", font_size=24, weight=BOLD, color=BLUE_B)\
            .next_to(smooth, UP, buff=0.18)
        cap = self.caption("CSG can be smooth too: a blended union (smin, radius r) replaces",
                           "the sharp seam with a fillet band — featureless by construction:",
                           "no primitive owns its surface, so no seam is traced there at all")
        self.play(FadeIn(bg), FadeIn(hard), FadeIn(smooth), FadeIn(lh), FadeIn(ls),
                  FadeIn(cap), run_time=1.1)
        self.wait(6.0)

        hl = Ellipse(width=2.3, height=2.1, color=YELLOW, stroke_width=3)\
            .move_to(P(4.0, 1.1))
        cap2 = self.caption("the fillet also swallows part of the cube's own edges: near the",
                            "sphere the surface pulls off the edge's carriers and rounds over;",
                            "farther out the same edge is untouched — still exactly analytic")
        self.swap_caption(cap2, cap)
        self.play(Create(hl), run_time=0.8)
        self.wait(5.8)

        meshr_s = load_render("smooth_union_mesh_solid_crop.png", 3.1).move_to(P(0.0, 0.4))
        meshr_w = load_render("smooth_union_mesh_crop.png", 3.1).move_to(P(4.55, 0.4))
        lms = Text("SFCC mesh — solid", font_size=22, weight=BOLD, color=RED_B)\
            .move_to(P(0.0, 2.25))
        lmw = Text("wireframe", font_size=22, weight=BOLD, color=RED_B)\
            .move_to(P(4.55, 2.25))
        ls2 = Text("smooth union", font_size=22, color=GREY_A).move_to(P(-4.55, 2.25))
        capm = self.caption("the meshed result: the fillet band is triangulated smooth under",
                            "the gradient-cone certificate, and the crease polylines terminate",
                            "at their exact endpoints — no crack where sharp meets smooth")
        self.play(FadeOut(Group(hard, lh, hl, ls)),
                  smooth.animate.scale_to_fit_height(3.1).move_to(P(-4.55, 0.4)),
                  FadeOut(cap2), FadeIn(capm), run_time=0.9)
        self.play(FadeIn(meshr_s), FadeIn(meshr_w), FadeIn(lms), FadeIn(lmw), FadeIn(ls2),
                  run_time=0.8)
        self.wait(6.0)

        # trim tick diagram (right)
        tk_y = 1.55
        tline = Line(P(0.9, tk_y), P(6.3, tk_y), color=WHITE, stroke_width=3)
        tlab = Text("a native box edge — parameter t", font_size=18, color=GREY_A)\
            .next_to(tline, UP, buff=0.35)
        t_cut = 0.64
        ticks = VGroup()
        for i in range(27):
            t = i / 26
            alive = t < t_cut
            x = 0.9 + 5.4 * t
            ticks.add(Line(P(x, tk_y - 0.12), P(x, tk_y + 0.12),
                           color=GREEN_B if alive else RED, stroke_width=3,
                           stroke_opacity=1.0 if alive else 0.55))
        cutx = 0.9 + 5.4 * t_cut
        cut = Dot(P(cutx, tk_y), radius=0.09, color=YELLOW)
        la = Text("alive: on surface · creased · flanks OK", font_size=16,
                  color=GREEN_B).move_to(P(2.4, tk_y - 0.5))
        ld = Text("dead: displaced into the fillet", font_size=16,
                  color=RED).move_to(P(5.5, tk_y - 0.5))
        cl = Text("bisected: the crease's exact endpoint", font_size=17,
                  color=YELLOW).move_to(P(4.3, tk_y - 1.05))
        cptr = Line(cl.get_top(), cut.get_bottom() + DOWN * 0.03,
                    color=GREY_B, stroke_width=2)
        tick_grp = VGroup(tline, tlab, ticks, cut, la, ld, cl, cptr)
        cap3 = self.caption("S1c trim makes the hand-off exact: each native edge is sampled",
                            "against the blended tree; the alive→dead transition is bisected —",
                            "the crease ends at the exact point it sinks into the fillet")
        self.play(FadeOut(Group(smooth, ls2, meshr_s, meshr_w, lms, lmw)), FadeOut(capm),
                  FadeIn(cap3), run_time=0.8)
        self.play(Create(tline), FadeIn(tlab), run_time=0.6)
        self.play(LaggedStart(*[GrowFromCenter(t) for t in ticks], lag_ratio=0.04),
                  run_time=1.4)
        self.play(GrowFromCenter(cut), FadeIn(la), FadeIn(ld), FadeIn(cl),
                  Create(cptr), run_time=0.9)
        self.wait(6.2)

        # 2D smooth-union contour (left), colored by ownership
        hard2d = DashedVMobject(Polygon(*union_outline(), color=GREY_A, stroke_width=3),
                                num_dashes=110)
        pts = smooth_contour(r=0.75)
        sm2d = VGroup()
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            m = (a + b) / 2
            band = min(abs(f_box(m[0], m[1])), abs(f_circ(m[0], m[1]))) > 0.03
            sm2d.add(Line(a, b, color=YELLOW if band else BLUE_B,
                          stroke_width=5.5 if band else 4))
        dead_dots = VGroup(*[Dot(p, radius=0.08, color=RED) for p in (SEAM_TOP, SEAM_RIGHT)])
        live_dots = VGroup(*[Dot(p, radius=0.08, color=PURPLE_A)
                             for p in (CORNER_TL, CORNER_BL, CORNER_BR)])
        grp2d = VGroup(hard2d, sm2d, dead_dots, live_dots)\
            .scale(0.72).move_to(P(-3.5, 0.75))
        legend = Text("yellow: the fillet band — no owner, no feature", font_size=16,
                      color=YELLOW).next_to(grp2d, DOWN, buff=0.22)
        crosses = VGroup(*[Cross(scale_factor=0.11).move_to(d) for d in dead_dots])
        cap4 = self.caption("in the 2D scene: smooth-union the same primitives — the two seam",
                            "features die (trim kills them), the far corners survive; features",
                            "exist exactly where the model is actually sharp")
        self.swap_caption(cap4, cap3)
        self.play(FadeIn(hard2d), FadeIn(sm2d), FadeIn(dead_dots), FadeIn(live_dots),
                  run_time=1.6)
        self.play(FadeIn(crosses), FadeIn(legend),
                  *[Indicate(d, color=PURPLE_A, scale_factor=1.6) for d in live_dots],
                  run_time=1.0)
        self.wait(5.6)

        cap5 = self.caption("the band meshes as smooth surface — no strata, so refinement uses",
                            "the tree's own ∇f cone (κ ≤ 1/r analytically) — and it joins the",
                            "crease's cells via once-per-face contouring: crack-free")
        self.swap_caption(cap5, cap4)
        self.wait(6.4)

        self.play(FadeOut(VGroup(bg, tick_grp, grp2d, crosses, legend)), FadeOut(cap5),
                  run_time=0.8)

    # ---------------------------------------------------------- chapter 4
    def ch4_octree(self):
        self.set_header("S2 — Certified feature-aware octree (a quadtree here)")
        sq, ci, solid = self.mob_scene
        self.play(solid.animate.set_fill(opacity=0.30), run_time=0.4)

        self.leaves = quadtree_leaves()
        grid = VGroup()
        for cx, cy, h, d, kind in sorted(self.leaves, key=lambda l: l[3]):
            color = {"empty": GREY_D, "surf": BLUE_C, "feat": YELLOW_C}[kind]
            w = {"empty": 1.0, "surf": 1.6, "feat": 2.6}[kind]
            op = {"empty": 0.15, "surf": 0.8, "feat": 1.0}[kind]
            grid.add(cell_square(cx, cy, h, color=color, stroke_width=w,
                                 stroke_opacity=op, fill_opacity=0))
        cull_cell = Square(side_length=1.7, color=RED_B, stroke_width=2.5).move_to(P(-5.3, 1.9))
        cull_ball = DashedVMobject(Circle(radius=1.2, color=GREY_A, stroke_width=2)
                                   .move_to(P(-5.3, 1.9)), num_dashes=32)
        cull_c = Dot(P(-5.3, 1.9), radius=0.06, color=WHITE)
        cull_t = Text("|f(c)| = 3.0  >  r = 1.2   ⇒  ✗ empty", font_size=18, color=RED_B)\
            .next_to(cull_ball, DOWN, buff=0.15)
        cap0 = self.caption("descent first proves regions empty: an exact SDF is 1-Lipschitz,",
                            "so |f(center)| > ball radius certifies the whole cell surface-free —",
                            "cull the subtree, never sample it again")
        self.play(FadeIn(cap0), Create(cull_cell), Create(cull_ball),
                  FadeIn(cull_c), FadeIn(cull_t), run_time=1.0)
        self.wait(4.6)

        cap = self.caption("everything that survives the cull now refines, feature-aware")
        self.play(FadeOut(VGroup(cull_cell, cull_ball, cull_c, cull_t)),
                  FadeOut(cap0), FadeIn(cap), run_time=0.6)
        self.play(LaggedStart(*[FadeIn(c) for c in grid], lag_ratio=0.008), run_time=3.0)
        self.wait(1.8)

        cap2 = self.caption("refine until every leaf is simple:",
                            "at most one feature curve through it — or exactly one claimed corner")
        self.swap_caption(cap2, cap)
        feats = [g for g, l in zip(grid, sorted(self.leaves, key=lambda l: l[3]))
                 if l[4] == "feat"]
        self.play(*[Indicate(f, scale_factor=1.15, color=YELLOW) for f in feats[:14]],
                  run_time=1.4)
        self.wait(2.6)

        # certificate insets on the right
        backdrop = RoundedRectangle(width=3.1, height=6.4, corner_radius=0.15,
                                    stroke_width=1.5, color=GREY_B,
                                    fill_color=BLACK, fill_opacity=0.75).move_to(P(5.45, -0.2))
        smooth_cell = Square(side_length=2.0, color=BLUE_C, stroke_width=2).move_to(P(5.45, 1.35))
        arc = Arc(radius=3.2, start_angle=100 * DEGREES, angle=-22 * DEGREES,
                  color=WHITE, stroke_width=3).move_arc_center_to(P(5.0, -1.7))
        n_arrows = VGroup()
        for t, ang in [(0.25, 96), (0.5, 90), (0.75, 84)]:
            base = arc.point_from_proportion(t)
            v = np.array([np.cos(ang * DEGREES), np.sin(ang * DEGREES), 0])
            n_arrows.add(Arrow(base, base + 0.7 * v, buff=0, stroke_width=3,
                               max_tip_length_to_length_ratio=0.25, color=GREEN_B))
        s_label = Text("normal cone ≤ 18°  ✓", font_size=19, color=GREEN_B)\
            .next_to(smooth_cell, DOWN, buff=0.12)

        crease_cell = Square(side_length=2.0, color=YELLOW_C, stroke_width=2).move_to(P(5.45, -1.75))
        vtx = P(5.45, -2.25)
        lseg = Line(vtx + np.array([-1.0, 0.75, 0]), vtx, color=TEAL, stroke_width=3)
        rseg = Line(vtx, vtx + np.array([1.0, 0.9, 0]), color=ORANGE, stroke_width=3)
        c_arrows = VGroup()
        for t in (0.3, 0.65):
            b = lseg.point_from_proportion(t)
            v = rotate_vector(lseg.get_unit_vector(), 90 * DEGREES)
            c_arrows.add(Arrow(b, b + 0.55 * v, buff=0, stroke_width=3,
                               max_tip_length_to_length_ratio=0.3, color=TEAL))
        for t in (0.35, 0.7):
            b = rseg.point_from_proportion(t)
            v = rotate_vector(rseg.get_unit_vector(), 90 * DEGREES)
            c_arrows.add(Arrow(b, b + 0.55 * v, buff=0, stroke_width=3,
                               max_tip_length_to_length_ratio=0.3, color=ORANGE))
        c_label = Text("per stratum:  ✓ ✓", font_size=19, color=GREEN_B)\
            .next_to(crease_cell, DOWN, buff=0.12)

        cap3 = self.caption("smoothness is certified per stratum, against each patch's own carrier —",
                            "the tree's normals never converge at a crease, but each carrier's do")
        self.swap_caption(cap3, cap2)
        self.play(FadeIn(backdrop), Create(smooth_cell), Create(arc),
                  *[GrowArrow(a) for a in n_arrows], FadeIn(s_label), run_time=1.2)
        self.wait(0.6)
        self.play(Create(crease_cell), Create(lseg), Create(rseg),
                  *[GrowArrow(a) for a in c_arrows], FadeIn(c_label), run_time=1.2)
        self.wait(4.0)

        cap4 = self.caption("so refinement terminates at creases instead of chasing the kinked",
                            "field forever; blend fillets certify the tree's own ∇f cone instead")
        self.swap_caption(cap4, cap3)
        self.wait(4.0)

        cap5 = self.caption("2:1 balanced (no leaf neighbors a cell >1 level coarser);",
                            "decisions are pure functions ⇒ the leaf set is order-independent")
        self.swap_caption(cap5, cap4)
        self.wait(4.0)

        inset = VGroup(backdrop, smooth_cell, arc, n_arrows, s_label,
                       crease_cell, lseg, rseg, c_arrows, c_label)
        self.play(FadeOut(inset), FadeOut(cap5), run_time=0.6)
        self.grid = grid

    # ---------------------------------------------------------- chapter 5
    def ch5_contour(self):
        self.set_header("S3a — Face contouring: every canonical face exactly once")
        lf1 = find_leaf(self.leaves, 2.65, 1.45)
        lf2 = find_leaf(self.leaves, 2.65, 0.55)
        hls = VGroup(*[cell_square(l[0], l[1], l[2], color=WHITE, stroke_width=3.5)
                       for l in (lf1, lf2)])
        dots = VGroup()
        for (cx, cy, h) in (lf1[:3], lf2[:3]):
            for sx in (-1, 1):
                for sy in (-1, 1):
                    x, y = cx + sx * h, cy + sy * h
                    ins = f_union(x, y) < 0
                    dots.add(Dot(P(x, y), radius=0.07,
                                 color=BLUE_B if ins else GREY_C,
                                 fill_opacity=1 if ins else 0.9)
                             .set_stroke(WHITE, width=1, opacity=0.6))
        cap = self.caption("corner samples live in one shared cache — each lattice point",
                          "evaluated once, so neighbor cells can never disagree on a sign")
        self.play(FadeIn(cap), Create(hls), run_time=0.8)
        self.play(LaggedStart(*[GrowFromCenter(d) for d in dots], lag_ratio=0.06), run_time=1.0)
        self.wait(3.6)

        cx, cy, h = lf1[:3]
        shared = Line(P(cx - h, cy - h), P(cx + h, cy - h), color=YELLOW, stroke_width=5)
        xr = edge_root_x(cx - h, cx + h, cy - h)
        cross1 = Dot(xr, radius=0.09, color=RED)
        cap2 = self.caption("shared face, sign change ⇒ one root (Illinois regula-falsi,",
                            "endpoints canonicalized) interned under an integer provenance key —",
                            "both cells consume the same vertex  ⇒  crack-free by construction")
        self.swap_caption(cap2, cap)
        self.play(Create(shared), run_time=0.6)
        self.play(GrowFromCenter(cross1), Flash(xr, color=RED, flash_radius=0.35), run_time=0.8)
        self.wait(4.2)

        yr = edge_root_y(cy - h, cy + h, cx - h)
        cross2 = Dot(yr, radius=0.09, color=RED)
        seg = Arrow(xr, yr, buff=0.1, color=RED_B, stroke_width=4,
                    max_tip_length_to_length_ratio=0.12)
        cap3 = self.caption("crossings pair into directed segments, exit → enter,",
                            "oriented so the solid lies on the segment's left")
        self.swap_caption(cap3, cap2)
        self.play(GrowFromCenter(cross2), GrowArrow(seg), run_time=0.9)
        self.wait(3.6)

        # the classic ambiguous face, resolved by one extra sample
        amb = ambiguous_inset(P(4.85, 0.15))
        cap3b = self.caption("faces can be ambiguous: four crossings admit two legal pairings —",
                             "exits pair with the nearest unmatched enter, and when two runs",
                             "remain, ONE face-center sample decides: joined, or separate lobes")
        self.swap_caption(cap3b, cap3)
        self.play(FadeIn(amb[0]), Create(amb[1]), FadeIn(amb[2]), FadeIn(amb[3]),
                  run_time=1.0)
        self.play(FadeIn(amb[4]), run_time=0.7)
        self.wait(1.6)
        self.play(GrowFromCenter(amb[5]),
                  Flash(amb[5].get_center(), color=BLUE_B, flash_radius=0.35), run_time=0.7)
        self.play(FadeOut(amb[4][0]),
                  amb[4][1].animate.set_stroke(WHITE, width=4, opacity=1.0), run_time=0.8)
        self.wait(3.8)
        self.play(FadeOut(amb), run_time=0.6)

        inset, route = pin_inset(self.leaves, P(4.95, -0.2), side=3.0)
        cap4 = self.caption("near a feature curve: its exact analytic crossings with the face",
                            "become pins — the certified route is  exit → pin → enter,",
                            "one kinked arc through the exact feature point (no QEF)")
        self.swap_caption(cap4, cap3b)
        ptr = Arrow(SEAM_RIGHT + RIGHT * 0.15, inset[0].get_left() + LEFT * 0.05,
                    color=GREY_B, stroke_width=2.5, max_tip_length_to_length_ratio=0.08)
        self.play(FadeIn(inset[0]), GrowArrow(ptr), run_time=0.8)
        self.play(Create(inset[1]), FadeIn(inset[2]), run_time=1.0)
        self.play(Create(route), run_time=1.2)
        self.wait(4.4)

        self.play(FadeOut(VGroup(hls, dots, shared, cross1, cross2, seg, inset, route, ptr)),
                  FadeOut(cap4), run_time=0.7)

    # ---------------------------------------------------------- chapter 5b
    def ch5b_provenance(self):
        self.set_header("Determinism — integer provenance keys, floats as payload")
        bg = Rectangle(width=13.9, height=5.9, stroke_width=1.5, color=GREY_B,
                       fill_color=BLACK, fill_opacity=0.93).move_to(UP * 0.32)
        cellA = Square(side_length=2.2, color=GREY_B, stroke_width=2.5).move_to(P(-4.5, 1.35))
        cellB = Square(side_length=2.2, color=GREY_B, stroke_width=2.5).move_to(P(-4.5, -0.85))
        lblA = Text("cell A", font_size=20, color=GREY_B)\
            .next_to(cellA, UP, buff=0.12).align_to(cellA, LEFT)
        lblB = Text("cell B", font_size=20, color=GREY_B)\
            .next_to(cellB, DOWN, buff=0.12).align_to(cellB, LEFT)
        edge = Line(P(-5.6, 0.25), P(-3.4, 0.25), color=YELLOW, stroke_width=5)
        curve = VMobject(color=WHITE, stroke_width=3)
        curve.set_points_smoothly([P(-4.95, 2.3), P(-4.15, 0.25), P(-3.55, -1.8)])
        X = P(-4.15, 0.25)
        cap = self.caption("S3a interned each crossing under an exact integer provenance",
                           "key — why not simply key vertices by their coordinates?")
        self.play(FadeIn(bg), FadeIn(cap), run_time=0.6)
        self.play(Create(cellA), Create(cellB), Create(edge), Create(curve),
                  FadeIn(lblA), FadeIn(lblB), run_time=1.2)
        self.wait(3.8)

        card_pos = P(2.95, 0.5)
        p1 = make_card("key = the computed position?", RED_B, [
            "cell A finds   x = 2.938413667201118",
            "cell B finds   x = 2.938413667201119",
            "one ulp apart: float results depend on evaluation",
            "order — across faces, cells, and worker partitions",
            "same point, two keys → two vertices → a crack",
        ], width=7.4).move_to(card_pos)
        d1 = Dot(X + UP * 0.09 + LEFT * 0.07, radius=0.075, color=RED)
        d2 = Dot(X + DOWN * 0.09 + RIGHT * 0.07, radius=0.075, color=ORANGE)
        cap2 = self.caption("computed floats are not a naming contract —",
                            "their equality breaks one bit at a time")
        self.play(FadeIn(p1, shift=RIGHT * 0.3), FadeOut(cap), FadeIn(cap2), run_time=0.7)
        self.play(GrowFromCenter(d1), GrowFromCenter(d2), run_time=0.6)
        self.wait(5.2)

        p2 = make_card("SFCC — the sub-edge itself is the address", GREEN_B, [
            "min corner → integer lattice coords (ix, iy, iz)",
            "latticeKey = (ix·span + iy)·span + iz",
            "vertex key = latticeKey·8 + axis",
            "the PointTable is first-writer-wins: every cell, face,",
            "and worker derives the same integer → same vertex id",
            "the float position is payload — never the key",
        ], width=7.4).move_to(card_pos)
        good = Dot(X, radius=0.09, color=GREEN_B)
        gl = Text("one id", font_size=20, color=GREEN_B).next_to(good, RIGHT, buff=0.12)
        cap3 = self.caption("both cells name the same discrete sub-edge, so both derive the",
                            "same integer — vertex identity never compares floats")
        self.play(FadeOut(p1), FadeIn(p2, shift=RIGHT * 0.3), FadeOut(cap2), FadeIn(cap3),
                  FadeOut(d1), FadeOut(d2), run_time=0.7)
        self.play(GrowFromCenter(good), FadeIn(gl), run_time=0.5)
        self.wait(5.8)

        p4 = make_card("when a float must join a key — freeze it", YELLOW_C, [
            "pin keys fix the curve parameter into text:",
            "\"F{axis}:{faceKey}:{curveId}:{t:.12}\"",
            "repair-midpoint keys use the exact bit pattern:",
            "\"p{x.to_bits()}_{y.to_bits()}_{z.to_bits()}\"",
            "and payload floats are bit-identical anyway —",
            "roots are found after canonicalizing endpoint order",
        ], width=7.4).move_to(card_pos)
        cap5 = self.caption("a float can join a key only frozen — fixed-format text or its",
                            "exact IEEE-754 bits — never through float equality")
        self.play(FadeOut(p2), FadeIn(p4, shift=RIGHT * 0.3),
                  FadeOut(cap3), FadeIn(cap5), run_time=0.7)
        self.wait(6.0)

        self.play(FadeOut(VGroup(bg, cellA, cellB, lblA, lblB, edge, curve, good, gl, p4)),
                  FadeOut(cap5), run_time=0.8)

    # ---------------------------------------------------------- chapter 6
    def ch6_mesh(self):
        self.set_header("S3b — Cell meshing: segments → closed loops → triangles")
        sq, ci, solid = self.mob_scene
        cpts = extract_contour(self.leaves)
        poly = Polygon(*cpts, color=RED_B, stroke_width=4)
        vdots = VGroup(*[Dot(p, radius=0.045, color=WHITE) for p in cpts])
        fdots = VGroup(*[Dot(p, radius=0.09, color=YELLOW) for p in LIVE_FEATURES])
        cap = self.caption("each cell requires every loop point to have exactly one outgoing",
                           "segment — anything inconsistent fails the whole cell (no garbage);",
                           "failed cells drive bounded re-refinement (≤ 2 extra rounds)")
        self.play(FadeIn(cap), run_time=0.4)
        self.play(Create(poly), run_time=2.2)
        self.play(FadeIn(vdots), FadeIn(fdots),
                  self.features.animate.set_opacity(0), run_time=0.8)
        self.wait(4.2)

        cap2 = self.caption("edge cells split their loop at the two pins into two disks, one per",
                            "stratum; corner cells fan from the exact corner vertex; big smooth",
                            "loops fan from an interior vertex Newton-projected onto the surface")
        self.swap_caption(cap2, cap)
        self.wait(4.6)

        # loop assembly + interior-vertex projection, mechanically
        lp = loop_inset(P(4.3, 0.9))
        cap2b = self.caption("how a cell meshes: its six faces' directed segments must chain",
                             "head-to-tail into closed loops — one outgoing segment per point,",
                             "or the WHOLE cell fails into re-refinement (never guess, never patch)")
        self.swap_caption(cap2b, cap2)
        self.play(FadeIn(lp[0]), FadeIn(lp[1]), Create(lp[2]), run_time=0.8)
        self.play(LaggedStart(*[GrowArrow(a) for a in lp[3]], lag_ratio=0.22), run_time=1.8)
        self.wait(3.2)
        cap2c = self.caption("≥5-gon loops fan from an interior vertex: start at the centroid,",
                             "steepest-descend onto the surface, accept only on-surface, in-box,",
                             "and same-sheet — otherwise fan from the best boundary ear")
        self.swap_caption(cap2c, cap2b)
        self.play(FadeIn(lp[4]), FadeIn(lp[6]), run_time=0.8)
        self.play(LaggedStart(*[Create(l) for l in lp[5]], lag_ratio=0.1), run_time=1.0)
        self.wait(4.4)
        self.play(FadeOut(lp), run_time=0.6)

        self.play(self.grid.animate.set_stroke(opacity=0.06),
                  solid.animate.set_fill(opacity=0.10),
                  poly.animate.set_stroke(opacity=0.25),
                  FadeOut(vdots), FadeOut(fdots), FadeOut(cap2c), run_time=0.8)
        left = crease_panel(P(-3.1, -0.4), "ms")
        right = crease_panel(P(3.1, -0.4), "sfcc")
        tl = Text("sampled contouring", font_size=24, color=GREY_A).next_to(left[0], UP, buff=0.2)
        tr = Text("SFCC", font_size=24, weight=BOLD, color=RED_B).next_to(right[0], UP, buff=0.2)
        cap3 = self.caption("no QEF anywhere: no minimizer can escape the cell, no clamping —",
                            "feature vertices are evaluations of the compiled analytic curves")
        self.play(FadeIn(left), FadeIn(tl), run_time=0.9)
        self.play(FadeIn(right), FadeIn(tr), run_time=0.9)
        self.play(FadeIn(cap3), run_time=0.4)
        self.wait(5.0)
        self.play(FadeOut(VGroup(left, right, tl, tr)), FadeOut(cap3),
                  poly.animate.set_stroke(opacity=1.0), FadeIn(vdots), FadeIn(fdots),
                  run_time=0.8)
        self.mesh_view = VGroup(poly, vdots, fdots)

    # ---------------------------------------------------------- chapter 7
    def ch7_audits(self):
        self.set_header("S4 — Audits and assembly: a certification, not a repair")
        checks = [
            "face-segment audit: every interior segment consumed once forward, once reversed",
            "combinatorial closed-2-manifold audit — open / non-manifold / misoriented edges: 0",
            "coincident-pair drop · debris drop · sliver flips (bounded, deterministic)",
            "irrational lattice jitter + provenance keys ⇒ bit-identical double runs",
        ]
        lines = VGroup(*[Text("✓  " + c, font_size=21, t2c={"✓": GREEN_B}) for c in checks])
        lines.arrange(DOWN, buff=0.22, aligned_edge=LEFT).move_to(DOWN * 2.7)
        self.play(self.grid.animate.set_stroke(opacity=0.0),
                  self.mob_scene.animate.set_fill(opacity=0.0).set_stroke(opacity=0.0),
                  self.mesh_view.animate.shift(UP * 0.35), run_time=0.7)

        # how the audits work: pure counting on shared edges
        ed_a, ed_b = P(4.1, 0.75), P(5.9, 0.75)
        tri_top = Polygon(ed_a, ed_b, P(5.0, 2.15), stroke_width=2.5, color=GREY_A)
        tri_bot = Polygon(ed_b, ed_a, P(5.0, -0.65), stroke_width=2.5, color=GREY_A)
        fwd = Arrow(ed_a + UP * 0.14, ed_b + UP * 0.14, buff=0.15, stroke_width=3,
                    max_tip_length_to_length_ratio=0.12, color=GREEN_B)
        rev = Arrow(ed_b + DOWN * 0.14, ed_a + DOWN * 0.14, buff=0.15, stroke_width=3,
                    max_tip_length_to_length_ratio=0.12, color=GREEN_B)
        aud = Text("count 2 · balance 0 ✓", font_size=18, color=GREEN_B)\
            .move_to(P(5.0, -1.15))
        audg = VGroup(tri_top, tri_bot, fwd, rev, aud)
        capA = self.caption("the audits are pure counting: every interior segment consumed once",
                            "forward + once reversed; every undirected edge used exactly twice,",
                            "in opposite directions — disagreeing neighbors cannot exist")
        self.play(FadeIn(capA), Create(tri_top), Create(tri_bot), run_time=0.9)
        self.play(GrowArrow(fwd), GrowArrow(rev), FadeIn(aud), run_time=0.8)
        self.wait(4.6)
        self.play(FadeOut(audg), FadeOut(capA), run_time=0.6)

        self.play(LaggedStart(*[FadeIn(l, shift=RIGHT * 0.3) for l in lines],
                              lag_ratio=0.35), run_time=2.8)
        self.wait(4.6)

        self.play(*[FadeOut(m) for m in list(self.mobjects)], run_time=1.0)
        end1 = Text("The mesh ships with a certification — not a repair.",
                    font_size=38)
        end2 = Text("SFCC  ·  docs/sfcc-meshing-algorithm.md", font_size=24, color=GREY_B)
        grp = VGroup(end1, end2).arrange(DOWN, buff=0.6)
        self.play(FadeIn(end1, scale=1.05), run_time=1.0)
        self.play(FadeIn(end2), run_time=0.6)
        self.wait(4.4)
        self.play(FadeOut(grp), run_time=1.0)


class IntroOnly(SFCC):
    """Dev helper: render just the new intro chapters for fast iteration."""

    def construct(self):
        self._header = None
        self.ch1a_sdf_cad()
        self.ch1b_problem()
        self.ch1b2_narrow()
        self.ch1c_feature_aware()
        self.ch1d_torture()


class BlendOnly(SFCC):
    """Dev helper: render just the smooth-CSG chapter for fast iteration."""

    def construct(self):
        self._header = None
        self.ch3c_blends()


class TortureOnly(SFCC):
    """Dev helper: render just the torture-test chapter for fast iteration."""

    def construct(self):
        self._header = None
        self.ch1d_torture()


# ------------------------------------------------------------- helpers
def find_leaf(leaves, x, y):
    best = None
    for l in leaves:
        cx, cy, h = l[:3]
        if abs(x - cx) <= h and abs(y - cy) <= h:
            if best is None or h < best[2]:
                best = l
    return best


def edge_root_x(x0, x1, y):
    a, b = x0, x1
    fa = f_union(a, y)
    for _ in range(48):
        m = (a + b) / 2
        if (f_union(m, y) < 0) == (fa < 0):
            a = m
        else:
            b = m
    return P((a + b) / 2, y)


def edge_root_y(y0, y1, x):
    a, b = y0, y1
    fa = f_union(x, a)
    for _ in range(48):
        m = (a + b) / 2
        if (f_union(x, m) < 0) == (fa < 0):
            a = m
        else:
            b = m
    return P(x, (a + b) / 2)


def dense_outline(step=0.02):
    pts = union_outline(n_arc=160)
    out = []
    for a, b in zip(pts, pts[1:] + [pts[0]]):
        d = np.linalg.norm(b - a)
        n = max(1, int(d / step))
        for i in range(n):
            out.append(a + (b - a) * (i / n))
    return out


def box_crossings(pts, cx, cy, h):
    def inside(p):
        return abs(p[0] - cx) <= h and abs(p[1] - cy) <= h

    res = []
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        ia = inside(a)
        if ia != inside(b):
            lo, hi = a, b
            for _ in range(28):
                m = (lo + hi) / 2
                if inside(m) == ia:
                    lo = m
                else:
                    hi = m
            res.append(((lo + hi) / 2, i, not ia))
    return res


def extract_contour(leaves):
    pts = dense_outline(0.01)
    n = len(pts)
    events = {}
    for cx, cy, h, d, kind in leaves:
        if kind == "empty":
            continue
        for p, i, entering in box_crossings(pts, cx, cy, h):
            key = (round(p[0], 3), round(p[1], 3))
            if key not in events:
                events[key] = (i + 0.5, p)
    verts = list(events.values())
    for f in LIVE_FEATURES:
        j = min(range(n), key=lambda i: np.hypot(pts[i][0] - f[0], pts[i][1] - f[1]))
        verts.append((float(j), f))
    verts.sort(key=lambda v: v[0])
    return [v[1] for v in verts]


def pin_inset(leaves, center, side=3.2):
    """Zoomed diagram of the edge cell containing SEAM_TOP: true boundary,
    face crossings, the exact pin, and the certified exit→pin→enter route."""
    lf = find_leaf(leaves, SEAM_RIGHT[0], SEAM_RIGHT[1])
    cx, cy, h = lf[:3]
    S = side / (2 * h)

    def T(p):
        return P((p[0] - cx) * S + center[0], (p[1] - cy) * S + center[1])

    def ins(p):
        return abs(p[0] - cx) <= h and abs(p[1] - cy) <= h

    pts = dense_outline(0.004)
    k = next(i for i, p in enumerate(pts) if not ins(p))
    pts = pts[k:] + pts[:k]
    run = [p for p in pts if ins(p)]
    cr = box_crossings(pts, cx, cy, h)

    cell = Square(side_length=side, color=YELLOW_C, stroke_width=2.5).move_to(center)
    bg = RoundedRectangle(width=side + 0.8, height=side + 1.3, corner_radius=0.15,
                          stroke_width=1.5, color=GREY_B, fill_color=BLACK,
                          fill_opacity=0.82).move_to(center + DOWN * 0.1)
    title = Text("edge cell (zoomed)", font_size=18, color=GREY_B)\
        .next_to(cell, UP, buff=0.14)
    boundary = VMobject(color=GREY_A, stroke_width=3)\
        .set_points_as_corners([T(p) for p in run])
    d1 = Dot(T(cr[0][0]), radius=0.09, color=RED)
    d2 = Dot(T(cr[1][0]), radius=0.09, color=RED)
    pin = Dot(T(SEAM_RIGHT), radius=0.11, color=YELLOW)
    pin_l = Text("pin (exact)", font_size=18, color=YELLOW)\
        .next_to(pin, UR, buff=0.12)
    route = VMobject(color=RED, stroke_width=5)\
        .set_points_as_corners([T(cr[0][0]), T(SEAM_RIGHT), T(cr[1][0])])
    return VGroup(VGroup(bg, cell, title), boundary, VGroup(d1, d2, pin, pin_l)), route


def crease_panel(center, mode):
    half = 1.3
    cell = Square(side_length=2 * half, color=GREY_B, stroke_width=2.5).move_to(center)
    K = center + np.array([0.15, -0.35, 0.0])

    def hit(dirv):
        d = np.array([dirv[0], dirv[1], 0.0])
        d = d / np.linalg.norm(d)
        ts = []
        for i in (0, 1):
            if abs(d[i]) > 1e-9:
                for s in (-1, 1):
                    t = (center[i] + s * half - K[i]) / d[i]
                    if t > 1e-9:
                        p = K + t * d
                        j = 1 - i
                        if abs(p[j] - center[j]) <= half + 1e-9:
                            ts.append(t)
        return K + min(ts) * d

    A = hit((-1.0, 0.55))
    B = hit((0.9, 0.75))
    bnd = VMobject(color=WHITE, stroke_width=3).set_points_as_corners([A, K, B])
    grp = VGroup(cell, bnd)
    if mode == "ms":
        lost = Polygon(A, K, B, stroke_width=0, fill_color=RED, fill_opacity=0.3)
        chord = DashedLine(A, B, color=GREY_B, stroke_width=3.5)
        cap = Text("chord — the corner is cut", font_size=20, color=GREY_A)
        grp.add(lost, chord)
    else:
        route = VMobject(color=RED, stroke_width=5).set_points_as_corners([A, K, B])
        pin = Dot(K, radius=0.1, color=YELLOW)
        cap = Text("through the exact feature", font_size=20, color=RED_B)
        grp.add(route, pin)
    cap.next_to(cell, DOWN, buff=0.15)
    grp.add(cap)
    return grp


# --------------------------------------------- ch1b: sampled-extraction demo
def wedge_normals():
    def up_normal(d):
        d = np.array([d[0], d[1], 0.0])
        d = d / np.linalg.norm(d)
        nrm = np.array([-d[1], d[0], 0.0])
        return nrm if nrm[1] > 0 else -nrm

    return up_normal((-1.0, 0.5)), up_normal((0.95, 0.62))


def wedge_f(x, y, K, n1, n2):
    v = np.array([x, y, 0.0]) - K
    return min(float(np.dot(n1, v)), float(np.dot(n2, v)))


def ray_to_box(K, dirv, C, half):
    d = np.array([dirv[0], dirv[1], 0.0])
    d = d / np.linalg.norm(d)
    ts = []
    for i in (0, 1):
        if abs(d[i]) > 1e-9:
            for s in (-1, 1):
                t = (C[i] + s * half - K[i]) / d[i]
                if t > 1e-9:
                    p = K + t * d
                    j = 1 - i
                    if abs(p[j] - C[j]) <= half + 1e-9:
                        ts.append(t)
    return K + min(ts) * d


def cell_ms_crossings(fw, x0, y0, s):
    corners = [(x0, y0), (x0 + s, y0), (x0 + s, y0 + s), (x0, y0 + s)]
    res = []
    for k in range(4):
        (xa, ya), (xb, yb) = corners[k], corners[(k + 1) % 4]
        fa = fw(xa, ya)
        if (fa < 0) != (fw(xb, yb) < 0):
            a, b = np.array([xa, ya, 0.0]), np.array([xb, yb, 0.0])
            for _ in range(40):
                m = (a + b) / 2
                if (fw(m[0], m[1]) < 0) == (fa < 0):
                    a = m
                else:
                    b = m
            res.append((a + b) / 2)
    return res


def ms_stage(fw, C, half, n, K):
    """Grid lines + per-cell marching-squares chords + the lost corner triangle."""
    step = 2 * half / n
    grid = VGroup()
    for i in range(1, n):
        x = C[0] - half + i * step
        y = C[1] - half + i * step
        grid.add(Line(P(x, C[1] - half), P(x, C[1] + half), stroke_width=1.5, color=GREY_D))
        grid.add(Line(P(C[0] - half, y), P(C[0] + half, y), stroke_width=1.5, color=GREY_D))
    chords = VGroup()
    lost = VGroup()
    for i in range(n):
        for j in range(n):
            x0, y0 = C[0] - half + i * step, C[1] - half + j * step
            crs = cell_ms_crossings(fw, x0, y0, step)
            if len(crs) == 2:
                chords.add(DashedLine(crs[0], crs[1], color=GREY_A,
                                      stroke_width=3, dash_length=0.12))
                if x0 <= K[0] <= x0 + step and y0 <= K[1] <= y0 + step:
                    lost.add(Polygon(crs[0], K, crs[1], stroke_width=0,
                                     fill_color=RED, fill_opacity=0.4))
    return VGroup(grid, chords, lost)


# --------------------------------------------- ch1b2: narrow-wedge demo
def narrow_flanks(half_angle_deg=7.0):
    t = np.tan(half_angle_deg * DEGREES)

    def up_n(d):
        d = np.array([d[0], d[1], 0.0])
        d = d / np.linalg.norm(d)
        nrm = np.array([-d[1], d[0], 0.0])
        return nrm if nrm[1] > 0 else -nrm

    return up_n((1.0, t)), -up_n((1.0, -t))


def narrow_f(x, y, K, nu, nl):
    v = np.array([x, y, 0.0]) - K
    return max(float(np.dot(nu, v)), float(np.dot(nl, v)))


def narrow_stage(fw, C, half, n, K, nu, nl):
    """Grid + reconstructed chords (flank-aware pairing) + missing-tip region."""
    step = 2 * half / n
    grid = VGroup()
    for i in range(1, n):
        x = C[0] - half + i * step
        y = C[1] - half + i * step
        grid.add(Line(P(x, C[1] - half), P(x, C[1] + half), stroke_width=1.2, color=GREY_D))
        grid.add(Line(P(C[0] - half, y), P(C[0] + half, y), stroke_width=1.2, color=GREY_D))
    chords = VGroup()
    min_x = C[0] + half
    for i in range(n):
        for j in range(n):
            x0, y0 = C[0] - half + i * step, C[1] - half + j * step
            crs = cell_ms_crossings(fw, x0, y0, step)
            pairs = []
            if len(crs) == 2:
                pairs.append(crs)
            elif len(crs) == 4:
                up, lo = [], []
                for p in crs:
                    (up if abs(np.dot(nu, p - K)) < abs(np.dot(nl, p - K)) else lo).append(p)
                for g in (up, lo):
                    if len(g) == 2:
                        pairs.append(g)
            for a, b in pairs:
                chords.add(Line(a, b, color=ORANGE, stroke_width=3.2))
                min_x = min(min_x, a[0], b[0])
    t = np.tan(7 * DEGREES)
    lost = VGroup()
    if min_x > K[0] + 1e-6:
        dx = min_x - K[0]
        lost.add(Polygon(K, P(min_x, K[1] + t * dx), P(min_x, K[1] - t * dx),
                         stroke_width=1.5, stroke_color=RED,
                         fill_color=RED, fill_opacity=0.5))
    return VGroup(grid, chords, lost)


# --------------------------------------------- mechanism insets
def tracer_inset(center, w=5.9, h=3.4):
    """Predictor-corrector seam march: tangent step, Newton snap-back."""
    bg = RoundedRectangle(width=w, height=h, corner_radius=0.15, stroke_width=1.5,
                          color=GREY_B, fill_color=BLACK, fill_opacity=0.92).move_to(center)
    title = Text("the tracer: predict along the tangent, correct with Newton",
                 font_size=16, color=GREY_B).move_to(center + UP * (h / 2 - 0.3))

    def g(x):
        return center[1] - 0.3 + 0.42 * np.sin(1.5 * (x - center[0] + 2.2))

    def gp(x):
        return 0.42 * 1.5 * np.cos(1.5 * (x - center[0] + 2.2))

    x0, x1 = center[0] - 2.6, center[0] + 2.6
    locus = VMobject(color=ORANGE, stroke_width=3).set_points_as_corners(
        [P(x, g(x)) for x in np.linspace(x0, x1, 140)])
    xs = [x0 + d for d in (0.2, 1.0, 1.55, 1.95, 2.45, 3.3, 3.9, 4.4, 5.0)]
    seed = Dot(P(xs[0], g(xs[0])), radius=0.08, color=YELLOW)
    steps = VGroup()
    for a, b in zip(xs[:-1], xs[1:]):
        pa, pb = P(a, g(a)), P(b, g(b))
        t = np.array([1.0, gp(a), 0.0])
        t = t / np.linalg.norm(t)
        pred = pa + t * np.linalg.norm(pb - pa)
        steps.add(VGroup(
            DashedLine(pa, pred, stroke_width=2, color=GREY_A, dash_length=0.07),
            Arrow(pred, pb, buff=0, stroke_width=2.5, color=RED,
                  max_tip_length_to_length_ratio=0.4),
            Dot(pb, radius=0.05, color=WHITE)))
    return VGroup(bg, title, locus, seed, steps)


def ambiguous_inset(center):
    """The MS ambiguous face: 4 crossings, 2 pairings, center sample decides."""
    bg = RoundedRectangle(width=4.5, height=4.7, corner_radius=0.15, stroke_width=1.5,
                          color=GREY_B, fill_color=BLACK, fill_opacity=0.92)\
        .move_to(center + DOWN * 0.05)
    face = Square(side_length=2.6, color=GREY_B, stroke_width=2.5).move_to(center)
    title = Text("the ambiguous face", font_size=17, color=GREY_B)\
        .move_to(center + UP * 1.95)
    h = 1.3
    dots = VGroup()
    for sx, sy, inside in ((-1, 1, True), (1, 1, False), (1, -1, True), (-1, -1, False)):
        dots.add(Dot(center + np.array([sx * h, sy * h, 0.0]), radius=0.07,
                     color=BLUE_B if inside else GREY_C))
    top, bot = center + np.array([0, h, 0.0]), center + np.array([0, -h, 0.0])
    left, right = center + np.array([-h, 0, 0.0]), center + np.array([h, 0, 0.0])
    for p in (top, bot, left, right):
        dots.add(Dot(p, radius=0.07, color=RED))
    lobes = VGroup(ArcBetweenPoints(left, top, angle=-PI / 2),
                   ArcBetweenPoints(right, bot, angle=-PI / 2))
    joined = VGroup(ArcBetweenPoints(top, right, angle=-PI / 2),
                    ArcBetweenPoints(bot, left, angle=-PI / 2))
    for arc in (*lobes, *joined):
        arc.set_stroke(GREY_A, width=2.5, opacity=0.85)
    opts = VGroup(lobes, joined)
    cdot = Dot(center, radius=0.09, color=BLUE_B)
    return VGroup(bg, face, title, dots, opts, cdot)


def loop_inset(center):
    """Directed segments chain into a loop; interior vertex projects on-surface."""
    bg = RoundedRectangle(width=5.5, height=4.5, corner_radius=0.15, stroke_width=1.5,
                          color=GREY_B, fill_color=BLACK, fill_opacity=0.92).move_to(center)
    title = Text("segments → closed loop → projected interior vertex",
                 font_size=16, color=GREY_B).move_to(center + UP * 1.95)
    c = center + DOWN * 0.1
    cellq = Square(side_length=3.0, color=BLUE_C, stroke_width=2).move_to(c)
    pts = [c + 1.15 * np.array([np.cos(a), np.sin(a), 0.0])
           for a in np.linspace(0.3, 0.3 + 2 * np.pi, 7)[:-1]]
    arrows = VGroup(*[Arrow(pts[i], pts[(i + 1) % 6], buff=0.06, stroke_width=3,
                            max_tip_length_to_length_ratio=0.18, color=RED_B)
                      for i in range(6)])
    proj = c + np.array([0.22, 0.18, 0.0])
    interior = VGroup(Dot(c, radius=0.07, color=GREY_B),
                      Arrow(c, proj, buff=0, stroke_width=2.5, color=YELLOW,
                            max_tip_length_to_length_ratio=0.3),
                      Dot(proj, radius=0.08, color=YELLOW))
    fan = VGroup(*[Line(proj, q, stroke_width=1.6, color=GREY_B, stroke_opacity=0.8)
                   for q in pts])
    form = Text("p ← p − f·∇f/|∇f|²", font_size=18, color=YELLOW)\
        .move_to(center + DOWN * 1.95)
    return VGroup(bg, title, cellq, arrows, interior, fan, form)


# --------------------------------------------- ch3c: smooth-CSG demo
def smin_round(a, b, r):
    h = min(max(0.5 + 0.5 * (b - a) / r, 0.0), 1.0)
    return b + (a - b) * h - r * h * (1.0 - h)


def f_smooth2d(x, y, r=0.55):
    return smin_round(f_box(x, y), f_circ(x, y), r)


def smooth_contour(r=0.55, n=480):
    """Zero contour of the 2D smooth union, ray-cast from an interior point."""
    c = np.array([0.35, 0.1])
    pts = []
    for k in range(n):
        th = 2 * np.pi * k / n
        d = np.array([np.cos(th), np.sin(th)])
        lo, hi = 0.0, 6.0
        for _ in range(48):
            m = (lo + hi) / 2
            q = c + m * d
            if f_smooth2d(q[0], q[1], r) < 0:
                lo = m
            else:
                hi = m
        q = c + 0.5 * (lo + hi) * d
        pts.append(P(q[0], q[1]))
    return pts


# --------------------------------------------- ch3b: feature-data cards
def make_card(title, color, lines, width=6.0):
    t = Text(title, font_size=23, weight=BOLD, color=color)
    body = VGroup(*[Text(l, font_size=20, color=GREY_A) for l in lines])\
        .arrange(DOWN, buff=0.14, aligned_edge=LEFT)
    inner = VGroup(t, body).arrange(DOWN, buff=0.28, aligned_edge=LEFT)
    if inner.width > width - 0.7:
        inner.scale_to_fit_width(width - 0.7)
    box = RoundedRectangle(width=width, height=inner.height + 0.6, corner_radius=0.15,
                           stroke_width=2, color=color, fill_color=BLACK, fill_opacity=0.6)
    inner.move_to(box.get_center()).align_to(box.get_left() + RIGHT * 0.35, LEFT)
    return VGroup(box, inner)
