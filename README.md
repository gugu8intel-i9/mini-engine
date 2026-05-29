# miniEngineWasm

**miniEngineWasm** is a high-performance, single-file WebGL2 game engine engineered for modern web applications. It prioritizes rendering efficiency through zero-allocation mathematics, Vertex Array Object (VAO) caching, true frustum culling, and an advanced render queue. It also features a WebAssembly (WASM) architecture optimized for bulk data processing.

## Features

*   **WebGL2 State Management:** Eliminates redundant GPU state changes via program, VAO, and texture binding caches.
*   **Zero-Allocation Math:** Strictly enforces the 'out' parameter pattern in vector and matrix operations to prevent Garbage Collection (GC) stutter.
*   **Advanced Render Queue:** Automatically sorts opaque objects front-to-back (leveraging Early-Z hardware culling) and transparent objects back-to-front.
*   **True Frustum Culling:** Extracts six frustum planes from the View-Projection matrix to accurately cull off-screen geometry.
*   **WASM Bulk Processing:** Provides a shared-memory WebAssembly interface designed for high-throughput tasks like particle systems and skeletal animation, bypassing the FFI overhead of per-vector calculations.

---

## Integration Guide

### 1. Inclusion

As a single-file engine, integration requires only a standard `<script>` tag. Ensure it is loaded before your application code.

```html
<script src="miniEngineWasm.js"></script>
<script src="your-game.js"></script>
```

### 2. Initialization

Initialize the `App` instance, which automatically creates the WebGL2 context, sets up the primary scene graph, and configures the perspective camera.

```javascript
const canvas = document.getElementById('game-canvas');
const app = new MiniEngine.App({ canvas });

// Adjust camera properties
app.camera.fov = Math.PI / 3;
app.camera.near = 0.1;
app.camera.far = 5000;
app.camera.updateProjection();
```

### 3. Creating Geometry and Materials

The engine utilizes a strict compilation step for geometry to generate VAOs. Materials require pre-compiled shader permutations.

```javascript
// 1. Generate Geometry
const boxGeo = app.createBox(2, 2, 2);

// 2. Compile Shader Program (with optional defines for permutations)
const progInfo = app.renderer.gl.createProgram(
    MiniEngine.ShaderLib.basicVS, 
    MiniEngine.ShaderLib.basicFS, 
    { USE_TEXTURE: 0 }
);

// 3. Create Material
const material = new MiniEngine.Material({
    programInfo: progInfo,
    uniforms: {
        u_color: new Float32Array([0.8, 0.2, 0.2])
    },
    transparent: false
});

// 4. Instantiate Mesh
const mesh = new MiniEngine.Mesh(boxGeo, material);
mesh.setPosition(0, 0, -10);

// 5. Add to Scene Graph
app.scene.add(mesh);
```

### 4. The Game Loop

Define the update logic via the `app.update` callback. The engine handles the `requestAnimationFrame` loop, delta time calculation, and rendering pipeline automatically.

```javascript
app.update = function(deltaTime) {
    // Rotate the mesh around the Y-axis
    mesh.rotation[1] += deltaTime * 1.5;
    
    // Flag the node as dirty to trigger matrix recalculation
    mesh.markDirty();
};

// Start the engine
app.start();
```

### 5. Scene Graph Management

Nodes can be nested to create complex hierarchical transformations.

```javascript
const parentNode = new MiniEngine.Node('Pivot');
parentNode.setPosition(5, 0, -10);

const childMesh = new MiniEngine.Mesh(sphereGeo, material);
childMesh.setPosition(2, 0, 0); // Relative to parentNode

parentNode.add(childMesh);
app.scene.add(parentNode);
```

---

## Advanced: Engine Exploitation & Memory Manipulation

For users seeking to bypass standard engine constraints, inject unauthorized rendering commands, or manipulate internal states, the engine's architecture exposes several vectors for direct intervention.

### WebGL Context Injection
You can intercept the raw WebGL2 context to inject custom draw calls, modify GPU state directly, or bypass the `Renderer` queue entirely. This is useful for injecting post-processing effects or unauthorized wireframe overlays.

```javascript
const gl = app.renderer.gl.gl;

// Bypass engine state cache to force wireframe rendering globally
// Note: polygonMode requires the OES_polygon_mode extension in WebGL
gl.disable(gl.CULL_FACE);

// Inject unauthorized depth buffer manipulation to force overlays on top
gl.depthRange(0.0, 0.5);
```

### WASM Memory Overwrite
If the `WasmBulkProcessor` is active, its shared memory buffer can be accessed and overwritten directly via the JavaScript console. This allows you to manipulate physics, particle data, or transform matrices without triggering engine validation checks or dirty-flagging systems.

```javascript
const wasmMemory = MiniEngine.WasmBulkProcessor.memory.buffer;
// Assuming bulkPtr is allocated in your specific implementation
const view = new Float32Array(wasmMemory, MiniEngine.WasmBulkProcessor.bulkPtr, 1024);

// Overwrite arbitrary vector data directly in WASM linear memory
view[0] = 9999.0; 
view[1] = 0.0;
```

### Render Queue Interception
You can hijack the render queue to force specific objects to render out of order, or inject custom draw commands between the opaque and transparent passes.

```javascript
const originalRender = app.renderer.render.bind(app.renderer);
app.renderer.render = function(scene, camera) {
    originalRender(scene, camera);
    
    // Inject unauthorized overlay rendering after the main pass
    const gl = this.gl.gl;
    gl.disable(gl.DEPTH_TEST);
    // Execute custom overlay shader or direct draw calls here
    gl.enable(gl.DEPTH_TEST);
};
```

---

## Performance Considerations

To maintain a stable 60+ FPS, adhere to the following architectural constraints:
1.  **Avoid Object Allocation in the Render Loop:** Never use `Vec3.create()` or `Mat4.create()` inside the `app.update` function. Utilize pre-allocated scratchpad variables or modify existing arrays directly.
2.  **Batching:** For rendering thousands of identical objects, utilize the `InstancedMesh` class (requires custom shader implementation for instance attributes).
3.  **Matrix Updates:** Only call `markDirty()` when a node's local transform has actually changed. The engine will propagate world matrix updates efficiently.

---

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPLv3)**. 

You are free to use, modify, and distribute this software, provided that any modifications or derivative works deployed on a network server are also made available under the same license. For full terms, refer to the official AGPLv3 license text.
