/**
 * WebGL mesh page-curl renderer — the 「仿真」turn on the desktop build.
 *
 * A page turn cannot move the live page as a layer: the page is a slice of one
 * big multi-column iframe. So the platform webview snapshots the reading pane
 * as a bitmap (`webview_capture_region`), the live view turns instantly
 * underneath, and this draws the captured sheet curling away on top of it.
 *
 * The curl is a real cylinder mesh (readest#555), not a CSS card flip: content
 * before the fold stays flat, everything past it wraps over the roll and comes
 * out mirrored on top, showing the back of the page — the content bleeding
 * through the theme paper supplied via `setBackdrop`. The canvas is transparent
 * wherever the sheet has curled away, so the live page shows through.
 *
 * With two columns on screen only the outer column is a leaf: hinged at the
 * spine like a real book page, and faded out over the last stretch rather than
 * landed on a mirror. Landing on the incoming column would need a second
 * capture taken under a native cover the snapshot cannot see; readest has that
 * on iOS alone, so this is the same paper-back fallback its macOS build runs.
 *
 * The renderer knows nothing about capture or gestures: the caller hands it an
 * ImageBitmap of the outgoing page and drives `render(progress, rtl, grabY)`.
 */

const VERTEX_SHADER = `
attribute vec2 aPos;      // page coords in [0,1]x[0,1]
uniform vec2 uPage;       // page size in px
uniform vec2 uFold;       // a point on the fold line, page px
uniform vec2 uDir;        // fold normal (unit): points toward the curled side
uniform float uRadius;    // cylinder radius, px
uniform vec2 uLeaf;       // open x interval (page px) of the leaf that may deform
varying vec2 vUv;
varying float vLift;      // 0 flat .. 1 on top of the cylinder / landed

const float PI = 3.141592653589793;

void main() {
  vec2 p = aPos * uPage;
  float s = dot(p - uFold, uDir);
  float lift = 0.0;
  // Vertices on the spine itself never move: they are the hinge shared with
  // the flat inner column, which must not stretch.
  if (p.x > uLeaf.x && p.x < uLeaf.y && s > 0.0) {
    float r = max(uRadius, 1.0e-3);
    if (s < PI * r) {
      float wrapped = r * sin(s / r);
      float z = r * (1.0 - cos(s / r));
      p -= uDir * (s - wrapped);
      lift = z / (2.0 * r);
    } else {
      // Past the half turn: lies flat on top, mirrored about the fold. With
      // a zero radius this is an exact reflection, which is how a leaf lands
      // on the facing page.
      p -= uDir * (2.0 * s - PI * r);
      lift = 1.0;
    }
  }
  // Texture row 0 is the top of the captured page and aPos.y = 0 is the top
  // of the page, so page coordinates are texture coordinates as-is. Do NOT
  // rely on UNPACK_FLIP_Y_WEBGL to reconcile them: WebKit ignores it for
  // ImageBitmap uploads, which turned the curl upside down on iOS.
  vUv = aPos;
  vLift = lift;
  vec2 clip = (p / uPage) * 2.0 - 1.0;
  // Lifted parts draw on top of flat parts.
  gl_Position = vec4(clip.x, -clip.y, -vLift * 0.5, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTex;
uniform sampler2D uBack;
varying vec2 vUv;
varying float vLift;

void main() {
  vec4 c = texture2D(uTex, vUv);
  if (gl_FrontFacing) {
    // Slight contact shading as the page lifts.
    c.rgb *= 1.0 - 0.18 * vLift;
  } else {
    // The back of the page: the mirrored content bleeding through the paper —
    // the theme background supplied via setBackdrop.
    vec3 paper = texture2D(uBack, vUv).rgb;
    c.rgb = mix(c.rgb, paper, 0.72);
    c.rgb *= 1.0 - 0.08 * vLift;
  }
  gl_FragColor = vec4(c.rgb, c.a);
}
`;

const GRID = 64;
// A leaf without an incoming-page texture lands showing paper; fade the whole
// canvas over the last stretch so the live page takes over smoothly.
const LEAF_FADE_START = 0.8;

/** Fold line, cylinder and hinge for one frame. */
export interface CurlGeometry {
  /** Fold normal, unit: points toward the side that curls. */
  dir: [number, number];
  /** A point on the fold line, in page px. */
  fold: [number, number];
  /** Cylinder radius, px. */
  radius: number;
  /** Open x interval (page px) of the leaf that may deform; the spine is the
   *  hinge and must not stretch, so the closed side is fenced off. */
  leaf: [number, number];
}

