# miniEngineWasm

**miniEngineWasm** is a high-performance, single-file WebGL2 game engine engineered for modern web applications.  
It prioritizes rendering efficiency through zero-allocation mathematics, Vertex Array Object (VAO) caching, true frustum culling, and an advanced render queue.  
The engine now includes a full suite of professional features: PBR shading (Cook-Torrance), cascaded shadow mapping, IBL environment reflections, post-processing bloom, fog, skeletal animation, instanced rendering, particle systems, and more.

## 🚀 What’s New (v3.0 "Titan")

- **PBR Shading** – Cook-Torrance BRDF with GGX distribution, Smith geometry, and Schlick Fresnel.  
- **Shadow Mapping** – Directional light with PCF (Percentage Closer Filtering) for soft shadows.  
- **IBL Environment Mapping** – Skybox and irradiance reflections via cube maps.  
- **Post-Processing Pipeline** – Bloom (bright pass + Gaussian blur + composite) with ACES Filmic tonemapping.  
- **Fog** – Linear, exponential, and exponential-squared fog modes.  
- **Skeletal Animation** – Bone hierarchy, skinning, and key-framed animation clips with quaternion slerp.  
- **Instanced Rendering with Per-Instance Colors** – Efficient GPU batching with individual color tints.  
- **Persistent Particle Buffers** – No per-frame allocations; particle data uploaded directly to GPU.  
- **Ring Buffer Allocator** – Zero-allocation frame data via pre-allocated typed arrays.  
- **Extended Primitives** – Box, Sphere, Plane, Cylinder, Torus, and Skybox geometries.  
- **Occlusion‑Ready Bounding Volumes** – AABB and bounding sphere for advanced culling.  
- **HDR Render Targets** – Float16 framebuffers for true HDR pipeline.  
- **Improved Resource Manager** – Central caching of shaders, textures, geometries, and cube maps.

---

## Features (Summary)

| Feature                     | Description                                                                 |
|-----------------------------|-----------------------------------------------------------------------------|
| **PBR Materials**           | Base color, roughness, metalness, AO, normal mapping, env reflections.      |
| **Shadow Mapping**          | Directional light shadows with PCF soft filtering.                           |
| **Skybox & IBL**            | Cube map environment rendering and image-based lighting.                     |
| **Post‑Processing**         | Bloom with HDR, brightness threshold, and ACES tonemapping.                  |
| **Fog**                     | Linear, exponential, and exp2 modes with configurable color and density.    |
| **Skeletal Animation**      | Skeleton, bones, skinning matrices, animation clips, and quaternion interpolation. |
| **Instanced Rendering**     | Per-instance matrix and color, drawn via `drawElementsInstanced`.            |
| **Particle System**         | Billboarded quads with persistent buffers, velocity, lifetime, color, size. |
| **Zero‑Allocation Math**    | `Vec3`, `Quat`, `Mat4` – all operations use pre-allocated `out` parameters. |
| **Advanced Render Queue**   | Opaque front-to-back (Early‑Z), transparent back-to-front, shadow casters.   |
| **True Frustum Culling**    | 6‑plane extraction from VP matrix, sphere and AABB tests.                    |
| **WASM Bulk Interface**     | Shared‑memory WebAssembly for future high‑throughput data processing.       |
| **Resource Manager**        | Shader permutations, texture loading, cube maps, geometry caching.          |
| **Ring Buffer Allocator**   | Frame‑local memory pool for zero allocations in render loop.                 |
| **WebGL2 State Cache**      | Eliminates redundant GPU calls for programs, VAOs, textures, UBOs, FBOs.    |
| **Directional Light**       | UBO‑based with shadow matrix, intensity, ambient, and color.                |

---

## Integration Guide

### 1. Inclusion

A single `<script>` tag is all you need.

```html
<script src="miniEngineWasm.js"></script>
<script src="your-game.js"></script>
```

### 2. Initialization

```javascript
const canvas = document.getElementById('game-canvas');
const app = new MiniEngine.App({ canvas });

// Access central resource manager
const res = app.resources;

// Setup shadow mapping
app.renderer.setupShadowMap();

// Optional: enable post‑processing (Bloom + HDR)
app.renderer.enablePostProcessing();
app.renderer.bloomStrength = 0.5;
app.renderer.bloomThreshold = 1.0;

// Adjust fog
app.renderer.fogMode = 2; // 1=linear, 2=exp, 3=exp2
app.renderer.fogDensity = 0.02;
app.renderer.fogColor = MiniEngine.Vec3.create(0.4, 0.45, 0.55);

// Configure camera
app.camera.setPosition(0, 3, 0);
app.camera.setRotation(-0.2, 0, 0);
```

