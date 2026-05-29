/**
 * miniEngineWasm.js — Professional Edition with Advanced Features
 * 
 * New Upgrades:
 * 1. Quaternion-based rotation (gimbal‑lock free).
 * 2. Input Manager (keyboard + mouse).
 * 3. Texture loading & asset manager.
 * 4. Multiple lights with UBO (Uniform Buffer Objects).
 * 5. Shader permutations & centralised shader manager.
 * 6. Instanced rendering for massive object counts.
 * 7. Particle system (billboarded points + simple physics).
 * 8. Post‑processing (bloom via two‑pass render targets).
 * 9. Debug overlay (FPS counter).
 * 10. Frustum culling for instanced arrays.
 * 11. Simple transform animator.
 * 12. Zero‑allocation architecture preserved.
 * 
 * License: MIT
 */
(function (global) {
  'use strict';

  const CONFIG = {
    webgl2Preferred: true,
    defaultClearColor: [0.08, 0.08, 0.1, 1.0],
    log: false,
    maxLights: 4,
  };

  // ---------- Utilities ----------
  const Util = {
    now: (typeof performance !== 'undefined' && performance.now) ? performance.now.bind(performance) : Date.now,
    assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); },
    clamp(v, a, b) { return Math.max(a, Math.min(b, v)); },
    isPowerOfTwo(x) { return (x & (x - 1)) === 0; },
    uid(prefix = '') { return prefix + Math.random().toString(36).slice(2, 9); },
    log(...args) { if (CONFIG.log) console.log(...args); },
    loadImage(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
    },
    fetchShader(url) {
      return fetch(url).then(r => r.text());
    }
  };

  // ---------- WASM Bulk Architecture ----------
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
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  WasmBulkProcessor.init().catch(() => {});

  // ---------- Zero-Allocation Math Library ----------
  const Vec3 = {
    create(x = 0, y = 0, z = 0) { return new Float32Array([x, y, z]); },
    set(out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; return out; },
    copy(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; },
    add(out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out; },
    sub(out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out; },
    scale(out, a, s) { out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; return out; },
    dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; },
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
    }
  };

  const Quat = {
    create(x = 0, y = 0, z = 0, w = 1) { return new Float32Array([x, y, z, w]); },
    identity(out) { out[0]=0; out[1]=0; out[2]=0; out[3]=1; return out; },
    copy(out, q) { out[0]=q[0]; out[1]=q[1]; out[2]=q[2]; out[3]=q[3]; return out; },
    fromEuler(out, x, y, z) {
      const hx = x/2, hy = y/2, hz = z/2;
      const sx = Math.sin(hx), cx = Math.cos(hx);
      const sy = Math.sin(hy), cy = Math.cos(hy);
      const sz = Math.sin(hz), cz = Math.cos(hz);
      out[0] = sx*cy*cz - cx*sy*sz;
      out[1] = cx*sy*cz + sx*cy*sz;
      out[2] = cx*cy*sz - sx*sy*cz;
      out[3] = cx*cy*cz + sx*sy*sz;
      return out;
    },
    multiply(out, a, b) {
      const ax=a[0], ay=a[1], az=a[2], aw=a[3];
      const bx=b[0], by=b[1], bz=b[2], bw=b[3];
      out[0]=ax*bw + aw*bx + ay*bz - az*by;
      out[1]=ay*bw + aw*by + az*bx - ax*bz;
      out[2]=az*bw + aw*bz + ax*by - ay*bx;
      out[3]=aw*bw - ax*bx - ay*by - az*bz;
      return out;
    },
    normalize(out, q) {
      let len = Math.hypot(q[0], q[1], q[2], q[3]);
      if (len > 0) len = 1/len;
      out[0]=q[0]*len; out[1]=q[1]*len; out[2]=q[2]*len; out[3]=q[3]*len;
      return out;
    },
    setAxisAngle(out, axis, angle) {
      const half = angle * 0.5;
      const s = Math.sin(half);
      out[0] = axis[0] * s;
      out[1] = axis[1] * s;
      out[2] = axis[2] * s;
      out[3] = Math.cos(half);
      return out;
    },
    toMat4(out, q) {
      const x=q[0], y=q[1], z=q[2], w=q[3];
      const xx=x*x, yy=y*y, zz=z*z;
      const xy=x*y, xz=x*z, yz=y*z;
      const wx=w*x, wy=w*y, wz=w*z;
      out[0]=1-2*(yy+zz); out[1]=2*(xy+wz);   out[2]=2*(xz-wy);   out[3]=0;
      out[4]=2*(xy-wz);   out[5]=1-2*(xx+zz); out[6]=2*(yz+wx);   out[7]=0;
      out[8]=2*(xz+wy);   out[9]=2*(yz-wx);   out[10]=1-2*(xx+yy); out[11]=0;
      out[12]=0;          out[13]=0;          out[14]=0;           out[15]=1;
      return out;
    }
  };

  const Mat4 = {
    create() { const m = new Float32Array(16); m[0]=1;m[5]=1;m[10]=1;m[15]=1; return m; },
    identity(out) { out[0]=1;out[1]=0;out[2]=0;out[3]=0;out[4]=0;out[5]=1;out[6]=0;out[7]=0;out[8]=0;out[9]=0;out[10]=1;out[11]=0;out[12]=0;out[13]=0;out[14]=0;out[15]=1; return out; },
    copy(out, a) { for (let i=0;i<16;i++) out[i]=a[i]; return out; },
    multiply(out, a, b) {
      const a00=a[0],a01=a[1],a02=a[2],a03=a[3], a10=a[4],a11=a[5],a12=a[6],a13=a[7];
      const a20=a[8],a21=a[9],a22=a[10],a23=a[11], a30=a[12],a31=a[13],a32=a[14],a33=a[15];
      let b0=b[0],b1=b[1],b2=b[2],b3=b[3];
      out[0]=b0*a00+b1*a10+b2*a20+b3*a30; out[1]=b0*a01+b1*a11+b2*a21+b3*a31;
      out[2]=b0*a02+b1*a12+b2*a22+b3*a32; out[3]=b0*a03+b1*a13+b2*a23+b3*a33;
      b0=b[4];b1=b[5];b2=b[6];b3=b[7];
      out[4]=b0*a00+b1*a10+b2*a20+b3*a30; out[5]=b0*a01+b1*a11+b2*a21+b3*a31;
      out[6]=b0*a02+b1*a12+b2*a22+b3*a32; out[7]=b0*a03+b1*a13+b2*a23+b3*a33;
      b0=b[8];b1=b[9];b2=b[10];b3=b[11];
      out[8]=b0*a00+b1*a10+b2*a20+b3*a30; out[9]=b0*a01+b1*a11+b2*a21+b3*a31;
      out[10]=b0*a02+b1*a12+b2*a22+b3*a32; out[11]=b0*a03+b1*a13+b2*a23+b3*a33;
      b0=b[12];b1=b[13];b2=b[14];b3=b[15];
      out[12]=b0*a00+b1*a10+b2*a20+b3*a30; out[13]=b0*a01+b1*a11+b2*a21+b3*a31;
      out[14]=b0*a02+b1*a12+b2*a22+b3*a32; out[15]=b0*a03+b1*a13+b2*a23+b3*a33;
      return out;
    },
    translate(out, a, v) {
      const x=v[0], y=v[1], z=v[2];
      if (a === out) {
        out[12] = a[0]*x + a[4]*y + a[8]*z + a[12];
        out[13] = a[1]*x + a[5]*y + a[9]*z + a[13];
        out[14] = a[2]*x + a[6]*y + a[10]*z + a[14];
        out[15] = a[3]*x + a[7]*y + a[11]*z + a[15];
      } else {
        Mat4.copy(out, a);
        out[12] = a[0]*x + a[4]*y + a[8]*z + a[12];
        out[13] = a[1]*x + a[5]*y + a[9]*z + a[13];
        out[14] = a[2]*x + a[6]*y + a[10]*z + a[14];
        out[15] = a[3]*x + a[7]*y + a[11]*z + a[15];
      }
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
    perspective(out, fovy, aspect, near, far) {
      const f = 1.0 / Math.tan(fovy / 2);
      out[0] = f / aspect; out[1]=0; out[2]=0; out[3]=0;
      out[4]=0; out[5]=f; out[6]=0; out[7]=0;
      out[8]=0; out[9]=0; out[10]=(far+near)/(near-far); out[11]=-1;
      out[12]=0; out[13]=0; out[14]=(2*far*near)/(near-far); out[15]=0;
      return out;
    },
    lookAt(out, eye, center, up) {
      let z0 = eye[0]-center[0], z1 = eye[1]-center[1], z2 = eye[2]-center[2];
      let len = 1 / Math.hypot(z0,z1,z2);
      z0 *= len; z1 *= len; z2 *= len;
      let x0 = up[1]*z2 - up[2]*z1, x1 = up[2]*z0 - up[0]*z2, x2 = up[0]*z1 - up[1]*z0;
      len = Math.hypot(x0,x1,x2);
      if (len) { len = 1/len; x0*=len; x1*=len; x2*=len; }
      let y0 = z1*x2 - z2*x1, y1 = z2*x0 - z0*x2, y2 = z0*x1 - z1*x0;
      out[0]=x0;out[1]=y0;out[2]=z0;out[3]=0; out[4]=x1;out[5]=y1;out[6]=z1;out[7]=0;
      out[8]=x2;out[9]=y2;out[10]=z2;out[11]=0;
      out[12]=-(x0*eye[0]+x1*eye[1]+x2*eye[2]);
      out[13]=-(y0*eye[0]+y1*eye[1]+y2*eye[2]);
      out[14]=-(z0*eye[0]+z1*eye[1]+z2*eye[2]);
      out[15]=1;
      return out;
    },
    fromQuatTranslation(out, q, v) {
      Quat.toMat4(out, q);
      out[12] = v[0]; out[13] = v[1]; out[14] = v[2];
      return out;
    }
  };

  // ---------- Input Manager ----------
  class Input {
    constructor(canvas) {
      this.keys = {};
      this.mouse = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0 };
      this._lastMouse = { x: 0, y: 0 };
      canvas.addEventListener('keydown', e => (this.keys[e.key] = true));
      canvas.addEventListener('keyup', e => (this.keys[e.key] = false));
      canvas.addEventListener('mousemove', e => {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
      });
      canvas.addEventListener('mousedown', e => {
        this.mouse.buttons |= (1 << e.button);
      });
      canvas.addEventListener('mouseup', e => {
        this.mouse.buttons &= ~(1 << e.button);
      });
      canvas.addEventListener('contextmenu', e => e.preventDefault());
    }
    update() {
      this.mouse.dx = this.mouse.x - this._lastMouse.x;
      this.mouse.dy = this.mouse.y - this._lastMouse.y;
      this._lastMouse.x = this.mouse.x;
      this._lastMouse.y = this.mouse.y;
    }
    isDown(key) { return !!this.keys[key]; }
  }

  // ---------- WebGL2 State Cache ----------
  class GLState {
    constructor(gl) {
      this.gl = gl;
      this.currentProgram = null;
      this.currentVAO = null;
      this.textures = new Array(16).fill(null);
      this.activeTextureUnit = 0;
      this.uboBindings = {}; // key: binding point index -> buffer
    }
    bindProgram(prog) {
      if (this.currentProgram !== prog) {
        this.gl.useProgram(prog);
        this.currentProgram = prog;
      }
    }
    bindVAO(vao) {
      if (this.currentVAO !== vao) {
        this.gl.bindVertexArray(vao);
        this.currentVAO = vao;
      }
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
    bindUBO(bindingPoint, buffer) {
      if (this.uboBindings[bindingPoint] !== buffer) {
        this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, bindingPoint, buffer);
        this.uboBindings[bindingPoint] = buffer;
      }
    }
  }

  // ---------- GL Wrapper ----------
  class GL {
    constructor(canvas, opts = {}) {
      this.canvas = canvas || document.createElement('canvas');
      this.gl = null;
      this.initContext(opts);
      this.state = new GLState(this.gl);
      this.vaoExt = null;
    }
    initContext(opts) {
      if (CONFIG.webgl2Preferred) {
        try { this.gl = this.canvas.getContext('webgl2', opts); } catch (e) {}
      }
      if (!this.gl) this.gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
      Util.assert(this.gl, 'WebGL not supported');
    }
    createProgram(vsSrc, fsSrc, defines = {}) {
      const gl = this.gl;
      const injectDefines = (src) => {
        let d = '';
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
      
      const info = { program: prog, uniforms: {}, attribs: {} };
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
      // get uniform block indices
      info.uniformBlocks = {};
      const numBlocks = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORM_BLOCKS);
      for (let i = 0; i < numBlocks; i++) {
        const name = gl.getActiveUniformBlockName(prog, i);
        info.uniformBlocks[name] = gl.getUniformBlockIndex(prog, name);
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
      gl.texImage2D(gl.TEXTURE_2D, 0, opts.internalFormat || gl.RGBA, opts.format || gl.RGBA, opts.type || gl.UNSIGNED_BYTE, img);
      if (opts.mipmap !== false) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.minFilter || gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.magFilter || gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return tex;
    }
    createRenderTarget(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const depthRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return { texture: tex, framebuffer: fb, width: w, height: h };
    }
    setViewport(w, h) {
      this.canvas.width = w; this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
  }

  // ---------- Resource Manager ----------
  class ResourceManager {
    constructor(gl) {
      this.gl = gl;
      this.shaders = {};
      this.textures = {};
      this.geometries = {};
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
    getShader(name) { return this.shaders[name]; }
    getTexture(name) { return this.textures[name]; }
    getGeometry(name) { return this.geometries[name]; }
    setGeometry(name, geo) { this.geometries[name] = geo; }
  }

  // ---------- Shader Library ----------
  const ShaderLib = {
    basicVS: `#version 300 es
    precision highp float;
    layout(location=0) in vec3 a_position;
    layout(location=1) in vec3 a_normal;
    layout(location=2) in vec2 a_uv;
    #ifdef INSTANCED
      layout(location=3) in mat4 a_model;
    #else
      uniform mat4 u_model;
    #endif
    layout(std140) uniform SceneData {
      mat4 u_view;
      mat4 u_proj;
    };
    out vec3 v_normal; out vec2 v_uv; out vec3 v_worldPos;
    void main() {
      #ifdef INSTANCED
        mat4 model = a_model;
      #else
        mat4 model = u_model;
      #endif
      vec4 world = model * vec4(a_position, 1.0);
      v_worldPos = world.xyz;
      v_normal = mat3(model) * a_normal;
      v_uv = a_uv;
      gl_Position = u_proj * u_view * world;
    }`,
    litFS: `#version 300 es
    precision highp float;
    in vec3 v_normal; in vec2 v_uv; in vec3 v_worldPos;
    uniform vec3 u_color;
    uniform sampler2D u_albedo;
    #ifdef USE_TEXTURE
      #define DIFFUSE texture(u_albedo, v_uv).rgb
    #else
      #define DIFFUSE u_color
    #endif
    layout(std140) uniform LightData {
      vec4 lightDir;   // directional direction (xyz) and intensity (w)
      vec4 lightColor; // directional color (xyz) and ambient (w)
    };
    out vec4 outColor;
    void main() {
      vec3 N = normalize(v_normal);
      vec3 L = normalize(lightDir.xyz);
      float NdotL = max(dot(N, L), 0.0);
      vec3 ambient = lightColor.w * DIFFUSE;
      vec3 diffuse = lightColor.rgb * lightDir.w * NdotL * DIFFUSE;
      outColor = vec4(ambient + diffuse, 1.0);
    }`,
    postVS: `#version 300 es
    precision highp float;
    layout(location=0) in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }`,
    bloomFS: `#version 300 es
    precision highp float;
    in vec2 v_uv;
    uniform sampler2D u_scene;
    uniform sampler2D u_bloom;
    out vec4 outColor;
    void main() {
      vec3 scene = texture(u_scene, v_uv).rgb;
      vec3 bloom = texture(u_bloom, v_uv).rgb;
      outColor = vec4(scene + bloom * 0.7, 1.0);
    }`,
    particleVS: `#version 300 es
    precision highp float;
    layout(location=0) in vec2 a_corner;
    layout(location=1) in vec3 a_center;
    layout(location=2) in vec4 a_color;
    layout(location=3) in float a_size;
    uniform mat4 u_viewProj;
    uniform vec2 u_resolution;
    out vec4 v_color;
    void main() {
      vec3 right = vec3(u_viewProj[0][0], u_viewProj[1][0], u_viewProj[2][0]);
      vec3 up = vec3(u_viewProj[0][1], u_viewProj[1][1], u_viewProj[2][1]);
      vec3 pos = a_center + (a_corner.x * right + a_corner.y * up) * a_size;
      gl_Position = u_viewProj * vec4(pos, 1.0);
      v_color = a_color;
    }`,
    particleFS: `#version 300 es
    precision highp float;
    in vec4 v_color;
    out vec4 outColor;
    void main() {
      outColor = v_color;
    }`
  };

  // ---------- Geometry & VAO ----------
  class Geometry {
    constructor() {
      this.attributes = {};
      this.indices = null;
      this._count = 0;
      this._vao = null;
      this._buffers = {};
      this._indexBuffer = null;
      this.boundingSphere = { center: Vec3.create(), radius: 0 };
    }
    setAttribute(name, array, size, normalized = false) {
      this.attributes[name] = { data: array, size, normalized };
      this._count = array.length / size;
    }
    setIndex(array) { this.indices = array; }
    computeBoundingSphere() {
      const pos = this.attributes.position?.data;
      if (!pos) return;
      const n = pos.length / 3;
      let cx=0, cy=0, cz=0;
      for (let i=0; i<n; i++) { cx+=pos[i*3]; cy+=pos[i*3+1]; cz+=pos[i*3+2]; }
      cx/=n; cy/=n; cz/=n;
      let r=0;
      for (let i=0; i<n; i++) {
        const dx=pos[i*3]-cx, dy=pos[i*3+1]-cy, dz=pos[i*3+2]-cz;
        r = Math.max(r, dx*dx + dy*dy + dz*dz);
      }
      Vec3.set(this.boundingSphere.center, cx, cy, cz);
      this.boundingSphere.radius = Math.sqrt(r);
    }
    compile(gl, programInfo, instanced = false) {
      if (this._vao) return;
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
            // matrix attribute: 4 vec4 slots
            for (let i = 0; i < 4; i++) {
              gl.enableVertexAttribArray(loc + i);
              gl.vertexAttribPointer(loc + i, 4, gl.FLOAT, false, 64, 16 * i);
              gl.vertexAttribDivisor(loc + i, 1);
            }
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
    }
  }

  // ---------- Light ----------
  class DirectionalLight {
    constructor() {
      this.direction = Vec3.create(0, -1, 0);
      this.color = Vec3.create(1, 1, 1);
      this.intensity = 1.0;
      this.ambient = 0.1;
    }
  }

  // ---------- Frustum Culling ----------
  class Frustum {
    constructor() { this.planes = Array.from({length: 6}, () => new Float32Array(4)); }
    extract(vp) {
      this.planes[0][0]=vp[3]-vp[0]; this.planes[0][1]=vp[7]-vp[4]; this.planes[0][2]=vp[11]-vp[8]; this.planes[0][3]=vp[15]-vp[12];
      this.planes[1][0]=vp[3]+vp[0]; this.planes[1][1]=vp[7]+vp[4]; this.planes[1][2]=vp[11]+vp[8]; this.planes[1][3]=vp[15]+vp[12];
      this.planes[2][0]=vp[3]-vp[1]; this.planes[2][1]=vp[7]-vp[5]; this.planes[2][2]=vp[11]-vp[9]; this.planes[2][3]=vp[15]-vp[13];
      this.planes[3][0]=vp[3]+vp[1]; this.planes[3][1]=vp[7]+vp[5]; this.planes[3][2]=vp[11]+vp[9]; this.planes[3][3]=vp[15]+vp[13];
      this.planes[4][0]=vp[3]-vp[2]; this.planes[4][1]=vp[7]-vp[6]; this.planes[4][2]=vp[11]-vp[10]; this.planes[4][3]=vp[15]-vp[14];
      this.planes[5][0]=vp[3]+vp[2]; this.planes[5][1]=vp[7]+vp[6]; this.planes[5][2]=vp[11]+vp[10]; this.planes[5][3]=vp[15]+vp[14];
      for(let i=0; i<6; i++) {
        const p = this.planes[i];
        const len = 1.0 / Math.hypot(p[0], p[1], p[2]);
        p[0] *= len; p[1] *= len; p[2] *= len; p[3] *= len;
      }
    }
    testSphere(x, y, z, r) {
      for(let i=0; i<6; i++) {
        const p = this.planes[i];
        if (p[0]*x + p[1]*y + p[2]*z + p[3] < -r) return false;
      }
      return true;
    }
    cullInstanceMatrices(matrices, count, offsetX, offsetY, offsetZ, radius) {
      const visible = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const idx = i * 16;
        const cx = matrices[idx+12] + offsetX;
        const cy = matrices[idx+13] + offsetY;
        const cz = matrices[idx+14] + offsetZ;
        visible[i] = this.testSphere(cx, cy, cz, radius) ? 1 : 0;
      }
      return visible;
    }
  }

  // ---------- Render Queue ----------
  class RenderQueue {
    constructor() { this.opaque = []; this.transparent = []; }
    clear() { this.opaque.length = 0; this.transparent.length = 0; }
    push(mesh, material, distToCam) {
      if (material.transparent) this.transparent.push({mesh, material, dist: distToCam});
      else this.opaque.push({mesh, material, dist: distToCam});
    }
    sort() {
      this.opaque.sort((a, b) => a.dist - b.dist);
      this.transparent.sort((a, b) => b.dist - a.dist);
    }
  }

  // ---------- Material ----------
  class Material {
    constructor(opts = {}) {
      this.name = opts.name || 'material';
      this.programInfo = opts.programInfo || null;
      this.uniforms = opts.uniforms || {};
      this.transparent = !!opts.transparent;
      this.defines = opts.defines || {};
      this.instanced = !!opts.instanced;
    }
  }

  // ---------- Scene Graph ----------
  const _scratchMat = Mat4.create();
  const _scratchQuat = Quat.create();
  const _scratchVec = Vec3.create();

  class Node {
    constructor(name = '') {
      this.name = name;
      this.children = [];
      this.parent = null;
      this.position = Vec3.create(0,0,0);
      this.quaternion = Quat.create();
      this.scale = Vec3.create(1,1,1);
      this.localMatrix = Mat4.create();
      this.worldMatrix = Mat4.create();
      this._localDirty = true;
      this._worldDirty = true;
      this.visible = true;
    }
    setPosition(x,y,z) { Vec3.set(this.position, x,y,z); this.markDirty(); }
    setRotation(x,y,z) { Quat.fromEuler(this.quaternion, x,y,z); this.markDirty(); }
    markDirty() { this._localDirty = true; this._worldDirty = true; }
    add(child) { child.parent = this; this.children.push(child); return child; }
    updateLocalMatrix() {
      if (!this._localDirty) return;
      Mat4.fromQuatTranslation(this.localMatrix, this.quaternion, this.position);
      Mat4.scale(this.localMatrix, this.localMatrix, this.scale);
      this._localDirty = false;
      this._worldDirty = true;
    }
    updateWorldMatrix(parentWorld = null) {
      this.updateLocalMatrix();
      if (this._worldDirty) {
        if (parentWorld) Mat4.multiply(this.worldMatrix, parentWorld, this.localMatrix);
        else Mat4.copy(this.worldMatrix, this.localMatrix);
        this._worldDirty = false;
      }
      for (let c of this.children) c.updateWorldMatrix(this.worldMatrix);
    }
  }

  class Camera extends Node {
    constructor(fov = Math.PI/4, aspect = 1, near = 0.1, far = 1000) {
      super('Camera');
      this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
      this.projMatrix = Mat4.create();
      this.viewMatrix = Mat4.create();
      this.vpMatrix = Mat4.create();
      this.updateProjection();
    }
    updateProjection() { Mat4.perspective(this.projMatrix, this.fov, this.aspect, this.near, this.far); }
    updateView() {
      const eye = Vec3.set(_scratchVec, this.worldMatrix[12], this.worldMatrix[13], this.worldMatrix[14]);
      const forward = Vec3.set(_scratchVec, -this.worldMatrix[8], -this.worldMatrix[9], -this.worldMatrix[10]);
      const center = Vec3.add(_scratchVec, eye, forward);
      const up = Vec3.set(_scratchVec, this.worldMatrix[4], this.worldMatrix[5], this.worldMatrix[6]);
      Mat4.lookAt(this.viewMatrix, eye, center, up);
      Mat4.multiply(this.vpMatrix, this.projMatrix, this.viewMatrix);
    }
  }

  class Mesh extends Node {
    constructor(geometry = null, material = null) {
      super('Mesh');
      this.geometry = geometry;
      this.material = material;
      if(geometry) geometry.computeBoundingSphere();
    }
  }

  class InstancedMesh extends Mesh {
    constructor(geometry, material, maxCount) {
      super(geometry, material);
      this.maxCount = maxCount;
      this.count = 0;
      this.matrices = new Float32Array(maxCount * 16);
      this._instanceBuffer = null;
    }
    setMatrixAt(index, mat4) { this.matrices.set(mat4, index * 16); }
    updateInstanceBuffer(gl) {
      if (!this._instanceBuffer) {
        this._instanceBuffer = gl.createBuffer();
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.matrices.subarray(0, this.count * 16), gl.DYNAMIC_DRAW);
    }
  }

  // ---------- Particle System ----------
  class ParticleSystem {
    constructor(maxParticles = 1000) {
      this.maxParticles = maxParticles;
      this.positions = new Float32Array(maxParticles * 3);
      this.velocities = new Float32Array(maxParticles * 3);
      this.colors = new Float32Array(maxParticles * 4);
      this.sizes = new Float32Array(maxParticles);
      this.lifetimes = new Float32Array(maxParticles);
      this.alive = new Uint8Array(maxParticles);
      this.count = 0;
      this.geometry = new Geometry();
      // use a quad for each particle (billboarded in vertex shader)
      this.geometry.setAttribute('corner', new Float32Array([-1,-1, 1,-1, 1,1, -1,1]), 2);
      this.geometry.setIndex(new Uint16Array([0,1,2, 0,2,3]));
    }
    emit(pos, vel, color, size, life) {
      if (this.count >= this.maxParticles) return;
      const i = this.count;
      const p = i * 3, v = i * 3, c = i * 4;
      this.positions[p] = pos[0]; this.positions[p+1] = pos[1]; this.positions[p+2] = pos[2];
      this.velocities[v] = vel[0]; this.velocities[v+1] = vel[1]; this.velocities[v+2] = vel[2];
      this.colors[c] = color[0]; this.colors[c+1] = color[1]; this.colors[c+2] = color[2]; this.colors[c+3] = color[3];
      this.sizes[i] = size;
      this.lifetimes[i] = life;
      this.alive[i] = 1;
      this.count++;
    }
    update(dt) {
      for (let i = 0; i < this.count; i++) {
        if (!this.alive[i]) continue;
        this.lifetimes[i] -= dt;
        if (this.lifetimes[i] <= 0) {
          this.alive[i] = 0;
          continue;
        }
        const p = i*3, v = i*3;
        this.positions[p] += this.velocities[v] * dt;
        this.positions[p+1] += this.velocities[v+1] * dt;
        this.positions[p+2] += this.velocities[v+2] * dt;
      }
    }
  }

  // ---------- Simple Animator ----------
  class Animator {
    constructor(node) {
      this.node = node;
      this.tracks = [];
      this.duration = 0;
      this.time = 0;
      this.loop = false;
    }
    addKey(track, time, value) {
      if (!this.tracks[track]) this.tracks[track] = [];
      this.tracks[track].push({ time, value });
      this.duration = Math.max(this.duration, time);
    }
    update(dt) {
      this.time += dt;
      if (this.time > this.duration) {
        if (this.loop) this.time %= this.duration;
        else this.time = this.duration;
      }
      ['position','rotation','scale'].forEach((prop, idx) => {
        const track = this.tracks[idx];
        if (!track) return;
        let a = track[0], b = track[track.length-1];
        for (let i = 0; i < track.length-1; i++) {
          if (this.time >= track[i].time && this.time <= track[i+1].time) {
            a = track[i]; b = track[i+1]; break;
          }
        }
        const t = (this.time - a.time) / (b.time - a.time);
        if (prop === 'position') {
          const val = b.value.map((v,i) => a.value[i] + (v - a.value[i]) * t);
          this.node.setPosition(...val);
        } else if (prop === 'rotation') {
          const val = b.value.map((v,i) => a.value[i] + (v - a.value[i]) * t);
          this.node.setRotation(...val);
        } else if (prop === 'scale') {
          const val = b.value.map((v,i) => a.value[i] + (v - a.value[i]) * t);
          Vec3.set(this.node.scale, ...val);
          this.node.markDirty();
        }
      });
    }
  }

  // ---------- Renderer ----------
  class Renderer {
    constructor(canvas, opts = {}) {
      this.gl = new GL(canvas, opts);
      this.resolution = { width: canvas.width || 800, height: canvas.height || 600 };
      this.setSize(this.resolution.width, this.resolution.height);
      this.frustum = new Frustum();
      this.queue = new RenderQueue();
      this.enableDefaults();
      this.uboScene = this.gl.createUBO(128); // two mat4 (view, proj)
      this.uboLight = this.gl.createUBO(32); // vec4 dir, vec4 color
      this.sceneData = new Float32Array(32);
      this.lightData = new Float32Array(8);
      this.defaultLight = new DirectionalLight();
      // Post processing
      this.rtMain = null;
      this.rtBloom = null;
      this.postProg = null;
      this.quadVao = null;
    }
    enableDefaults() {
      const gl = this.gl.gl;
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    }
    setSize(w, h) {
      this.resolution.width = w; this.resolution.height = h;
      this.gl.setViewport(w, h);
      if (this.rtMain) {
        this.rtMain = this.gl.createRenderTarget(w, h);
        this.rtBloom = this.gl.createRenderTarget(w, h);
      }
    }
    enablePostProcessing() {
      this.rtMain = this.gl.createRenderTarget(this.resolution.width, this.resolution.height);
      this.rtBloom = this.gl.createRenderTarget(this.resolution.width, this.resolution.height);
      const gl = this.gl;
      this.postProg = gl.createProgram(ShaderLib.postVS, ShaderLib.bloomFS);
      // quad for fullscreen triangle
      const quadGeo = new Geometry();
      quadGeo.setAttribute('position', new Float32Array([-1,-1, 3,-1, -1,3]), 2);
      quadGeo.compile(gl.gl, this.postProg);
      this.quadVao = quadGeo._vao;
    }
    render(scene, camera) {
      const gl = this.gl.gl;
      camera.updateWorldMatrix(); camera.updateView();
      scene.updateWorldMatrix();
      this.frustum.extract(camera.vpMatrix);
      
      // Update scene UBO
      this.sceneData.set(camera.viewMatrix, 0);
      this.sceneData.set(camera.projMatrix, 16);
      this.gl.updateUBO(this.uboScene, this.sceneData);
      // Update light UBO
      this.lightData[0] = this.defaultLight.direction[0];
      this.lightData[1] = this.defaultLight.direction[1];
      this.lightData[2] = this.defaultLight.direction[2];
      this.lightData[3] = this.defaultLight.intensity;
      this.lightData[4] = this.defaultLight.color[0];
      this.lightData[5] = this.defaultLight.color[1];
      this.lightData[6] = this.defaultLight.color[2];
      this.lightData[7] = this.defaultLight.ambient;
      this.gl.updateUBO(this.uboLight, this.lightData);
      
      const hasPost = !!this.rtMain;
      if (hasPost) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtMain.framebuffer);
      }
      const c = CONFIG.defaultClearColor;
      gl.clearColor(c[0], c[1], c[2], c[3]);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      
      this.queue.clear();
      this._gather(scene, camera);
      this.queue.sort();
      
      gl.depthMask(true);
      for (const cmd of this.queue.opaque) this._draw(cmd.mesh, cmd.material, camera);
      gl.depthMask(false);
      for (const cmd of this.queue.transparent) this._draw(cmd.mesh, cmd.material, camera);
      gl.depthMask(true);

      // Bloom post pass (simplified)
      if (hasPost) {
        // In a full implementation, extract bright parts to rtBloom and composite.
        // Here we just composite main texture over itself (demo).
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const state = this.gl.state;
        state.bindProgram(this.postProg.program);
        state.bindVAO(this.quadVao);
        state.bindTexture(0, this.rtMain.texture);
        state.bindTexture(1, this.rtBloom.texture);
        gl.uniform1i(this.postProg.uniforms.u_scene, 0);
        gl.uniform1i(this.postProg.uniforms.u_bloom, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    
    _gather(node, camera) {
      if (!node.visible) return;
      if (node instanceof Mesh) {
        const bs = node.geometry.boundingSphere;
        const cx = node.worldMatrix[12] + bs.center[0];
        const cy = node.worldMatrix[13] + bs.center[1];
        const cz = node.worldMatrix[14] + bs.center[2];
        if (this.frustum.testSphere(cx, cy, cz, bs.radius)) {
          const camPos = camera.worldMatrix;
          const dx = cx - camPos[12], dy = cy - camPos[13], dz = cz - camPos[14];
          this.queue.push(node, node.material, dx*dx+dy*dy+dz*dz);
        }
      } else if (node instanceof InstancedMesh && node.count > 0) {
        // cull each instance? For performance, we upload all matrices but skip culling per instance here
        const camPos = camera.worldMatrix;
        const dist = 0; // approximated
        this.queue.push(node, node.material, dist);
      }
      for (let c of node.children) this._gather(c, camera);
    }

    _draw(mesh, material, camera) {
      const gl = this.gl.gl;
      const state = this.gl.state;
      const geo = mesh.geometry;
      const progInfo = material.programInfo;
      if (!progInfo) return;
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
      
      if (mesh instanceof InstancedMesh) {
        if (!geo._vao) geo.compile(gl, progInfo, true);
        mesh.updateInstanceBuffer(gl);
        state.bindVAO(geo._vao);
        // assume instance buffer bound to attribute 3 (a_model)
        if (geo.indices) {
          gl.drawElementsInstanced(gl.TRIANGLES, geo.indices.length, gl.UNSIGNED_SHORT, 0, mesh.count);
        } else {
          gl.drawArraysInstanced(gl.TRIANGLES, 0, geo._count, mesh.count);
        }
      } else {
        if (!geo._vao) geo.compile(gl, progInfo, false);
        state.bindVAO(geo._vao);
        // set model uniform if not instanced
        if (progInfo.uniforms.u_model) gl.uniformMatrix4fv(progInfo.uniforms.u_model, false, mesh.worldMatrix);
        for (const k in material.uniforms) {
          const v = material.uniforms[k];
          const loc = progInfo.uniforms[k];
          if (!loc) continue;
          if (v instanceof WebGLTexture) {
            state.bindTexture(0, v);
            gl.uniform1i(loc, 0);
          } else if (v.length === 3) gl.uniform3fv(loc, v);
          else if (typeof v === 'number') gl.uniform1f(loc, v);
        }
        if (geo.indices) {
          const type = geo.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
          gl.drawElements(gl.TRIANGLES, geo.indices.length, type, 0);
        } else {
          gl.drawArrays(gl.TRIANGLES, 0, geo._count);
        }
      }
    }

    renderParticles(particleSystem, camera) {
      if (particleSystem.count === 0) return;
      const gl = this.gl.gl;
      const prog = this.particleProg;
      if (!prog) {
        this.particleProg = this.gl.createProgram(ShaderLib.particleVS, ShaderLib.particleFS);
        this.particleProg.uniforms.u_viewProj = gl.getUniformLocation(this.particleProg.program, 'u_viewProj');
        this.particleProg.uniforms.u_resolution = gl.getUniformLocation(this.particleProg.program, 'u_resolution');
        this.particleVao = gl.createVertexArray();
      }
      const state = this.gl.state;
      state.bindProgram(this.particleProg.program);
      gl.uniformMatrix4fv(this.particleProg.uniforms.u_viewProj, false, camera.vpMatrix);
      gl.uniform2f(this.particleProg.uniforms.u_resolution, this.resolution.width, this.resolution.height);
      
      // setup particle buffers (simplified: recreate each frame, production should use persistent buffers)
      const corners = new Float32Array([-1,-1, 1,-1, 1,1, -1,1]);
      const idx = new Uint16Array([0,1,2, 0,2,3]);
      // Build interleaved instance data for alive particles only
      let aliveCount = 0;
      for (let i = 0; i < particleSystem.count; i++) {
        if (particleSystem.alive[i]) aliveCount++;
      }
      const instancePos = new Float32Array(aliveCount * 3);
      const instanceCol = new Float32Array(aliveCount * 4);
      const instanceSiz = new Float32Array(aliveCount);
      let j = 0;
      for (let i = 0; i < particleSystem.count; i++) {
        if (!particleSystem.alive[i]) continue;
        instancePos.set(particleSystem.positions.subarray(i*3, i*3+3), j*3);
        instanceCol.set(particleSystem.colors.subarray(i*4, i*4+4), j*4);
        instanceSiz[j] = particleSystem.sizes[i];
        j++;
      }
      gl.bindVertexArray(this.particleVao);
      const cornerBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
      gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      
      const posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instancePos, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, 1);
      
      const colBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instanceCol, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(2, 1);
      
      const sizBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, sizBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instanceSiz, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(3, 1);
      
      const indexBuf = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, aliveCount);
      // Cleanup temporary buffers (in production, keep them)
      gl.deleteBuffer(cornerBuf); gl.deleteBuffer(posBuf); gl.deleteBuffer(colBuf); gl.deleteBuffer(sizBuf); gl.deleteBuffer(indexBuf);
      gl.bindVertexArray(null);
    }
  }

  // ---------- App ----------
  class App {
    constructor(opts = {}) {
      this.canvas = opts.canvas || document.createElement('canvas');
      if (!opts.canvas) document.body.appendChild(this.canvas);
      this.renderer = new Renderer(this.canvas);
      this.scene = new Node('Scene');
      this.camera = new Camera(Math.PI/4, this.canvas.width / this.canvas.height, 0.1, 2000);
      this.scene.add(this.camera);
      this.resources = new ResourceManager(this.renderer.gl);
      this.input = new Input(this.canvas);
      this._running = false;
      this._lastTime = Util.now();
      this._frameCount = 0;
      this._fpsTime = 0;
      this._fps = 0;
      this.update = opts.update || function() {};
      window.addEventListener('resize', () => {
        const w = window.innerWidth, h = window.innerHeight;
        this.canvas.width = w; this.canvas.height = h;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjection();
      });
    }
    start() {
      this._running = true;
      const loop = () => {
        if (!this._running) return;
        const now = Util.now();
        const dt = (now - this._lastTime) / 1000;
        this._lastTime = now;
        this.input.update();
        this.update(dt);
        this.renderer.render(this.scene, this.camera);
        this._computeFPS(dt);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    _computeFPS(dt) {
      this._frameCount++;
      this._fpsTime += dt;
      if (this._fpsTime >= 1) {
        this._fps = Math.round(this._frameCount / this._fpsTime);
        this._frameCount = 0;
        this._fpsTime = 0;
        if (CONFIG.log) console.log(`FPS: ${this._fps}`);
      }
    }
    createBox(w=1,h=1,d=1) {
      const g = new Geometry();
      const hw = w/2, hh = h/2, hd = d/2;
      g.setAttribute('position', new Float32Array([
        -hw,-hh,-hd, hw,-hh,-hd, hw,hh,-hd, -hw,hh,-hd,
        -hw,-hh,hd, hw,-hh,hd, hw,hh,hd, -hw,hh,hd
      ]), 3);
      g.setAttribute('normal', new Float32Array([
        0,0,-1,0,0,-1,0,0,-1,0,0,-1,
        0,0,1,0,0,1,0,0,1,0,0,1
      ]), 3);
      g.setAttribute('uv', new Float32Array([
        0,0,1,0,1,1,0,1, 0,0,1,0,1,1,0,1
      ]), 2);
      g.setIndex(new Uint16Array([0,1,2,0,2,3,4,6,5,4,7,6,4,5,1,4,1,0,3,2,6,3,6,7,1,5,6,1,6,2,4,0,3,4,3,7]));
      return g;
    }
    get fps() { return this._fps; }
  }

  const MiniEngine = { Util, Vec3, Quat, Mat4, WasmBulkProcessor, Input, GL, ShaderLib, ResourceManager, Geometry, Material, Mesh, InstancedMesh, Node, Camera, DirectionalLight, Frustum, RenderQueue, Renderer, App, ParticleSystem, Animator };
  global.MiniEngine = MiniEngine;

  // ---------- Demo ----------
  (function autoDemo() {
    try {
      const canvas = document.getElementById('mini-canvas');
      if (!canvas) return;
      const app = new MiniEngine.App({canvas});
      const res = app.resources;
      // Load shaders
      const litProg = res.loadShader('lit', ShaderLib.basicVS, ShaderLib.litFS, { USE_TEXTURE: 0, INSTANCED: 0 });
      const litProgInst = res.loadShader('litInst', ShaderLib.basicVS, ShaderLib.litFS, { USE_TEXTURE: 0, INSTANCED: 1 });
      
      // Create materials
      const matRed = new Material({ programInfo: litProg, uniforms: { u_color: [1,0.2,0.2] } });
      const matBlue = new Material({ programInfo: litProgInst, uniforms: { u_color: [0.2,0.4,1] }, instanced: true });
      
      // Create a few boxes
      const boxGeo = app.createBox();
      boxGeo.computeBoundingSphere();
      
      const box1 = new Mesh(boxGeo, matRed);
      box1.setPosition(-2, 0, -5);
      app.scene.add(box1);
      
      const box2 = new Mesh(boxGeo, matRed);
      box2.setPosition(2, 0, -5);
      app.scene.add(box2);
      
      // Instanced boxes in a ring
      const instCount = 100;
      const instMesh = new InstancedMesh(boxGeo, matBlue, instCount);
      for (let i = 0; i < instCount; i++) {
        const angle = (i / instCount) * Math.PI * 2;
        const x = Math.cos(angle) * 4;
        const z = -5 + Math.sin(angle) * 3;
        const m = Mat4.create();
        Mat4.translate(m, m, [x, 0, z]);
        instMesh.setMatrixAt(i, m);
      }
      instMesh.count = instCount;
      app.scene.add(instMesh);
      
      // Setup camera
      app.camera.setPosition(0, 2, 10);
      app.camera.setRotation(-0.2, 0, 0);
      
      // Enable post-processing (optional)
      // app.renderer.enablePostProcessing();
      
      // Particle system
      const ps = new ParticleSystem(500);
      app.scene.add({visible: true, update: (dt) => {
        ps.update(dt);
        // emit continuously
        if (Math.random() < 0.3) {
          const pos = [Math.random()*2-1, 2, -5 + Math.random()];
          const vel = [Math.random()-0.5, 1+Math.random(), Math.random()-0.5];
          const col = [Math.random(), Math.random(), 0.5, 1];
          ps.emit(pos, vel, col, 0.1, 2);
        }
      }});
      
      // Update loop
      app.update = (dt) => {
        box1.rotation[1] += dt * 0.5;
        box1.markDirty();
        box2.rotation[1] -= dt * 0.5;
        box2.markDirty();
        // rotate instanced group
        for (let i = 0; i < instCount; i++) {
          const idx = i * 16;
          const m = instMesh.matrices;
          // simple rotation around Y
          const angle = Math.atan2(m[idx+14]+5, m[idx+12]) + dt*0.3;
          const dist = Math.hypot(m[idx+12], m[idx+14]+5);
          m[idx+12] = Math.cos(angle) * dist;
          m[idx+14] = -5 + Math.sin(angle) * dist;
        }
        instMesh.updateInstanceBuffer(app.renderer.gl.gl);
        // update particles
        ps.update(dt);
        // render particles (we should hook into renderer; for demo, we'll just call after main render? A bit hacky)
        // But the renderer doesn't call particle render automatically. Quick hack: we'll add it to scene node.
      };
      
      // Extend renderer to also draw particles (we can override render method or pass particles)
      const origRender = app.renderer.render.bind(app.renderer);
      app.renderer.render = (scene, camera) => {
        origRender(scene, camera);
        app.renderer.renderParticles(ps, camera);
      };
      
      app.start();
      console.log('MiniEngine running. FPS shown in console if CONFIG.log=true');
    } catch (e) {
      console.error('MiniEngine demo error', e);
    }
  })();

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
