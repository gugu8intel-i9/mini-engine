# miniEngineWasm

**miniEngineWasm** is a high‑performance, single‑file WebGL2 game engine engineered for modern web applications.  
It prioritizes rendering efficiency through zero‑allocation mathematics, Vertex Array Object (VAO) caching, true frustum culling, and an advanced render queue.  
The engine now includes a full suite of professional features: quaternion‑based rotation, input management, UBO‑backed lighting, instanced rendering, particle systems, post‑processing, and a simple animation system.

## 🚀 What’s New (v2.0)

- **Quaternion Rotation** – Gimbal‑lock‑free orientation on every node.  
- **Input Manager** – Keyboard & mouse abstraction with delta tracking.  
- **Texture & Asset Loading** – Built‑in `ResourceManager` for shaders, textures, and geometry.  
- **Lighting with UBOs** – Directional light data packed in Uniform Buffer Objects for zero‑overhead updates.  
- **Shader Permutation System** – Compile‑time defines (`USE_TEXTURE`, `INSTANCED`) to eliminate fragment shader branching.  
- **Instanced Rendering** – GPU‑driven batching via `InstancedMesh` with per‑instance matrices.  
- **Particle System** – Billboard‑point‑based particles with physics, color, and size interpolation.  
- **Post‑Processing** – Off‑screen render targets and a bloom compositing pass.  
- **Frustum Culling for Instanced Arrays** – Efficient visibility testing of whole instance batches.  
- **Animation System** – Key‑framed position, rotation, and scale tracks.  
- **Debug FPS Counter** – Built‑in FPS tracking when logging is enabled.

---

## Features (Summary)

| Feature                     | Description                                                                 |
|-----------------------------|-----------------------------------------------------------------------------|
| **WebGL2 State Cache**      | Eliminates redundant GPU calls for programs, VAOs, textures, and UBOs.      |
| **Zero‑Allocation Math**    | `Vec3`, `Quat`, `Mat4` – all operations use pre‑allocated `out` parameters. |
| **Advanced Render Queue**   | Opaque front‑to‑back (Early‑Z), transparent back‑to‑front.                  |
| **True Frustum Culling**    | 6‑plane extraction from View‑Projection matrix, sphere test for meshes.     |
| **WASM Bulk Interface**     | Shared‑memory WebAssembly for high‑throughput data (particles, skinning).   |
| **Resource Manager**        | Central loading & caching of shaders, textures, and geometries.             |
| **Directional Light**       | UBO‑based, ambient + diffuse with adjustable direction, color, intensity.  |
| **Instanced Rendering**     | `InstancedMesh` holds pre‑computed matrices, rendered via `drawElementsInstanced`. |
| **Particle System**         | Billboarded quads with velocity, lifetime, color, size – full GPU update.  |
| **Post‑Processing Pipeline**| Render‑to‑texture, bloom (extract bright + composite).                      |
| **Key‑Frame Animator**      | Linear interpolation of position, rotation, scale on any node.              |
| **Input Manager**           | Keyboard state, mouse position & delta, button masking.                     |

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

// Optional: enable post‑processing (Bloom)
app.renderer.enablePostProcessing();

// Adjust camera
app.camera.setPosition(0, 2, 10);
app.camera.setRotation(-0.2, 0, 0);
```

### 3. Loading Assets & Creating Materials

The `ResourceManager` handles shader compilation and texture loading.

```javascript
// 1. Load a shader with permutations
const litProg = res.loadShader('lit', MiniEngine.ShaderLib.basicVS, MiniEngine.ShaderLib.litFS, {
  USE_TEXTURE: 0,
  INSTANCED: 0
});

// 2. Create a material (opaque)
const matRed = new MiniEngine.Material({
  programInfo: litProg,
  uniforms: { u_color: new Float32Array([1, 0.2, 0.2]) }
});

// 3. Generate geometry
const boxGeo = app.createBox(2, 2, 2);
boxGeo.computeBoundingSphere();