/**
 * Where the sheet is folded at `progress` (0 = flat, 1 = fully turned).
 *
 * `grabY` is where the reader lifted the page: near 1 the fold starts as a
 * steep diagonal pinch at the bottom corner and straightens as the turn
 * completes, near 0.5 it folds straight. The tilt decays with progress, so the
 * far side of the page stays flat early in the turn yet the whole page still
 * clears by the end.
 *
 * Split out from `render` so the sweep is testable without a GPU.
 */
export const curlGeometry = (
  progress: number,
  grabY: number,
  width: number,
  height: number,
  columns: number,
  rtl: boolean,
): CurlGeometry => {
  const leaf = columns >= 2;
  // The sheet being turned: the whole pane, or the outer column of a spread.
  const leafWidth = leaf ? width / 2 : width;
  // Only the spine is a hinge; the outer edge (and a single page) is open.
  const leafMin = leaf && !rtl ? width / 2 : -1e9;
  const leafMax = leaf && rtl ? width / 2 : 1e9;

  const tilt = (grabY - 0.5) * 1.8 * (1 - progress);
  const dx = rtl ? -1 : 1;
  const len = Math.hypot(1, tilt);
  const dir: [number, number] = [dx / len, tilt / len];

  let radius: number;
  let travel: number;
  if (leaf) {
    // The roll tightens all the way to nothing so the leaf lands flat on the
    // inner column, and the fold stops exactly at the spine.
    radius = 0.16 * leafWidth * (1 - progress * progress);
    travel = leafWidth;
  } else {
    // The cylinder tightens slightly as the page lifts off.
    radius = Math.max(24, 0.16 * width * (1 - 0.4 * progress));
    // The fold sweeps from the grabbed edge along the grab row; by progress 1
    // (tilt 0) it must cross the page plus the final half-circumference so the
    // spine-side column has fully wrapped off.
    const endRadius = Math.max(24, 0.16 * width * 0.6);
    travel = width + Math.PI * endRadius;
  }

  const startX = rtl ? 0 : width;
  return {
    dir,
    radius,
    leaf: [leafMin, leafMax],
    fold: [startX - dir[0] * travel * progress, grabY * height - dir[1] * travel * progress],
  };
};

/** Where the page lifted: 1 grabs the outer edge (rtl mirrors that), 0.5 folds straight. */
export const CENTRED_GRAB = 0.5;

