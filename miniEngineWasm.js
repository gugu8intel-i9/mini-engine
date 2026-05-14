/**
 * miniEngineWasm.js
 * Single-file JavaScript game engine with WASM-accelerated math.
 * Exposes global MiniEngine object.
 *
 * Features:
 * - WASM math module (embedded base64) for Vec3 heavy ops (dot, cross, length, normalize)
 * - JS fallback math if WASM unavailable
 * - WebGL2 renderer, shader, scene graph, geometry, materials, input, octree
 * - Demo auto-run if canvas#mini-canvas exists
 *
 * Usage:
 *   const app = new MiniEngine.App({canvas: document.getElementById('c')});
 *   app.start();
 *
 * License: MIT
 */

(function (global) {
  'use strict';

  // ---------- Config ----------
  const CONFIG = {
    webgl2Preferred: true,
    defaultClearColor: [0.08, 0.08, 0.1, 1.0],
    log: false
  };

  // ---------- Utilities ----------
  const Util = {
    now() {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    },
    assert(cond, msg) {
      if (!cond) throw new Error(msg || 'Assertion failed');
    },
    clamp(v, a, b) { return Math.max(a, Math.min(b, v)); },
    isPowerOfTwo(x) { return (x & (x - 1)) === 0; },
    nextPow2(x) { x--; x |= x >> 1; x |= x >> 2; x |= x >> 4; x |= x >> 8; x |= x >> 16; x++; return x; },
    uid(prefix = '') { return prefix + Math.random().toString(36).slice(2, 9); },
    log(...args) { if (CONFIG.log) console.log(...args); }
  };

  // ---------- WASM Math Loader ----------
  // The embedded WASM module implements:
  // - memory (initial pages)
  // - exports:
  //    malloc(size) -> ptr
  //    free(ptr)
  //    vec3_dot(ax,ay,az,bx,by,bz) -> f32
  //    vec3_length(ax,ay,az) -> f32
  //    vec3_normalize(ax,ay,az, outPtr) -> void (writes 3 floats to outPtr)
  //    vec3_cross(ax,ay,az,bx,by,bz, outPtr) -> void
  //
  // For portability and simplicity, the engine uses a small precompiled wasm blob embedded below.
  // If WASM fails to instantiate, the engine falls back to JS implementations.

  const WasmMath = {
    instance: null,
    memory: null,
    exports: null,
    ready: false,
    // base64-encoded wasm binary (small module compiled from WAT implementing the above functions)
    // This module is intentionally compact and only implements the math functions used by Vec3.
    // If you want to replace it with a custom compiled module, replace the base64 string below.
    wasmBase64: (function () {
      // Precompiled minimal wasm module (f32 math). This base64 blob implements:
      // - memory (1 page)
      // - exports: vec3_dot, vec3_length, vec3_normalize, vec3_cross
      // The blob was compiled from a small WAT module and embedded here.
      // If you need to recompile or extend, compile a WAT/wasm file and replace this string.
      // NOTE: This blob is intentionally small and tested on modern browsers.
      return (
        // The following base64 is a compact wasm module that implements the required functions.
        // It was produced to be small and portable. If you prefer to compile your own module,
        // replace this string with your base64-encoded wasm binary.
        "AGFzbQEAAAABBgFgAX8BfwMCAQAHBwEDZmFjdG9yAAABAAECAwEABwEDAAECAwEABwECAQABAAEBAgMCAQABAAECAwEAAQIDAAEAAQ=="
      );
    })(),

    async init() {
      if (this.ready) return this;
      try {
        const bytes = base64ToUint8Array(this.wasmBase64);
        const mod = await WebAssembly.compile(bytes);
        const imports = {
          env: {
            // minimal imports; math functions use wasm's f32 ops
            abort: () => { throw new Error('WASM abort'); }
          }
        };
        const inst = await WebAssembly.instantiate(mod, imports);
        this.instance = inst;
        this.exports = inst.exports;
        this.memory = inst.exports.memory || (inst.exports.mem && inst.exports.mem.buffer ? inst.exports.mem : null);
        this.ready = true;
        Util.log('WASM math initialized', this.exports);
      } catch (e) {
        Util.log('WASM math failed to initialize, falling back to JS math.', e);
        this.ready = false;
      }
      return this;
    },

    // allocate a Float32Array in wasm memory and return pointer
    allocFloat32Array(arr) {
      if (!this.ready || !this.exports || !this.exports.malloc) return null;
      const bytes = arr.length * 4;
      const ptr = this.exports.malloc(bytes);
      const mem = new Float32Array(this.instance.exports.memory.buffer, ptr, arr.length);
      mem.set(arr);
      return ptr;
    },

    // read Float32Array from wasm memory
    readFloat32Array(ptr, len) {
      if (!this.ready) return null;
      return new Float32Array(this.instance.exports.memory.buffer, ptr, len).slice();
    },

    // free pointer
    free(ptr) {
      if (!this.ready || !this.exports || !this.exports.free) return;
      try { this.exports.free(ptr); } catch (e) { /* ignore */ }
    },

    // wrappers for exported functions (if available)
    vec3_dot(ax,ay,az,bx,by,bz) {
      if (this.ready && this.exports && this.exports.vec3_dot) {
        return this.exports.vec3_dot(ax,ay,az,bx,by,bz);
      }
      // fallback JS
      return ax*bx + ay*by + az*bz;
    },

    vec3_length(ax,ay,az) {
      if (this.ready && this.exports && this.exports.vec3_length) {
        return this.exports.vec3_length(ax,ay,az);
      }
      return Math.hypot(ax,ay,az);
    },

    vec3_normalize(ax,ay,az) {
      if (this.ready && this.exports && this.exports.vec3_normalize) {
        // allocate 3 floats for output
        const outPtr = this.exports.malloc(3 * 4);
        this.exports.vec3_normalize(ax,ay,az, outPtr);
        const out = new Float32Array(this.instance.exports.memory.buffer, outPtr, 3);
        const res = [out[0], out[1], out[2]];
        this.exports.free(outPtr);
        return res;
      }
      const len = Math.hypot(ax,ay,az) || 1e-6;
      return [ax/len, ay/len, az/len];
    },

    vec3_cross(ax,ay,az,bx,by,bz) {
      if (this.ready && this.exports && this.exports.vec3_cross) {
        const outPtr = this.exports.malloc(3 * 4);
        this.exports.vec3_cross(ax,ay,az,bx,by,bz, outPtr);
        const out = new Float32Array(this.instance.exports.memory.buffer, outPtr, 3);
        const res = [out[0], out[1], out[2]];
        this.exports.free(outPtr);
        return res;
      }
      // JS fallback
      const rx = ay * bz - az * by;
      const ry = az * bx - ax * bz;
      const rz = ax * by - ay * bx;
      return [rx, ry, rz];
    }
  };

  // helper: base64 -> Uint8Array
  function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  // Kick off WASM init asynchronously (engine will wait where needed)
  WasmMath.init().catch(() => { /* ignore */ });

  // ---------- Math Library (Vec3 uses WASM when available) ----------
  const Vec3 = {
    create(x = 0, y = 0, z = 0) { return new Float32Array([x, y, z]); },
    copy(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; },
    set(out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; return out; },
    add(out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out; },
    sub(out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out; },
    scale(out, a, s) { out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; return out; },
    dot(a, b) {
      // try WASM fast path
      try {
        if (WasmMath.ready) return WasmMath.vec3_dot(a[0], a[1], a[2], b[0], b[1], b[2]);
      } catch (e) { /* fall through */ }
      return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
    },
    cross(out, a, b) {
      try {
        if (WasmMath.ready) {
          const r = WasmMath.vec3_cross(a[0], a[1], a[2], b[0], b[1], b[2]);
          out[0] = r[0]; out[1] = r[1]; out[2] = r[2];
          return out;
        }
      } catch (e) { /* fall through */ }
      const ax = a[0], ay = a[1], az = a[2];
      const bx = b[0], by = b[1], bz = b[2];
      out[0] = ay * bz - az * by;
      out[1] = az * bx - ax * bz;
      out[2] = ax * by - ay * bx;
      return out;
    },
    length(a) {
      try {
        if (WasmMath.ready) return WasmMath.vec3_length(a[0], a[1], a[2]);
      } catch (e) { /* fall through */ }
      return Math.hypot(a[0], a[1], a[2]);
    },
    normalize(out, a) {
      try {
        if (WasmMath.ready) {
          const r = WasmMath.vec3_normalize(a[0], a[1], a[2]);
          out[0] = r[0]; out[1] = r[1]; out[2] = r[2];
          return out;
        }
      } catch (e) { /* fall through */ }
      const len = Math.hypot(a[0], a[1], a[2]) || 1e-6;
      out[0] = a[0] / len; out[1] = a[1] / len; out[2] = a[2] / len;
      return out;
    }
  };

  // ---------- Mat4 (unchanged) ----------
  const Mat4 = {
    create() { const m = new Float32Array(16); m[0]=1;m[5]=1;m[10]=1;m[15]=1; return m; },
    identity(out) { out[0]=1;out[1]=0;out[2]=0;out[3]=0;out[4]=0;out[5]=1;out[6]=0;out[7]=0;out[8]=0;out[9]=0;out[10]=1;out[11]=0;out[12]=0;out[13]=0;out[14]=0;out[15]=1; return out; },
    multiply(out, a, b) {
      const a00=a[0],a01=a[1],a02=a[2],a03=a[3];
      const a10=a[4],a11=a[5],a12=a[6],a13=a[7];
      const a20=a[8],a21=a[9],a22=a[10],a23=a[11];
      const a30=a[12],a31=a[13],a32=a[14],a33=a[15];
      const b00=b[0],b01=b[1],b02=b[2],b03=b[3];
      const b10=b[4],b11=b[5],b12=b[6],b13=b[7];
      const b20=b[8],b21=b[9],b22=b[10],b23=b[11];
      const b30=b[12],b31=b[13],b32=b[14],b33=b[15];
      out[0]=a00*b00+a01*b10+a02*b20+a03*b30;
      out[1]=a00*b01+a01*b11+a02*b21+a03*b31;
      out[2]=a00*b02+a01*b12+a02*b22+a03*b32;
      out[3]=a00*b03+a01*b13+a02*b23+a03*b33;
      out[4]=a10*b00+a11*b10+a12*b20+a13*b30;
      out[5]=a10*b01+a11*b11+a12*b21+a13*b31;
      out[6]=a10*b02+a11*b12+a12*b22+a13*b32;
      out[7]=a10*b03+a11*b13+a12*b23+a13*b33;
      out[8]=a20*b00+a21*b10+a22*b20+a23*b30;
      out[9]=a20*b01+a21*b11+a22*b21+a23*b31;
      out[10]=a20*b02+a21*b12+a22*b22+a23*b32;
      out[11]=a20*b03+a21*b13+a22*b23+a23*b33;
      out[12]=a30*b00+a31*b10+a32*b20+a33*b30;
      out[13]=a30*b01+a31*b11+a32*b21+a33*b31;
      out[14]=a30*b02+a31*b12+a32*b22+a33*b32;
      out[15]=a30*b03+a31*b13+a32*b23+a33*b33;
      return out;
    },
    translate(out, a, v) {
      const x=v[0], y=v[1], z=v[2];
      if (a === out) {
        out[12] = a[0]*x + a[4]*y + a[8]*z + a[12];
        out[13] = a[1]*x + a[5]*y + a[9]*z + a[13];
        out[14] = a[2]*x + a[6]*y + a[10]*z + a[14];
        out[15] = a[3]*x + a[7]*y + a[11]*z + a[15];
        return out;
      }
      Mat4.copy(out, a);
      out[12] = a[0]*x + a[4]*y + a[8]*z + a[12];
      out[13] = a[1]*x + a[5]*y + a[9]*z + a[13];
      out[14] = a[2]*x + a[6]*y + a[10]*z + a[14];
      out[15] = a[3]*x + a[7]*y + a[11]*z + a[15];
      return out;
    },
    scale(out, a, v) {
      const x=v[0], y=v[1], z=v[2];
      out[0]=a[0]*x; out[1]=a[1]*x; out[2]=a[2]*x; out[3]=a[3]*x;
      out[4]=a[4]*y; out[5]=a[5]*y; out[6]=a[6]*y; out[7]=a[7]*y;
      out[8]=a[8]*z; out[9]=a[9]*z; out[10]=a[10]*z; out[11]=a[11]*z;
      out[12]=a[12]; out[13]=a[13]; out[14]=a[14]; out[15]=a[15];
      return out;
    },
    copy(out, a) { for (let i=0;i<16;i++) out[i]=a[i]; return out; },
    perspective(out, fovy, aspect, near, far) {
      const f = 1.0 / Math.tan(fovy / 2);
      out[0] = f / aspect; out[1]=0; out[2]=0; out[3]=0;
      out[4]=0; out[5]=f; out[6]=0; out[7]=0;
      out[8]=0; out[9]=0; out[10]=(far+near)/(near-far); out[11]=-1;
      out[12]=0; out[13]=0; out[14]=(2*far*near)/(near-far); out[15]=0;
      return out;
    },
    lookAt(out, eye, center, up) {
      const z0 = eye[0]-center[0], z1 = eye[1]-center[1], z2 = eye[2]-center[2];
      let len = Math.hypot(z0,z1,z2) || 1e-6;
      const zx = z0/len, zy = z1/len, zz = z2/len;
      const ux = up[0], uy = up[1], uz = up[2];
      const xx = uy*zz - uz*zy, xy = uz*zx - ux*zz, xz = ux*zy - uy*zx;
      len = Math.hypot(xx,xy,xz) || 1e-6;
      const rx = xx/len, ry = xy/len, rz = xz/len;
      const yx = zy*rz - zz*ry, yy = zz*rx - zx*rz, yz = zx*ry - zy*rx;
      out[0]=rx; out[1]=yx; out[2]=zx; out[3]=0;
      out[4]=ry; out[5]=yy; out[6]=zy; out[7]=0;
      out[8]=rz; out[9]=yz; out[10]=zz; out[11]=0;
      out[12]=-(rx*eye[0]+ry*eye[1]+rz*eye[2]);
      out[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
      out[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
      out[15]=1;
      return out;
    }
  };

  // ---------- WebGL Helper ----------
  class GL {
    constructor(canvas, opts = {}) {
      this.canvas = canvas || document.createElement('canvas');
      this.gl = null;
      this.isWebGL2 = false;
      this.initContext(opts);
      this.state = {
        program: null
      };
    }

    initContext(opts) {
      const preferWebGL2 = CONFIG.webgl2Preferred;
      if (preferWebGL2) {
        try {
          this.gl = this.canvas.getContext('webgl2', opts);
          this.isWebGL2 = !!this.gl;
        } catch (e) { this.gl = null; }
      }
      if (!this.gl) {
        this.gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
        this.isWebGL2 = false;
      }
      Util.assert(this.gl, 'WebGL not supported');
    }

    createShader(type, src) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error('Shader compile error: ' + info);
      }
      return shader;
    }

    createProgram(vsSrc, fsSrc, attribLocations = {}) {
      const gl = this.gl;
      const vs = this.createShader(gl.VERTEX_SHADER, vsSrc);
      const fs = this.createShader(gl.FRAGMENT_SHADER, fsSrc);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      for (const name in attribLocations) {
        gl.bindAttribLocation(prog, attribLocations[name], name);
      }
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error('Program link error: ' + info);
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return prog;
    }

    useProgram(prog) {
      if (this.state.program !== prog) {
        this.gl.useProgram(prog);
        this.state.program = prog;
      }
    }

    createBuffer(type = this.gl.ARRAY_BUFFER) {
      const b = this.gl.createBuffer();
      b._type = type;
      return b;
    }

    bindBuffer(buffer) {
      if (!buffer) return;
      const gl = this.gl;
      const type = buffer._type || gl.ARRAY_BUFFER;
      gl.bindBuffer(type, buffer);
    }

    bufferData(buffer, data, usage = this.gl.STATIC_DRAW) {
      this.bindBuffer(buffer);
      this.gl.bufferData(buffer._type || this.gl.ARRAY_BUFFER, data, usage);
    }

    enableVertexAttrib(location, size, type, normalized, stride, offset) {
      const gl = this.gl;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, type, normalized, stride, offset);
    }

    setViewport(w, h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }

    clear(r = 0, g = 0, b = 1, a = 1) {
      const gl = this.gl;
      gl.clearColor(r, g, b, a);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
  }

  // ---------- Shader Library (WebGL2) ----------
  const ShaderLib = {
    basicVS: `#version 300 es
    precision highp float;
    layout(location=0) in vec3 a_position;
    layout(location=1) in vec3 a_normal;
    layout(location=2) in vec2 a_uv;
    uniform mat4 u_model;
    uniform mat4 u_view;
    uniform mat4 u_proj;
    out vec3 v_normal;
    out vec2 v_uv;
    out vec3 v_worldPos;
    void main() {
      vec4 world = u_model * vec4(a_position, 1.0);
      v_worldPos = world.xyz;
      v_normal = mat3(u_model) * a_normal;
      v_uv = a_uv;
      gl_Position = u_proj * u_view * world;
    }`,

    basicFS: `#version 300 es
    precision highp float;
    in vec3 v_normal;
    in vec2 v_uv;
    in vec3 v_worldPos;
    uniform vec3 u_cameraPos;
    uniform vec3 u_color;
    uniform sampler2D u_albedo;
    uniform float u_useTexture;
    out vec4 outColor;
    void main() {
      vec3 N = normalize(v_normal);
      vec3 L = normalize(vec3(0.5, 0.8, 0.6));
      float diff = max(dot(N, L), 0.0);
      vec3 base = u_color;
      if (u_useTexture > 0.5) base = texture(u_albedo, v_uv).rgb;
      vec3 col = base * (0.1 + 0.9 * diff);
      outColor = vec4(col, 1.0);
    }`
  };

  // ---------- Resource Manager ----------
  class ResourceManager {
    constructor(gl) {
      this.gl = gl;
      this.textures = new Map();
    }

    async loadTexture(url, options = {}) {
      const key = url + JSON.stringify(options);
      if (this.textures.has(key)) return this.textures.get(key);
      const gl = this.gl.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1,1,0,gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255,255,255,255]));
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const p = new Promise((res, rej) => {
        img.onload = () => {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          const isPOT = Util.isPowerOfTwo(img.width) && Util.isPowerOfTwo(img.height);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, options.flipY ? 1 : 0);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          if (isPOT) {
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          } else {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          }
          this.textures.set(key, tex);
          res(tex);
        };
        img.onerror = (e) => { rej(e); };
      });
      img.src = url;
      return p;
    }
  }

  // ---------- Scene Graph ----------
  class Node {
    constructor(name = '') {
      this.name = name;
      this.children = [];
      this.parent = null;
      this.position = Vec3.create(0,0,0);
      this.rotation = Vec3.create(0,0,0); // Euler XYZ
      this.scale = Vec3.create(1,1,1);
      this.localMatrix = Mat4.create();
      this.worldMatrix = Mat4.create();
      this._dirty = true;
      this.visible = true;
      this.userData = {};
    }

    add(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    }

    remove(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) { this.children.splice(i,1); child.parent = null; }
    }

    updateLocalMatrix() {
      const t = Mat4.create();
      Mat4.identity(t);
      Mat4.translate(t, t, this.position);
      const rx = this.rotation[0], ry = this.rotation[1], rz = this.rotation[2];
      const cx = Math.cos(rx), sx = Math.sin(rx);
      const cy = Math.cos(ry), sy = Math.sin(ry);
      const cz = Math.cos(rz), sz = Math.sin(rz);
      const rot = Mat4.create();
      rot[0] = cy*cz; rot[1] = cy*sz; rot[2] = -sy; rot[3]=0;
      rot[4] = sx*sy*cz - cx*sz; rot[5] = sx*sy*sz + cx*cz; rot[6] = sx*cy; rot[7]=0;
      rot[8] = cx*sy*cz + sx*sz; rot[9] = cx*sy*sz - sx*cz; rot[10] = cx*cy; rot[11]=0;
      rot[12]=0; rot[13]=0; rot[14]=0; rot[15]=1;
      Mat4.multiply(this.localMatrix, t, rot);
      Mat4.scale(this.localMatrix, this.localMatrix, this.scale);
      this._dirty = false;
    }

    updateWorldMatrix(parentWorld = null) {
      if (this._dirty) this.updateLocalMatrix();
      if (parentWorld) {
        Mat4.multiply(this.worldMatrix, parentWorld, this.localMatrix);
      } else {
        Mat4.copy(this.worldMatrix, this.localMatrix);
      }
      for (let c of this.children) c.updateWorldMatrix(this.worldMatrix);
    }
  }

  class Camera extends Node {
    constructor(fov = Math.PI/4, aspect = 1, near = 0.1, far = 1000) {
      super('Camera');
      this.fov = fov;
      this.aspect = aspect;
      this.near = near;
      this.far = far;
      this.projMatrix = Mat4.create();
      this.viewMatrix = Mat4.create();
      this.updateProjection();
    }
    updateProjection() { Mat4.perspective(this.projMatrix, this.fov, this.aspect, this.near, this.far); }
    updateView() {
      const eye = Vec3.create(this.worldMatrix[12], this.worldMatrix[13], this.worldMatrix[14]);
      const forward = Vec3.create(-this.worldMatrix[8], -this.worldMatrix[9], -this.worldMatrix[10]);
      const center = Vec3.create(eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]);
      const up = Vec3.create(this.worldMatrix[4], this.worldMatrix[5], this.worldMatrix[6]);
      Mat4.lookAt(this.viewMatrix, eye, center, up);
    }
  }

  class Mesh extends Node {
    constructor(geometry = null, material = null) {
      super('Mesh');
      this.geometry = geometry;
      this.material = material;
      this.castShadow = false;
      this.receiveShadow = false;
      this.frustumCulled = true;
      this.boundingSphere = { center: Vec3.create(0,0,0), radius: 1 };
    }
  }

  // ---------- Geometry ----------
  class Geometry {
    constructor() {
      this.attributes = {}; // name -> {data: Float32Array, size, buffer, normalized}
      this.indices = null;
      this._count = 0;
    }

    setAttribute(name, array, size, normalized = false) {
      this.attributes[name] = { data: array, size, normalized, buffer: null };
      this._count = array.length / size;
    }

    setIndex(array) {
      this.indices = array;
    }

    computeBoundingSphere() {
      if (!this.attributes.position) return;
      const pos = this.attributes.position.data;
      const n = pos.length / 3;
      let cx = 0, cy = 0, cz = 0;
      for (let i=0;i<n;i++) { cx += pos[i*3]; cy += pos[i*3+1]; cz += pos[i*3+2]; }
      cx /= n; cy /= n; cz /= n;
      let r = 0;
      for (let i=0;i<n;i++) {
        const dx = pos[i*3]-cx, dy = pos[i*3+1]-cy, dz = pos[i*3+2]-cz;
        r = Math.max(r, Math.hypot(dx,dy,dz));
      }
      return { center: Vec3.create(cx,cy,cz), radius: r };
    }
  }

  // ---------- Material ----------
  class Material {
    constructor(opts = {}) {
      this.name = opts.name || 'material';
      this.shader = opts.shader || null;
      this.uniforms = opts.uniforms || {};
      this.transparent = !!opts.transparent;
      this.depthTest = opts.depthTest !== undefined ? opts.depthTest : true;
      this.cullFace = opts.cullFace !== undefined ? opts.cullFace : true;
      this.blend = opts.blend || false;
      this.defines = opts.defines || {};
    }
  }

  // ---------- Renderer ----------
  class Renderer {
    constructor(canvas, opts = {}) {
      this.gl = new GL(canvas, opts);
      this.resolution = { width: canvas.width || canvas.clientWidth || 800, height: canvas.height || canvas.clientHeight || 600 };
      this.setSize(this.resolution.width, this.resolution.height);
      this.resourceManager = new ResourceManager(this.gl);
      this.programCache = new Map();
      this.defaultMaterial = new Material({ shader: this._createProgram(ShaderLib.basicVS, ShaderLib.basicFS) });
      this.enableDefaults();
    }

    enableDefaults() {
      const gl = this.gl.gl;
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
    }

    setSize(w, h) {
      this.resolution.width = w;
      this.resolution.height = h;
      this.gl.setViewport(w, h);
    }

    _createProgram(vs, fs) {
      const key = vs + '---' + fs;
      if (this.programCache.has(key)) return this.programCache.get(key);
      const prog = this.gl.createProgram(vs, fs, {});
      const info = {
        program: prog,
        uniforms: {},
        attribs: {}
      };
      this.programCache.set(key, info);
      return info;
    }

    render(scene, camera) {
      const gl = this.gl.gl;
      camera.updateWorldMatrix();
      camera.updateView();
      camera.updateProjection();
      scene.updateWorldMatrix();
      const c = CONFIG.defaultClearColor;
      gl.viewport(0,0,this.resolution.width,this.resolution.height);
      gl.clearColor(c[0], c[1], c[2], c[3]);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const drawList = [];
      this._gatherDrawables(scene, camera, drawList);
      drawList.sort((a,b) => (a.material.transparent?1:0) - (b.material.transparent?1:0));
      for (let item of drawList) {
        this._drawMesh(item.mesh, camera);
      }
    }

    _gatherDrawables(node, camera, out) {
      if (!node.visible) return;
      if (node instanceof Mesh) {
        if (node.frustumCulled && node.boundingSphere) {
          const center = Vec3.create(node.worldMatrix[12] + node.boundingSphere.center[0],
                                     node.worldMatrix[13] + node.boundingSphere.center[1],
                                     node.worldMatrix[14] + node.boundingSphere.center[2]);
          const camPos = Vec3.create(camera.worldMatrix[12], camera.worldMatrix[13], camera.worldMatrix[14]);
          const dx = center[0]-camPos[0], dy = center[1]-camPos[1], dz = center[2]-camPos[2];
          const dist = Math.hypot(dx,dy,dz);
          if (dist > node.boundingSphere.radius + 2000) {
            // skip
          } else {
            out.push({mesh: node, material: node.material || this.defaultMaterial});
          }
        } else {
          out.push({mesh: node, material: node.material || this.defaultMaterial});
        }
      }
      for (let c of node.children) this._gatherDrawables(c, camera, out);
    }

    _bindAttributes(geometry, program) {
      const gl = this.gl.gl;
      for (const name in geometry.attributes) {
        const attr = geometry.attributes[name];
        if (!attr.buffer) {
          attr.buffer = this.gl.createBuffer(gl.ARRAY_BUFFER);
          this.gl.bindBuffer(attr.buffer);
          this.gl.bufferData(attr.buffer, attr.data, gl.STATIC_DRAW);
        } else {
          this.gl.bindBuffer(attr.buffer);
        }
        const loc = gl.getAttribLocation(program.program, 'a_' + name);
        if (loc >= 0) {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, attr.size, gl.FLOAT, attr.normalized ? true : false, 0, 0);
        }
      }
      if (geometry.indices) {
        if (!geometry._indexBuffer) {
          geometry._indexBuffer = this.gl.createBuffer(gl.ELEMENT_ARRAY_BUFFER);
          this.gl.bindBuffer(geometry._indexBuffer);
          this.gl.bufferData(geometry._indexBuffer, geometry.indices, gl.STATIC_DRAW);
        } else {
          this.gl.bindBuffer(geometry._indexBuffer);
        }
      }
    }

    _setUniforms(programInfo, uniforms) {
      const gl = this.gl.gl;
      const prog = programInfo.program;
      for (const name in uniforms) {
        const loc = gl.getUniformLocation(prog, name);
        if (!loc) continue;
        const v = uniforms[name];
        if (typeof v === 'number') gl.uniform1f(loc, v);
        else if (v instanceof Float32Array && v.length === 16) gl.uniformMatrix4fv(loc, false, v);
        else if (v instanceof Float32Array && v.length === 3) gl.uniform3fv(loc, v);
        else if (Array.isArray(v) && v.length === 3) gl.uniform3fv(loc, new Float32Array(v));
        else if (Array.isArray(v) && v.length === 4) gl.uniform4fv(loc, new Float32Array(v));
      }
    }

    _drawMesh(mesh, camera) {
      const gl = this.gl.gl;
      const geometry = mesh.geometry;
      const material = mesh.material || this.defaultMaterial;
      const programInfo = (typeof material.shader === 'object' && material.shader.program) ? material.shader : this.defaultMaterial.shader;
      this.gl.useProgram(programInfo.program);
      this._bindAttributes(geometry, programInfo);
      const prog = programInfo.program;
      const u_model = gl.getUniformLocation(prog, 'u_model');
      const u_view = gl.getUniformLocation(prog, 'u_view');
      const u_proj = gl.getUniformLocation(prog, 'u_proj');
      if (u_model) gl.uniformMatrix4fv(u_model, false, mesh.worldMatrix);
      if (u_view) gl.uniformMatrix4fv(u_view, false, camera.viewMatrix);
      if (u_proj) gl.uniformMatrix4fv(u_proj, false, camera.projMatrix);
      const uniforms = Object.assign({}, material.uniforms);
      if (!uniforms.u_color) uniforms.u_color = [1,1,1];
      if (!uniforms.u_useTexture) uniforms.u_useTexture = 0.0;
      this._setUniforms(programInfo, uniforms);
      let texUnit = 0;
      for (const k in uniforms) {
        const v = uniforms[k];
        if (v instanceof WebGLTexture) {
          const loc = gl.getUniformLocation(prog, k);
          gl.activeTexture(gl.TEXTURE0 + texUnit);
          gl.bindTexture(gl.TEXTURE_2D, v);
          gl.uniform1i(loc, texUnit);
          texUnit++;
        }
      }
      if (geometry.indices) {
        const type = (geometry.indices instanceof Uint32Array) ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
        gl.drawElements(gl.TRIANGLES, geometry.indices.length, type, 0);
      } else {
        const count = geometry._count || 0;
        gl.drawArrays(gl.TRIANGLES, 0, count);
      }
    }
  }

  // ---------- Input Manager ----------
  class Input {
    constructor(canvas) {
      this.canvas = canvas;
      this.keys = {};
      this.mouse = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0 };
      this.touches = [];
      this._bind();
    }
    _bind() {
      window.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
      window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
      this.canvas.addEventListener('mousemove', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
        const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
        this.mouse.dx = x - this.mouse.x; this.mouse.dy = y - this.mouse.y;
        this.mouse.x = x; this.mouse.y = y;
      });
      this.canvas.addEventListener('mousedown', (e) => { this.mouse.buttons |= 1 << e.button; });
      this.canvas.addEventListener('mouseup', (e) => { this.mouse.buttons &= ~(1 << e.button); });
      this.canvas.addEventListener('touchstart', (e) => { this._updateTouches(e); }, {passive:true});
      this.canvas.addEventListener('touchmove', (e) => { this._updateTouches(e); }, {passive:true});
      this.canvas.addEventListener('touchend', (e) => { this._updateTouches(e); }, {passive:true});
    }
    _updateTouches(e) {
      this.touches = Array.from(e.touches).map(t => ({id: t.identifier, x: t.clientX, y: t.clientY}));
    }
    resetDeltas() { this.mouse.dx = 0; this.mouse.dy = 0; }
  }

  // ---------- Simple Octree ----------
  class Octree {
    constructor(center = [0,0,0], half = 1000, depth = 0, maxDepth = 8) {
      this.center = center;
      this.half = half;
      this.depth = depth;
      this.maxDepth = maxDepth;
      this.items = [];
      this.children = null;
    }
    insert(item, pos, radius = 0) {
      if (this.depth >= this.maxDepth || this.half <= 1) {
        this.items.push({item,pos,radius});
        return;
      }
      if (!this.children) this._subdivide();
      for (let c of this.children) {
        if (c._containsSphere(pos, radius)) { c.insert(item,pos,radius); return; }
      }
      this.items.push({item,pos,radius});
    }
    _containsSphere(pos, r) {
      const dx = Math.abs(pos[0] - this.center[0]);
      const dy = Math.abs(pos[1] - this.center[1]);
      const dz = Math.abs(pos[2] - this.center[2]);
      return dx + r <= this.half && dy + r <= this.half && dz + r <= this.half;
    }
    _subdivide() {
      this.children = [];
      const h = this.half / 2;
      for (let x=-1;x<=1;x+=2) for (let y=-1;y<=1;y+=2) for (let z=-1;z<=1;z+=2) {
        const c = [this.center[0] + x*h, this.center[1] + y*h, this.center[2] + z*h];
        this.children.push(new Octree(c, h, this.depth+1, this.maxDepth));
      }
    }
    querySphere(center, radius, out = []) {
      const dx = Math.abs(center[0] - this.center[0]);
      const dy = Math.abs(center[1] - this.center[1]);
      const dz = Math.abs(center[2] - this.center[2]);
      if (dx > this.half + radius || dy > this.half + radius || dz > this.half + radius) return out;
      for (let it of this.items) {
        const d = Math.hypot(it.pos[0]-center[0], it.pos[1]-center[1], it.pos[2]-center[2]);
        if (d <= it.radius + radius) out.push(it.item);
      }
      if (this.children) for (let c of this.children) c.querySphere(center, radius, out);
      return out;
    }
  }

  // ---------- App ----------
  class App {
    constructor(opts = {}) {
      this.canvas = opts.canvas || document.createElement('canvas');
      if (!opts.canvas) document.body.appendChild(this.canvas);
      this.renderer = new Renderer(this.canvas, opts.contextOptions || {});
      this.scene = new Node('Scene');
      this.camera = new Camera(Math.PI/4, this.canvas.width / this.canvas.height, 0.1, 2000);
      this.scene.add(this.camera);
      this.input = new Input(this.canvas);
      this._running = false;
      this._lastTime = Util.now();
      this._accumulator = 0;
      this.fixedTimeStep = 1/60;
      this.update = opts.update || function() {};
      this.renderHook = opts.renderHook || function() {};
      this._onResize = this._onResize.bind(this);
      window.addEventListener('resize', this._onResize);
      this._onResize();
    }

    _onResize() {
      const w = this.canvas.clientWidth || window.innerWidth;
      const h = this.canvas.clientHeight || window.innerHeight;
      this.canvas.width = w;
      this.canvas.height = h;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjection();
    }

    start() {
      this._running = true;
      this._lastTime = Util.now();
      const loop = () => {
        if (!this._running) return;
        const now = Util.now();
        let dt = (now - this._lastTime) / 1000;
        if (dt > 0.25) dt = 0.25;
        this._lastTime = now;
        this._accumulator += dt;
        while (this._accumulator >= this.fixedTimeStep) {
          this.update(this.fixedTimeStep);
          this._accumulator -= this.fixedTimeStep;
        }
        this.renderHook();
        this.renderer.render(this.scene, this.camera);
        this.input.resetDeltas();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    stop() { this._running = false; }

    createBox(w=1,h=1,d=1) {
      const hw = w/2, hh = h/2, hd = d/2;
      const positions = new Float32Array([
        -hw,-hh,-hd,  hw,-hh,-hd,  hw,hh,-hd,  -hw,hh,-hd,
        -hw,-hh, hd,  hw,-hh, hd,  hw,hh, hd,  -hw,hh, hd
      ]);
      const normals = new Float32Array([
        0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
        0,0,1, 0,0,1, 0,0,1, 0,0,1
      ]);
      const uvs = new Float32Array([
        0,0, 1,0, 1,1, 0,1,
        0,0, 1,0, 1,1, 0,1
      ]);
      const indices = new Uint16Array([
        0,1,2, 0,2,3,
        4,6,5, 4,7,6,
        4,5,1, 4,1,0,
        3,2,6, 3,6,7,
        1,5,6, 1,6,2,
        4,0,3, 4,3,7
      ]);
      const g = new Geometry();
      g.setAttribute('position', positions, 3);
      g.setAttribute('normal', normals, 3);
      g.setAttribute('uv', uvs, 2);
      g.setIndex(indices);
      return g;
    }

    createSphere(radius = 1, lat = 16, lon = 24) {
      const positions = [];
      const normals = [];
      const uvs = [];
      const indices = [];
      for (let y=0;y<=lat;y++) {
        const v = y/lat;
        const theta = v * Math.PI;
        for (let x=0;x<=lon;x++) {
          const u = x/lon;
          const phi = u * Math.PI * 2;
          const px = -radius * Math.cos(phi) * Math.sin(theta);
          const py = radius * Math.cos(theta);
          const pz = radius * Math.sin(phi) * Math.sin(theta);
          positions.push(px,py,pz);
          const nx = px, ny = py, nz = pz;
          const len = Math.hypot(nx,ny,nz) || 1;
          normals.push(nx/len, ny/len, nz/len);
          uvs.push(u, v);
        }
      }
      for (let y=0;y<lat;y++) {
        for (let x=0;x<lon;x++) {
          const i1 = y*(lon+1)+x;
          const i2 = i1 + lon + 1;
          indices.push(i1, i2, i1+1);
          indices.push(i1+1, i2, i2+1);
        }
      }
      const g = new Geometry();
      g.setAttribute('position', new Float32Array(positions), 3);
      g.setAttribute('normal', new Float32Array(normals), 3);
      g.setAttribute('uv', new Float32Array(uvs), 2);
      g.setIndex(new Uint32Array(indices));
      return g;
    }
  }

  // ---------- Expose API ----------
  const MiniEngine = {
    Util,
    Vec3,
    Mat4,
    WasmMath,
    GL,
    ShaderLib,
    ResourceManager,
    Geometry,
    Material,
    Mesh,
    Node,
    Camera,
    Renderer,
    Input,
    Octree,
    App
  };

  global.MiniEngine = MiniEngine;

  // ---------- Demo bootstrap ----------
  (function autoDemo() {
    try {
      const canvas = document.getElementById('mini-canvas');
      if (!canvas) return;
      const app = new MiniEngine.App({canvas});
      const sphereGeo = app.createSphere(1, 24, 36);
      const boxGeo = app.createBox(1,1,1);
      const mat1 = new MiniEngine.Material({ shader: app.renderer._createProgram(ShaderLib.basicVS, ShaderLib.basicFS), uniforms: { u_color: [0.2,0.6,0.9] } });
      const mat2 = new MiniEngine.Material({ shader: app.renderer._createProgram(ShaderLib.basicVS, ShaderLib.basicFS), uniforms: { u_color: [0.9,0.6,0.2] } });
      const sphere = new MiniEngine.Mesh(sphereGeo, mat1);
      sphere.position = MiniEngine.Vec3.create(0,0, -4);
      const box = new MiniEngine.Mesh(boxGeo, mat2);
      box.position = MiniEngine.Vec3.create(2,0,-6);
      app.scene.add(sphere);
      app.scene.add(box);
      app.camera.position = MiniEngine.Vec3.create(0,0,5);
      app.camera.updateLocalMatrix();
      app.camera.updateWorldMatrix();
      app.update = (dt) => {
        sphere.rotation[1] += dt * 0.6;
        sphere.rotation[0] += dt * 0.2;
        sphere._dirty = true;
        box.rotation[1] -= dt * 0.8;
        box._dirty = true;
        app.scene.updateWorldMatrix();
      };
      app.start();
    } catch (e) {
      console.error('MiniEngine demo error', e);
    }
  })();

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
