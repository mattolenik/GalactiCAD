"use strict";
export class SDFRenderer {
  canvas;
  gl;
  program;
  // Buffers
  positionBuffer;
  positionLoc;
  // Uniforms
  resolutionLoc;
  timeLoc;
  cameraLoc;
  forwardLoc;
  rightLoc;
  upLoc;
  // Animation
  startTime;
  requestId = null;
  // Camera spherical parameters
  radius = 5;
  target = [0, 0, 0];
  theta = 0;
  phi = Math.PI * 0.5;
  // Speeds
  rotateSpeed = 5e-3;
  zoomSpeed = 0.1;
  panSpeed = 1;
  // Mouse state
  isRotating = false;
  isPanning = false;
  lastMouseX = 0;
  lastMouseY = 0;
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 not supported.");
    this.gl = gl;
    this.program = this.createProgram(gl, this.vs(), this.fs());
    gl.useProgram(this.program);
    this.positionLoc = gl.getAttribLocation(this.program, "aPosition");
    this.resolutionLoc = gl.getUniformLocation(this.program, "uResolution");
    this.timeLoc = gl.getUniformLocation(this.program, "uTime");
    this.cameraLoc = gl.getUniformLocation(this.program, "uCamera");
    this.forwardLoc = gl.getUniformLocation(this.program, "uForward");
    this.rightLoc = gl.getUniformLocation(this.program, "uRight");
    this.upLoc = gl.getUniformLocation(this.program, "uUp");
    this.positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(this.positionLoc);
    gl.vertexAttribPointer(this.positionLoc, 2, gl.FLOAT, false, 0, 0);
    this.onResize();
    window.addEventListener("resize", () => this.onResize());
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.canvas.addEventListener("mousemove", (e) => this.onMouseMove(e));
    this.canvas.addEventListener("mouseup", () => this.resetMouse());
    this.canvas.addEventListener("mouseleave", () => this.resetMouse());
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), {
      passive: false
    });
    this.startTime = performance.now();
    this.renderLoop = this.renderLoop.bind(this);
    this.requestId = requestAnimationFrame(this.renderLoop);
  }
  onMouseDown(e) {
    e.preventDefault();
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    if (e.button === 2) {
      this.isPanning = true;
      this.isRotating = false;
    } else if (e.button === 0) {
      this.isRotating = true;
      this.isPanning = false;
    }
  }
  resetMouse() {
    this.isRotating = false;
    this.isPanning = false;
  }
  onMouseMove(e) {
    if (!this.isRotating && !this.isPanning) return;
    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    if (this.isRotating) {
      this.theta -= dx * this.rotateSpeed;
      this.phi -= dy * this.rotateSpeed;
      const EPS = 1e-3;
      if (this.phi < EPS) this.phi = EPS;
      if (this.phi > Math.PI - EPS) this.phi = Math.PI - EPS;
    } else if (this.isPanning) {
      const fov = 1;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const aspect = w / h;
      const viewPlaneHeight = 2 * Math.tan(fov * 0.5) * this.radius;
      const viewPlaneWidth = viewPlaneHeight * aspect;
      const worldMoveX = dx / w * viewPlaneWidth;
      const worldMoveY = -(dy / h) * viewPlaneHeight;
      const camPos = this.getCameraPosition();
      const forward = this.normalize([
        this.target[0] - camPos[0],
        this.target[1] - camPos[1],
        this.target[2] - camPos[2]
      ]);
      const right = this.normalize(this.cross(forward, [0, 1, 0]));
      const up = this.normalize(this.cross(right, forward));
      this.target[0] -= (right[0] * worldMoveX + up[0] * worldMoveY) * this.panSpeed;
      this.target[1] -= (right[1] * worldMoveX + up[1] * worldMoveY) * this.panSpeed;
      this.target[2] -= (right[2] * worldMoveX + up[2] * worldMoveY) * this.panSpeed;
    }
  }
  onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;
    this.radius *= 1 + delta * this.zoomSpeed;
    if (this.radius < 0.2) this.radius = 0.2;
  }
  onResize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }
  renderLoop(now) {
    const gl = this.gl;
    const time = (now - this.startTime) * 1e-3;
    gl.uniform2f(this.resolutionLoc, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.timeLoc, time);
    const camPos = this.getCameraPosition();
    gl.uniform3f(this.cameraLoc, camPos[0], camPos[1], camPos[2]);
    const forward = this.normalize([
      this.target[0] - camPos[0],
      this.target[1] - camPos[1],
      this.target[2] - camPos[2]
    ]);
    const right = this.normalize(this.cross(forward, [0, 1, 0]));
    const up = this.normalize(this.cross(right, forward));
    gl.uniform3f(this.forwardLoc, forward[0], forward[1], forward[2]);
    gl.uniform3f(this.rightLoc, right[0], right[1], right[2]);
    gl.uniform3f(this.upLoc, up[0], up[1], up[2]);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.requestId = requestAnimationFrame(this.renderLoop);
  }
  dispose() {
    if (this.requestId) cancelAnimationFrame(this.requestId);
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
  getCameraPosition() {
    const sinPhi = Math.sin(this.phi);
    const x = this.target[0] + this.radius * sinPhi * Math.cos(this.theta);
    const y = this.target[1] + this.radius * Math.cos(this.phi);
    const z = this.target[2] + this.radius * sinPhi * Math.sin(this.theta);
    return [x, y, z];
  }
  normalize(v) {
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-8) return [0, 0, 0];
    return [v[0] / len, v[1] / len, v[2] / len];
  }
  cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }
  vs() {
    return `#version 300 es
    in vec2 aPosition;
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;
  }
  fs() {
    return `#version 300 es
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
      return length(max(d,0.0)) + min(max(d.x, max(d.y,d.z)),0.0);
    }
    float mapScene(vec3 p) {
      float d1 = sdSphere(p,1.0);
      float d2 = sdBox(p - vec3(2.0, 0.0, 0.0), vec3(0.5));
      return min(d1, d2);
    }

    float rayMarch(vec3 ro, vec3 rd){
      float t = 0.0;
      for(int i=0; i<100; i++){
        vec3 pos = ro + rd*t;
        float dist = mapScene(pos);
        if(dist < 0.001) return t;
        t += dist;
        if(t > 100.) break;
      }
      return -1.0;
    }

    vec3 calcNormal(vec3 p){
      float d = mapScene(p);
      float e = 0.001;
      return normalize(vec3(
        mapScene(p + vec3(e, 0.0, 0.0)) - d,
        mapScene(p + vec3(0.0, e, 0.0)) - d,
        mapScene(p + vec3(0.0, 0.0, e)) - d
      ));
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
      uv.x *= uResolution.x / uResolution.y;

      float fov = 1.0;
      vec3 ro = uCamera;
      vec3 rd = normalize(uRight * uv.x + uUp * uv.y + uForward * fov);

      float dist = rayMarch(ro, rd);
      if(dist > 0.0) {
        vec3 p = ro + rd * dist;
        vec3 n = calcNormal(p);
        vec3 lightDir = normalize(vec3(0.5, 1.0, 0.2));
        float diff = max(dot(n, lightDir), 0.0);
        vec3 col = vec3(0.2, 0.8, 0.4) * diff + 0.1;
        outColor = vec4(col, 1.0);
      } else {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
      }
    }
    `;
  }
  createProgram(gl, vsSrc, fsSrc) {
    const vs = this.createShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = this.createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error("Link error: " + info);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }
  createShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("Compile error: " + info);
    }
    return sh;
  }
}
