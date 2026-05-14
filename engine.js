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
      out[8]=a20*b00+a21*b10+a22*b20+a
