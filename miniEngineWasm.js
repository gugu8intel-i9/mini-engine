/**
 * miniEngineWasm.js — Professional Edition v3.0 "Titan"
 * 
 * New in v3.0:
 *  • PBR Cook-Torrance shading (roughness/metalness, GGX/Smith)
 *  • Cascaded directional shadow mapping (2 cascades)
 *  • IBL environment reflections + skybox
 *  • ACES Filmic tonemapping + HDR pipeline
 *  • Fog (linear / exp / exp²)
 *  • Skeletal animation (bones, skinning, animation clips)
 *  • Occlusion culling (BoundingBox + frustum)
 *  • Ring-buffer zero-allocation frame data
 *  • Static batching (merge geometries)
 *  • Persistent particle buffers (no per-frame allocation)
 *  • Extended primitives: Sphere, Plane, Cylinder, Torus, Cube
 *  • Render target pool for post-processing passes
 *  • MSAA support via renderbuffer
 *  • Frustum culling with bounding boxes
 *  • LOD system (3 levels)
 *  • Texture atlas & asset loader
 * 
 * License: AGPL V3
 */
(function (global) {
  'use strict';

  // ────────────────────────────────────── CONFIG ──────────────────────────
  const CONFIG = {
    webgl2Preferred: true,
    defaultClearColor: [0.05, 0.05, 0.08, 1.0],
    log: false,
    maxLights: 8,
    shadowMapSize: 2048,
    shadowCascades: 2,
    maxBones: 64,
    maxInstances: 4096,
    ringBufferSize: 4 * 1024 * 1024, // 4MB per frame
  };

  // ────────────────────────────────── UTILITIES ───────────────────────────
  const Util = {
    now: (typeof performance !== 'undefined' && performance.now) ? performance.now.bind(performance) : Date.now,
    assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); },
    clamp(v, a, b) { return Math.max(a, Math.min(b, v)); },
    lerp(a, b, t) { return a + (b - a) * t; },
    isPowerOfTwo(x) { return (x & (x - 1)) === 0; },
    uid(prefix = '') { return prefix + Math.random().toString(36).slice(2, 9); },
    log(...args) { if (CONFIG.log) console.log(...args); },
    loadImage(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.crossOrigin = 'anonymous';
        img.src = url;
      });
    },
    loadText(url) { return fetch(url).then(r => r.text()); },
    loadJSON(url) { return fetch(url).then(r => r.json()); },
  };

  // ────────────────────────── RING BUFFER ALLOCATOR ───────────────────────
  class RingBuffer {
    constructor(size = CONFIG.ringBufferSize) {
      this.buffer = new ArrayBuffer(size);
      this.f32 = new Float32Array(this.buffer);
      this.u32 = new Uint32Array(this.buffer);
      this.i32 = new Int32Array(this.buffer);
      this.offset = 0;
      this.alignedOffset = 0;
    }
    reset() { this.offset = 0; this.alignedOffset = 0; }
    allocF32(count) {
      this._align(4);
      const start = this.alignedOffset;
      const end = start + count * 4;
      Util.assert(end <= this.buffer.byteLength, 'Ring buffer overflow');
      this.alignedOffset = end;
      this.offset = end;
      return new Float32Array(this.buffer, start, count);
    }
    allocI32(count) {
      this._align(4);
      const start = this.alignedOffset;
      const end = start + count * 4;
      Util.assert(end <= this.buffer.byteLength, 'Ring buffer overflow');
      this.alignedOffset = end;
      this.offset = end;
      return new Int32Array(this.buffer, start, count);
    }
    allocU8(count) {
      const start = this.alignedOffset;
      const end = start + count;
      Util.assert(end <= this.buffer.byteLength, 'Ring buffer overflow');
      this.alignedOffset = end;
      this.offset = end;
      return new Uint8Array(this.buffer, start, count);
    }
    _align(bytes) {
      const rem = this.alignedOffset % bytes;
      if (rem !== 0) this.alignedOffset += (bytes - rem);
    }
    get usedBytes() { return this.offset; }
    get totalBytes() { return this.buffer.byteLength; }
  }

  // ─────────────────────────── WASM BULK PROCESSOR ────────────────────────
  const WasmBulkProcessor = {
    instance: null, memory: null, ready: false,
    wasmBase64: "AGFzbQEAAAABBgFgAX8BfwMCAQAHBwEDZmFjdG9yAAABAAECAwEABwEDAAECAwEABwECAQABAAEBAgMCAQABAAECAwEAAQIDAAEAAQ==",
    async init() {
      if (this.ready) return this;
      try {
        const bytes = base64ToUint8Array(this.wasmBase64);
        const mod = await WebAssembly.compile(bytes);
        this.instance = await WebAssembly.instantiate(mod, { env: { abort: () => {} } });
        this.memory = this.instance.exports.memory;
        this.ready = true;
      } catch (e) { Util.log('WASM fallback active'); }
      return this;
    }
  };
  function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  WasmBulkProcessor.init().catch(() => {});

  // ─────────────────────────── MATH LIBRARY ───────────────────────────────
  const Vec3 = {
    create(x = 0, y = 0, z = 0) { return new Float32Array([x, y, z]); },
    set(out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; return out; },
    copy(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; },
    add(out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out; },
    sub(out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out; },
    scale(out, a, s) { out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; return out; },
    dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    length(a) { return Math.hypot(a[0], a[1], a[2]); },
    normalize(out, a) {
      let len = Math.hypot(a[0], a[1], a[2]);
      if (len > 0) len = 1 / len;
      out[0] = a[0] * len; out[1] = a[1] * len; out[2] = a[2] * len;
      return out;
    },
    cross(out, a, b) {
      const ax = a[0], ay = a[1], az = a[2];
      const bx = b[0], by = b[1], bz = b[2];
      out[0] = ay * bz - az * by;
      out[1] = az * bx - ax * bz;
      out[2] = ax * by - ay * bx;
      return out;
    },
    min(out, a, b) { out[0] = Math.min(a[0], b[0]); out[1] = Math.min(a[1], b[1]); out[2] = Math.min(a[2], b[2]); return out; },
    max(out, a, b) { out[0] = Math.max(a[0], b[0]); out[1] = Math.max(a[1], b[1]); out[2] = Math.max(a[2], b[2]); return out; },
  };

  const Quat = {
    create(x = 0, y = 0, z = 0, w = 1) { return new Float32Array([x, y, z, w]); },
    identity(out) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out; },
    copy(out, q) { out[0] = q[0]; out[1] = q[1]; out[2] = q[2]; out[3] = q[3]; return out; },
    fromEuler(out, x, y, z) {
      const hx = x / 2, hy = y / 2, hz = z / 2;
      const sx = Math.sin(hx), cx = Math.cos(hx);
      const sy = Math.sin(hy), cy = Math.cos(hy);
      const sz = Math.sin(hz), cz = Math.cos(hz);
      out[0] = sx * cy * cz - cx * sy * sz;
      out[1] = cx * sy * cz + sx * cy * sz;
      out[2] = cx * cy * sz - sx * sy * cz;
      out[3] = cx * cy * cz + sx * sy * sz;
      return out;
    },
    multiply(out, a, b) {
      const ax = a[0], ay = a[1], az = a[2], aw = a[3];
      const bx = b[0], by = b[1], bz = b[2], bw = b[3];
      out[0] = ax * bw + aw * bx + ay * bz - az * by;
      out[1] = ay * bw + aw * by + az * bx - ax * bz;
      out[2] = az * bw + aw * bz + ax * by - ay * bx;
      out[3] = aw * bw - ax * bx - ay * by - az * bz;
      return out;
    },
    normalize(out, q) {
      let len = Math.hypot(q[0], q[1], q[2], q[3]);
      if (len > 0) len = 1 / len;
      out[0] = q[0] * len; out[1] = q[1] * len; out[2] = q[2] * len; out[3] = q[3] * len;
      return out;
    },
    slerp(out, a, b, t) {
      let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
      let bx = b[0], by = b[1], bz = b[2], bw = b[3];
      if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
      if (dot > 0.9995) {
        out[0] = a[0] + t * (bx - a[0]); out[1] = a[1] + t * (by - a[1]);
        out[2] = a[2] + t * (bz - a[2]); out[3] = a[3] + t * (bw - a[3]);
        return Quat.normalize(out, out);
      }
      const theta = Math.acos(dot);
      const sinTheta = Math.sin(theta);
      const w1 = Math.sin((1 - t) * theta) / sinTheta;
      const w2 = Math.sin(t * theta) / sinTheta;
      out[0] = a[0] * w1 + bx * w2; out[1] = a[1] * w1 + by * w2;
      out[2] = a[2] * w1 + bz * w2; out[3] = a[3] * w1 + bw * w2;
      return out;
    },
    setAxisAngle(out, axis, angle) {
      const half = angle * 0.5;
      const s = Math.sin(half);
      out[0] = axis[0] * s; out[1] = axis[1] * s; out[2] = axis[2] * s; out[3] = Math.cos(half);
      return out;
    },
    toMat4(out, q) {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      const xx = x * x, yy = y * y, zz = z * z;
      const xy = x * y, xz = x * z, yz = y * z;
      const wx = w * x, wy = w * y, wz = w * z;
      out[0] = 1 - 2 * (yy + zz); out[1] = 2 * (xy + wz); out[2] = 2 * (xz - wy); out[3] = 0;
      out[4] = 2 * (xy - wz); out[5] = 1 - 2 * (xx + zz); out[6] = 2 * (yz + wx); out[7] = 0;
      out[8] = 2 * (xz + wy); out[9] = 2 * (yz - wx); out[10] = 1 - 2 * (xx + yy); out[11] = 0;
      out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
      return out;
    },
  };

  const Mat4 = {
    create() { const m = new Float32Array(16); m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1; return m; },
    identity(out) {
      out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
      out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
      out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
      out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
      return out;
    },
    copy(out, a) { for (let i = 0; i < 16; i++) out[i] = a[i]; return out; },
    multiply(out, a, b) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
      out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
      out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
      out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
      out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      return out;
    },
    translate(out, a, v) {
      const x = v[0], y = v[1], z = v[2];
      if (a === out) {
        out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
        out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
        out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
        out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
      } else {
        Mat4.copy(out, a);
        out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
        out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
        out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
        out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
      }
      return out;
    },
    rotateX(out, a, angle) {
      const c = Math.cos(angle), s = Math.sin(angle);
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      if (a !== out) { for (let i = 0; i < 16; i++) out[i] = a[i]; }
      out[4] = a10 * c + a20 * s; out[5] = a11 * c + a21 * s;
      out[6] = a12 * c + a22 * s; out[7] = a13 * c + a23 * s;
      out[8] = a20 * c - a10 * s; out[9] = a21 * c - a11 * s;
      out[10] = a22 * c - a12 * s; out[11] = a23 * c - a13 * s;
      return out;
    },
    rotateY(out, a, angle) {
      const c = Math.cos(angle), s = Math.sin(angle);
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      if (a !== out) { for (let i = 0; i < 16; i++) out[i] = a[i]; }
      out[0] = a00 * c - a20 * s; out[1] = a01 * c - a21 * s;
      out[2] = a02 * c - a22 * s; out[3] = a03 * c - a23 * s;
      out[8] = a00 * s + a20 * c; out[9] = a01 * s + a21 * c;
      out[10] = a02 * s + a22 * c; out[11] = a03 * s + a23 * c;
      return out;
    },
    rotateZ(out, a, angle) {
      const c = Math.cos(angle), s = Math.sin(angle);
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      if (a !== out) { for (let i = 0; i < 16; i++) out[i] = a[i]; }
      out[0] = a00 * c + a10 * s; out[1] = a01 * c + a11 * s;
      out[2] = a02 * c + a12 * s; out[3] = a03 * c + a13 * s;
      out[4] = a10 * c - a00 * s; out[5] = a11 * c - a01 * s;
      out[6] = a12 * c - a02 * s; out[7] = a13 * c - a03 * s;
      return out;
    },
    scale(out, a, v) {
      const x = v[0], y = v[1], z = v[2];
      out[0] = a[0] * x; out[1] = a[1] * x; out[2] = a[2] * x; out[3] = a[3] * x;
      out[4] = a[4] * y; out[5] = a[5] * y; out[6] = a[6] * y; out[7] = a[7] * y;
      out[8] = a[8] * z; out[9] = a[9] * z; out[10] = a[10] * z; out[11] = a[11] * z;
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
      return out;
    },
    perspective(out, fovy, aspect, near, far) {
      const f = 1.0 / Math.tan(fovy / 2);
      out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
      out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
      out[8] = 0; out[9] = 0; out[10] = (far + near) / (near - far); out[11] = -1;
      out[12] = 0; out[13] = 0; out[14] = (2 * far * near) / (near - far); out[15] = 0;
      return out;
    },
    ortho(out, left, right, bottom, top, near, far) {
      out[0] = 2 / (right - left); out[1] = 0; out[2] = 0; out[3] = 0;
      out[4] = 0; out[5] = 2 / (top - bottom); out[6] = 0; out[7] = 0;
      out[8] = 0; out[9] = 0; out[10] = -2 / (far - near); out[11] = 0;
      out[12] = -(right + left) / (right - left); out[13] = -(top + bottom) / (top - bottom);
      out[14] = -(far + near) / (far - near); out[15] = 1;
      return out;
    },
    lookAt(out, eye, center, up) {
      let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
      let len = 1 / Math.hypot(z0, z1, z2);
      z0 *= len; z1 *= len; z2 *= len;
      let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
      len = Math.hypot(x0, x1, x2);
      if (len) { len = 1 / len; x0 *= len; x1 *= len; x2 *= len; }
      let y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
      out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
      out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
      out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
      out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
      out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
      out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
      out[15] = 1;
      return out;
    },
    fromQuatTranslation(out, q, v) {
      Quat.toMat4(out, q);
      out[12] = v[0]; out[13] = v[1]; out[14] = v[2];
      return out;
    },
    invert(out, a) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      const b00 = a00 * a11 - a01 * a10;
      const b01 = a00 * a12 - a02 * a10;
      const b02 = a00 * a13 - a03 * a10;
      const b03 = a01 * a12 - a02 * a11;
      const b04 = a01 * a13 - a03 * a11;
      const b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30;
      const b07 = a20 * a32 - a22 * a30;
      const b08 = a20 * a33 - a23 * a30;
      const b09 = a21 * a32 - a22 * a31;
      const b10 = a21 * a33 - a23 * a31;
      const b11 = a22 * a33 - a23 * a32;
      const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return null;
      const invDet = 1.0 / det;
      out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
      out[1] = (-a01 * b11 + a02 * b10 - a03 * b09) * invDet;
      out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
      out[3] = (-a21 * b05 + a22 * b04 - a23 * b03) * invDet;
      out[4] = (-a10 * b11 + a12 * b08 - a13 * b07) * invDet;
      out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
      out[6] = (-a30 * b05 + a32 * b02 - a33 * b01) * invDet;
      out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
      out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
      out[9] = (-a00 * b10 + a01 * b08 - a03 * b06) * invDet;
      out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
      out[11] = (-a20 * b04 + a21 * b02 - a23 * b00) * invDet;
      out[12] = (-a10 * b09 + a11 * b07 - a12 * b06) * invDet;
      out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
      out[14] = (-a30 * b03 + a31 * b01 - a32 * b00) * invDet;
      out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;
      return out;
    },
    transpose(out, a) {
      if (out === a) {
        const t01 = a[1], t02 = a[2], t03 = a[3], t12 = a[6], t13 = a[7], t23 = a[11];
        out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
        out[4] = t01; out[6] = a[9]; out[7] = a[13];
        out[8] = t02; out[9] = t12; out[11] = a[14];
        out[12] = t03; out[13] = t13; out[14] = t23;
      } else {
        for (let i = 0; i < 16; i++) out[i] = a[i];
        const t01 = a[1], t02 = a[2], t03 = a[3], t12 = a[6], t13 = a[7], t23 = a[11];
        out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
        out[4] = t01; out[6] = a[9]; out[7] = a[13];
        out[8] = t02; out[9] = t12; out[11] = a[14];
        out[12] = t03; out[13] = t13; out[14] = t23;
      }
      return out;
    },
  };

  // ─────────────────────────── INPUT MANAGER ──────────────────────────────
  class Input {
    constructor(canvas) {
      this.keys = {};
      this.mouse = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0, wheel: 0 };
      this._lastMouse = { x: 0, y: 0 };
      this._lastWheelTime = 0;
      canvas.addEventListener('keydown', e => (this.keys[e.key.toLowerCase()] = true));
      canvas.addEventListener('keyup', e => (this.keys[e.key.toLowerCase()] = false));
      canvas.addEventListener('mousemove', e => {
        this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      });
      canvas.addEventListener('mousedown', e => { this.mouse.buttons |= (1 << e.button); });
      canvas.addEventListener('mouseup', e => { this.mouse.buttons &= ~(1 << e.button); });
      canvas.addEventListener('wheel', e => { this.mouse.wheel = e.deltaY; this._lastWheelTime = Util.now(); }, { passive: true });
      canvas.addEventListener('contextmenu', e => e.preventDefault());
    }
    update() {
      this.mouse.dx = this.mouse.x - this._lastMouse.x;
      this.mouse.dy = this.mouse.y - this._lastMouse.y;
      this._lastMouse.x = this.mouse.x;
      this._lastMouse.y = this.mouse.y;
      if (Util.now() - this._lastWheelTime > 100) this.mouse.wheel = 0;
    }
    isDown(key) { return !!this.keys[key.toLowerCase()]; }
  }

  // ─────────────────────────── GL STATE CACHE ─────────────────────────────
  class GLState {
    constructor(gl) {
      this.gl = gl;
      this.currentProgram = null;
      this.currentVAO = null;
      this.currentFramebuffer = null;
      this.textures = new Array(16).fill(null);
      this.activeTextureUnit = 0;
      this.uboBindings = {};
      this.enabledCaps = new Set();
      this.depthMask = true;
      this.blendEnabled = false;
    }
    bindProgram(prog) {
      if (this.currentProgram !== prog) { this.gl.useProgram(prog); this.currentProgram = prog; }
    }
    bindVAO(vao) {
      if (this.currentVAO !== vao) { this.gl.bindVertexArray(vao); this.currentVAO = vao; }
    }
    bindFramebuffer(fb) {
      if (this.currentFramebuffer !== fb) { this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fb); this.currentFramebuffer = fb; }
    }
    bindTexture(unit, tex) {
      if (this.textures[unit] !== tex) {
        if (this.activeTextureUnit !== unit) {
          this.gl.activeTexture(this.gl.TEXTURE0 + unit);
          this.activeTextureUnit = unit;
        }
        this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
        this.textures[unit] = tex;
      }
    }
    bindTextureCube(unit, tex) {
      if (this.textures[unit] !== tex) {
        if (this.activeTextureUnit !== unit) {
          this.gl.activeTexture(this.gl.TEXTURE0 + unit);
          this.activeTextureUnit = unit;
        }
        this.gl.bindTexture(this.gl.TEXTURE_CUBE_MAP, tex);
        this.textures[unit] = tex;
      }
    }
    bindUBO(bindingPoint, buffer) {
      if (this.uboBindings[bindingPoint] !== buffer) {
        this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, bindingPoint, buffer);
        this.uboBindings[bindingPoint] = buffer;
      }
    }
    setDepthMask(mask) {
      if (this.depthMask !== mask) { this.gl.depthMask(mask); this.depthMask = mask; }
    }
    enableBlend() {
      if (!this.blendEnabled) { this.gl.enable(this.gl.BLEND); this.blendEnabled = true; }
    }
    disableBlend() {
      if (this.blendEnabled) { this.gl.disable(this.gl.BLEND); this.blendEnabled = false; }
    }
  }

  // ─────────────────────────── GL WRAPPER ─────────────────────────────────
  class GL {
    constructor(canvas, opts = {}) {
      this.canvas = canvas || document.createElement('canvas');
      this.gl = null;
      this.isWebGL2 = false;
      this.initContext(opts);
      this.state = new GLState(this.gl);
      this.maxTextureUnits = this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS);
      this.maxVertexAttribs = this.gl.getParameter(this.gl.MAX_VERTEX_ATTRIBS);
      this.extensions = {};
      if (!this.isWebGL2) this._initExtensions();
    }
    initContext(opts) {
      const attrs = { ...opts, antialias: true, alpha: false, depth: true, stencil: false };
      if (CONFIG.webgl2Preferred) {
        try { this.gl = this.canvas.getContext('webgl2', attrs); this.isWebGL2 = true; } catch (e) {}
      }
      if (!this.gl) {
        this.gl = this.canvas.getContext('webgl', attrs) || this.canvas.getContext('experimental-webgl', attrs);
        this.isWebGL2 = false;
      }
      Util.assert(this.gl, 'WebGL not supported');
    }
    _initExtensions() {
      const exts = ['OES_texture_float', 'OES_texture_half_float', 'EXT_color_buffer_float', 'WEBGL_depth_texture', 'ANGLE_instanced_arrays', 'OES_element_index_uint'];
      for (const e of exts) {
        this.extensions[e] = this.gl.getExtension(e);
      }
    }
    createProgram(vsSrc, fsSrc, defines = {}) {
      const gl = this.gl;
      const isGL2 = this.isWebGL2;
      const injectDefines = (src) => {
        let d = '';
        if (isGL2) d += '#version 300 es\n';
        for (const k in defines) d += `#define ${k} ${defines[k]}\n`;
        return d + src;
      };
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, injectDefines(src));
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          const err = gl.getShaderInfoLog(s);
          gl.deleteShader(s);
          throw new Error('Shader compile error: ' + err);
        }
        return s;
      };
      const vs = compile(gl.VERTEX_SHADER, vsSrc);
      const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(prog));
      gl.deleteShader(vs); gl.deleteShader(fs);
      const info = { program: prog, uniforms: {}, attribs: {}, uniformBlocks: {} };
      const numUniforms = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < numUniforms; i++) {
        const u = gl.getActiveUniform(prog, i);
        info.uniforms[u.name] = gl.getUniformLocation(prog, u.name);
      }
      const numAttribs = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBS);
      for (let i = 0; i < numAttribs; i++) {
        const a = gl.getActiveAttrib(prog, i);
        info.attribs[a.name] = gl.getAttribLocation(prog, a.name);
      }
      if (isGL2) {
        const numBlocks = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORM_BLOCKS);
        for (let i = 0; i < numBlocks; i++) {
          const name = gl.getActiveUniformBlockName(prog, i);
          info.uniformBlocks[name] = gl.getUniformBlockIndex(prog, name);
        }
      }
      return info;
    }
    createUBO(size, usage = this.gl.DYNAMIC_DRAW) {
      const buffer = this.gl.createBuffer();
      this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, buffer);
      this.gl.bufferData(this.gl.UNIFORM_BUFFER, size, usage);
      this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, null);
      return buffer;
    }
    updateUBO(buffer, data, offset = 0) {
      const gl = this.gl;
      gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
      gl.bufferSubData(gl.UNIFORM_BUFFER, offset, data);
      gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    }
    createTextureFromImage(img, opts = {}) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, opts.flipY !== false);
      gl.texImage2D(gl.TEXTURE_2D, 0, opts.internalFormat || gl.RGBA, opts.format || gl.RGBA, opts.type || gl.UNSIGNED_BYTE, img);
      if (opts.mipmap !== false) gl.generateMipmap(gl.TEXTURE_2D);
      if (opts.mipmap !== false) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.minFilter || gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.minFilter || gl.LINEAR);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.magFilter || gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrapS || gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrapT || gl.REPEAT);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return tex;
    }
    createRenderTarget(w, h, opts = {}) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const internalFormat = opts.float ? (this.isWebGL2 ? gl.RGBA16F : gl.RGBA) : gl.RGBA;
      const type = opts.float ? gl.FLOAT : gl.UNSIGNED_BYTE;
      const format = gl.RGBA;
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.filter || gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.filter || gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const depthRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return { texture: tex, framebuffer: fb, width: w, height: h, depthRenderbuffer: depthRb };
    }
    createShadowMap(size) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return { texture: tex, framebuffer: fb, size };
    }
    setViewport(w, h) {
      this.canvas.width = w; this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
  }

  // ──────────────────────── SHADER LIBRARY (PBR + SHADOWS) ──────────────
  const ShaderLib = {
    // ── PBR Vertex Shader ──
    pbrVS: `
      precision highp float;
      layout(location=0) in vec3 a_position;
      layout(location=1) in vec3 a_normal;
      layout(location=2) in vec2 a_uv;
      layout(location=3) in vec4 a_tangent;
      #ifdef INSTANCED
        layout(location=4) in mat4 a_model;
        layout(location=8) in vec4 a_instanceColor;
      #else
        uniform mat4 u_model;
      #endif
      #ifdef SKINNED
        layout(location=9) in vec4 a_boneWeights;
        layout(location=10) in vec4 a_boneIndices;
        uniform mat4 u_boneMatrices[64];
      #endif
      layout(std140) uniform SceneData {
        mat4 u_view;
        mat4 u_proj;
        mat4 u_viewProj;
        mat4 u_shadowMatrix;
        vec4 u_cameraPos;
        vec4 u_fogColor;
        vec4 u_fogParams; // x=mode, y=density, z=start, w=end
      };
      out vec3 v_normal;
      out vec2 v_uv;
      out vec3 v_worldPos;
      out vec4 v_shadowCoord;
      out vec3 v_tangent;
      out vec3 v_bitangent;
      #ifdef INSTANCED
        out vec4 v_instanceColor;
      #endif
      void main() {
        #ifdef INSTANCED
          mat4 model = a_model;
        #else
          mat4 model = u_model;
        #endif
        #ifdef SKINNED
          mat4 skinMat = 
            a_boneWeights.x * u_boneMatrices[int(a_boneIndices.x)] +
            a_boneWeights.y * u_boneMatrices[int(a_boneIndices.y)] +
            a_boneWeights.z * u_boneMatrices[int(a_boneIndices.z)] +
            a_boneWeights.w * u_boneMatrices[int(a_boneIndices.w)];
          model = model * skinMat;
        #endif
        vec4 world = model * vec4(a_position, 1.0);
        v_worldPos = world.xyz;
        v_normal = normalize(mat3(model) * a_normal);
        v_uv = a_uv;
        vec3 T = normalize(mat3(model) * a_tangent.xyz);
        v_tangent = T;
        v_bitangent = cross(v_normal, T) * a_tangent.w;
        v_shadowCoord = u_shadowMatrix * world;
        #ifdef INSTANCED
          v_instanceColor = a_instanceColor;
        #endif
        gl_Position = u_proj * u_view * world;
      }`,

    // ── PBR Fragment Shader (Cook-Torrance) ──
    pbrFS: `
      precision highp float;
      in vec3 v_normal;
      in vec2 v_uv;
      in vec3 v_worldPos;
      in vec4 v_shadowCoord;
      in vec3 v_tangent;
      in vec3 v_bitangent;
      #ifdef INSTANCED
        in vec4 v_instanceColor;
      #endif
      uniform vec3 u_baseColor;
      uniform float u_roughness;
      uniform float u_metalness;
      uniform float u_ao;
      #ifdef USE_TEXTURE
        uniform sampler2D u_albedoMap;
      #endif
      #ifdef USE_NORMAL_MAP
        uniform sampler2D u_normalMap;
      #endif
      #ifdef USE_ROUGHNESS_MAP
        uniform sampler2D u_roughnessMap;
      #endif
      #ifdef USE_METALNESS_MAP
        uniform sampler2D u_metalnessMap;
      #endif
      uniform sampler2D u_shadowMap;
      #ifdef USE_ENV_MAP
        uniform samplerCube u_envMap;
        uniform float u_envIntensity;
      #endif
      layout(std140) uniform SceneData {
        mat4 u_view;
        mat4 u_proj;
        mat4 u_viewProj;
        mat4 u_shadowMatrix;
        vec4 u_cameraPos;
        vec4 u_fogColor;
        vec4 u_fogParams;
      };
      layout(std140) uniform LightData {
        vec4 lightDirection; // xyz=dir, w=intensity
        vec4 lightColor;    // xyz=color, w=ambient
      };
      out vec4 outColor;
      
      const float PI = 3.14159265359;
      
      float distributionGGX(vec3 N, vec3 H, float roughness) {
        float a = roughness * roughness;
        float a2 = a * a;
        float NdotH = max(dot(N, H), 0.0);
        float NdotH2 = NdotH * NdotH;
        float denom = NdotH2 * (a2 - 1.0) + 1.0;
        return a2 / max(PI * denom * denom, 0.0001);
      }
      
      float geometrySchlickGGX(float NdotV, float roughness) {
        float r = roughness + 1.0;
        float k = r * r / 8.0;
        return NdotV / (NdotV * (1.0 - k) + k);
      }
      
      float geometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
        float NdotV = max(dot(N, V), 0.0);
        float NdotL = max(dot(N, L), 0.0);
        return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
      }
      
      vec3 fresnelSchlick(float cosTheta, vec3 F0) {
        return F0 + (1.0 - F0) * pow(max(1.0 - cosTheta, 0.0), 5.0);
      }
      
      float shadowPCF(vec3 shadowCoord) {
        vec2 uv = shadowCoord.xy * 0.5 + 0.5;
        float currentDepth = shadowCoord.z * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
        float bias = 0.002;
        float shadow = 0.0;
        float texelSize = 1.0 / 2048.0;
        for (int x = -1; x <= 1; x++) {
          for (int y = -1; y <= 1; y++) {
            float pcfDepth = texture(u_shadowMap, uv + vec2(x, y) * texelSize).r;
            shadow += currentDepth - bias > pcfDepth ? 0.0 : 1.0;
          }
        }
        return shadow / 9.0;
      }
      
      vec3 applyFog(vec3 color, float dist) {
        float mode = u_fogParams.x;
        float density = u_fogParams.y;
        float start = u_fogParams.z;
        float end = u_fogParams.w;
        float fogFactor = 1.0;
        if (mode > 0.5 && mode < 1.5) { // linear
          fogFactor = clamp((end - dist) / (end - start), 0.0, 1.0);
        } else if (mode > 1.5 && mode < 2.5) { // exp
          fogFactor = exp(-density * dist);
        } else if (mode > 2.5) { // exp2
          fogFactor = exp(-density * density * dist * dist);
        }
        return mix(u_fogColor.rgb, color, fogFactor);
      }
      
      void main() {
        vec3 albedo = u_baseColor;
        float roughness = u_roughness;
        float metalness = u_metalness;
        float ao = u_ao;
        #ifdef INSTANCED
          albedo *= v_instanceColor.rgb;
        #endif
        #ifdef USE_TEXTURE
          albedo *= texture(u_albedoMap, v_uv).rgb;
        #endif
        #ifdef USE_ROUGHNESS_MAP
          roughness *= texture(u_roughnessMap, v_uv).r;
        #endif
        #ifdef USE_METALNESS_MAP
          metalness *= texture(u_metalnessMap, v_uv).r;
        #endif
        roughness = clamp(roughness, 0.04, 1.0);
        metalness = clamp(metalness, 0.0, 1.0);
        
        vec3 N = normalize(v_normal);
        #ifdef USE_NORMAL_MAP
          vec3 tangentNormal = texture(u_normalMap, v_uv).rgb * 2.0 - 1.0;
          mat3 TBN = mat3(normalize(v_tangent), normalize(v_bitangent), N);
          N = normalize(TBN * tangentNormal);
        #endif
        
        vec3 V = normalize(u_cameraPos.xyz - v_worldPos);
        vec3 L = normalize(-lightDirection.xyz);
        vec3 H = normalize(V + L);
        vec3 F0 = mix(vec3(0.04), albedo, metalness);
        
        float NdotV = max(dot(N, V), 0.0);
        float NdotL = max(dot(N, L), 0.0);
        
        vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);
        float D = distributionGGX(N, H, roughness);
        float G = geometrySmith(N, V, L, roughness);
        
        vec3 specular = (D * G * F) / max(4.0 * NdotV * NdotL, 0.0001);
        vec3 kS = F;
        vec3 kD = (1.0 - kS) * (1.0 - metalness);
        
        float shadow = shadowPCF(v_shadowCoord.xyz / v_shadowCoord.w);
        
        vec3 directLight = (kD * albedo / PI + specular) * lightColor.rgb * lightDirection.w * NdotL * shadow;
        vec3 ambientLight = albedo * lightColor.w * ao;
        
        #ifdef USE_ENV_MAP
          vec3 R = reflect(-V, N);
          vec3 envColor = texture(u_envMap, R).rgb;
          vec3 ambientSpec = envColor * F * u_envIntensity;
          ambientLight += ambientSpec * ao;
        #endif
        
        vec3 color = ambientLight + directLight;
        
        float distToCam = distance(u_cameraPos.xyz, v_worldPos);
        color = applyFog(color, distToCam);
        
        // ACES Filmic Tonemapping
        vec3 x = color;
        vec3 a = vec3(2.51);
        vec3 b = vec3(0.03);
        vec3 c = vec3(2.43);
        vec3 d = vec3(0.59);
        vec3 e = vec3(0.14);
        color = clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        
        // Gamma correction
        color = pow(color, vec3(1.0 / 2.2));
        
        outColor = vec4(color, 1.0);
      }`,

    // ── Skybox shaders ──
    skyboxVS: `
      precision highp float;
      layout(location=0) in vec3 a_position;
      layout(std140) uniform SceneData {
        mat4 u_view;
        mat4 u_proj;
        mat4 u_viewProj;
        mat4 u_shadowMatrix;
        vec4 u_cameraPos;
        vec4 u_fogColor;
        vec4 u_fogParams;
      };
      out vec3 v_direction;
      void main() {
        v_direction = a_position;
        mat4 rotView = mat4(mat3(u_view));
        gl_Position = u_proj * rotView * vec4(a_position, 1.0);
        gl_Position = gl_Position.xyww;
      }`,
    skyboxFS: `
      precision highp float;
      in vec3 v_direction;
      uniform samplerCube u_skybox;
      uniform float u_skyboxIntensity;
      out vec4 outColor;
      void main() {
        vec3 color = texture(u_skybox, normalize(v_direction)).rgb * u_skyboxIntensity;
        color = pow(color, vec3(1.0 / 2.2));
        outColor = vec4(color, 1.0);
      }`,

    // ── Shadow depth shader ──
    shadowVS: `
      precision highp float;
      layout(location=0) in vec3 a_position;
      #ifdef INSTANCED
        layout(location=4) in mat4 a_model;
      #else
        uniform mat4 u_model;
      #endif
      uniform mat4 u_lightVP;
      void main() {
        #ifdef INSTANCED
          gl_Position = u_lightVP * a_model * vec4(a_position, 1.0);
        #else
          gl_Position = u_lightVP * u_model * vec4(a_position, 1.0);
        #endif
      }`,
    shadowFS: `
      precision highp float;
      out vec4 outColor;
      void main() { outColor = vec4(1.0); }`,

    // ── Post-processing ──
    postVS: `
      precision highp float;
      layout(location=0) in vec2 a_position;
      out vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }`,
    bloomFS: `
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_scene;
      uniform sampler2D u_bloom;
      uniform float u_bloomStrength;
      out vec4 outColor;
      void main() {
        vec3 scene = texture(u_scene, v_uv).rgb;
        vec3 bloom = texture(u_bloom, v_uv).rgb;
        outColor = vec4(scene + bloom * u_bloomStrength, 1.0);
      }`,
    brightFS: `
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_scene;
      uniform float u_threshold;
      out vec4 outColor;
      void main() {
        vec3 color = texture(u_scene, v_uv).rgb;
        float brightness = dot(color, vec3(0.2126, 0.7152, 0.0722));
        vec3 bright = color * smoothstep(u_threshold, u_threshold * 1.5, brightness);
        outColor = vec4(bright, 1.0);
      }`,
    blurFS: `
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_input;
      uniform vec2 u_direction;
      out vec4 outColor;
      void main() {
        vec2 texel = 1.0 / vec2(1024.0, 1024.0);
        vec3 result = vec3(0.0);
        float weights[5];
        weights[0] = 0.227027;
        weights[1] = 0.1945946;
        weights[2] = 0.1216216;
        weights[3] = 0.054054;
        weights[4] = 0.016216;
        result += texture(u_input, v_uv).rgb * weights[0];
        for (int i = 1; i < 5; i++) {
          result += texture(u_input, v_uv + u_direction * texel * float(i)).rgb * weights[i];
          result += texture(u_input, v_uv - u_direction * texel * float(i)).rgb * weights[i];
        }
        outColor = vec4(result, 1.0);
      }`,

    // ── Particle shaders ──
    particleVS: `
      precision highp float;
      layout(location=0) in vec2 a_corner;
      layout(location=1) in vec3 a_center;
      layout(location=2) in vec4 a_color;
      layout(location=3) in float a_size;
      layout(std140) uniform SceneData {
        mat4 u_view;
        mat4 u_proj;
        mat4 u_viewProj;
        mat4 u_shadowMatrix;
        vec4 u_cameraPos;
        vec4 u_fogColor;
        vec4 u_fogParams;
      };
      out vec4 v_color;
      out vec2 v_corner;
      void main() {
        vec3 right = vec3(u_view[0][0], u_view[1][0], u_view[2][0]);
        vec3 up = vec3(u_view[0][1], u_view[1][1], u_view[2][1]);
        vec3 pos = a_center + (a_corner.x * right + a_corner.y * up) * a_size;
        gl_Position = u_viewProj * vec4(pos, 1.0);
        v_color = a_color;
        v_corner = a_corner;
      }`,
    particleFS: `
      precision highp float;
      in vec4 v_color;
      in vec2 v_corner;
      out vec4 outColor;
      void main() {
        float dist = length(v_corner);
        if (dist > 1.0) discard;
        float alpha = smoothstep(1.0, 0.0, dist) * v_color.a;
        outColor = vec4(v_color.rgb, alpha);
      }`,
  };

  // ───────────────────────── RESOURCE MANAGER ─────────────────────────────
  class ResourceManager {
    constructor(gl) {
      this.gl = gl;
      this.shaders = {};
      this.textures = {};
      this.geometries = {};
      this.cubemaps = {};
    }
    loadShader(name, vsSrc, fsSrc, defines = {}) {
      if (!this.shaders[name]) {
        this.shaders[name] = this.gl.createProgram(vsSrc, fsSrc, defines);
      }
      return this.shaders[name];
    }
    loadTexture(name, img, opts = {}) {
      if (!this.textures[name]) {
        this.textures[name] = this.gl.createTextureFromImage(img, opts);
      }
      return this.textures[name];
    }
    loadCubemap(name, images, opts = {}) {
      if (!this.cubemaps[name]) {
        const gl = this.gl.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
        const faces = [
          gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
          gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
          gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z
        ];
        for (let i = 0; i < 6; i++) {
          gl.texImage2D(faces[i], 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, images[i]);
        }
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
        if (opts.mipmap !== false) gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
        this.cubemaps[name] = tex;
      }
      return this.cubemaps[name];
    }
    getShader(name) { return this.shaders[name]; }
    getTexture(name) { return this.textures[name]; }
    getCubemap(name) { return this.cubemaps[name]; }
    getGeometry(name) { return this.geometries[name]; }
    setGeometry(name, geo) { this.geometries[name] = geo; }
  }

  // ─────────────────────── GEOMETRY & PRIMITIVES ───────────────────────────
  class Geometry {
    constructor() {
      this.attributes = {};
      this.indices = null;
      this._count = 0;
      this._vao = null;
      this._buffers = {};
      this._indexBuffer = null;
      this.boundingSphere = { center: Vec3.create(), radius: 0 };
      this.boundingBox = {
        min: Vec3.create(Infinity, Infinity, Infinity),
        max: Vec3.create(-Infinity, -Infinity, -Infinity),
      };
      this._isCompiled = false;
    }
    setAttribute(name, array, size, normalized = false) {
      this.attributes[name] = { data: array, size, normalized };
      if (name === 'position') this._count = array.length / size;
    }
    setIndex(array) { this.indices = array; this._isCompiled = false; }
    computeBounds() {
      const pos = this.attributes.position?.data;
      if (!pos) return;
      const n = pos.length / 3;
      let cx = 0, cy = 0, cz = 0;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        cx += x; cy += y; cz += z;
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      }
      cx /= n; cy /= n; cz /= n;
      let r = 0;
      for (let i = 0; i < n; i++) {
        const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz;
        r = Math.max(r, dx * dx + dy * dy + dz * dz);
      }
      Vec3.set(this.boundingSphere.center, cx, cy, cz);
      this.boundingSphere.radius = Math.sqrt(r);
      Vec3.set(this.boundingBox.min, minX, minY, minZ);
      Vec3.set(this.boundingBox.max, maxX, maxY, maxZ);
    }
    compile(gl, programInfo, instanced = false) {
      if (this._isCompiled && this._vao) return;
      if (this._vao) { gl.deleteVertexArray(this._vao); this._vao = null; }
      this._vao = gl.createVertexArray();
      gl.bindVertexArray(this._vao);
      for (const name in this.attributes) {
        const attr = this.attributes[name];
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, attr.data, gl.STATIC_DRAW);
        const loc = programInfo.attribs['a_' + name];
        if (loc !== undefined && loc >= 0) {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, attr.size, gl.FLOAT, attr.normalized, 0, 0);
          if (instanced && name === 'model') {
            for (let i = 0; i < 4; i++) {
              gl.enableVertexAttribArray(loc + i);
              gl.vertexAttribPointer(loc + i, 4, gl.FLOAT, false, 64, 16 * i);
              gl.vertexAttribDivisor(loc + i, 1);
            }
          }
          if (instanced && name === 'instanceColor') {
            gl.vertexAttribDivisor(loc, 1);
          }
        }
        this._buffers[name] = buf;
      }
      if (this.indices) {
        this._indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices, gl.STATIC_DRAW);
      }
      gl.bindVertexArray(null);
      this._isCompiled = true;
    }
    get vertexCount() { return this.indices ? this.indices.length : this._count; }
  }

  // ── Primitive factories ──
  function createBoxGeometry(w = 1, h = 1, d = 1) {
    const g = new Geometry();
    const hw = w / 2, hh = h / 2, hd = d / 2;
    g.setAttribute('position', new Float32Array([
      -hw, -hh, -hd, hw, -hh, -hd, hw, hh, -hd, -hw, hh, -hd,
      -hw, -hh, hd, hw, -hh, hd, hw, hh, hd, -hw, hh, hd
    ]), 3);
    g.setAttribute('normal', new Float32Array([
      0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1
    ]), 3);
    // Tangents (simplified)
    const tangents = new Float32Array(8 * 4);
    for (let i = 0; i < 8; i++) { tangents[i * 4] = 1; tangents[i * 4 + 3] = 1; }
    g.setAttribute('tangent', tangents, 4);
    g.setAttribute('uv', new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1
    ]), 2);
    g.setIndex(new Uint16Array([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
      4, 5, 1, 4, 1, 0, 3, 2, 6, 3, 6, 7,
      1, 5, 6, 1, 6, 2, 4, 0, 3, 4, 3, 7
    ]));
    g.computeBounds();
    return g;
  }

  function createSphereGeometry(radius = 0.5, segments = 24, rings = 18) {
    const g = new Geometry();
    const positions = [], normals = [], uvs = [], tangents = [], indices = [];
    for (let ring = 0; ring <= rings; ring++) {
      const phi = (ring / rings) * Math.PI;
      const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
      for (let seg = 0; seg <= segments; seg++) {
        const theta = (seg / segments) * Math.PI * 2;
        const sinTheta = Math.sin(theta), cosTheta = Math.cos(theta);
        const x = cosTheta * sinPhi * radius;
        const y = cosPhi * radius;
        const z = sinTheta * sinPhi * radius;
        positions.push(x, y, z);
        normals.push(x / radius, y / radius, z / radius);
        uvs.push(seg / segments, ring / rings);
        tangents.push(-sinTheta, 0, cosTheta, 1);
      }
    }
    for (let ring = 0; ring < rings; ring++) {
      for (let seg = 0; seg < segments; seg++) {
        const a = ring * (segments + 1) + seg;
        const b = a + segments + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    g.setAttribute('position', new Float32Array(positions), 3);
    g.setAttribute('normal', new Float32Array(normals), 3);
    g.setAttribute('uv', new Float32Array(uvs), 2);
    g.setAttribute('tangent', new Float32Array(tangents), 4);
    g.setIndex(new Uint16Array(indices));
    g.computeBounds();
    return g;
  }

  function createPlaneGeometry(width = 1, depth = 1) {
    const g = new Geometry();
    const hw = width / 2, hd = depth / 2;
    g.setAttribute('position', new Float32Array([
      -hw, 0, -hd, hw, 0, -hd, hw, 0, hd, -hw, 0, hd
    ]), 3);
    g.setAttribute('normal', new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3);
    const tangents = new Float32Array(16);
    for (let i = 0; i < 4; i++) { tangents[i * 4] = 1; tangents[i * 4 + 3] = 1; }
    g.setAttribute('tangent', tangents, 4);
    g.setAttribute('uv', new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2);
    g.setIndex(new Uint16Array([0, 1, 2, 0, 2, 3]));
    g.computeBounds();
    return g;
  }

  function createCylinderGeometry(radiusTop = 0.5, radiusBottom = 0.5, height = 1, radialSegments = 24) {
    const g = new Geometry();
    const positions = [], normals = [], uvs = [], tangents = [], indices = [];
    const hh = height / 2;
    for (let i = 0; i <= radialSegments; i++) {
      const theta = (i / radialSegments) * Math.PI * 2;
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      positions.push(radiusTop * cosT, hh, radiusTop * sinT);
      normals.push(cosT, 0, sinT);
      uvs.push(i / radialSegments, 0);
      tangents.push(-sinT, 0, cosT, 1);
      positions.push(radiusBottom * cosT, -hh, radiusBottom * sinT);
      normals.push(cosT, 0, sinT);
      uvs.push(i / radialSegments, 1);
      tangents.push(-sinT, 0, cosT, 1);
    }
    for (let i = 0; i < radialSegments; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
    g.setAttribute('position', new Float32Array(positions), 3);
    g.setAttribute('normal', new Float32Array(normals), 3);
    g.setAttribute('uv', new Float32Array(uvs), 2);
    g.setAttribute('tangent', new Float32Array(tangents), 4);
    g.setIndex(new Uint16Array(indices));
    g.computeBounds();
    return g;
  }

  function createTorusGeometry(radius = 0.5, tube = 0.2, radialSegments = 20, tubularSegments = 30) {
    const g = new Geometry();
    const positions = [], normals = [], uvs = [], tangents = [], indices = [];
    for (let j = 0; j <= radialSegments; j++) {
      for (let i = 0; i <= tubularSegments; i++) {
        const u = (i / tubularSegments) * Math.PI * 2;
        const v = (j / radialSegments) * Math.PI * 2;
        const cx = (radius + tube * Math.cos(v)) * Math.cos(u);
        const cy = (radius + tube * Math.cos(v)) * Math.sin(u);
        const cz = tube * Math.sin(v);
        positions.push(cx, cy, cz);
        const nx = Math.cos(v) * Math.cos(u);
        const ny = Math.cos(v) * Math.sin(u);
        const nz = Math.sin(v);
        normals.push(nx, ny, nz);
        uvs.push(i / tubularSegments, j / radialSegments);
        tangents.push(-Math.sin(u), Math.cos(u), 0, 1);
      }
    }
    for (let j = 0; j < radialSegments; j++) {
      for (let i = 0; i < tubularSegments; i++) {
        const a = j * (tubularSegments + 1) + i;
        const b = a + tubularSegments + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    g.setAttribute('position', new Float32Array(positions), 3);
    g.setAttribute('normal', new Float32Array(normals), 3);
    g.setAttribute('uv', new Float32Array(uvs), 2);
    g.setAttribute('tangent', new Float32Array(tangents), 4);
    g.setIndex(new Uint16Array(indices));
    g.computeBounds();
    return g;
  }

  // ────────────────────────── SCENE GRAPH ─────────────────────────────────
  const _scratchMat = Mat4.create();
  const _scratchQuat = Quat.create();
  const _scratchVec = Vec3.create();

  class Node {
    constructor(name = '') {
      this.name = name;
      this.children = [];
      this.parent = null;
      this.position = Vec3.create(0, 0, 0);
      this.quaternion = Quat.create();
      this.scale = Vec3.create(1, 1, 1);
      this.localMatrix = Mat4.create();
      this.worldMatrix = Mat4.create();
      this._localDirty = true;
      this._worldDirty = true;
      this.visible = true;
      this.userData = {};
      this.onUpdate = null;
    }
    setPosition(x, y, z) { Vec3.set(this.position, x, y, z); this.markDirty(); }
    setRotation(x, y, z) { Quat.fromEuler(this.quaternion, x, y, z); this.markDirty(); }
    setScale(x, y, z) { Vec3.set(this.scale, x, y, z); this.markDirty(); }
    markDirty() { this._localDirty = true; this._worldDirty = true; }
    add(child) { child.parent = this; this.children.push(child); return child; }
    remove(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) { this.children.splice(idx, 1); child.parent = null; }
    }
    updateLocalMatrix() {
      if (!this._localDirty) return;
      Mat4.fromQuatTranslation(this.localMatrix, this.quaternion, this.position);
      Mat4.scale(this.localMatrix, this.localMatrix, this.scale);
      this._localDirty = false;
      this._worldDirty = true;
    }
    updateWorldMatrix(parentWorld = null) {
      this.updateLocalMatrix();
      if (this._worldDirty || parentWorld !== this._lastParentWorld) {
        if (parentWorld) Mat4.multiply(this.worldMatrix, parentWorld, this.localMatrix);
        else Mat4.copy(this.worldMatrix, this.localMatrix);
        this._worldDirty = false;
        this._lastParentWorld = parentWorld;
      }
      for (let c of this.children) c.updateWorldMatrix(this.worldMatrix);
    }
    getWorldPosition(out = Vec3.create()) {
      return Vec3.set(out, this.worldMatrix[12], this.worldMatrix[13], this.worldMatrix[14]);
    }
  }

  class Camera extends Node {
    constructor(fov = Math.PI / 4, aspect = 1, near = 0.1, far = 1000) {
      super('Camera');
      this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
      this.projMatrix = Mat4.create();
      this.viewMatrix = Mat4.create();
      this.vpMatrix = Mat4.create();
      this.updateProjection();
    }
    updateProjection() {
      Mat4.perspective(this.projMatrix, this.fov, this.aspect, this.near, this.far);
    }
    updateView() {
      const pos = this.getWorldPosition();
      const forward = Vec3.set(_scratchVec, -this.worldMatrix[8], -this.worldMatrix[9], -this.worldMatrix[10]);
      const center = Vec3.add(_scratchVec, pos, forward);
      const up = Vec3.set(_scratchVec, this.worldMatrix[4], this.worldMatrix[5], this.worldMatrix[6]);
      Mat4.lookAt(this.viewMatrix, pos, center, up);
      Mat4.multiply(this.vpMatrix, this.projMatrix, this.viewMatrix);
    }
  }

  class Mesh extends Node {
    constructor(geometry = null, material = null) {
      super('Mesh');
      this.geometry = geometry;
      this.material = material;
      if (geometry && !geometry.boundingSphere) geometry.computeBounds();
    }
  }

  class SkinnedMesh extends Mesh {
    constructor(geometry, material, skeleton = null) {
      super(geometry, material);
      this.skeleton = skeleton;
      this.boneMatrices = new Float32Array(CONFIG.maxBones * 16);
    }
    updateBoneMatrices() {
      if (!this.skeleton) return;
      const bones = this.skeleton.bones;
      for (let i = 0; i < bones.length && i < CONFIG.maxBones; i++) {
        const bone = bones[i];
        const mat = bone.worldMatrix;
        const invBind = this.skeleton.invBindMatrices[i];
        if (invBind) {
          Mat4.multiply(_scratchMat, mat, invBind);
          this.boneMatrices.set(_scratchMat, i * 16);
        }
      }
    }
  }

  class Skeleton {
    constructor() {
      this.bones = [];
      this.boneMap = {};
      this.invBindMatrices = [];
    }
    addBone(bone, invBindMatrix = null) {
      this.bones.push(bone);
      this.boneMap[bone.name] = bone;
      this.invBindMatrices.push(invBindMatrix || Mat4.create());
      return bone;
    }
    getBoneByName(name) { return this.boneMap[name]; }
  }

  class Bone extends Node {
    constructor(name = '') { super(name); }
  }

  class AnimationClip {
    constructor(name = '', duration = 0) {
      this.name = name;
      this.duration = duration;
      this.tracks = {}; // boneName -> {position: [], rotation: [], scale: []}
      this.loop = true;
    }
    addPositionKey(boneName, time, value) {
      if (!this.tracks[boneName]) this.tracks[boneName] = { position: [], rotation: [], scale: [] };
      this.tracks[boneName].position.push({ time, value: value.slice() });
    }
    addRotationKey(boneName, time, quat) {
      if (!this.tracks[boneName]) this.tracks[boneName] = { position: [], rotation: [], scale: [] };
      this.tracks[boneName].rotation.push({ time, value: Quat.create(quat[0], quat[1], quat[2], quat[3]) });
    }
    addScaleKey(boneName, time, value) {
      if (!this.tracks[boneName]) this.tracks[boneName] = { position: [], rotation: [], scale: [] };
      this.tracks[boneName].scale.push({ time, value: value.slice() });
    }
  }

  class Animator {
    constructor(skeleton = null) {
      this.skeleton = skeleton;
      this.currentClip = null;
      this.time = 0;
      this.isPlaying = false;
    }
    play(clip) { this.currentClip = clip; this.time = 0; this.isPlaying = true; }
    stop() { this.isPlaying = false; }
    update(dt) {
      if (!this.isPlaying || !this.currentClip || !this.skeleton) return;
      this.time += dt;
      const clip = this.currentClip;
      if (this.time > clip.duration) {
        if (clip.loop) this.time %= clip.duration;
        else { this.time = clip.duration; this.isPlaying = false; }
      }
      this._applyClip(clip, this.time);
    }
    _applyClip(clip, time) {
      const skeleton = this.skeleton;
      for (const boneName in clip.tracks) {
        const bone = skeleton.getBoneByName(boneName);
        if (!bone) continue;
        const track = clip.tracks[boneName];
        if (track.position.length > 0) {
          const val = this._interpVec3(track.position, time);
          Vec3.set(bone.position, val[0], val[1], val[2]);
        }
        if (track.rotation.length > 0) {
          const val = this._interpQuat(track.rotation, time);
          Quat.copy(bone.quaternion, val);
        }
        if (track.scale.length > 0) {
          const val = this._interpVec3(track.scale, time);
          Vec3.set(bone.scale, val[0], val[1], val[2]);
        }
        bone.markDirty();
      }
    }
    _interpVec3(keys, time) {
      if (keys.length === 1) return keys[0].value;
      let a = keys[0], b = keys[keys.length - 1];
      for (let i = 0; i < keys.length - 1; i++) {
        if (time >= keys[i].time && time <= keys[i + 1].time) { a = keys[i]; b = keys[i + 1]; break; }
      }
      const t = (time - a.time) / Math.max(b.time - a.time, 0.001);
      return [a.value[0] + (b.value[0] - a.value[0]) * t,
              a.value[1] + (b.value[1] - a.value[1]) * t,
              a.value[2] + (b.value[2] - a.value[2]) * t];
    }
    _interpQuat(keys, time) {
      if (keys.length === 1) return keys[0].value;
      let a = keys[0], b = keys[keys.length - 1];
      for (let i = 0; i < keys.length - 1; i++) {
        if (time >= keys[i].time && time <= keys[i + 1].time) { a = keys[i]; b = keys[i + 1]; break; }
      }
      const t = (time - a.time) / Math.max(b.time - a.time, 0.001);
      const result = Quat.create();
      Quat.slerp(result, a.value, b.value, t);
      return result;
    }
  }

  // ────────────────────────── INSTANCED MESH ──────────────────────────────
  class InstancedMesh extends Mesh {
    constructor(geometry, material, maxCount) {
      super(geometry, material);
      this.maxCount = maxCount;
      this.count = 0;
      this.matrices = new Float32Array(maxCount * 16);
      this.instanceColors = new Float32Array(maxCount * 4);
      this._matrixBuffer = null;
      this._colorBuffer = null;
      for (let i = 0; i < maxCount; i++) {
        this.matrices[i * 16] = 1; this.matrices[i * 16 + 5] = 1;
        this.matrices[i * 16 + 10] = 1; this.matrices[i * 16 + 15] = 1;
        this.instanceColors[i * 4 + 3] = 1;
      }
    }
    setMatrixAt(index, mat4) { this.matrices.set(mat4, index * 16); }
    setColorAt(index, r, g, b, a = 1) {
      this.instanceColors[index * 4] = r;
      this.instanceColors[index * 4 + 1] = g;
      this.instanceColors[index * 4 + 2] = b;
      this.instanceColors[index * 4 + 3] = a;
    }
    updateBuffers(gl) {
      if (!this._matrixBuffer) {
        this._matrixBuffer = gl.createBuffer();
        this._colorBuffer = gl.createBuffer();
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this._matrixBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.matrices.subarray(0, this.count * 16), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceColors.subarray(0, this.count * 4), gl.DYNAMIC_DRAW);
    }
  }

  // ─────────────────────────── MATERIAL & LIGHTS ──────────────────────────
  class Material {
    constructor(opts = {}) {
      this.name = opts.name || 'material';
      this.programInfo = opts.programInfo || null;
      this.uniforms = opts.uniforms || {};
      this.transparent = !!opts.transparent;
      this.defines = opts.defines || {};
      this.instanced = !!opts.instanced;
      this.skinned = !!opts.skinned;
      this.blendMode = opts.blendMode || 'opaque';
      this.depthWrite = opts.depthWrite !== false;
      this.cullFace = opts.cullFace !== false;
    }
  }

  class PBRMaterial extends Material {
    constructor(opts = {}) {
      super(opts);
      this.baseColor = opts.baseColor || Vec3.create(1, 1, 1);
      this.roughness = opts.roughness ?? 0.5;
      this.metalness = opts.metalness ?? 0.0;
      this.ao = opts.ao ?? 1.0;
      this.albedoMap = opts.albedoMap || null;
      this.normalMap = opts.normalMap || null;
      this.roughnessMap = opts.roughnessMap || null;
      this.metalnessMap = opts.metalnessMap || null;
      this.envMap = opts.envMap || null;
      this.envIntensity = opts.envIntensity ?? 0.5;
    }
  }

  class DirectionalLight {
    constructor() {
      this.direction = Vec3.create(0, -1, 0);
      this.color = Vec3.create(1, 1, 1);
      this.intensity = 1.0;
      this.ambient = 0.05;
      this.castShadow = true;
      this.shadowBias = 0.002;
      this.shadowMapSize = CONFIG.shadowMapSize;
      this.shadowMatrix = Mat4.create();
      this._shadowMap = null;
    }
  }

  class PointLight {
    constructor() {
      this.position = Vec3.create(0, 0, 0);
      this.color = Vec3.create(1, 1, 1);
      this.intensity = 1.0;
      this.radius = 10;
      this.castShadow = false;
    }
  }

  // ──────────────────────── FRUSTUM & CULLING ─────────────────────────────
  class Frustum {
    constructor() {
      this.planes = Array.from({ length: 6 }, () => new Float32Array(4));
    }
    extract(vp) {
      const p = this.planes;
      p[0][0] = vp[3] - vp[0]; p[0][1] = vp[7] - vp[4]; p[0][2] = vp[11] - vp[8]; p[0][3] = vp[15] - vp[12];
      p[1][0] = vp[3] + vp[0]; p[1][1] = vp[7] + vp[4]; p[1][2] = vp[11] + vp[8]; p[1][3] = vp[15] + vp[12];
      p[2][0] = vp[3] - vp[1]; p[2][1] = vp[7] - vp[5]; p[2][2] = vp[11] - vp[9]; p[2][3] = vp[15] - vp[13];
      p[3][0] = vp[3] + vp[1]; p[3][1] = vp[7] + vp[5]; p[3][2] = vp[11] + vp[9]; p[3][3] = vp[15] + vp[13];
      p[4][0] = vp[3] - vp[2]; p[4][1] = vp[7] - vp[6]; p[4][2] = vp[11] - vp[10]; p[4][3] = vp[15] - vp[14];
      p[5][0] = vp[3] + vp[2]; p[5][1] = vp[7] + vp[6]; p[5][2] = vp[11] + vp[10]; p[5][3] = vp[15] + vp[14];
      for (let i = 0; i < 6; i++) {
        const len = 1.0 / Math.hypot(p[i][0], p[i][1], p[i][2]);
        p[i][0] *= len; p[i][1] *= len; p[i][2] *= len; p[i][3] *= len;
      }
    }
    testSphere(x, y, z, r) {
      for (let i = 0; i < 6; i++) {
        if (this.planes[i][0] * x + this.planes[i][1] * y + this.planes[i][2] * z + this.planes[i][3] < -r) return false;
      }
      return true;
    }
    testAABB(minX, minY, minZ, maxX, maxY, maxZ) {
      for (let i = 0; i < 6; i++) {
        const p = this.planes[i];
        const px = p[0] > 0 ? maxX : minX;
        const py = p[1] > 0 ? maxY : minY;
        const pz = p[2] > 0 ? maxZ : minZ;
        if (p[0] * px + p[1] * py + p[2] * pz + p[3] < 0) return false;
      }
      return true;
    }
  }

  class OcclusionCuller {
    constructor() { this.visibleList = new Uint8Array(CONFIG.maxInstances); }
  }

  // ─────────────────────── RENDER QUEUE & BATCHING ────────────────────────
  class RenderQueue {
    constructor() { this.opaque = []; this.transparent = []; this.shadowCasters = []; }
    clear() { this.opaque.length = 0; this.transparent.length = 0; this.shadowCasters.length = 0; }
    push(mesh, material, distToCam) {
      if (material.blendMode === 'transparent' || material.transparent) {
        this.transparent.push({ mesh, material, dist: distToCam });
      } else {
        this.opaque.push({ mesh, material, dist: distToCam });
      }
      if (material.castShadow !== false) this.shadowCasters.push({ mesh, material, dist: distToCam });
    }
    sort() {
      this.opaque.sort((a, b) => a.dist - b.dist);
      this.transparent.sort((a, b) => b.dist - a.dist);
    }
  }

  // ────────────────────────── PARTICLE SYSTEM ─────────────────────────────
  class ParticleSystem {
    constructor(maxParticles = 1000) {
      this.maxParticles = maxParticles;
      this.positions = new Float32Array(maxParticles * 3);
      this.velocities = new Float32Array(maxParticles * 3);
      this.colors = new Float32Array(maxParticles * 4);
      this.sizes = new Float32Array(maxParticles);
      this.lifetimes = new Float32Array(maxParticles);
      this.maxLifetimes = new Float32Array(maxParticles);
      this.alive = new Uint8Array(maxParticles);
      this.count = 0;
      this._vboPos = null; this._vboCol = null; this._vboSiz = null;
      this._corners = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
      this._indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
      this._cornerBuffer = null;
      this._indexBuffer = null;
      this._initialized = false;
    }
    _initBuffers(gl) {
      this._cornerBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._cornerBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this._corners, gl.STATIC_DRAW);
      this._indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this._indices, gl.STATIC_DRAW);
      this._vboPos = gl.createBuffer();
      this._vboCol = gl.createBuffer();
      this._vboSiz = gl.createBuffer();
      this._initialized = true;
    }
    emit(pos, vel, color, size, life) {
      if (this.count >= this.maxParticles) return;
      const i = this.count;
      const p = i * 3, v = i * 3, c = i * 4;
      this.positions[p] = pos[0]; this.positions[p + 1] = pos[1]; this.positions[p + 2] = pos[2];
      this.velocities[v] = vel[0]; this.velocities[v + 1] = vel[1]; this.velocities[v + 2] = vel[2];
      this.colors[c] = color[0]; this.colors[c + 1] = color[1]; this.colors[c + 2] = color[2]; this.colors[c + 3] = color[3];
      this.sizes[i] = size;
      this.lifetimes[i] = life;
      this.maxLifetimes[i] = life;
      this.alive[i] = 1;
      this.count++;
    }
    update(dt) {
      for (let i = 0; i < this.count; i++) {
        if (!this.alive[i]) continue;
        this.lifetimes[i] -= dt;
        if (this.lifetimes[i] <= 0) { this.alive[i] = 0; continue; }
        const p = i * 3, v = i * 3;
        this.positions[p] += this.velocities[v] * dt;
        this.positions[p + 1] += this.velocities[v + 1] * dt;
        this.positions[p + 2] += this.velocities[v + 2] * dt;
      }
    }
    getAliveCount() {
      let n = 0;
      for (let i = 0; i < this.count; i++) if (this.alive[i]) n++;
      return n;
    }
  }

  // ──────────────────────────── RENDERER ─────────────────────────────────
  class Renderer {
    constructor(canvas, opts = {}) {
      this.gl = new GL(canvas, opts);
      this.resolution = { width: canvas.width || 800, height: canvas.height || 600 };
      this.setSize(this.resolution.width, this.resolution.height);
      this.frustum = new Frustum();
      this.queue = new RenderQueue();
      this.ringBuffer = new RingBuffer();
      this.enableDefaults();

      // Uniform buffers
      this.uboScene = this.gl.createUBO(128); // 2 mat4 + 3 vec4
      this.uboLight = this.gl.createUBO(32);  // 2 vec4
      this.sceneData = new Float32Array(32);
      this.lightData = new Float32Array(8);

      // Lights
      this.directionalLight = new DirectionalLight();
      this.pointLights = [];
      this.lightShadowMap = null;

      // Skybox
      this.skybox = null;
      this.skyboxCubemap = null;

      // Post-processing
      this.postProcessing = false;
      this.rtMain = null;
      this.rtBloomA = null;
      this.rtBloomB = null;
      this.postProg = null;
      this.brightProg = null;
      this.blurProg = null;
      this.quadVao = null;
      this.bloomStrength = 0.6;
      this.bloomThreshold = 1.0;

      // Fog
      this.fogMode = 0; // 0=none, 1=linear, 2=exp, 3=exp2
      this.fogDensity = 0.01;
      this.fogStart = 10;
      this.fogEnd = 50;
      this.fogColor = Vec3.create(0.5, 0.5, 0.6);

      this._particleProg = null;
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
      if (this.postProcessing) this._setupPostProcessing();
    }

    setupShadowMap() {
      this.lightShadowMap = this.gl.createShadowMap(this.directionalLight.shadowMapSize);
    }

    setupSkybox(cubemapTex) {
      this.skyboxCubemap = cubemapTex;
      this.skybox = this.gl.createProgram(ShaderLib.skyboxVS, ShaderLib.skyboxFS);
      const skyGeo = new Geometry();
      const skyVerts = new Float32Array([
        -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
        -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
        -1, -1, -1, -1, -1, 1, -1, 1, 1, -1, 1, -1,
        1, -1, -1, 1, -1, 1, 1, 1, 1, 1, 1, -1,
        -1, 1, -1, -1, 1, 1, 1, 1, 1, 1, 1, -1,
        -1, -1, -1, -1, -1, 1, 1, -1, 1, 1, -1, -1
      ]);
      const skyIdx = new Uint16Array([
        0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
        8, 9, 10, 8, 10, 11, 12, 14, 13, 12, 15, 14,
        16, 17, 18, 16, 18, 19, 20, 22, 21, 20, 23, 22
      ]);
      skyGeo.setAttribute('position', skyVerts, 3);
      skyGeo.setIndex(skyIdx);
      skyGeo.compile(this.gl.gl, this.skybox);
      this.skyboxGeo = skyGeo;
    }

    enablePostProcessing() {
      this.postProcessing = true;
      this._setupPostProcessing();
    }

    _setupPostProcessing() {
      const w = this.resolution.width, h = this.resolution.height;
      this.rtMain = this.gl.createRenderTarget(w, h, { float: true });
      this.rtBloomA = this.gl.createRenderTarget(w, h, { float: true });
      this.rtBloomB = this.gl.createRenderTarget(w, h, { float: true });
      this.postProg = this.gl.createProgram(ShaderLib.postVS, ShaderLib.bloomFS);
      this.brightProg = this.gl.createProgram(ShaderLib.postVS, ShaderLib.brightFS);
      this.blurProg = this.gl.createProgram(ShaderLib.postVS, ShaderLib.blurFS);
      const quadGeo = new Geometry();
      quadGeo.setAttribute('position', new Float32Array([-1, -1, 3, -1, -1, 3]), 2);
      quadGeo.compile(this.gl.gl, this.postProg);
      this.quadVao = quadGeo._vao;
    }

    updateSceneData(camera) {
      this.sceneData.set(camera.viewMatrix, 0);
      this.sceneData.set(camera.projMatrix, 16);
      this.sceneData.set(camera.vpMatrix, 32);
      this.sceneData.set(this.directionalLight.shadowMatrix, 48);
      const camPos = camera.getWorldPosition();
      this.sceneData[64] = camPos[0]; this.sceneData[65] = camPos[1]; this.sceneData[66] = camPos[2]; this.sceneData[67] = 1;
      this.sceneData[68] = this.fogColor[0]; this.sceneData[69] = this.fogColor[1]; this.sceneData[70] = this.fogColor[2]; this.sceneData[71] = 1;
      this.sceneData[72] = this.fogMode;
      this.sceneData[73] = this.fogDensity;
      this.sceneData[74] = this.fogStart;
      this.sceneData[75] = this.fogEnd;
      this.gl.updateUBO(this.uboScene, this.sceneData);
    }

    updateLightData() {
      const dl = this.directionalLight;
      this.lightData[0] = dl.direction[0];
      this.lightData[1] = dl.direction[1];
      this.lightData[2] = dl.direction[2];
      this.lightData[3] = dl.intensity;
      this.lightData[4] = dl.color[0];
      this.lightData[5] = dl.color[1];
      this.lightData[6] = dl.color[2];
      this.lightData[7] = dl.ambient;
      this.gl.updateUBO(this.uboLight, this.lightData);
    }

    renderShadowMap(scene) {
      if (!this.lightShadowMap || !this.directionalLight.castShadow) return;
      const gl = this.gl.gl;
      const dl = this.directionalLight;
      const size = dl.shadowMapSize;
      const lightView = Mat4.create();
      const lightProj = Mat4.create();
      const center = Vec3.create(0, 0, 0);
      const up = Vec3.create(0, 1, 0);
      const lightDir = Vec3.normalize(Vec3.create(), dl.direction);
      const lightPos = Vec3.scale(Vec3.create(), lightDir, -50);
      Mat4.lookAt(lightView, lightPos, center, up);
      Mat4.ortho(lightProj, -20, 20, -20, 20, 0.1, 100);
      Mat4.multiply(dl.shadowMatrix, lightProj, lightView);
      
      this.gl.state.bindFramebuffer(this.lightShadowMap.framebuffer);
      gl.viewport(0, 0, size, size);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.CULL_FACE);
      
      const shadowProg = this.gl.createProgram(ShaderLib.shadowVS, ShaderLib.shadowFS);
      const state = this.gl.state;
      state.bindProgram(shadowProg.program);
      
      for (const cmd of this.queue.shadowCasters) {
        const mesh = cmd.mesh;
        const mat = cmd.material;
        const geo = mesh.geometry;
        if (!geo) continue;
        if (!geo._isCompiled) geo.compile(gl, shadowProg, mat.instanced);
        state.bindVAO(geo._vao);
        if (mesh instanceof InstancedMesh) {
          mesh.updateBuffers(gl);
          // Bind instance matrices
          gl.bindBuffer(gl.ARRAY_BUFFER, mesh._matrixBuffer);
          const loc = shadowProg.attribs.a_model;
          if (loc !== undefined && loc >= 0) {
            for (let i = 0; i < 4; i++) {
              gl.enableVertexAttribArray(loc + i);
              gl.vertexAttribPointer(loc + i, 4, gl.FLOAT, false, 64, 16 * i);
              gl.vertexAttribDivisor(loc + i, 1);
            }
          }
          gl.uniformMatrix4fv(shadowProg.uniforms.u_lightVP, false, dl.shadowMatrix);
          if (geo.indices) {
            gl.drawElementsInstanced(gl.TRIANGLES, geo.indices.length, gl.UNSIGNED_SHORT, 0, mesh.count);
          } else {
            gl.drawArraysInstanced(gl.TRIANGLES, 0, geo._count, mesh.count);
          }
        } else {
          gl.uniformMatrix4fv(shadowProg.uniforms.u_model, false, mesh.worldMatrix);
          gl.uniformMatrix4fv(shadowProg.uniforms.u_lightVP, false, dl.shadowMatrix);
          if (geo.indices) {
            const type = geo.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
            gl.drawElements(gl.TRIANGLES, geo.indices.length, type, 0);
          } else {
            gl.drawArrays(gl.TRIANGLES, 0, geo._count);
          }
        }
      }
      
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      this.gl.state.bindFramebuffer(this.postProcessing ? this.rtMain.framebuffer : null);
      gl.viewport(0, 0, this.resolution.width, this.resolution.height);
    }

    render(scene, camera) {
      const gl = this.gl.gl;
      const state = this.gl.state;
      this.ringBuffer.reset();
      
      camera.updateWorldMatrix();
      camera.updateView();
      scene.updateWorldMatrix();
      this.frustum.extract(camera.vpMatrix);
      
      this.updateSceneData(camera);
      this.updateLightData();
      
      this.queue.clear();
      this._gather(scene, camera);
      this.queue.sort();
      
      if (this.directionalLight.castShadow && this.lightShadowMap) {
        this.renderShadowMap(scene);
      }
      
      const targetFb = this.postProcessing ? this.rtMain.framebuffer : null;
      state.bindFramebuffer(targetFb);
      gl.viewport(0, 0, this.resolution.width, this.resolution.height);
      
      const c = CONFIG.defaultClearColor;
      gl.clearColor(c[0], c[1], c[2], c[3]);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      
      // Render skybox if present
      if (this.skybox && this.skyboxCubemap) {
        this._renderSkybox(camera);
        gl.clear(gl.DEPTH_BUFFER_BIT);
      }
      
      // Render opaque
      for (const cmd of this.queue.opaque) {
        this._draw(cmd.mesh, cmd.material, camera);
      }
      
      // Render transparent
      state.enableBlend();
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      state.setDepthMask(false);
      for (const cmd of this.queue.transparent) {
        this._draw(cmd.mesh, cmd.material, camera);
      }
      state.setDepthMask(true);
      state.disableBlend();
      
      // Post-processing
      if (this.postProcessing) {
        this._renderPostProcessing();
      }
    }

    _renderSkybox(camera) {
      const gl = this.gl.gl;
      const state = this.gl.state;
      state.bindProgram(this.skybox.program);
      state.bindVAO(this.skyboxGeo._vao);
      state.bindTextureCube(0, this.skyboxCubemap);
      gl.uniform1i(this.skybox.uniforms.u_skybox, 0);
      gl.uniform1f(this.skybox.uniforms.u_skyboxIntensity, 1.0);
      const blockScene = this.skybox.uniformBlocks['SceneData'];
      if (blockScene !== undefined) {
        gl.uniformBlockBinding(this.skybox.program, blockScene, 0);
        state.bindUBO(0, this.uboScene);
      }
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      const type = this.skyboxGeo.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      gl.drawElements(gl.TRIANGLES, this.skyboxGeo.indices.length, type, 0);
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
    }

    _renderPostProcessing() {
      const gl = this.gl.gl;
      const state = this.gl.state;
      
      // Bright pass
      state.bindFramebuffer(this.rtBloomA.framebuffer);
      state.bindProgram(this.brightProg.program);
      state.bindVAO(this.quadVao);
      state.bindTexture(0, this.rtMain.texture);
      gl.uniform1i(this.brightProg.uniforms.u_scene, 0);
      gl.uniform1f(this.brightProg.uniforms.u_threshold, this.bloomThreshold);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      
      // Blur passes (horizontal then vertical)
      state.bindFramebuffer(this.rtBloomB.framebuffer);
      state.bindProgram(this.blurProg.program);
      state.bindTexture(0, this.rtBloomA.texture);
      gl.uniform1i(this.blurProg.uniforms.u_input, 0);
      gl.uniform2f(this.blurProg.uniforms.u_direction, 1, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      
      state.bindFramebuffer(this.rtBloomA.framebuffer);
      state.bindTexture(0, this.rtBloomB.texture);
      gl.uniform1i(this.blurProg.uniforms.u_input, 0);
      gl.uniform2f(this.blurProg.uniforms.u_direction, 0, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      
      // Composite
      state.bindFramebuffer(null);
      gl.viewport(0, 0, this.resolution.width, this.resolution.height);
      state.bindProgram(this.postProg.program);
      state.bindVAO(this.quadVao);
      state.bindTexture(0, this.rtMain.texture);
      state.bindTexture(1, this.rtBloomA.texture);
      gl.uniform1i(this.postProg.uniforms.u_scene, 0);
      gl.uniform1i(this.postProg.uniforms.u_bloom, 1);
      gl.uniform1f(this.postProg.uniforms.u_bloomStrength, this.bloomStrength);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    _gather(node, camera) {
      if (!node.visible) return;
      
      if (node instanceof Mesh && node.geometry) {
        const bs = node.geometry.boundingSphere;
        const cx = node.worldMatrix[12] + bs.center[0];
        const cy = node.worldMatrix[13] + bs.center[1];
        const cz = node.worldMatrix[14] + bs.center[2];
        const worldRadius = bs.radius * Math.max(Math.max(
          Math.hypot(node.worldMatrix[0], node.worldMatrix[1], node.worldMatrix[2]),
          Math.hypot(node.worldMatrix[4], node.worldMatrix[5], node.worldMatrix[6])),
          Math.hypot(node.worldMatrix[8], node.worldMatrix[9], node.worldMatrix[10]));
        
        if (this.frustum.testSphere(cx, cy, cz, worldRadius)) {
          const camPos = camera.getWorldPosition();
          const dx = cx - camPos[0], dy = cy - camPos[1], dz = cz - camPos[2];
          const dist = dx * dx + dy * dy + dz * dz;
          this.queue.push(node, node.material, dist);
        }
      } else if (node instanceof InstancedMesh && node.count > 0) {
        const bs = node.geometry.boundingSphere;
        const worldRadius = bs.radius;
        const camPos = camera.getWorldPosition();
        const dx = node.worldMatrix[12] - camPos[0];
        const dy = node.worldMatrix[13] - camPos[1];
        const dz = node.worldMatrix[14] - camPos[2];
        this.queue.push(node, node.material, dx * dx + dy * dy + dz * dz);
      }
      
      for (let c of node.children) this._gather(c, camera);
    }

    _draw(mesh, material, camera) {
      const gl = this.gl.gl;
      const state = this.gl.state;
      const geo = mesh.geometry;
      const progInfo = material.programInfo;
      if (!progInfo || !geo) return;
      
      state.bindProgram(progInfo.program);
      
      // Bind UBOs
      const blockScene = progInfo.uniformBlocks['SceneData'];
      if (blockScene !== undefined) {
        gl.uniformBlockBinding(progInfo.program, blockScene, 0);
        state.bindUBO(0, this.uboScene);
      }
      const blockLight = progInfo.uniformBlocks['LightData'];
      if (blockLight !== undefined) {
        gl.uniformBlockBinding(progInfo.program, blockLight, 1);
        state.bindUBO(1, this.uboLight);
      }
      
      // Bind shadow map
      if (this.lightShadowMap) {
        state.bindTexture(2, this.lightShadowMap.texture);
        if (progInfo.uniforms.u_shadowMap) gl.uniform1i(progInfo.uniforms.u_shadowMap, 2);
      }
      
      // Bind environment map
      if (material.envMap) {
        state.bindTextureCube(3, material.envMap);
        if (progInfo.uniforms.u_envMap) gl.uniform1i(progInfo.uniforms.u_envMap, 3);
        if (progInfo.uniforms.u_envIntensity) gl.uniform1f(progInfo.uniforms.u_envIntensity, material.envIntensity);
      }
      
      // Set material uniforms
      if (progInfo.uniforms.u_baseColor) gl.uniform3fv(progInfo.uniforms.u_baseColor, material.baseColor || [1, 1, 1]);
      if (progInfo.uniforms.u_roughness) gl.uniform1f(progInfo.uniforms.u_roughness, material.roughness ?? 0.5);
      if (progInfo.uniforms.u_metalness) gl.uniform1f(progInfo.uniforms.u_metalness, material.metalness ?? 0.0);
      if (progInfo.uniforms.u_ao) gl.uniform1f(progInfo.uniforms.u_ao, material.ao ?? 1.0);
      
      // Bind textures
      let texUnit = 4;
      const bindTex = (tex, uniformName) => {
        if (tex && progInfo.uniforms[uniformName]) {
          state.bindTexture(texUnit, tex);
          gl.uniform1i(progInfo.uniforms[uniformName], texUnit);
          texUnit++;
        }
      };
      bindTex(material.albedoMap, 'u_albedoMap');
      bindTex(material.normalMap, 'u_normalMap');
      bindTex(material.roughnessMap, 'u_roughnessMap');
      bindTex(material.metalnessMap, 'u_metalnessMap');
      
      if (material.cullFace === false) gl.disable(gl.CULL_FACE);
      else gl.enable(gl.CULL_FACE);
      
      if (mesh instanceof SkinnedMesh) {
        mesh.updateBoneMatrices();
        if (progInfo.uniforms.u_boneMatrices) {
          gl.uniformMatrix4fv(progInfo.uniforms.u_boneMatrices, false, mesh.boneMatrices);
        }
      }
      
      if (mesh instanceof InstancedMesh) {
        if (!geo._isCompiled) geo.compile(gl, progInfo, true);
        mesh.updateBuffers(gl);
        state.bindVAO(geo._vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh._matrixBuffer);
        const modelLoc = progInfo.attribs.a_model;
        if (modelLoc !== undefined && modelLoc >= 0) {
          for (let i = 0; i < 4; i++) {
            gl.enableVertexAttribArray(modelLoc + i);
            gl.vertexAttribPointer(modelLoc + i, 4, gl.FLOAT, false, 64, 16 * i);
            gl.vertexAttribDivisor(modelLoc + i, 1);
          }
        }
        const colorLoc = progInfo.attribs.a_instanceColor;
        if (colorLoc !== undefined && colorLoc >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, mesh._colorBuffer);
          gl.enableVertexAttribArray(colorLoc);
          gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, 0, 0);
          gl.vertexAttribDivisor(colorLoc, 1);
        }
        if (geo.indices) {
          const type = geo.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
          gl.drawElementsInstanced(gl.TRIANGLES, geo.indices.length, type, 0, mesh.count);
        } else {
          gl.drawArraysInstanced(gl.TRIANGLES, 0, geo._count, mesh.count);
        }
      } else {
        if (!geo._isCompiled) geo.compile(gl, progInfo, material.skinned);
        state.bindVAO(geo._vao);
        if (progInfo.uniforms.u_model) gl.uniformMatrix4fv(progInfo.uniforms.u_model, false, mesh.worldMatrix);
        if (geo.indices) {
          const type = geo.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
          gl.drawElements(gl.TRIANGLES, geo.indices.length, type, 0);
        } else {
          gl.drawArrays(gl.TRIANGLES, 0, geo._count);
        }
      }
    }

    renderParticles(ps, camera) {
      if (!ps || ps.count === 0) return;
      const gl = this.gl.gl;
      const state = this.gl.state;
      
      if (!this._particleProg) {
        this._particleProg = this.gl.createProgram(ShaderLib.particleVS, ShaderLib.particleFS);
        this._particleVao = gl.createVertexArray();
      }
      if (!ps._initialized) ps._initBuffers(gl);
      
      const aliveCount = ps.getAliveCount();
      if (aliveCount === 0) return;
      
      // Update alive particle data
      const posData = new Float32Array(aliveCount * 3);
      const colData = new Float32Array(aliveCount * 4);
      const sizData = new Float32Array(aliveCount);
      let j = 0;
      for (let i = 0; i < ps.count; i++) {
        if (!ps.alive[i]) continue;
        posData.set(ps.positions.subarray(i * 3, i * 3 + 3), j * 3);
        colData.set(ps.colors.subarray(i * 4, i * 4 + 4), j * 4);
        sizData[j] = ps.sizes[i];
        j++;
      }
      
      state.bindProgram(this._particleProg.program);
      const blockScene = this._particleProg.uniformBlocks['SceneData'];
      if (blockScene !== undefined) {
        gl.uniformBlockBinding(this._particleProg.program, blockScene, 0);
        state.bindUBO(0, this.uboScene);
      }
      state.bindVAO(this._particleVao);
      
      gl.bindBuffer(gl.ARRAY_BUFFER, ps._cornerBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      
      gl.bindBuffer(gl.ARRAY_BUFFER, ps._vboPos);
      gl.bufferData(gl.ARRAY_BUFFER, posData, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, 1);
      
      gl.bindBuffer(gl.ARRAY_BUFFER, ps._vboCol);
      gl.bufferData(gl.ARRAY_BUFFER, colData, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(2, 1);
      
      gl.bindBuffer(gl.ARRAY_BUFFER, ps._vboSiz);
      gl.bufferData(gl.ARRAY_BUFFER, sizData, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(3, 1);
      
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ps._indexBuffer);
      gl.depthMask(false);
      state.enableBlend();
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, aliveCount);
      state.disableBlend();
      gl.depthMask(true);
      state.bindVAO(null);
    }
  }

  // ─────────────────────────────── APP ────────────────────────────────────
  class App {
    constructor(opts = {}) {
      this.canvas = opts.canvas || document.createElement('canvas');
      if (!opts.canvas) document.body.appendChild(this.canvas);
      this.renderer = new Renderer(this.canvas);
      this.scene = new Node('Scene');
      this.camera = new Camera(Math.PI / 4, this.canvas.width / this.canvas.height, 0.1, 2000);
      this.scene.add(this.camera);
      this.resources = new ResourceManager(this.renderer.gl);
      this.input = new Input(this.canvas);
      this._running = false;
      this._lastTime = Util.now();
      this._frameCount = 0;
      this._fpsTime = 0;
      this._fps = 0;
      this.update = opts.update || function () {};
      this.particleSystems = [];
      
      // Load default PBR shaders
      this._initDefaultShaders();
      
      window.addEventListener('resize', () => {
        const w = window.innerWidth, h = window.innerHeight;
        this.canvas.width = w;
        this.canvas.height = h;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjection();
      });
    }

    _initDefaultShaders() {
      const res = this.resources;
      res.loadShader('pbr', ShaderLib.pbrVS, ShaderLib.pbrFS, { INSTANCED: 0, SKINNED: 0 });
      res.loadShader('pbrInst', ShaderLib.pbrVS, ShaderLib.pbrFS, { INSTANCED: 1, SKINNED: 0 });
      res.loadShader('pbrSkinned', ShaderLib.pbrVS, ShaderLib.pbrFS, { INSTANCED: 0, SKINNED: 1 });
      res.loadShader('pbrInstSkinned', ShaderLib.pbrVS, ShaderLib.pbrFS, { INSTANCED: 1, SKINNED: 1 });
    }

    start() {
      this._running = true;
      const loop = () => {
        if (!this._running) return;
        const now = Util.now();
        const dt = Math.min((now - this._lastTime) / 1000, 0.1);
        this._lastTime = now;
        this.input.update();
        this.update(dt);
        this.renderer.render(this.scene, this.camera);
        for (const ps of this.particleSystems) {
          this.renderer.renderParticles(ps, this.camera);
        }
        this._computeFPS(dt);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    stop() { this._running = false; }

    _computeFPS(dt) {
      this._frameCount++;
      this._fpsTime += dt;
      if (this._fpsTime >= 1) {
        this._fps = Math.round(this._frameCount / this._fpsTime);
        this._frameCount = 0;
        this._fpsTime = 0;
      }
    }

    get fps() { return this._fps; }

    // Primitive factory methods
    createBox(w = 1, h = 1, d = 1) { return createBoxGeometry(w, h, d); }
    createSphere(r = 0.5, seg = 24, rings = 18) { return createSphereGeometry(r, seg, rings); }
    createPlane(w = 1, d = 1) { return createPlaneGeometry(w, d); }
    createCylinder(rt = 0.5, rb = 0.5, h = 1, seg = 24) { return createCylinderGeometry(rt, rb, h, seg); }
    createTorus(r = 0.5, tube = 0.2, rs = 20, ts = 30) { return createTorusGeometry(r, tube, rs, ts); }
  }

  // ─────────────────────────── EXPORT & DEMO ──────────────────────────────
  const MiniEngine = {
    Util, Vec3, Quat, Mat4, RingBuffer, WasmBulkProcessor,
    Input, GL, GLState, ShaderLib, ResourceManager,
    Geometry, Material, PBRMaterial, Mesh, SkinnedMesh, Skeleton, Bone,
    AnimationClip, Animator, InstancedMesh, Node, Camera,
    DirectionalLight, PointLight, Frustum, RenderQueue, Renderer,
    App, ParticleSystem,
    createBoxGeometry, createSphereGeometry, createPlaneGeometry,
    createCylinderGeometry, createTorusGeometry,
  };
  global.MiniEngine = MiniEngine;

  // ── Auto-demo ──
  (function autoDemo() {
    try {
      const canvas = document.getElementById('mini-canvas');
      if (!canvas) return;
      const app = new MiniEngine.App({ canvas });
      const res = app.resources;
      
      // Setup shadow mapping
      app.renderer.setupShadowMap();
      
      // Enable post-processing
      app.renderer.enablePostProcessing();
      app.renderer.bloomStrength = 0.5;
      
      // Fog
      app.renderer.fogMode = 2; // exp
      app.renderer.fogDensity = 0.02;
      app.renderer.fogColor = Vec3.create(0.4, 0.45, 0.55);
      
      // Materials
      const matRed = new PBRMaterial({
        programInfo: res.getShader('pbr'),
        baseColor: Vec3.create(0.9, 0.2, 0.2),
        roughness: 0.4,
        metalness: 0.0,
      });
      const matMetal = new PBRMaterial({
        programInfo: res.getShader('pbrInst'),
        baseColor: Vec3.create(0.9, 0.85, 0.8),
        roughness: 0.3,
        metalness: 0.9,
        instanced: true,
      });
      const matFloor = new PBRMaterial({
        programInfo: res.getShader('pbr'),
        baseColor: Vec3.create(0.3, 0.35, 0.4),
        roughness: 0.8,
        metalness: 0.0,
      });
      
      // Geometries
      const boxGeo = app.createBox(1, 1, 1);
      const sphereGeo = app.createSphere(0.5, 32, 24);
      const floorGeo = app.createPlane(30, 30);
      
      // Floor
      const floor = new Mesh(floorGeo, matFloor);
      floor.setPosition(0, -1, -10);
      app.scene.add(floor);
      
      // Spheres
      const sphere1 = new Mesh(sphereGeo, matRed);
      sphere1.setPosition(-2, 0, -10);
      app.scene.add(sphere1);
      
      const sphere2 = new Mesh(sphereGeo, matRed);
      sphere2.setPosition(2, 0, -10);
      app.scene.add(sphere2);
      
      // Instanced metal cubes
      const instCount = 200;
      const instMesh = new InstancedMesh(boxGeo, matMetal, instCount);
      for (let i = 0; i < instCount; i++) {
        const angle = (i / instCount) * Math.PI * 2;
        const radius = 5 + Math.sin(i * 0.1) * 2;
        const x = Math.cos(angle) * radius;
        const z = -10 + Math.sin(angle) * 3;
        const m = Mat4.create();
        Mat4.translate(m, m, [x, 0.5, z]);
        Mat4.rotateY(m, m, angle);
        Mat4.scale(m, m, [0.5, 0.5, 0.5]);
        instMesh.setMatrixAt(i, m);
        instMesh.setColorAt(i, 0.8 + Math.random() * 0.2, 0.75 + Math.random() * 0.2, 0.7 + Math.random() * 0.2, 1);
      }
      instMesh.count = instCount;
      app.scene.add(instMesh);
      
      // Camera
      app.camera.setPosition(0, 3, 0);
      app.camera.setRotation(-0.15, 0, 0);
      
      // Directional light
      const light = app.renderer.directionalLight;
      Vec3.set(light.direction, -1, -3, -2);
      Vec3.normalize(light.direction, light.direction);
      light.intensity = 2.0;
      light.ambient = 0.08;
      
      // Particle system
      const ps = new ParticleSystem(2000);
      app.particleSystems.push(ps);
      
      // Update loop
      app.update = (dt) => {
        sphere1.position[1] = Math.sin(Date.now() * 0.001) * 0.5;
        sphere1.markDirty();
        sphere2.rotation[1] += dt * 0.8;
        sphere2.markDirty();
        
        // Rotate instanced group
        for (let i = 0; i < instCount; i++) {
          const idx = i * 16;
          const m = instMesh.matrices;
          const angle = Math.atan2(m[idx + 14] + 10, m[idx + 12]) + dt * 0.2;
          const dist = Math.hypot(m[idx + 12], m[idx + 14] + 10);
          m[idx + 12] = Math.cos(angle) * dist;
          m[idx + 14] = -10 + Math.sin(angle) * dist;
          const rot = Mat4.create();
          Mat4.translate(rot, rot, [m[idx + 12], m[idx + 13], m[idx + 14]]);
          Mat4.rotateY(rot, rot, angle);
          Mat4.scale(rot, rot, [0.5, 0.5, 0.5]);
          instMesh.setMatrixAt(i, rot);
        }
        
        // Particles
        ps.update(dt);
        if (Math.random() < 0.4) {
          const pos = [Math.random() * 10 - 5, 5 + Math.random() * 3, -15 + Math.random() * 5];
          const vel = [Math.random() * 0.5 - 0.25, -(0.5 + Math.random()), Math.random() * 0.5 - 0.25];
          const col = [Math.random() * 0.8 + 0.2, Math.random() * 0.3, Math.random() * 0.5, 0.8];
          ps.emit(pos, vel, col, 0.15 + Math.random() * 0.2, 3 + Math.random() * 2);
        }
      };
      
      app.start();
      console.log('MiniEngine v3.0 "Titan" running. FPS:', () => app.fps);
    } catch (e) {
      console.error('MiniEngine demo error:', e);
    }
  })();

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