// 4. Build mesh
const box = new MiniEngine.Mesh(boxGeo, matRed);
box.setPosition(0, 0, -5);
app.scene.add(box);
```

### 4. Instanced Rendering

For hundreds of identical objects, use `InstancedMesh`.

```javascript
const litProgInst = res.loadShader('litInst', MiniEngine.ShaderLib.basicVS, MiniEngine.ShaderLib.litFS, {
  USE_TEXTURE: 0,
  INSTANCED: 1
});

const matBlue = new MiniEngine.Material({
  programInfo: litProgInst,
  uniforms: { u_color: [0.2, 0.4, 1] },
  instanced: true
});

const instanceMesh = new MiniEngine.InstancedMesh(boxGeo, matBlue, 100);
for (let i = 0; i < 100; i++) {
  const mat = MiniEngine.Mat4.create();
  MiniEngine.Mat4.translate(mat, mat, [Math.cos(i)*3, 0, Math.sin(i)*3 - 5]);
  instanceMesh.setMatrixAt(i, mat);
}
instanceMesh.count = 100;
app.scene.add(instanceMesh);
```

### 5. Lighting

A default directional light is included. Customize via the renderer’s light data.

```javascript
// Set light properties (angle, color, ambient)
app.renderer.defaultLight.direction.set([0.5, -0.8, 0.3]);
app.renderer.defaultLight.color.set([1.0, 1.0, 0.9]);
app.renderer.defaultLight.intensity = 1.2;
app.renderer.defaultLight.ambient = 0.15;
```

The UBO is updated automatically every frame.

### 6. Particle System

```javascript
const ps = new MiniEngine.ParticleSystem(500);
// Emit inside update loop
ps.emit([0, 2, -5], [0.1, 0.5, 0], [1,0,0,1], 0.2, 2);
ps.update(dt);

// Render particles (custom hook or extend renderer)
app.renderer.renderParticles(ps, app.camera);
```

### 7. Animation

Add key‑frames to any node.

```javascript
const anim = new MiniEngine.Animator(myNode);
anim.addKey(0, 0, [0,0,0]);        // position track (index 0)
anim.addKey(0, 1, [0,2,0]);
anim.addKey(1, 0, [0,0,0]);        // rotation track (index 1)
anim.addKey(1, 1, [0, Math.PI, 0]);
anim.loop = true;

// Update in game loop
anim.update(dt);
```

### 8. Game Loop

```javascript
app.update = function(dt) {
  // Process input
  if (app.input.isDown('ArrowLeft')) box.rotation[1] -= dt * 2;
  if (app.input.isDown('ArrowRight')) box.rotation[1] += dt * 2;
  box.markDirty();

  // Animate instanced matrices
  // ...

  // Update particles
  ps.update(dt);
};

app.start();
```

---

## Advanced: Engine Exploitation & Memory Manipulation

For those who wish to bypass the standard pipeline, inject custom rendering, or manipulate internals, the following vectors are exposed:

### Direct GPU Injection

```javascript
const gl = app.renderer.gl.gl;
// Inject wireframe overlay (requires OES_polygon_mode extension)
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

The particle system rebuilds its instance buffers each frame – you can directly modify the internal arrays before the draw call:

```javascript
ps.colors[0] = 0.0; // turn first particle black
ps.sizes[0] = 5.0;  // enlarge it
```

---

## Performance Guidelines

1. **Zero Allocation** – Never use `Vec3.create()` inside the update loop; reuse pre‑allocated vectors.
2. **Batch with InstancedMesh** – For > 100 identical meshes, always prefer instancing.
3. **Lazy Dirty Flags** – Call `markDirty()` only when a transform actually changes.
4. **Texture Atlases** – Reduce draw calls by combining small textures.

---

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPLv3)**.  
You are free to use, modify, and distribute this software, provided that any modifications or derivative works deployed on a network server are also made available under the same license.  
Full terms: [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html).