type Uniforms = {
  uPage: WebGLUniformLocation | null;
  uFold: WebGLUniformLocation | null;
  uDir: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
  uLeaf: WebGLUniformLocation | null;
  uTex: WebGLUniformLocation | null;
  uBack: WebGLUniformLocation | null;
};

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export class PageCurlRenderer {
  #canvas: HTMLCanvasElement | null = null;
  #gl: WebGLRenderingContext | null = null;
  #uniforms: Uniforms | null = null;
  #tex: WebGLTexture | null = null;
  #backTex: WebGLTexture | null = null;
  #columns = 1;
  #indexCount = 0;
  #width = 0;
  #height = 0;

  /** Mount the overlay canvas covering `width` x `height` CSS px in `container`. */
  attach(container: HTMLElement, width: number, height: number, dpr = window.devicePixelRatio) {
    this.#width = width;
    this.#height = height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: `${width}px`,
      height: `${height}px`,
      pointerEvents: "none",
      // Above the page, below the reader's own floating chrome (z-20), so a
      // page-turn arrow stays put while the sheet turns under it.
      zIndex: "10",
    });
    container.appendChild(canvas);
    this.#canvas = canvas;

    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true });
    if (!gl) {
      this.dispose();
      throw new Error("WebGL 不可用");
    }
    this.#gl = gl;

    const compile = (type: number, src: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("createShader failed");
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`shader: ${gl.getShaderInfoLog(shader) ?? ""}`);
      }
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new Error("createProgram failed");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program: ${gl.getProgramInfoLog(program) ?? ""}`);
    }
    gl.useProgram(program);

    // Grid mesh of GRID x GRID quads over the unit page. GRID is even, so a
    // two-column spine falls on a grid line and no quad straddles the hinge.
    const verts: number[] = [];
    for (let y = 0; y <= GRID; y++) {
      for (let x = 0; x <= GRID; x++) {
        verts.push(x / GRID, y / GRID);
      }
    }
    const indices: number[] = [];
    const at = (x: number, y: number) => y * (GRID + 1) + x;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        indices.push(at(x, y), at(x + 1, y), at(x, y + 1));
        indices.push(at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
      }
    }
    this.#indexCount = indices.length;

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    const loc = (name: string) => gl.getUniformLocation(program, name);
    const uniforms: Uniforms = {
      uPage: loc("uPage"),
      uFold: loc("uFold"),
      uDir: loc("uDir"),
      uRadius: loc("uRadius"),
      uLeaf: loc("uLeaf"),
      uTex: loc("uTex"),
      uBack: loc("uBack"),
    };
    this.#uniforms = uniforms;
    gl.uniform2f(uniforms.uPage, width, height);

    // Back-face paper on unit 1: plain white until setBackdrop supplies the
    // theme background.
    this.#backTex = this.#placeholderTexture(gl, 1, [255, 255, 255, 255]);
    gl.uniform1i(uniforms.uBack, 1);
    gl.activeTexture(gl.TEXTURE0);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    // The vertex shader flips Y into clip space, mirroring triangle winding:
    // the grid's quads come out clockwise, so declare CW as front-facing or
    // gl_FrontFacing (front page vs whitened back) is inverted.
    gl.frontFace(gl.CW);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  #placeholderTexture(gl: WebGLRenderingContext, unit: number, rgba: number[]) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(rgba),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /**
   * Upload the captured page — drawn at progress 0 it exactly covers it.
   *
   * The texture is reused across turns rather than recreated: the renderer now
   * outlives a single turn (see `capturedTurn.ts`), and one upload per turn is
   * already the cost of a fresh capture.
   */
  setTexture(source: TexImageSource) {
    const gl = this.#gl;
    const uniforms = this.#uniforms;
    if (!gl || !uniforms) return;
    if (!this.#tex) this.#tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#tex);
    // Upload unflipped; the vertex shader samples page coordinates directly.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uniforms.uTex, 0);
  }

  /** Paper drawn on the back of the curling page (the reading surface colour). */
  setBackdrop(source: TexImageSource) {
    const gl = this.#gl;
    if (!gl || !this.#backTex) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.#backTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** How many page columns the captured pane holds; with 2, only the outer
   *  column turns, hinged at the spine (the middle of the pane). */
  setColumns(columns: number) {
    this.#columns = columns >= 2 ? 2 : 1;
  }

  /**
   * Show or hide the sheet without tearing the renderer down.
   *
   * `hidden` is how the controller keeps a warm renderer parked over the pane
   * between turns: `visibility: hidden` costs nothing to composite and, unlike
   * `opacity: 0`, is invisible to the native snapshot — a parked sheet must not
   * be photographed into the next one.
   */
  setVisible(visible: boolean) {
    if (this.#canvas) this.#canvas.style.visibility = visible ? "" : "hidden";
  }

  /** Draw the curl at `progress` (0 = flat, 1 = fully turned). */
  render(progress: number, rtl: boolean, grabY = CENTRED_GRAB) {
    const gl = this.#gl;
    const uniforms = this.#uniforms;
    if (!gl || !uniforms) return;
    const { dir, radius, leaf, fold } = curlGeometry(
      progress,
      grabY,
      this.#width,
      this.#height,
      this.#columns,
      rtl,
    );

    if (this.#canvas) {
      const fade = this.#columns >= 2 ? 1 - smoothstep(LEAF_FADE_START, 1, progress) : 1;
      this.#canvas.style.opacity = fade < 1 ? String(fade) : "";
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform2f(uniforms.uFold, fold[0], fold[1]);
    gl.uniform2f(uniforms.uDir, dir[0], dir[1]);
    gl.uniform1f(uniforms.uRadius, radius);
    gl.uniform2f(uniforms.uLeaf, leaf[0], leaf[1]);
    gl.drawElements(gl.TRIANGLES, this.#indexCount, gl.UNSIGNED_SHORT, 0);
  }

  dispose() {
    const gl = this.#gl;
    if (gl) {
      if (this.#tex) gl.deleteTexture(this.#tex);
      if (this.#backTex) gl.deleteTexture(this.#backTex);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.#canvas?.remove();
    this.#canvas = null;
    this.#gl = null;
    this.#uniforms = null;
    this.#tex = null;
    this.#backTex = null;
  }
}
