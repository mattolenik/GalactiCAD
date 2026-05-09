// Shared Phase-3 logic: project a cube-edge Hermite crossing onto an explicit
// feature locus before QEF accumulation. Used by MDC (`edgeDetection_Pass3`)
// and mirrored on the CPU for SHREC MergeSharp (`mdc-feature-crossing-project.mts`).
//
// Include after `struct ComponentFeature` and `//:) include "hg_sdf.wgsl"`.
// On the WGSL side this file forward-references `sceneSDF_mid` and `uniforms`
// (both defined later in `mdc.wgsl`); WGSL allows forward function and module-scope
// references inside the same shader module.

/** Same symbol as `mdc.wgsl`; keep numerically in sync with TS `MDC_LINE_QEF_PROJECT_SCALE`. */
const MDC_LINE_QEF_PROJECT_SCALE: f32 = 1.85;
/** Same symbol as `mdc.wgsl`; keep numerically in sync with TS `MDC_RING_QEF_PROJECT_SCALE`. */
const MDC_RING_QEF_PROJECT_SCALE: f32 = 1.85;

/** Max fixed-point iterations for `mdcClosestPointOnLineFeatureIterative`. */
const MDC_LINE_ITERATIVE_MAX_ITERS: u32 = 4u;
/** Iteration tolerance scale (× voxelSize). Stops when |Δq|² < (voxelSize·scale)². */
const MDC_LINE_ITERATIVE_TOL_SCALE: f32 = 1e-3;

fn mdcClosestPointOnRingFeature(f: ComponentFeature, p: vec3f) -> vec3f {
    let radial = f.point - f.axisCenter;
    let ringR = length(radial);
    if (ringR < 1e-8) { return f.point; }
    let tang = safeUnit3(f.tangent);
    let axisRaw = cross(tang, radial);
    if (lengthSqr(axisRaw) < 1e-12) { return f.point; }
    let ringAxis = safeUnit3(axisRaw);
    let v = p - f.axisCenter;
    let inPlane = v - ringAxis * dot(v, ringAxis);
    let rho = length(inPlane);
    if (rho > 1e-8) {
        return f.axisCenter + inPlane * (ringR / rho);
    }
    return f.point;
}

fn featureLineTangent(f: ComponentFeature) -> vec3f {
    if (lengthSqr(f.tangent) > 1e-8) { return safeUnit3(f.tangent); }
    if (f.normalCount >= 2u) {
        let t = cross(f.n0, f.n1);
        if (lengthSqr(t) > 1e-8) { return safeUnit3(t); }
    }
    return vec3f(0.0);
}

fn mdcClosestPointOnLineFeature(f: ComponentFeature, p: vec3f) -> vec3f {
    let tangent = featureLineTangent(f);
    if (lengthSqr(tangent) > 1e-8) {
        return f.point + tangent * dot(p - f.point, tangent);
    }
    return p;
}

/** Tangent extracted from a fresh `SDFResultMid` sample, mirroring `featureLineTangent`. */
fn featureLineTangentFromMid(s: SDFResultMid) -> vec3f {
    if (lengthSqr(s.featureTangent) > 1e-8) { return safeUnit3(s.featureTangent); }
    if (s.featureNormalCount >= 2u) {
        let t = cross(s.n, s.featureN1);
        if (lengthSqr(t) > 1e-8) { return safeUnit3(t); }
    }
    return vec3f(0.0);
}

