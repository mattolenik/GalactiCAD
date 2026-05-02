// Shared Phase-3 logic: project a cube-edge Hermite crossing onto an explicit
// feature locus before QEF accumulation. Used by MDC (`edgeDetection_Pass3`)
// and mirrored on the CPU for SHREC MergeSharp (`mdc-feature-crossing-project.mts`).
//
// Include after `struct ComponentFeature` and `//:) include "hg_sdf.wgsl"`.

/** Same symbol as `mdc.wgsl`; keep numerically in sync with TS `MDC_LINE_QEF_PROJECT_SCALE`. */
const MDC_LINE_QEF_PROJECT_SCALE: f32 = 1.85;
/** Same symbol as `mdc.wgsl`; keep numerically in sync with TS `MDC_RING_QEF_PROJECT_SCALE`. */
const MDC_RING_QEF_PROJECT_SCALE: f32 = 1.85;

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
            projPos = mdcClosestPointOnLineFeature(feature, intersectionPos);
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
        let tangent = featureLineTangent(feature);
        if (lengthSqr(tangent) > 1e-8) {
            projPos = feature.point + tangent * dot(intersectionPos - feature.point, tangent);
        }
    }
    return projPos;
}
