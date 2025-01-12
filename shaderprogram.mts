export class ShaderProgram {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vertexShader: WebGLShader | null = null;
  private fragmentShader: WebGLShader | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const program = this.gl.createProgram();
    if (!program) throw new Error("Failed to create program");
    this.program = program;
  }

  private compileShader(source: string, type: number): WebGLShader {
    const shader = this.gl.createShader(type);
    if (!shader) throw new Error("Failed to create shader");

    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(shader);
      this.gl.deleteShader(shader);
      throw new Error("Shader compile error: " + info);
    }

    return shader;
  }

  reload(vertexSource: string, fragmentSource: string): WebGLProgram {
    const newVertexShader = this.compileShader(
      vertexSource,
      this.gl.VERTEX_SHADER
    );
    const newFragmentShader = this.compileShader(
      fragmentSource,
      this.gl.FRAGMENT_SHADER
    );

    const newProgram = this.gl.createProgram();
    if (!newProgram) throw new Error("Failed to create program");

    this.gl.attachShader(newProgram, newVertexShader);
    this.gl.attachShader(newProgram, newFragmentShader);
    this.gl.linkProgram(newProgram);

    if (!this.gl.getProgramParameter(newProgram, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(newProgram);
      this.gl.deleteProgram(newProgram);
      this.gl.deleteShader(newVertexShader);
      this.gl.deleteShader(newFragmentShader);
      throw new Error("Program link error: " + info);
    }

    // Clean up old resources
    if (this.vertexShader) {
      this.gl.deleteShader(this.vertexShader);
    }
    if (this.fragmentShader) {
      this.gl.deleteShader(this.fragmentShader);
    }
    this.gl.deleteProgram(this.program);

    // Set new resources
    this.program = newProgram;
    this.vertexShader = newVertexShader;
    this.fragmentShader = newFragmentShader;
    this.gl.useProgram(this.program);
    return this.program;
  }

  getProgram(): WebGLProgram {
    return this.program;
  }

  getUniformLocation(name: string): WebGLUniformLocation | null {
    return this.gl.getUniformLocation(this.program, name);
  }

  getAttribLocation(name: string): number {
    return this.gl.getAttribLocation(this.program, name);
  }
}
