#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uCamera;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;

out vec4 outColor;

float sdSphere(vec3 p, float r) {
    return length(p) - r;
}
float sdBox(vec3 p, vec3 b) {
    vec3 d = abs(p) - b;
    return length(max(d, 0.0f)) + min(max(d.x, max(d.y, d.z)), 0.0f);
}
float mapScene(vec3 p) {
    float d1 = sdSphere(p, 1.0f);
    float d2 = sdBox(p - vec3(2.0f, 0.0f, 0.0f), vec3(0.5f));
    return min(d1, d2);
}

float rayMarch(vec3 ro, vec3 rd) {
    float t = 0.0f;
    for(int i = 0; i < 100; i++) {
        vec3 pos = ro + rd * t;
        float dist = mapScene(pos);
        if(dist < 0.001f)
            return t;
        t += dist;
        if(t > 100.f)
            break;
    }
    return -1.0f;
}

vec3 calcNormal(vec3 p) {
    float d = mapScene(p);
    float e = 0.001f;
    return normalize(vec3(mapScene(p + vec3(e, 0.0f, 0.0f)) - d, mapScene(p + vec3(0.0f, e, 0.0f)) - d, mapScene(p + vec3(0.0f, 0.0f, e)) - d));
}

void main() {
    vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0f - 1.0f;
    uv.x *= uResolution.x / uResolution.y;

    float fov = 1.0f;
    vec3 ro = uCamera;
    vec3 rd = normalize(uRight * uv.x + uUp * uv.y + uForward * fov);

    float dist = rayMarch(ro, rd);
    if(dist > 0.0f) {
        vec3 p = ro + rd * dist;
        vec3 n = calcNormal(p);
        vec3 lightDir = normalize(vec3(0.5f, 1.0f, 0.2f));
        float diff = max(dot(n, lightDir), 0.0f);
        vec3 col = vec3(0.2f, 0.8f, 0.4f) * diff + 0.1f;
        outColor = vec4(col, 1.0f);
    } else {
        outColor = vec4(0.0f, 0.0f, 0.0f, 1.0f);
    }
}