// Project `intersectionPos` onto the LINE feature curve produced by the operator
// stack at this scene point.
//
// Each `sceneSDF_mid` call returns the local linearization (point, tangent) of
// whatever curve the operator chain produces, transported correctly by every
// operator's `sdf*FeatureMid` helper. Fixed-point iteration over those local
// frames converges to the actual closest point on the curve (helix from twist,
// arc from bend, taper-warped polyline, etc.) without per-operator special cases
// in the projection itself.
//
// Crossings whose own local sample lacks a LINE feature (e.g. a side-face
// crossing within a LINE-classified cell) are left at `intersectionPos` —
// projecting them onto a tangent line elsewhere in the cell mixes inconsistent
// data into the QEF and is what caused the "stair-step" chips along helical
// edges. Leaving them put preserves the QEF's normal-plane geometry; the cell's
// inferred-feature plane bias still pulls the vertex onto the curve.
fn mdcLineFeatureFollow(intersectionPos: vec3f) -> vec3f {
    var q = intersectionPos;
    let tol = uniforms.voxelSize * MDC_LINE_ITERATIVE_TOL_SCALE;
    let tol2 = tol * tol;
    for (var i = 0u; i < MDC_LINE_ITERATIVE_MAX_ITERS; i = i + 1u) {
        let s = sceneSDF_mid(q);
        if (s.featureKind != MID_FEATURE_LINE) { return intersectionPos; }
        let t = featureLineTangentFromMid(s);
        if (lengthSqr(t) < 1e-8) { return intersectionPos; }
        let qNew = s.featurePoint + t * dot(q - s.featurePoint, t);
        let dq = qNew - q;
        q = qNew;
        if (lengthSqr(dq) < tol2) { break; }
    }
    return q;
}

fn mdcSeamFeatureFollow(intersectionPos: vec3f) -> vec3f {
    var q = intersectionPos;
    let tol = uniforms.voxelSize * MDC_LINE_ITERATIVE_TOL_SCALE;
    let tol2 = tol * tol;
    for (var i = 0u; i < MDC_LINE_ITERATIVE_MAX_ITERS; i = i + 1u) {
        let s = sceneSDF_mid(q);
        if (s.featureKind != MID_FEATURE_BOOLEAN_SEAM) { return intersectionPos; }
        let t = featureLineTangentFromMid(s);
        if (lengthSqr(t) < 1e-8) { return intersectionPos; }
        let qNew = s.featurePoint + t * dot(q - s.featurePoint, t);
        let dq = qNew - q;
        q = qNew;
        if (lengthSqr(dq) < tol2) { break; }
    }
    return q;
}

fn mdcClosestPointOnLineFeatureIterative(feature: ComponentFeature, intersectionPos: vec3f) -> vec3f {
    return mdcLineFeatureFollow(intersectionPos);
}
fn mdcClosestPointOnSeamFeatureIterative(feature: ComponentFeature, intersectionPos: vec3f) -> vec3f {
    return mdcSeamFeatureFollow(intersectionPos);
}

fn mdcFeatureProjectCrossingPosition(
    intersectionPos: vec3f,
    feature: ComponentFeature,
    explicitRingFeat: ComponentFeature,
    featureConstraintsEnabled: bool,
    explicitLineDist: f32,
    explicitRingDist: f32,
    explicitCornerDist: f32,
    explicitSeamDist: f32,
    lineQefProjection: bool,
    ringQefCircleProjection: bool,
) -> vec3f {
    var projPos = intersectionPos;
    if (!featureConstraintsEnabled) { return projPos; }
    if (feature.kind == MID_FEATURE_LINE && explicitLineDist < 1e8) {
        if (lineQefProjection) {
            // Curve-following projection: the per-cell `feature` is only a single-sample
            // tangent line, but `sceneSDF_mid` evaluated at the iterate gives a fresh
            // local linearization of whatever curve the operator stack produces (helix
            // under twist, arc under bend, etc.). Falls back to the static projection
            // if the iteration drifts off the LINE feature kind.
            projPos = mdcClosestPointOnLineFeatureIterative(feature, intersectionPos);
        } else {
            projPos = intersectionPos;
        }
    } else if (feature.kind == MID_FEATURE_RING && explicitRingDist < 1e8) {
        if (ringQefCircleProjection) {
            projPos = mdcClosestPointOnRingFeature(explicitRingFeat, intersectionPos);
        } else {
            projPos = intersectionPos;
        }
    } else if (feature.kind == MID_FEATURE_CORNER && explicitCornerDist < 1e8) {
        projPos = feature.point;
    } else if (feature.kind == MID_FEATURE_BOOLEAN_SEAM && explicitSeamDist < 1e8) {
        // Same curve-following idea for seams; falls through to the static line
        // projection on the cell's `feature` if the iterate leaves the seam locus.
        projPos = mdcClosestPointOnSeamFeatureIterative(feature, intersectionPos);
    }
    return projPos;
}
