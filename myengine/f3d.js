// 导出 Three.js - 使用 npm 包
export * from "three";
// 精确导出所需的扩展模块
export { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
export { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
export { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
export { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
export { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
export { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
export { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
export { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
export { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
export { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
export { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
export { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
export { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
export { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
export { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
export { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
export { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";

// 导出核心模块
export * from "./engine/engine.Core.js";
export * from "./editor/editor.Core.js";
export * from "./f3dApp.js";
 