### 3. Creating PBR Materials

```javascript
// Load PBR shader (non-instanced)
const pbrProg = res.loadShader('pbr', MiniEngine.ShaderLib.pbrVS, MiniEngine.ShaderLib.pbrFS, {
  INSTANCED: 0,
  SKINNED: 0
});

// Create a metal material
const matMetal = new MiniEngine.PBRMaterial({
  programInfo: pbrProg,
  baseColor: MiniEngine.Vec3.create(0.9, 0.85, 0.8),
  roughness: 0.3,
  metalness: 0.9,
  ao: 1.0
});

// Create a rough dielectric material
const matFloor = new MiniEngine.PBRMaterial({
  programInfo: pbrProg,
  baseColor: MiniEngine.Vec3.create(0.3, 0.35, 0.4),
  roughness: 0.8,
  metalness: 0.0
});
```

### 4. Geometry & Meshes

```javascript
// Generate a sphere
const sphereGeo = app.createSphere(0.5, 32, 24);

// Build a mesh
const sphere = new MiniEngine.Mesh(sphereGeo, matMetal);
sphere.setPosition(0, 1, -5);
app.scene.add(sphere);
```

### 5. Instanced Rendering with Per-Instance Colors

For hundreds of identical objects, use `InstancedMesh` with per-instance color tinting.

```javascript
// Load instanced PBR shader
const pbrInstProg = res.loadShader('pbrInst', MiniEngine.ShaderLib.pbrVS, MiniEngine.ShaderLib.pbrFS, {
  INSTANCED: 1,
  SKINNED: 0
});

const matInst = new MiniEngine.PBRMaterial({
  programInfo: pbrInstProg,
  baseColor: MiniEngine.Vec3.create(0.8, 0.8, 0.8),
  roughness: 0.4,
  metalness: 0.6,
  instanced: true
});

const boxGeo = app.createBox(1, 1, 1);
const instMesh = new MiniEngine.InstancedMesh(boxGeo, matInst, 100);

for (let i = 0; i < 100; i++) {
  const angle = (i / 100) * Math.PI * 2;
  const mat = MiniEngine.Mat4.create();
  MiniEngine.Mat4.translate(mat, mat, [Math.cos(angle) * 5, 0.5, Math.sin(angle) * 5 - 10]);
  MiniEngine.Mat4.rotateY(mat, mat, angle);
  MiniEngine.Mat4.scale(mat, mat, [0.5, 0.5, 0.5]);
  instMesh.setMatrixAt(i, mat);
  instMesh.setColorAt(i, 0.8 + Math.random() * 0.2, 0.7 + Math.random() * 0.2, 0.6 + Math.random() * 0.2, 1);
}
instMesh.count = 100;
app.scene.add(instMesh);
```

### 6. Directional Light & Shadows

```javascript
const light = app.renderer.directionalLight;
light.direction.set([-1, -3, -2]);
light.direction = MiniEngine.Vec3.normalize(MiniEngine.Vec3.create(), light.direction);
light.intensity = 2.0;
light.ambient = 0.08;
light.castShadow = true; // Default true after setupShadowMap()
```

### 7. Skybox / Environment Mapping

Load a cube map (6 images) and assign it to the renderer.

```javascript
const faceImages = [
  await MiniEngine.Util.loadImage('skybox/right.jpg'),
  await MiniEngine.Util.loadImage('skybox/left.jpg'),
  await MiniEngine.Util.loadImage('skybox/top.jpg'),
  await MiniEngine.Util.loadImage('skybox/bottom.jpg'),
  await MiniEngine.Util.loadImage('skybox/front.jpg'),
  await MiniEngine.Util.loadImage('skybox/back.jpg')
];
const cubeTex = res.loadCubemap('skybox', faceImages);
app.renderer.setupSkybox(cubeTex);

// Assign environment map to a material
matMetal.envMap = cubeTex;
matMetal.envIntensity = 0.7;
```

### 8. Skeletal Animation

