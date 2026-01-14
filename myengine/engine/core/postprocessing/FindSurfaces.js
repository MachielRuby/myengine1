
import { 
    ShaderMaterial, 
    BufferAttribute 
} from "three";

/*
  This class computes "surface IDs" for a given mesh.
  A "surface" is defined as a set of triangles that share vertices.
*/
class FindSurfaces {
  constructor() {
    // Start at 1 because 0 is reserved for background/unselected
    this.surfaceId = 1;
  }

  /*
   * Returns the surface Ids as a Float32Array that can be inserted as a vertex attribute
   * Mode: 'single' (one ID per mesh) or 'split' (split by angle)
   */
  getSurfaceIdAttribute(mesh, mode = 'single') {
    const bufferGeometry = mesh.geometry;
    const numVertices = bufferGeometry.attributes.position.count;
    
    let vertexIdToSurfaceId;
    if (mode === 'single') {
        vertexIdToSurfaceId = this._generateSingleSurfaceId(mesh);
    } else {
        vertexIdToSurfaceId = this._generateSurfaceIds(mesh);
    }

    const colors = [];
    for (let i = 0; i < numVertices; i++) {
      const vertexId = i;
      let surfaceId = vertexIdToSurfaceId[vertexId];
      // Store surfaceId in the red channel
      colors.push(surfaceId, 0, 0, 1);
    }

    const colorsTypedArray = new Float32Array(colors);
    return colorsTypedArray;
  }

  _generateSingleSurfaceId(mesh) {
      const numVertices = mesh.geometry.attributes.position.count;
      const id = this.surfaceId;
      const map = {};
      for(let i=0; i<numVertices; i++) {
          map[i] = id;
      }
      this.surfaceId++;
      return map;
  }

  /*
   * Returns a `vertexIdToSurfaceId` map
   * given a vertex, returns the surfaceId
   */
  _generateSurfaceIds(mesh) {
    const bufferGeometry = mesh.geometry;
    const numIndices = bufferGeometry.index ? bufferGeometry.index.count : 0;
    
    // If no indices, every 3 vertices is a triangle (non-indexed geometry)
    // But this algorithm relies on shared vertices (indices). 
    // If non-indexed, we might need to merge vertices first or assume disconnected triangles.
    // For now, assuming indexed geometry or just processing what we have.
    
    // If no index buffer, we can't easily find shared vertices by index.
    // We would need to match by position, which is slower.
    // Fallback: assign unique surface ID to every triangle or just return 0?
    if (!bufferGeometry.index) {
        console.warn("FindSurfaces: Geometry is not indexed. Surface IDs might be incorrect.");
        // Simple fallback: 0 for all
        const map = {};
        for(let i=0; i<bufferGeometry.attributes.position.count; i++) map[i] = 0;
        return map;
    }

    const indexBuffer = bufferGeometry.index.array;
    // For each vertex, search all its neighbors
    const vertexMap = {};
    for (let i = 0; i < numIndices; i += 3) {
      const i1 = indexBuffer[i + 0];
      const i2 = indexBuffer[i + 1];
      const i3 = indexBuffer[i + 2];

      add(i1, i2);
      add(i1, i3);
      add(i2, i3);
    }
    function add(a, b) {
      if (vertexMap[a] == undefined) vertexMap[a] = [];
      if (vertexMap[b] == undefined) vertexMap[b] = [];

      if (vertexMap[a].indexOf(b) == -1) vertexMap[a].push(b);
      if (vertexMap[b].indexOf(a) == -1) vertexMap[b].push(a);
    }

    // Find cycles
    const frontierNodes = Object.keys(vertexMap).map((v) => Number(v));
    const exploredNodes = {};
    const vertexIdToSurfaceId = {};

    while (frontierNodes.length > 0) {
      const node = frontierNodes.pop();
      if (exploredNodes[node]) continue;

      // Get all neighbors recursively
      const surfaceVertices = getNeighborsNonRecursive(node);
      // Mark them as explored
      for (let v of surfaceVertices) {
        exploredNodes[v] = true;
        vertexIdToSurfaceId[v] = this.surfaceId;
      }

      this.surfaceId += 1;
    }
    
    function getNeighborsNonRecursive(node) {
      const frontier = [node];
      const explored = {};
      const result = [];

      while (frontier.length > 0) {
        const currentNode = frontier.pop();
        if (explored[currentNode]) continue;
        const neighbors = vertexMap[currentNode];
        result.push(currentNode);

        explored[currentNode] = true;

        for (let n of neighbors) {
          if (!explored[n]) {
            frontier.push(n);
          }
        }
      }

      return result;
    }

    return vertexIdToSurfaceId;
  }
}

export default FindSurfaces;

export function getSurfaceIdMaterial() {
  return new ShaderMaterial({
    uniforms: {
      maxSurfaceId: { value: 1 },
    },
    vertexShader: getVertexShader(),
    fragmentShader: getFragmentShader(),
    vertexColors: true,
  });
}

function getVertexShader() {
  return `
  varying vec2 v_uv;
  varying vec4 vColor;

  void main() {
     v_uv = uv;
     vColor = color; // Expecting 'color' attribute

     gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
  `;
}

function getFragmentShader() {
  return `
  varying vec2 v_uv;
  varying vec4 vColor;
  uniform float maxSurfaceId;

  void main() {
    // Normalize the surfaceId when writing to texture
    float surfaceId = round(vColor.r) / maxSurfaceId;
    // Pass the typeId (stored in G channel) directly
    float typeId = vColor.g;
    gl_FragColor = vec4(surfaceId, typeId, 0.0, 1.0);
  }
  `;
}

// For debug rendering
export function getDebugSurfaceIdMaterial() {
  return new ShaderMaterial({
    uniforms: {},
    vertexShader: getVertexShader(),
    fragmentShader: `
  varying vec2 v_uv;
  varying vec4 vColor;

  void main() {      
      int surfaceId = int(round(vColor.r) * 100.0);
      float R = float(surfaceId % 255) / 255.0;
      float G = float((surfaceId + 50) % 255) / 255.0;
      float B = float((surfaceId * 20) % 255) / 255.0;

      gl_FragColor = vec4(R, G, B, 1.0);
  }
  `,
    vertexColors: true,
  });
}
