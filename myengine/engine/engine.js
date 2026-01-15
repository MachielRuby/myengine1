/**
 * 引擎类 - 3D引擎的核心控制器
 * @author AGan
 */
import {
    ACESFilmicToneMapping,
    Scene,
    WebGLRenderer,
    PCFSoftShadowMap,
    Color,
    SRGBColorSpace,
    Loader,
    TextureLoader,
    ImageLoader,
    CubeTextureLoader,
    Frustum,
    Matrix4,
    Box3,
    Sphere,
    Vector3
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

import { EventBus } from "./core/events/eventEmitter.js";
import { AssetsManager } from "./core/assets/assetsManager.js";
import { InputManager } from "./interaction/inputManager.js";
import { ModelController } from "./controllers/modelController.js";
import { AnimationController } from "./controllers/animationController.js";
import { HotspotController } from "./controllers/hotspotController.js";
import { HighlightController } from "./controllers/highlightController.js";
import { EditorController } from "./controllers/editController.js";
import { XRController } from "./controllers/xrController.js";
import { Logger } from "../editor/tools/logger.js";
import { cameraApi } from "../editor/apis/cameraApi.js";

export class Engine {
    // 引擎状态
    editor = null;  //编辑器
    animationId = null;  //动画ID
    onUpdateList = {}; //更新回调列表
    events = new EventBus(); //事件总线
    frameCount = 0; //帧计数器

    // 场景组件
    mainScene = null; //主场景
    camera = null; //相机
    renderer = null; //渲染器
    labelRenderer = null; //CSS2D渲染器
    containerElement = null; //容器元素
    editController = null; //编辑控制器
    modelController = null; //模型控制器
    animationController = null; //动画控制器
    hotspotController = null; //热点控制器
    highlightController = null; //高亮控制器
    xrController = null; //XR控制器
    assetsManager = null; //资源管理器
    inputManager = null; //输入管理器
    
    // 视锥体剔除优化
    frustum = new Frustum();
    projScreenMatrix = new Matrix4();
    cullingEnabled = true;
    cullingStats = { visible: 0, total: 0 };
    _tempBox = new Box3();  // 复用避免GC
    _tempSphere = new Sphere();
    _tempVec = new Vector3();
    /**
     * 创建引擎实例
     * @param {Object} config 配置选项
     */
    constructor(config = {}) {
        this.config = config;

        this.initCore(config);
        this.initManagers();
        this.initControllers();

        //防止跨域报错 - 设置所有Three.js加载器的CORS
        Loader.prototype.crossOrigin = 'anonymous';
        TextureLoader.prototype.crossOrigin = 'anonymous';
        ImageLoader.prototype.crossOrigin = 'anonymous';
        CubeTextureLoader.prototype.crossOrigin = 'anonymous';
        GLTFLoader.prototype.crossOrigin = 'anonymous';
        FBXLoader.prototype.crossOrigin = 'anonymous';
        OBJLoader.prototype.crossOrigin = 'anonymous';
        STLLoader.prototype.crossOrigin = 'anonymous';
        // 监听窗口大小变化 - 保存引用以便正确清理
        this.handleResize = this.handleResize.bind(this);
        window.addEventListener("resize", this.handleResize);
    }

    /**
     * 初始化引擎核心组件
     */
    initCore(config) {
        this.initRenderer(config);
        this.initScenes();
        this.initCamera();
        this.initController();
        this.initInputManager();
    };

    /**
     * 初始化输入管理器
     */
    initInputManager() {
        if (!this.renderer) {
            Logger.warn("渲染器未初始化，无法创建输入管理器");
            return;
        }

        this.inputManager = new InputManager(this.renderer.domElement, this);
    }

    /**
     * 初始化场景
     */
    initScenes() {
        this.mainScene = new Scene();
        this.mainScene.name = "主场景";
    }

    /**
     * 初始化相机
     */
    initCamera() {
        const aspect = this.containerElement
            ? this.containerElement.clientWidth / this.containerElement.clientHeight
            : window.innerWidth / window.innerHeight;

        this.camera = new cameraApi(60, aspect, 0.1, 1000);
        this.camera.position.set(0, 0, 10);
        this.camera.lookAt(0, 0, 0);
    }

    /**
     * 初始化渲染器
     */
    initRenderer(config) {
        const { domElement } = config;

        this.renderer = new WebGLRenderer({
            canvas: domElement instanceof HTMLCanvasElement ? domElement : undefined,
            antialias:true, 
            alpha: true,
            xr: true,  
            powerPreference: "high-performance",  
            precision: "highp"  
        });
        
        // 启用 XR 支持
        this.renderer.xr.enabled = true;
    
        const devicePixelRatio = window.devicePixelRatio || 1;
        let pixelRatio;
        if (devicePixelRatio === 1) {
            pixelRatio = 1;  
        } else {
            pixelRatio = Math.min(devicePixelRatio, 2);
        }

        this.renderer.setPixelRatio(pixelRatio);
        // 关闭阴影设置
        this.renderer.shadowMap.enabled = false;
        this.renderer.shadowMap.type = PCFSoftShadowMap; 
        this.renderer.shadowMap.autoUpdate = false;
        
        // 阴影优化
        this.renderer.shadowMap.autoUpdate = false;
        this.renderer.shadowMap.needsUpdate = false; 
    
        // 色调映射
        this.renderer.toneMapping = ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;  // 统一基线曝光
        this.renderer.outputColorSpace = SRGBColorSpace; 

        // 设置DOM容器
        if (domElement && !(domElement instanceof HTMLCanvasElement)) {
            domElement.appendChild(this.renderer.domElement);
            this.containerElement = domElement;
        } else if (!domElement) {
            document.body.appendChild(this.renderer.domElement);
            this.containerElement = document.body;
        } else {
            this.containerElement = domElement.parentElement || document.body;
        }

        // 确保CSS2D 渲染器正确对齐
        if (this.containerElement !== document.body) {
            const style = window.getComputedStyle(this.containerElement);
            if (style.position === 'static') {
                this.containerElement.style.position = 'relative';
            }
        }

        // 配置渲染器
        const { clientWidth, clientHeight } = this.containerElement;
        this.renderer.setSize(clientWidth, clientHeight);
        this.renderer.shadowMap.enabled = false;
        this.renderer.shadowMap.type = PCFSoftShadowMap;
        this.renderer.sortObjects = true;

        this.renderer.setClearColor(0x000000, 0); 

        // 初始化 CSS2D 渲染器，用于渲染热点文本标签
        this.labelRenderer = new CSS2DRenderer();
        this.labelRenderer.setSize(clientWidth, clientHeight);
        this.labelRenderer.domElement.style.position = 'absolute';
        this.labelRenderer.domElement.style.top = '0';
        this.labelRenderer.domElement.style.left = '0';
        this.labelRenderer.domElement.style.pointerEvents = 'none';
        this.containerElement.appendChild(this.labelRenderer.domElement);
    }

    /**
     * 初始化相机控制器
     */
    initController() {
        if (!this.camera || !this.renderer) {
            Logger.warn("相机和渲染器未初始化，无法创建控制器");
            return;
        }

        this.editController = new EditorController(this.camera, this.renderer.domElement);

        // 绑定相机和控制器
        this.camera.setControls?.(this.editController);
    }

    /**
     * 初始化资源管理器
     */
    initManagers() {
        this.assetsManager = new AssetsManager(this);
    }

    /**
     * 初始化控制器
     */
    initControllers() {
        this.modelController = new ModelController(this);
        this.animationController = new AnimationController(this);
        this.hotspotController = new HotspotController(this);
        this.highlightController = new HighlightController(this);
        this.xrController = new XRController(this);
    }

    /**
     * 处理窗口大小变化
     */
    handleResize() {
        if (!this.containerElement) return;
        const { clientWidth: width, clientHeight: height } = this.containerElement;
        // 更新相机
        if (this.camera) {
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
        }
        // 更新渲染器
        this.renderer?.setSize(width, height);
        // 更新 CSS2D 渲染器
        this.labelRenderer?.setSize(width, height);
        // 更新高亮控制器
        this.highlightController?.setSize(width, height);
    }

    /**
     * 启动引擎
     */
    start() {
        if (!this.animationId) {
            this.animate();
        }
    }

    /**
     * 停止引擎
     */
    stop() {
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    /**
     * 动画循环
     */
    animate = () => {
        this.animationId = requestAnimationFrame(this.animate);
        this.frameCount++;
        
        // 计算deltaTime - 修复计算错误
        const currentTime = performance.now();
        if (!this.lastTime) {
            this.lastTime = currentTime;
        }
        const deltaTime = (currentTime - this.lastTime) / 1000;
        this.lastTime = currentTime;
        
        // 执行更新回调（统一传入deltaTime）
        for (const key in this.onUpdateList) {
            const cb = this.onUpdateList[key];
            if (typeof cb === 'function') cb(deltaTime);
        }
        
        // 更新控制器（统一时间步长）
        this.editController?.update?.(deltaTime);
        this.modelController?.update?.(deltaTime);
        this.hotspotController?.update?.(deltaTime);
        
        // 视锥体剔除（每10帧执行一次）
        if (this.cullingEnabled && this.frameCount % 10 === 0) {
            this.performFrustumCulling();
        }
        
        // 渲染场景
        if (this.renderer && this.mainScene && this.camera) {
            const composer = this.highlightController?.getComposer?.();
            if (composer) {
                composer.render();
            } else {
                this.renderer.render(this.mainScene, this.camera);
            }
            this.labelRenderer?.render(this.mainScene, this.camera);
        }
    }

    /**
     * 添加更新回调
     */
    addUpdateCallback(key, callback) {
        if (typeof callback === 'function') {
            this.onUpdateList[key] = callback;
        }
    }

    /**
     * 移除更新回调
     */
    removeUpdateCallback(key) {
        delete this.onUpdateList[key];
    }

    /**
     * 设置编辑器引用
     */
    setEditor(editor) {
        this.editor = editor;
    }

    /**
     * 清理资源
     */
    dispose() {
        // 停止动画循环
        this.stop();

        // 移除事件监听
        window.removeEventListener("resize", this.handleResize);

        // 清理控制器
        this.editController?.dispose();
        this.modelController?.dispose();
        this.animationController?.dispose();
        this.hotspotController?.dispose();
        this.highlightController?.dispose();

        // 清理管理器
        this.inputManager?.dispose();
        this.assetsManager?.dispose();

        // 清理渲染器
        this.renderer?.dispose();
        if (this.labelRenderer?.domElement?.parentElement) {
            this.labelRenderer.domElement.parentElement.removeChild(this.labelRenderer.domElement);
        }
        this.labelRenderer = null;

        // 清空场景
        if (this.mainScene) {
            while (this.mainScene.children.length > 0) {
                const child = this.mainScene.children[0];
                if (typeof child.dispose === 'function') child.dispose();
                this.mainScene.remove(child);
            }
        }

        // 清理事件总线
        this.events?.removeAllListeners();

        // 清空更新列表
        this.onUpdateList = {};

        // 清空引用
        this.editor = null;
        this.camera = null;
        this.renderer = null;
        this.mainScene = null;
        this.editController = null;
        this.modelController = null;
        this.animationController = null;
        this.hotspotController = null;
        this.highlightController = null;
        this.xrController = null;
        this.inputManager = null;
        this.assetsManager = null;
        this.containerElement = null;
        this.events = null;
    }

    /**
     * 检测光照质量
     */
    optimizeLighting() {
        if (!this.mainScene) return;
        
        let lightCount = 0;
        let totalIntensity = 0;
        
        this.mainScene.traverse(object => {
            if (object.isLight) {
                lightCount++;
                totalIntensity += object.intensity;
                console.log(`光源: ${object.type}, 强度: ${object.intensity}`);
            }
        });
        
        console.log(`光照: ${lightCount}个, 总强度: ${totalIntensity.toFixed(2)}`);
        
        if (lightCount === 0) {
            console.warn('无光源');
        } else if (totalIntensity < 1.0) {
            console.warn('光照过暗');
        } else if (totalIntensity > 5.0) {
            console.warn('光照过亮');
        }
        
        return { lightCount, totalIntensity };
    }
    
    /**
     * 截取当前场景的图片
     */
    captureScreenshot() {
        if (!this.renderer || !this.mainScene || !this.camera) {
            console.error('截图失败: 渲染器、场景或相机未初始化');
            return null;
        }

        // 保存当前背景设置
        const originalBackground = this.mainScene.background;
        const originalClearColor = this.renderer.getClearColor(new Color());
        const originalClearAlpha = this.renderer.getClearAlpha();

        try {
            // 设置截图背景色为 #1a1a1a
            this.mainScene.background = new Color(0x1a1a1a);
            this.renderer.setClearColor(0x1a1a1a, 1);

            // 渲染一帧确保画面是最新的
            this.renderer.render(this.mainScene, this.camera);

            // 获取截图数据
            const screenshot = this.renderer.domElement.toDataURL('image/png');

            return screenshot;
        } finally {
            // 恢复原始背景设置
            this.mainScene.background = originalBackground;
            this.renderer.setClearColor(originalClearColor, originalClearAlpha);
        }
    }

    /**
     * 更新视锥体
     */
    updateFrustum() {
        if (!this.camera) return;
        
        this.projScreenMatrix.multiplyMatrices(
            this.camera.projectionMatrix,
            this.camera.matrixWorldInverse
        );
        this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
    }

    /**
     * 检查对象是否在视锥体内
     * @param {THREE.Object3D} object - 要检查的对象
     * @returns {boolean} 是否可见
     */
    isObjectVisible(object) {
        if (!this.cullingEnabled || !object) return true;
        if (!object.geometry && !object.children.length) return true;
        
        // 优先用包围球（更快），复用临时对象避免GC
        const geo = object.geometry;
        if (geo?.boundingSphere) {
            this._tempSphere.copy(geo.boundingSphere);
            this._tempSphere.applyMatrix4(object.matrixWorld);
            return this.frustum.intersectsSphere(this._tempSphere);
        }
        
        // 回退到包围盒
        this._tempBox.setFromObject(object);
        return this.frustum.intersectsBox(this._tempBox);
    }

    /**
     * 递归设置对象可见性
     * @param {THREE.Object3D} object - 要处理的对象
     */
    setObjectVisibility(object) {
        if (!object) return;
        
        const isVisible = this.isObjectVisible(object);
        object.visible = isVisible;
        
        // 递归处理子对象
        if (object.children && object.children.length > 0) {
            object.children.forEach(child => {
                this.setObjectVisibility(child);
            });
        }
    }

    /**
     * 执行视锥体剔除
     */
    performFrustumCulling() {
        if (!this.cullingEnabled || !this.mainScene) return;
        
        this.updateFrustum();
        
        let visibleCount = 0;
        let totalCount = 0;
        
        // 遍历场景中的所有对象
        this.mainScene.traverse(object => {
            if (object.isMesh || object.isGroup) {
                // 跳过被动画隔离控制的mesh
                if (object.userData?.__isolationControlled) {
                    // 使用隔离时设置的可见性，不进行视锥体剔除
                    if (object.userData.__isolationVisible) {
                        visibleCount++;
                    }
                    return;
                }
                totalCount++;
                
                // 跳过被动画隔离控制的mesh
                if (object.userData?.__isolationControlled) {
                    // 使用隔离时设置的可见性，不进行视锥体剔除
                    if (object.userData.__isolationVisible) {
                        visibleCount++;
                    }
                    return;
                }
                                
                const isVisible = this.isObjectVisible(object);
                object.visible = isVisible;
                if (isVisible) visibleCount++;
            }
        });
        
        // 更新统计信息
        this.cullingStats.visible = visibleCount;
        this.cullingStats.total = totalCount;
        
        // 统计信息已更新到 this.cullingStats
    }

    /**
     * 切换视锥体剔除
     * @param {boolean} enabled - 是否启用
     */
    toggleFrustumCulling(enabled) {
        this.cullingEnabled = enabled;
        console.log(`视锥体剔除已${enabled ? '启用' : '禁用'}`);
        
        // 如果禁用，显示所有对象
        if (!enabled && this.mainScene) {
            this.mainScene.traverse(object => {
                if (object.isMesh || object.isGroup) {
                    object.visible = true;
                }
            });
        }
    }
}