```javascript
// Create skeleton
const skeleton = new MiniEngine.Skeleton();

// Root bone
const rootBone = new MiniEngine.Bone('root');
rootBone.setPosition(0, 0, 0);
skeleton.addBone(rootBone, MiniEngine.Mat4.create()); // inverse bind matrix

// Child bone
const armBone = new MiniEngine.Bone('arm');
armBone.setPosition(0, 1, 0);
rootBone.add(armBone);
skeleton.addBone(armBone, MiniEngine.Mat4.create());

// Create skinned mesh
const skinnedGeo = createCharacterGeometry(); // Your geometry with bone indices & weights
const skinnedMesh = new MiniEngine.SkinnedMesh(skinnedGeo, matPBR, skeleton);
app.scene.add(skinnedMesh);

// Animation clip
const clip = new MiniEngine.AnimationClip('walk', 2.0);
clip.addRotationKey('arm', 0.0, MiniEngine.Quat.create(0, 0, 0, 1));
clip.addRotationKey('arm', 0.5, MiniEngine.Quat.create(0, 0, 0.707, 0.707));
clip.addRotationKey('arm', 1.0, MiniEngine.Quat.create(0, 0, 0, 1));
clip.loop = true;

const animator = new MiniEngine.Animator(skeleton);
animator.play(clip);

// In update loop
animator.update(dt);
```

### 9. Particle System

```javascript
const ps = new MiniEngine.ParticleSystem(2000);
app.particleSystems.push(ps); // Renderer automatically draws these

// Emit particles
ps.emit(
  [0, 2, -5],           // position
  [0.1, 0.5, 0],        // velocity
  [1, 0, 0, 1],         // color (RGBA)
  0.2,                  // size
  2.0                   // lifetime (seconds)
);

// In update loop
ps.update(dt);
```

### 10. Game Loop

```javascript
app.update = function(dt) {
  // Process input
  if (app.input.isDown('ArrowLeft')) box.rotation[1] -= dt * 2;
  if (app.input.isDown('ArrowRight')) box.rotation[1] += dt * 2;
  box.markDirty();

  // Update animator
  animator.update(dt);

  // Update particles
  ps.update(dt);

  // Update instanced matrices
  // ...
};

app.start();
```

---

## Advanced: Engine Exploitation & Memory Manipulation

For those who wish to bypass the standard pipeline, inject custom rendering, or manipulate internals, the following vectors are exposed:

### Direct GPU Injection

```javascript
const gl = app.renderer.gl.gl;
// Inject wireframe overlay
gl.disable(gl.CULL_FACE);
gl.depthRange(0.0, 0.5); // Force overlay depth

// Manipulate UBO data directly
const sceneData = app.renderer.sceneData;
sceneData[0] = 1.0; // Corrupt view matrix – wild effects
```

### WASM Memory Overwrite

If `WasmBulkProcessor` is active:

```javascript
const view = new Float32Array(MiniEngine.WasmBulkProcessor.memory.buffer);
// Overwrite particle positions or transform matrices without dirty flags
view[100] = 9999;
```

### Render Queue Hijack

```javascript
const origRender = app.renderer.render.bind(app.renderer);
app.renderer.render = function(scene, camera) {
  origRender(scene, camera);
  const gl = this.gl.gl;
  gl.disable(gl.DEPTH_TEST);
  // Draw your own HUD / cheat overlay
  gl.enable(gl.DEPTH_TEST);
};
```

### Particle Buffer Injection

The particle system maintains persistent buffers – you can directly modify the internal arrays before the draw call:

```javascript
ps.colors[0] = 0.0; // turn first particle black
ps.sizes[0] = 5.0;  // enlarge it
```

### Shadow Map Manipulation

Access the shadow map texture and framebuffer:

```javascript
const shadowMap = app.renderer.lightShadowMap;
// Render custom depth into it
gl.bindFramebuffer(gl.FRAMEBUFFER, shadowMap.framebuffer);
// ... draw objects with a depth shader
```

---

## Performance Guidelines

1. **Zero Allocation** – Never use `Vec3.create()` inside the update loop; reuse pre-allocated vectors from the ring buffer or module scope.
2. **Batch with InstancedMesh** – For > 100 identical meshes, always prefer instancing with per-instance colors.
3. **Lazy Dirty Flags** – Call `markDirty()` only when a transform actually changes.
4. **Texture Atlases** – Reduce draw calls by combining small textures.
5. **Use PBR Materials** – They are optimized for modern GPUs; avoid legacy Phong materials.
6. **Enable Shadows Only When Needed** – Shadow mapping is expensive; disable `castShadow` on unimportant objects.
7. **Optimize Particle Count** – Keep particle counts within GPU buffer limits; use `app.particleSystems` for automatic rendering.

---

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPLv3)**.  
You are free to use, modify, and distribute this software, provided that any modifications or derivative works deployed on a network server are also made available under the same license.  
Full terms: [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html).
