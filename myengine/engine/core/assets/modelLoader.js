import { LoadingManager, Box3, Vector3, BufferGeometry, Mesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";

// BVH 初始化标志（确保只初始化一次）
let bvhInitialized = false;

// 初始化 BVH（扩展 Three.js 原型）
function initializeBVH() {
    if (bvhInitialized) return;
    if (BufferGeometry && !BufferGeometry.prototype.computeBoundsTree) {
        BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
        BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
    }
    if (Mesh && !Mesh.prototype._originalRaycast) {
        Mesh.prototype._originalRaycast = Mesh.prototype.raycast;
        Mesh.prototype.raycast = acceleratedRaycast;
    }
    bvhInitialized = true;
    console.log('[BVH] 已初始化加速射线检测');
}

// 3D模型加载器，支持GLTF/GLB(含Draco压缩)、FBX、OBJ、STL格式
export class ModelLoader {
  // renderer参数用于KTX2纹理加载
  constructor(renderer = null, onProgress = null) {
    this.loadingManager = new LoadingManager();
    this.renderer = renderer;
    this.onProgressCallback = onProgress;
    
    // 初始化 BVH（只需执行一次）
    initializeBVH();
    
    // 设置加载事件
    this.loadingManager.onStart = (url, itemsLoaded, itemsTotal) => {
      console.log(`Started loading: ${url} (${itemsLoaded}/${itemsTotal})`);
    };
    
    this.loadingManager.onLoad = () => {
      console.log('Loading complete');
    };
    
    this.loadingManager.onProgress = (url, itemsLoaded, itemsTotal) => {
      const progress = (itemsLoaded / itemsTotal * 100).toFixed(2);
      console.log(`Loading file: ${url} (${progress}% loaded)`);
      
      // 调用外部进度回调
      if (this.onProgressCallback && typeof this.onProgressCallback === 'function') {
        this.onProgressCallback(url, itemsLoaded, itemsTotal, progress);
      }
    };
    
    this.loadingManager.onError = (url) => {
      console.error(`Error loading: ${url}`);
    };
    
    // 初始化加载器
    this.initDracoLoader();
    this.initKTX2Loader();
    this.initGLTFLoader();
    
    this.fbxLoader = new FBXLoader(this.loadingManager);
    this.objLoader = new OBJLoader(this.loadingManager);
    this.stlLoader = new STLLoader(this.loadingManager);
  }
  
  // 设置进度回调
  setProgressCallback(callback) {
    if (typeof callback === 'function') {
      this.onProgressCallback = callback;
    }
  }
  
  // 处理加载后的模型
  processModel(model, options = {}) {
    if (!model) return model;
    
    const { 
      autoScale = true, 
      targetSize = 5,
      alignToGround = false,
      centerAtOrigin = false,
      position,
      rotation,
      scale
    } = options;
    
    // 自动缩放 - 只在没有指定scale时执行
    if (autoScale && !scale) {
      this.scaleToSize(model, targetSize);
    }
    
    // 居中到原点
    if (centerAtOrigin) {
      this.centerToOrigin(model);
    }
    
    // 让底面贴地
    if (alignToGround) {
      this.alignToGround(model);
    }
    
    // 设置变换 - 这里会处理scale，避免双重缩放
    this.setTransform(model, position, rotation, scale);
    
    // 启用阴影
    this.enableShadows(model);
    
    // 构建 BVH 索引（加速射线检测）
    this.buildBVH(model);
    
    return model;
  }
  
  // 将模型缩放到指定尺寸
  scaleToSize(model, targetSize = 5) {
    if (!model?.scale) return;
    
    // 先重置缩放，避免原始scale影响包围盒
    model.scale.set(1, 1, 1);
    const box = new Box3().setFromObject(model);
    const size = new Vector3();
    box.getSize(size);
    
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) {
      model.scale.setScalar(targetSize / maxDim);
    }
  }
  
  // 将模型居中到世界坐标原点
  centerToOrigin(model) {
    if (!model?.position) return;
    
    const box = new Box3().setFromObject(model);
    const center = new Vector3();
    box.getCenter(center);
    
    // 将模型位置偏移，使包围盒中心与世界坐标原点对齐
    model.position.x -= center.x;
    model.position.y -= center.y;
    model.position.z -= center.z;
  }
  
  // 让模型底面贴地
  alignToGround(model) {
    if (!model?.position) return;
    
    const box = new Box3().setFromObject(model);
    model.position.y -= box.min.y;
  }
  
  // 设置模型变换
  setTransform(model, position, rotation, scale) {
    // 设置位置
    if (position && model?.position) {
      model.position.x = position.x ?? model.position.x;
      model.position.y += position.y ?? 0; // 叠加Y轴位置
      model.position.z = position.z ?? model.position.z;
    }
    
    // 设置旋转
    if (rotation && model?.rotation) {
      model.rotation.set(
        rotation.x ?? model.rotation.x, 
        rotation.y ?? model.rotation.y, 
        rotation.z ?? model.rotation.z
      );
    }
    
    // 设置缩放
    if (scale && model?.scale) {
      if (typeof scale === 'number') {
        model.scale.multiplyScalar(scale);
      } else {
        model.scale.x *= scale.x ?? 1;
        model.scale.y *= scale.y ?? 1;
        model.scale.z *= scale.z ?? 1;
      }
    }
  }
  
  // 关闭阴影
  enableShadows(model) {
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        
        if (child.material) {
          child.material.needsUpdate = true;
        }
      }
    });
  }
  
  // 构建 BVH 索引（加速射线检测）
  buildBVH(model) {
    if (!model) return;
    let count = 0;
    model.traverse((child) => {
      if (child.isMesh && child.geometry) {
        // 确保所有 mesh 都构建 BVH（包括已有 boundsTree 的，避免遗漏）
        if (!child.geometry.boundsTree) {
          try {
            if (typeof child.geometry.computeBoundsTree === 'function') {
              child.geometry.computeBoundsTree();
              count++;
            }
          } catch (error) {
            console.warn(`[BVH] 构建失败: ${child.name || '未命名'}`, error);
          }
        }
      }
    });
    if (count > 0) {
      console.log(`[BVH] 已为 ${count} 个 mesh 构建索引`);
    }
  }
  
  // 通用加载方法 - 根据文件扩展名自动选择加载器
  load(url, onLoad, onProgress, onError) {
    // 检测文件扩展名来确定加载器类型
    const extension = url.split('.').pop().toLowerCase();
    let loadMethod;
    switch (extension) {
      case 'glb':
      case 'gltf':
        loadMethod = 'loadGLTF';
        break;
      case 'fbx':
        loadMethod = 'loadFBX';
        break;
      case 'obj':
        loadMethod = 'loadOBJ';
        break;
      case 'stl':
        loadMethod = 'loadSTL';
        break;
      default:
        console.error('不支持的文件格式:', extension);
        if (onError) onError(new Error(`不支持的文件格式: ${extension}`));
        return;
    }
    
    // 调用对应的加载方法
    return this[loadMethod](url, onLoad, onProgress, onError);
  }
  
  loadAsync(url) {
    return new Promise((resolve, reject) => {
      this.load(url, resolve, null, reject);
    });
  }
  
  // 批量加载模型
  async loadMultiple(urls, options = {}) {
    const results = [];
    const errors = [];
    
    for (let i = 0; i < urls.length; i++) {
      try {
        const model = await this.loadAsync(urls[i]);
        
        // 处理模型
        if (options.processModels !== false) {
          this.processModel(model, options);
        }
        
        results.push({ url: urls[i], model, success: true });
      } catch (error) {
        results.push({ url: urls[i], error, success: false });
        errors.push({ url: urls[i], error });
      }
      
      if (options.onProgress) {
        options.onProgress(i + 1, urls.length, results);
      }
    }
    
    return { results, errors };
  }
  
  // 初始化Draco压缩解码器
  initDracoLoader() {
    this.dracoLoader = new DRACOLoader(this.loadingManager);
    // 使用 public 目录下的解码器文件（Vite 会将 public 目录映射到根路径）
    this.dracoLoader.setDecoderPath('/libs/draco/gltf/');
    this.dracoLoader.setDecoderConfig({ type: 'js' }); // 使用JS解码器更兼容
    this.dracoLoader.preload(); // 预加载解码器
  }
  
  // 初始化KTX2纹理加载器
  initKTX2Loader() {
    if (this.renderer) {
      this.ktx2Loader = new KTX2Loader(this.loadingManager);
      this.ktx2Loader.crossOrigin = 'anonymous';
      // 使用 public 目录下的解码器文件（Vite 会将 public 目录映射到根路径）
      this.ktx2Loader.setTranscoderPath('/libs/basis/');
      this.ktx2Loader.detectSupport(this.renderer);
    }
  }
  
  // 初始化GLTF加载器
  initGLTFLoader() {
    this.gltfLoader = new GLTFLoader(this.loadingManager);
    this.gltfLoader.crossOrigin = 'anonymous';
    this.gltfLoader.setDRACOLoader(this.dracoLoader);
    
    if (this.ktx2Loader) {
      this.gltfLoader.setKTX2Loader(this.ktx2Loader);
    }
  }
  
  // 加载GLTF/GLB模型
  loadGLTF(url, onLoad, onProgress, onError) {
    this.gltfLoader.load(
      url,
      (gltf) => {
        console.log("ModelLoader: GLTF加载完成", {
          url,
          hasScene: !!gltf.scene,
          hasAnimations: !!gltf.animations,
          animationsCount: gltf.animations?.length || 0,
          animations: gltf.animations?.map(a => a.name) || []
        });

        // 优化模型
        this.optimizeModel(gltf);
        const model = gltf.scene || gltf;
        
        // 检查模型是否包含动画
        if (model.animations && model.animations.length > 0) {
          console.log("ModelLoader: 模型包含动画数据", {
            modelName: model.name,
            animationsCount: model.animations.length,
            animationNames: model.animations.map(a => a.name)
          });
        } else {
          console.log("ModelLoader: 模型不包含动画数据");
        }
        
        // 最终检查模型对象
        console.log("ModelLoader: 最终模型对象检查", {
          modelType: model.constructor?.name,
          hasAnimations: !!model.animations,
          animationsCount: model.animations?.length || 0,
          modelName: model.name
        });
        
        // 发送模型加载完成事件 - 通过loadingManager触发全局事件
        if (this.loadingManager.onModelLoaded) {
          this.loadingManager.onModelLoaded({ url, model });
        }
        
        if (onLoad) onLoad(model);
      },
      (xhr) => {
        // 计算详细的加载进度
        if (xhr.lengthComputable) {
          const percentComplete = (xhr.loaded / xhr.total) * 100;
          
          // 调用外部进度回调，传递详细进度
          if (this.onProgressCallback && typeof this.onProgressCallback === 'function') {
            this.onProgressCallback(url, xhr.loaded, xhr.total, percentComplete);
          }
        }
        
        if (onProgress) onProgress(xhr);
      },
      (error) => {
        console.error('Error loading GLTF:', error);
        this.handleLoadError(url, error);
        if (onError) onError(error);
      }
    );
  }
  
  // 优化模型设置
  optimizeModel(gltf) {
    if (!gltf || !gltf.scene) return;
    
    // 确保动画数据被正确传递到场景对象
    if (gltf.animations && gltf.animations.length > 0) {
      gltf.scene.animations = gltf.animations;
      console.log("ModelLoader: 动画数据已传递到场景", {
        animationsCount: gltf.animations.length,
        animationNames: gltf.animations.map(a => a.name)
      });
    }
    
    // 遍历模型中的网格
    gltf.scene.traverse((child) => {
      if (child.isMesh) {
        // 关闭阴影
        child.castShadow = false;
        child.receiveShadow = false;
        
        // 更新材质
        if (child.material) {
          child.material.needsUpdate = true;
        }
      }
    });
    
    // 构建 BVH 索引（加速射线检测）
    this.buildBVH(gltf.scene);
  }
  
  // 处理加载错误
  handleLoadError(url, error) {
    if (error.message.includes('404')) {
      console.error('文件未找到:', url);
    } else if (error.message.includes('CORS')) {
      console.error('CORS错误，服务器可能不允许跨域请求');
    } else if (error.message.includes('DRACO')) {
      console.error('DRACO解码错误，检查解码器路径');
    }
  }
  
  // 加载FBX模型
  loadFBX(url, onLoad, onProgress, onError) {
    this.fbxLoader.load(
      url,
      (fbx) => {
        // FBX通常需要缩放调整，但不强制应用
        // 让用户通过options来控制缩放
        console.log("ModelLoader: FBX加载完成", {
          url,
          hasAnimations: !!fbx.animations,
          animationsCount: fbx.animations?.length || 0,
          originalScale: fbx.scale.clone()
        });
        
        if (onLoad) onLoad(fbx);
      },
      (xhr) => this._handleXHRProgress(xhr, url, onProgress),
      (error) => {
        console.error('Error loading FBX:', error);
        if (onError) onError(error);
      }
    );
  }
  
  // 加载OBJ模型
  loadOBJ(url, onLoad, onProgress, onError) {
    this.objLoader.load(
      url,
      (obj) => {
        if (onLoad) onLoad(obj);
      },
      (xhr) => this._handleXHRProgress(xhr, url, onProgress),
      (error) => {
        console.error('Error loading OBJ:', error);
        if (onError) onError(error);
      }
    );
  }
  
  // 加载STL模型
  loadSTL(url, onLoad, onProgress, onError) {
    this.stlLoader.load(
      url,
      (geometry) => {
        if (onLoad) onLoad(geometry);
      },
      (xhr) => this._handleXHRProgress(xhr, url, onProgress),
      (error) => {
        console.error('Error loading STL:', error);
        if (onError) onError(error);
      }
    );
  }
  
  // 获取加载状态
  getLoadingStats() {
    return {
      isLoading: this.loadingManager.isLoading,
      itemsLoaded: this.loadingManager.itemsLoaded,
      itemsTotal: this.loadingManager.itemsTotal
    };
  }
  
  // 释放资源
  dispose() {
    if (this.dracoLoader) {
      this.dracoLoader.dispose();
    }
    
    if (this.ktx2Loader) {
      this.ktx2Loader.dispose();
    }
    
    // 清理事件处理器
    this.loadingManager.onStart = null;
    this.loadingManager.onLoad = null;
    this.loadingManager.onProgress = null;
    this.loadingManager.onError = null;
    this.loadingManager.onModelLoaded = null;
  }
}

// 统一的XHR进度处理与类型判断
ModelLoader.prototype._handleXHRProgress = function(xhr, url, onProgress) {
  if (xhr && xhr.lengthComputable) {
    const percentComplete = (xhr.loaded / xhr.total) * 100;
    const loaderType = this._getLoaderType(url);
    console.log(`${loaderType} 详细进度: ${percentComplete.toFixed(2)}% (${xhr.loaded}/${xhr.total} bytes)`);
    if (this.onProgressCallback && typeof this.onProgressCallback === 'function') {
      this.onProgressCallback(url, xhr.loaded, xhr.total, percentComplete);
    }
  }
  if (onProgress) onProgress(xhr);
};

ModelLoader.prototype._getLoaderType = function(url) {
  const lowerUrl = (url || '').toLowerCase();
  if (lowerUrl.includes('.gltf') || lowerUrl.includes('.glb')) return 'GLTF';
  if (lowerUrl.includes('.fbx')) return 'FBX';
  if (lowerUrl.includes('.obj')) return 'OBJ';
  if (lowerUrl.includes('.stl')) return 'STL';
  return 'Unknown';
};

