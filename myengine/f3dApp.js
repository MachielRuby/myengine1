/**
 * F3D引擎封装，提供简洁易用的3D场景管理API
 * @author GunGod
 */
import {
    AmbientLight,
    DirectionalLight
} from "three";
import { Engine } from "./engine/engine.js";
import { EventBus } from "./engine/core/events/eventEmitter.js";

// 常量定义
const SHADOW_MAP_SIZE = 1024;                   // 标准分辨率
const SHADOW_CAMERA_BOUNDS = 15;                // 中等范围
const SHADOW_BIAS = -0.0001;                    // 标准偏移
const ANGLE_TO_RADIAN = Math.PI / 180;          // 角度值转为弧度值

//导出引擎库ss
export class F3dApp {
    // 默认配置
    static defaultConfig = {
        container: null,                        // 容器元素
        autoStart: true,                        // 是否自动开始
        backgroundColor: null,                  // 背景颜色
        transparentBackground: false,           // 是否透明
        lights: {
            ambient: { color: 0xffffff, intensity: 0 },
            main: { color: 0xffffff, intensity: 0, position: { x: 5, y: 10, z: 7 }, castShadow: false },
            fill: { color: 0xffffff, intensity: 0, position: { x: -5, y: 5, z: -7 } }
        },
        camera: {                               // 设置默认相机位置和限制
            position: { x: 0, y: 5, z: 10 },
            target: { x: 0, y: 0, z: 0 },
            limits: {
                distance: { min: 2, max: 100 },
                angle: { min: -90, max: 90 }
            }
        }
    };
    
    // 核心组件
    engine = null;               // 引擎实例
    events = new EventBus();     // 事件总线
    models = new Map();          // 模型缓存
    environments = new Map();    // 环境贴图缓存
    
    // 引擎子组件
    assets = null;               // 资产管理器
    scene = null;                // 场景实例
    camera = null;               // 相机实例
    modelCtrl = null;            // 模型控制器
    animCtrl = null;             // 动画控制器
    sceneLoader = null;          // 场景加载器

    // 场景配置
    _sceneConfig = {
        models: [],              // 模型列表
        environments: [],        // 环境贴图列表
        autoStart: true,         // 是否自动开始
    };      

    /**
     * 构造函数
     * @param {Object} config - 配置选项
     */
    constructor(config = {}) {
        this.config = { ...F3dApp.defaultConfig, ...config };
        this._init();
    }

    /**
     * 统一错误处理
     * @private
     * @param {string} message - 错误消息
     * @param {Error} error    - 错误对象
     * @param {string} type    - 错误类型
     */
    _handleError(message, error, type = 'general') {
        const errorInfo = {
            type,
            message,                                                                                                                                                                                                                    
            error: error?.message || error,
            stack: error?.stack,
            timestamp: new Date().toISOString()
        };
        
        console.error(`[F3dApp] ${message}:`, errorInfo);
        this.events.emit('error', errorInfo);
    }

    /**
     * 初始化引擎和核心组件
     * @private
     */
    _init() {
        const container = this._getContainer();
        if (!container) {
            const error = new Error('找不到容器元素');
            this._handleError('找不到容器元素', error, 'init');
            return;
        }
        try {
            this.engine = new Engine({
                domElement: container
            });

            if (!this.engine) {
                throw new Error('引擎初始化失败');
            }

            this.assets = this.engine.assetsManager;
            this.scene = this.engine.mainScene;
            this.camera = this.engine.camera;
            this.modelCtrl = this.engine.modelController;
            this.animCtrl = this.engine.animationController;
            this.xrCtrl = this.engine.xrController;
            this.sceneLoader = this.assets.getSceneLoader();

            this._setupScene();
            this._setupEvents();

            if (this.config.autoStart) this.start();
        } catch (error) {
            this._handleError('引擎初始化失败', error, 'init');
        }
    }

    /**
     * 获取DOM容器元素
     */
    _getContainer() {
        const { container } = this.config;
        return typeof container === 'string'
            ? document.getElementById(container) || document.querySelector(container)
            : container;
    }

    /**
     * 设置场景
     */
    _setupScene() {
        this.setBackgroundColor(this.config.backgroundColor);
        // 按配置应用透明背景
        if (this.config.transparentBackground === true) {
            try { this.setTransparentBackground(true); } catch (_) {}
        }
        this._setupLights();
        this._setupCamera();
    }

    /**
     * 设置场景光源
     */
    _setupLights() {
        const lights = this.config?.lights;

        // 默认不添加任何光源，避免影响材质环境反射效果。
        // 只有在外部显式开启时（lights.enabled === true）才按配置添加。
        if (!lights || lights.enabled === false) {
            return;
        }

        if (lights.ambient) {
            const { color, intensity } = lights.ambient;
            const light = new AmbientLight(color, intensity);
            light.name = "ambient_light";
            this.scene.add(light);
        }

        if (lights.main) {
            const { color, intensity, position, castShadow } = lights.main;
            const light = new DirectionalLight(color, intensity);

            if (position) light.position.set(position.x, position.y, position.z);
            light.castShadow = castShadow !== false;

            if (light.castShadow) {
                light.shadow.mapSize.width = SHADOW_MAP_SIZE;
                light.shadow.mapSize.height = SHADOW_MAP_SIZE;
                light.shadow.camera.near = 0.5;
                light.shadow.camera.far = 50;
                light.shadow.camera.left = -SHADOW_CAMERA_BOUNDS;
                light.shadow.camera.right = SHADOW_CAMERA_BOUNDS;
                light.shadow.camera.top = SHADOW_CAMERA_BOUNDS;
                light.shadow.camera.bottom = -SHADOW_CAMERA_BOUNDS;
                light.shadow.bias = SHADOW_BIAS;
            }

            light.name = "main_light";
            this.scene.add(light);
        }

        if (lights.fill) {
            const { color, intensity, position } = lights.fill;
            const light = new DirectionalLight(color, intensity);

            if (position) light.position.set(position.x, position.y, position.z);
            light.name = "fill_light";
            this.scene.add(light);
        }
    }

    /**
     * 设置相机位置和约束
     */
    _setupCamera() {
        const { camera } = this.config;

        if (camera.position) {
            this.camera.setPosition(
                camera.position.x,
                camera.position.y,
                camera.position.z
            );
        }

        if (camera.target) {
            this.camera.setTarget(
                camera.target.x,
                camera.target.y,
                camera.target.z
            );
        }

        if (camera.limits) {
            const { distance, angle } = camera.limits;

            if (distance) {
                distance.min !== undefined && this.camera.setMinDistance(distance.min);
                distance.max !== undefined && this.camera.setMaxDistance(distance.max);
            }

            if (angle) {
                angle.min !== undefined && this.camera.setMinPolarAngle(angle.min * ANGLE_TO_RADIAN);
                angle.max !== undefined && this.camera.setMaxPolarAngle(angle.max * ANGLE_TO_RADIAN);
            }
        }
    }

    /**
     * 设置事件转发 - 统一事件代理机制
     */
    _setupEvents() {
        // 统一的事件代理配置
        const eventProxies = [
            // 引擎核心事件
            { source: this.engine.events, events: [
                ['load:start', 'loading'],
                ['load:progress', 'progress'],
                ['asset:loaded', 'loaded'],
                ['load:complete', 'ready'],
                ['load:error', 'error'],
                ['model:loaded', 'modelLoaded'],
                ['scene:loading', 'scene.loading'],
                ['load:progress', 'scene.progress'],
                ['scene:loaded', 'scene.loaded'],
                ['scene:error', 'scene.error'],
                ['scene:model', 'scene.modelLoaded'],
                ['scene:env', 'scene.environmentLoaded'],
                ['camera.set_position', 'camera.set_position'],
                // 材质相关事件
                ['material:updated', 'material.updated'],
                ['material:error', 'material.error'],
                ['material:properties:updated', 'material.properties.updated'],
                ['material:downloaded', 'material.downloaded'],
                ['material:textureReplaced', 'material:textureReplaced'],
                // 模型点击事件
                ['mesh:click', 'mesh:click'],
                // mesh动画绑定相关事件（从engine.events转发）
                ['mesh:animation:bound', 'mesh:animation:bound'],
                ['mesh:animation:unbound', 'mesh:animation:unbound'],
                ['mesh:animation:updated', 'mesh:animation:updated'],
                ['mesh:animation:binding:clicked', 'mesh:animation:binding:clicked'],
                ['mesh:animation:clicked', 'mesh:animation:clicked'],
                ['mesh:animation:played', 'mesh:animation:played']
            ]},
            // animationController 事件
            { source: this.engine?.animationController?.events, events: [
                ['animations:loaded', 'animations:loaded'],
                ['animation:updated', 'animation:updated'],
                ['globalSettings:changed', 'globalSettings:changed'],
                // 动画完成事件转发
                ['animation:finished', 'animation.finished']
            ]},
            {
                source: this.engine?.hotspotController?.events, events: [
                    ['hotspot:added', 'hotspot:added'],
                    ['hotspot:updated', 'hotspot:updated'],
                    ['hotspot:removed', 'hotspot:removed'],
                    ['hotspot:selected', 'hotspot:selected'],
                    ['hotspot:cleared', 'hotspot:cleared'],
                    ['hotspot:click', 'hotspot:click'],
                    ['hotspot:camera:focus', 'hotspot:camera:focus'],
                    ['hotspot:attached', 'hotspot:attached']
                ]
            }
        ];

        // 统一设置事件代理
        eventProxies.forEach(proxy => {
            if (proxy.source) {
                proxy.events.forEach(([src, dest]) => {
                    proxy.source.on(src, data => {
                        this.events.emit(dest, data);
                    });
                });
            } else {
                console.warn(`F3dApp: 事件源不存在，跳过代理设置`);
            }
        });
    }

    // === 场景加载流式API ===

    /**
     * 创建场景构建器 - 流式API起点
     * @returns {Object} 场景构建器对象
     * @returns {Function} returns.addModel - 添加模型到场景
     * @returns {Function} returns.addEnvironment - 添加环境贴图到场景
     * @returns {Function} returns.autoStart - 设置是否自动开始
     * @returns {Function} returns.load - 加载场景并返回Promise
     */
    createScene() {
        // 重置场景配置
        this._sceneConfig = {
            models: [],
            environments: [],
            autoStart: true,
        };

        // 创建构建器对象
        const builder = {
            // 添加模型
            addModel: (url, options = {}) => {
                this._sceneConfig.models.push({ url, ...options });
                return builder;
            },

            // 添加环境贴图
            addEnvironment: (url, options = {}) => {
                this._sceneConfig.environments.push({ url, ...options });
                return builder;
            },

            // 设置是否自动开始
            autoStart: (value = true) => {
                this._sceneConfig.autoStart = value;
                return builder;
            },


            // 加载场景并返回Promise
            load: () => {
                return this.assets.loadScene(this._sceneConfig);
            }
        };

        return builder;
    }

    /**
     * 启动渲染循环
     * @returns {F3dApp} 返回当前实例，支持链式调用
     */
    start() {
        this.engine?.start();
        return this;
    }

    /**
     * 停止渲染循环
     * @returns {F3dApp} 返回当前实例，支持链式调用
     */
    stop() {
        this.engine?.stop();
        return this;
    }

    /**
     * 设置纯色背景
     * @param {number|string} color - 背景颜色，支持十六进制数字或CSS颜色字符串
     * @returns {F3dApp} 返回当前实例，支持链式调用
     */
    setBackgroundColor(color) {
        this.sceneLoader?.setColor(color);
        return this;
    }

    /**
     * 设置透明背景/恢复默认背景
     * @param {boolean} transparent 是否透明
     * @returns {F3dApp}
     */
    setTransparentBackground(transparent = true) {
        try {
            const container = this._getContainer();
            if (transparent) {
                // 清除DOM背景
                if (container) {
                    container.style.background = 'transparent';
                    container.style.backgroundImage = 'none';
                    container.style.backgroundColor = 'transparent';
                }
                // 清除场景背景
                if (this.sceneLoader && typeof this.sceneLoader._clearBackground === 'function') {
                    this.sceneLoader._clearBackground();
                }
                if (this.engine?.renderer?.setClearColor) {
                    this.engine.renderer.setClearColor(0x000000, 0);
                }
                if (this.engine?.mainScene) {
                    this.engine.mainScene.background = null;
                }
            } else {
                // 恢复为不透明默认背景（黑色）
                if (container) {
                    container.style.background = '#000000';
                    container.style.backgroundImage = 'none';
                }
                if (this.engine?.renderer?.setClearColor) {
                    this.engine.renderer.setClearColor(0x000000, 1);
                }
            }
        } catch (_) {}
        return this;
    }

    /**
     * 设置渐变背景
     * @param {number|string} topColor - 顶部颜色
     * @param {number|string} bottomColor - 底部颜色
     * @returns {F3dApp} 返回当前实例，支持链式调用
     */
    setGradientBackground(topColor, bottomColor) {
        this.sceneLoader?.setGradient(topColor, bottomColor);
        return this;
    }

    /**
     * 加载HDR环境贴图
     * @param {string} url - HDR文件URL
     * @param {Object} [options={}] - 加载选项
     * @param {string} [options.id=url] - 环境贴图ID
     * @param {number} [options.intensity=1.0] - 环境光强度
     * @param {boolean} [options.background=true] - 是否作为背景
     * @returns {Promise} 返回加载完成的Promise
     */
    loadEnvironment(url, options = {}) {
        const { id = url, intensity = 1.0, background = true } = options;

        return this.assets?.loadEnvironment(url, { id, intensity, background })
            .then(envMap => {
                this.environments.set(id, envMap);
                return envMap;
            });
    }

    /**
     * 切换HDR环境贴图（仅用于光照，不影响背景）
     * @param {string} url - HDR文件URL
     * @param {Object} [options={}] - 选项
     * @param {number} [options.intensity=1.0] - 环境光强度
     * @returns {Promise} 返回加载完成的Promise
     */
    switchEnvironment(url, options = {}) {
        const { intensity = 1.0 } = options;

        // 确保不影响背景设置
        return this.assets?.loadEnvironment(url, {
            id: url,
            intensity,
            background: false
        }).then(envMap => {
            this.environments.set(url, envMap);
            console.log('HDR环境贴图已切换，保持背景设置不变');
            return envMap;
        });
    }

    /**
     * 设置HDR环境光强度 (0-100)
     * @param {number} intensity HDR环境光强度
     */
    setHDRIntensity(intensity) {
        this.sceneLoader?.setEnvMapIntensity(intensity);
        return this;
    }

    /**
     * 加载3D模型
     * @param {string} url - 模型URL
     * @param {Object} options - 加载选项
     * @returns {Promise} 加载完成的Promise
     */
    loadModel(url, options = {}) {
        // 验证URL参数
        if (!url || typeof url !== 'string') {
            const error = new Error('无效的模型URL');
            this._handleError('无效的模型URL', error, 'model');
            return Promise.reject(error);
        }

        // 验证assets管理器是否存在
        if (!this.assets) {
            const error = new Error('资源管理器未初始化');
            this._handleError('资源管理器未初始化', error, 'model');
            return Promise.reject(error);
        }

        const {
            id = url,
            position,
            rotation,
            scale = 1,
            autoScale = true,
            alignToGround = true,
            rotate = false,
            rotateSpeed = 1
        } = options;

        return this.assets.loadModelToScene(url, {
            id,
            position,
            rotation,
            scale,
            autoScale,
            alignToGround
        }).then(model => {
            if (!model) {
                throw new Error('模型加载失败');
            }

            this.models.set(id, model);

            if (rotate && this.modelCtrl) {
                this.modelCtrl.setRotation(id, true, rotateSpeed);
            }

            // 自动注册动画（如果模型有动画）
            if (model.animations && model.animations.length > 0) {
                this.registerModelAnimation(id);
            }

            return model;
        }).catch(error => {
            this._handleError(`模型加载失败: ${url}`, error, 'model');
            throw error;
        });
    }

    /**
     * 获取模型
     * @param {string} id - 模型ID
     * @returns {Object|null} 模型对象，如果未找到则返回null
     */
    getModel(id) {
        return this.models.get(id) || this.assets?.getModel(id);
    }

    /**
     * 注册模型动画（手动触发动画控制器注册）
     * @param {string} modelId - 模型ID
     * @returns {boolean} 是否成功
     */
    registerModelAnimation(modelId) {
        const model = this.getModel(modelId);
        if (!model) {
            console.error('模型不存在:', modelId);
            return false;
        }
        
        if (!model.animations || model.animations.length === 0) {
            console.warn('模型没有动画:', modelId);
            return false;
        }
        
        if (this.animCtrl?.mixers?.has(modelId)) {
            console.log('动画已注册:', modelId);
            return true;
        }
        
        if (this.animCtrl?._setupModelAnimations) {
            this.animCtrl._setupModelAnimations(model, modelId);
            return true;
        }
        
        return false;
    }

    /**
     * 分割动画片段（按动画名称，返回片段名称）
     * @param {string} modelId - 模型ID
     * @param {string} animationName - 原始动画名称
     * @param {number} startTime - 开始时间（秒）
     * @param {number} endTime - 结束时间（秒）
     * @param {string} name - 片段名称（可选）
     * @returns {string|null} 分割后的动画名称
     */
    splitAnimation(modelId, animationName, startTime, endTime, name) {
        if (!this.animCtrl) return null;

        const segmentName = name || `${animationName}_${startTime}-${endTime}s`;
        const splitNames = this.animCtrl.splitByTime(
            modelId,
            animationName,
            [[startTime, endTime]],
            [segmentName]
        );

        if (splitNames.length === 0) return null;
        return splitNames[0];
    }

    /**
     * 批量分割动画片段（按动画名称，返回片段名称数组）
     * @param {string} modelId
     * @param {string} animationName - 原始动画名称
     * @param {Array<Array<number>>} timeRanges [[start,end],...]
     * @param {Array<string>} names 自定义名称列表
     * @returns {Array<string>} 分割后的动画名称数组
     */
    splitAnimations(modelId, animationName, timeRanges = [], names = []) {
        if (!this.animCtrl) return [];
        return this.animCtrl.splitByTime(modelId, animationName, timeRanges, names);
    }

    /**
     * 获取动画涉及的mesh
     * @param {string} modelId
     * @param {string} animationNameOrMeshId - 动画名称或mesh的userData.id
     * @returns {Array<{name:string,uuid:string,id:string,visible:boolean,mesh:THREE.Mesh}>}
     */
    getAnimationMeshes(modelId, animationNameOrMeshId) {
        if (!this._isAnimationControllerReady()) return [];
        return this.engine.animationController.getAnimationMeshes(modelId, animationNameOrMeshId);
    }

    /**
     * 获取指定动画相关的mesh id数组
     * @param {string} modelId 模型ID
     * @param {string} animationNameOrMeshId 动画名称或mesh的userData.id
     * @returns {Array<string>} mesh的userData.id数组
     */
    getAnimationMeshIds(modelId, animationNameOrMeshId) {
        if (!this._isAnimationControllerReady()) return [];
        return this.engine.animationController.getAnimationMeshIds(modelId, animationNameOrMeshId);
    }

    /**
     * 高亮动画相关的mesh（使用OutlinePass后处理）
     * @param {string} modelId 模型ID
     * @param {string} animationNameOrMeshId 动画名称或mesh的userData.id
     * @param {Object} options 选项 { color: 0xffffff, edgeStrength: 5.0, edgeGlow: 0.5, edgeThickness: 2.0 }
     */
    highlightAnimationMeshes(modelId, animationNameOrMeshId, options = {}) {
        if (!this._isAnimationControllerReady()) return;
        return this.engine.animationController.highlightAnimationMeshes(modelId, animationNameOrMeshId, options);
    }

    /**
     * 直接高亮指定的mesh（通过mesh的userData.id）
     * @param {string|Array<string>} meshIds mesh的userData.id（单个或数组）
     * @param {Object} options 选项 { color: 0xffffff, edgeStrength: 5.0, edgeGlow: 0.5, edgeThickness: 2.0 }
     * @returns {boolean} 是否成功
     */
    highlightMeshes(meshIds, options = {}) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.highlightMeshes(meshIds, options);
    }

    /**
     * 获取热点绑定的 meshId
     * @param {string} hotspotName 热点名字
     * @returns {string|null}
     */
    getHotspotTargetMeshId(hotspotName) {
        if (!this.engine?.hotspotController) return null;
        return this.engine.hotspotController.getHotspotTargetMeshId?.(hotspotName) || null;
    }

    /**
     * 清除所有动画mesh的高亮边框
     */
    clearAnimationMeshHighlights() {
        if (!this._isAnimationControllerReady()) return;
        return this.engine.animationController.clearAnimationMeshHighlights();
    }

    /**
     * 绑定动画到指定mesh（按动画名称）
     * @param {string} modelId
     * @param {string} meshIdentifier - mesh的userData.id、名称或UUID（优先使用userData.id）
     * @param {string} animationName
     * @param {Object} options 绑定选项 
     * @returns {boolean}
     */
    bindMeshAnimation(modelId, meshIdentifier, animationName, options = {}) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.bindMeshAnimation(modelId, meshIdentifier, animationName, options);
    }

    /**
     * 批量绑定动画到mesh
     * @param {Array<{modelId,mesh,animation,options}>} bindings
     * @returns {number} 成功数量
     */
    bindMeshAnimations(bindings = []) {
        if (!this._isAnimationControllerReady()) return 0;
        return this.engine.animationController.bindMeshAnimations(bindings);
    }

    /**
     * 更新已绑定动画的参数（不重新绑定）
     * @param {string} modelId
     * @param {string} meshIdentifier - mesh的userData.id、名称或UUID（优先使用userData.id）
     * @param {Object} options 部分参数
     * @returns {boolean}
     */
    updateMeshBinding(modelId, meshIdentifier, options = {}) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.updateMeshBinding(modelId, meshIdentifier, options);
    }

    /**
     * 获取模型的绑定列表
     * @param {string} modelId
     * @returns {Array}
     */
    getModelBindings(modelId) {
        if (!this._isAnimationControllerReady()) return [];
        return this.engine.animationController.getModelBindings(modelId);
    }

    /**
     * 获取mesh的绑定信息
     * @param {string} modelId - 模型ID
     * @param {string} meshIdentifier - mesh的userData.id、名称或UUID（优先使用userData.id）
     * @returns {Object|null} 绑定信息
     */
    getMeshBinding(modelId, meshIdentifier) {
        if (!this._isAnimationControllerReady()) return null;
        return this.engine.animationController.getMeshBinding(modelId, meshIdentifier);
    }

    /**
     * 解绑mesh和动画
     * @param {string} modelId - 模型ID
     * @param {string} meshIdentifier - mesh的userData.id、名称或UUID（优先使用userData.id）
     * @returns {boolean} 是否成功
     */
    unbindMeshAnimation(modelId, meshIdentifier) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.unbindMeshAnimation(modelId, meshIdentifier);
    }

    /**
     * 开始动画绑定模式：等待用户点击mesh来绑定动画
     * @param {string} clipUuid - 动画clip的UUID
     * @param {Object} options - 绑定选项（可选）
     * @returns {boolean} 是否成功进入绑定模式
     */
    startAnimationBinding(clipUuid, options = {}) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.startAnimationBinding(clipUuid, options);
    }

    /**
     * 取消动画绑定模式
     */
    cancelAnimationBinding() {
        if (!this._isAnimationControllerReady()) return;
        this.engine.animationController.cancelAnimationBinding();
    }

    /**
     * 播放动画片段（通过动画名称）
     * @param {string} modelId - 模型ID
     * @param {string} animationName - 动画名称（分割后的动画名称）
     * @param {Object} options - 播放选项 { playMode, loopType, loopCount, playDirectionType }
     * @returns {boolean} 是否成功
     */
    playClip(modelId, animationName, options = {}) {
        if (!this.animCtrl) return false;
        return this.animCtrl.playSplit(modelId, animationName, options);
    }

    /**
     * 暂停分割动画（通过分割动画ID或名称）
     * @param {string} modelId - 模型ID
     * @param {string} animationIdOrName - 分割动画ID或名称
     * @returns {boolean} 是否成功
     */
    pauseClip(modelId, animationIdOrName) {
        if (!this.animCtrl) return false;
        return this.animCtrl.pauseSplit(modelId, animationIdOrName);
    }

    /**
     * 继续播放分割动画（从暂停位置继续）
     * @param {string} modelId - 模型ID
     * @param {string} animationIdOrName - 分割动画ID或名称
     * @returns {boolean} 是否成功
     */
    resumeClip(modelId, animationIdOrName) {
        if (!this.animCtrl) return false;
        return this.animCtrl.resumeSplit(modelId, animationIdOrName);
    }

    /**
     * 重置分割动画（停止并时间归零）
     * @param {string} modelId - 模型ID
     * @param {string} animationIdOrName - 分割动画ID或名称
     * @returns {boolean} 是否成功
     */
    resetClip(modelId, animationIdOrName) {
        if (!this.animCtrl) return false;
        return this.animCtrl.resetSplit(modelId, animationIdOrName);
    }

    /**
     * 同时设置模型旋转开关与速度
     * @param {string} id - 模型ID
     * @param {boolean} enabled - 是否启用旋转
     * @param {number} speed - 旋转速度
     * @returns {boolean}
     */
    setModelRotationState(id, enabled, speed) {
        return this.modelCtrl?.setRotationState(id, enabled, speed);
    }

    /**
     * 设置相机自动旋转（围绕模型中心）
     */
    setCameraAutoRotate(enabled, speed = 1.0) {
        if (!this.engine?.editController) {
            console.warn('setCameraAutoRotate: 编辑控制器未初始化');
            return false;
        }
        this.engine.editController.setCameraAutoRotate(enabled, speed);
        return true;
    }

    /**
     * 获取相机自动旋转状态
     */
    getCameraAutoRotateState() {
        if (!this.engine?.editController) {
            return { enabled: false, speed: 1.0 };
        }
        return this.engine.editController.getCameraAutoRotate();
    }

    /**
     * 截取场景图片
     * @returns {Promise<string>} 返回包含图片数据URL的Promise
     */
    takeScreenshot() {
        return this.engine?.captureScreenshot();
    }

    /**
     * 添加更新回调
     * @param {string} key - 回调标识符
     * @param {Function} callback - 更新回调函数
     * @returns {F3dApp} 返回当前实例，支持链式调用
     */
    addUpdate(key, callback) {
        this.engine?.addUpdateCallback(key, callback);
        return this;
    }

    /**
     * 移除更新回调
     * @param {string} key - 回调标识符
     * @returns {F3dApp} 返回当前实例，支持链式调用
     */
    removeUpdate(key) {
        this.engine?.removeUpdateCallback(key);
        return this;
    }

    /**
     * 注册事件监听
     * @param {string} event - 事件名称
     * @param {Function} callback - 事件回调函数
     * @returns {Function} 返回取消监听的函数
     */
    on(event, callback) {
        return this.events.on(event, callback);
    }
    
    /**
     * 删除事件监听
     * @param {string} event - 事件名称
     * @param {Function} callback - 事件回调函数
     * @returns {boolean} 操作是否成功
     */
    off(event, callback) {
        return this.events.off(event, callback)
    }

    /**
     * 一次性事件监听
     * @param {string} event - 事件名称
     * @param {Function} callback - 事件回调函数
     * @returns {Function} 返回取消监听的函数
     */
    once(event, callback) {
        return this.events.once(event, callback)
    }



    /**
     * 发送信号执行功能
     * @param {string} event - 事件名称
     * @param {*} data - 事件数据
     * @returns {boolean} 事件是否被处理
     */
    emit(event, data) {
        return this.events.emit(event, data);
    }

    /**
     * 设置服务器材质信息（用于从外部注入，避免依赖全局变量）
     * @param {Array} serverMaterials - 服务器材质数组
     */
    setServerMaterials(serverMaterials) {
        if (this.assets && this.assets.materialLoader) {
            this.assets.materialLoader.setServerMaterials(serverMaterials);
        }
    }

    /**
     * 获取模型材质列表
     * @param {Object} model - 模型对象
     * @param {Array} serverMaterials - 可选的服务器材质数组（用于获取服务器UUID，如果不传则使用实例中保存的值）
     * @returns {Array} 材质列表
     */
    getMaterials(model, serverMaterials = null) {
        return this.assets.getMaterials(model, serverMaterials);
    }

    /**
     * 获取材质详细信息
     * @param {Object} model - 模型对象
     * @param {string} materialUuid - 材质UUID
     * @returns {Object} 材质详细信息
     */
    getMaterialDetails(model, materialUuid) {
        return this.assets.getMaterialDetails(model, materialUuid);
    }

    /**
     * 更新材质颜色
     * @param {Object} model - 模型对象
     * @param {string} materialUuid - 材质UUID
     * @param {string} colorType - 颜色类型
     * @param {number|string} colorValue - 颜色值
     * @returns {boolean} 操作是否成功
     */
    updateMaterialColor(model, materialUuid, colorType, colorValue) {
        return this.assets.updateMaterialColor(model, materialUuid, colorType, colorValue);
    }

    /**
     * 更新材质属性
     * @param {Object} model - 模型对象
     * @param {string} materialUuid - 材质UUID
     * @param {string} propertyName - 属性名称
     * @param {*} value - 属性值
     * @returns {boolean} 操作是否成功
     */
    updateMaterialProperty(model, materialUuid, propertyName, value) {
        return this.assets.updateMaterialProperty(model, materialUuid, propertyName, value);
    }

    /**
     * 更新材质布尔属性
     * @param {Object} model - 模型对象
     * @param {string} materialUuid - 材质UUID
     * @param {string} propertyName - 属性名称
     * @param {boolean} value - 布尔值
     * @returns {boolean} 操作是否成功
     */
    updateMaterialBooleanProperty(model, materialUuid, propertyName, value) {
        return this.assets.updateMaterialBooleanProperty(model, materialUuid, propertyName, value);
    }

    /**
     * 替换材质纹理
     * @param {Object} model - 模型对象
     * @param {string} materialUuid - 材质UUID
     * @param {string} mapType - 纹理类型
     * @param {string} textureSource - 纹理源（URL、路径或base64）
     * @returns {boolean} 操作是否成功
     */
    replaceMaterialTexture(model, materialUuid, mapType, textureSource) {
        return this.assets.replaceMaterialTexture(model, materialUuid, mapType, textureSource);
    }

    // 二进制纹理接口已移除，统一使用图片URL/本地路径/base64

    /**
     * 移除材质纹理
     * @param {Object} model - 模型对象
     * @param {string} materialUuid - 材质UUID
     * @param {string} textureType - 纹理类型
     * @returns {boolean} 操作是否成功
     */
    removeMaterialTexture(model, materialUuid, textureType) {
        return this.assets.removeMaterialTexture(model, materialUuid, textureType);
    }

    /**
     * 导出完整材质数据（包含纹理图片）
     * @param {Object} model - 模型对象
     * @returns {Promise<Object>} 返回包含材质数据的Promise
     */
    /**
     * 导出模型的完整材质数据（用于数据库存储）
     * @param {Object} model - 模型对象
     * @param {Array} serverMaterials - 可选的服务器材质数组（如果不传则使用实例中保存的值）
     * @returns {Object} 导出的材质数据
     */
    async exportMaterialsData(model, serverMaterials = null) {
        return await this.assets.exportMaterialsData(model, serverMaterials);
    }
    
    /**
     * 通过指定材质触发1秒高亮
     * @param {THREE.Material|string} material - 目标材质对象或材质名称
     * @param {THREE.Object3D} rootObject - 可选的根对象，如果不提供则使用主场景
     */
    highlightByMaterial(material, rootObject = null) {
        if (!this.engine || !this.engine.inputManager) {
            console.warn('highlightByMaterial: 引擎或输入管理器未初始化');
            return;
        }

        return this.engine.inputManager.highlightByMaterial(material, rootObject);
    }
    
    /**
     * 设置射线检测开关
     * @param {boolean} enabled - true启用射线检测，false禁用射线检测
     * @returns {void}
     */
    setRaycastEnabled(enabled) {
        if (!this.engine || !this.engine.inputManager) {
            console.warn('setRaycastEnabled: 引擎或输入管理器未初始化');
            return;
        }
        this.engine.inputManager.setRaycastEnabled(enabled);
    }

    /**
     * 设置动画播放功能开关
     * @param {boolean} enabled - true启用动画播放，false禁用动画播放
     * @returns {void}
     */
    setAnimationPlayEnabled(enabled) {
        if (!this.engine || !this.engine.inputManager) {
            console.warn('setAnimationPlayEnabled: 引擎或输入管理器未初始化');
            return;
        }
        this.engine.inputManager.setAnimationPlayEnabled(enabled);
    }

    /**
     * 设置点击播放动画模式
     * @param {string} [mode='first'] - 播放模式：'first' | 'all'
     * @returns {void}
     */
    setClickAnimationMode(mode = 'first') {
        if (!this.engine || !this.engine.inputManager) return;
        const allowed = mode === 'first' || mode === 'all' ? mode : 'first';
        this.engine.inputManager.clickPlayMode = allowed;
    }

    /**
     * 设置点击播放的默认参数
     * @param {Object} [options={}] - 动画播放选项
     * @returns {void}
     */
    setClickAnimationOptions(options = {}) {
        if (!this.engine || !this.engine.inputManager) return;
        this.engine.inputManager.clickPlayOptions = {
            ...this.engine.inputManager.clickPlayOptions,
            ...options
        };
    }

    /**
     * 获取动画播放功能状态
     * @returns {boolean} 是否启用动画播放
     */
    isAnimationPlayEnabled() {
        if (!this.engine || !this.engine.inputManager) {
            console.warn('isAnimationPlayEnabled: 引擎或输入管理器未初始化');
            return false;
        }
        return this.engine.inputManager.isAnimationPlayEnabled();
    }

    /**
     * 切换视锥体剔除
     * @param {boolean} enabled - true启用视锥体剔除，false禁用
     * @returns {void}
     */
    toggleFrustumCulling(enabled) {
        if (!this.engine) {
            console.warn('toggleFrustumCulling: 引擎未初始化');
            return;
        }
        this.engine.toggleFrustumCulling(enabled);
    }

    /**
     * 获取视锥体剔除统计信息
     * @returns {Object} 统计信息 {visible, total}
     */
    getFrustumCullingStats() {
        if (!this.engine) {
            console.warn('getFrustumCullingStats: 引擎未初始化');
            return { visible: 0, total: 0 };
        }
        return this.engine.cullingStats;
    }

    // ========== 动画控制接口 ==========
    
    /**
     * 检查动画控制器是否可用
     * @private
     * @returns {boolean} 是否可用
     */
    _isAnimationControllerReady() {
        if (!this.engine?.animationController) {
            console.warn('动画控制器未初始化');
            return false;
        }
        return true;
    }
    
    /**
     * 规范化动画选项（委托给AnimationController处理）
     * @private
     * @param {Object} options - 动画选项
     * @returns {Object} 规范化后的选项
     */
    _normalizeAnimationOptions(options = {}) {
        // 直接委托给AnimationController的参数处理方法
        if (this.engine?.animationController?._processTimeParams) {
            return this.engine.animationController._processTimeParams(options);
        }
        return options;
    }
    
    /**
     * 播放动画 - 完整接口
     * @param {string} animationName 动画名称
     * @param {string} modelId 模型ID
     * @param {Object} options 播放选项
     * @returns {boolean} 是否成功
     */
    playAnimation(animationName, modelId, options = {}) {
        if (!this._isAnimationControllerReady()) return false;
        
        // 使用默认参数并合并用户选项
        const defaultOptions = {
            speed: 1.0,
            playDirectionType: 1,
            loopModeType: 2,  // 默认循环播放
            loopCount: -1,    // 默认无限循环
            startDelayTime: 0,
            fadeInTime: 0,
            fadeOutTime: 0,
            baseWeight: 50,
            activeType: 1
        };
        
        const finalOptions = { ...defaultOptions, ...this._normalizeAnimationOptions(options) };
        // 若 activeType 显式为 0，确保 enabled 也为 false，下传到引擎层
        if (finalOptions.activeType === 0) {
            finalOptions.enabled = false;
        } else if (finalOptions.activeType === 1 && finalOptions.enabled === undefined) {
            finalOptions.enabled = true;
        }
        return this.engine.animationController.playAnimationByName(modelId, animationName, finalOptions);
    }

    
    /**
     * 停止动画
     * @param {string} animationName 动画名称
     * @param {string} modelId 模型ID
     * @returns {boolean} 是否成功
     */
    stopAnimation(animationName, modelId) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.stopAnimationByName(modelId, animationName);
    }
    
    /**
     * 停止所有动画
     * @param {string} modelId 模型ID
     * @returns {boolean} 是否成功
     */
    stopAllAnimations(modelId) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.stopAllAnimations(modelId);
    }


    /**
     * 立刻停止动画（无淡出）
     * @param {string} animationName - 动画名称
     * @param {string} modelId - 模型ID
     * @returns {boolean} 是否成功
     */
    stopAnimationNow(animationName, modelId) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.stopAnimationNowByName(modelId, animationName);
    }

    /**
     * 暂停动画
     * @param {string} animationName - 动画名称
     * @param {string} modelId - 模型ID
     * @returns {boolean} 是否成功
     */
    pauseAnimation(animationName, modelId) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.pauseAnimationByName(modelId, animationName);
    }

    /**
     * 继续动画
     * @param {string} animationName - 动画名称
     * @param {string} modelId - 模型ID
     * @returns {boolean} 是否成功
     */
    resumeAnimation(animationName, modelId) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.resumeAnimationByName(modelId, animationName);
    }
    
    /**
     * 设置动画参数 - 统一接口
     * @param {string} animationName 动画名称
     * @param {string} modelId 模型ID
     * @param {Object} params 参数对象
     * @returns {boolean} 是否成功
     */
    setAnimationParams(animationName, modelId, params) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.setAnimationParamsByName(modelId, animationName, this._normalizeAnimationOptions(params));
    }

    /**
     * 动态设置播放速度（不重启动画）
     */
    setSpeed(animationName, modelId, speed) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.setSpeedByName(modelId, animationName, speed);
    }

    /**
     * 设置播放形式（循环模式）- 统一接口
     * @param {string} animationName 动画名称
     * @param {string} modelId 模型ID
     * @param {number} loopModeType 循环类型 1..5
     * @param {number} [loopCount=1] 循环次数
     */
    setLoopMode(animationName, modelId, loopModeType, loopCount = 1) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.setLoopModeByName(modelId, animationName, loopModeType, loopCount);
    }

    /**
     * 为当前模型全部动画设置播放形式（循环模式）
     * @param {string} modelId 模型ID
     * @param {number} loopModeType 循环类型 1..5
     * @param {number} [loopCount=1] 循环次数
     */
    setAllLoopMode(modelId, loopModeType, loopCount = 1) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.setAllLoopMode(modelId, loopModeType, loopCount);
    }

    /**
     * 启用/停用动画（按名称）
     * @param {string} animationName 动画名称
     * @param {string} modelId 模型ID
     * @param {boolean} enabled 是否启用
     * @returns {boolean} 是否成功
     */
    setAnimationEnabled(animationName, modelId, enabled) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.setAnimationParamsByName(modelId, animationName, { enabled });
    }
    
    /**
     * 获取动画列表
     * @param {string} modelId 模型ID
     * @returns {Array} 动画列表
     */
    getAnimationList(modelId) {
        if (!this._isAnimationControllerReady()) return [];
        return this.engine.animationController.getModelAnimations(modelId);
    }
    
    /**
     * 获取动画状态
     * @param {string} animationName 动画名称
     * @param {string} modelId 模型ID
     * @returns {Object|null} 动画状态
     */
    getAnimationStatus(animationName, modelId) {
        if (!this._isAnimationControllerReady()) return null;
        return this.engine.animationController.getAnimationStatusByName(modelId, animationName);
    }
    
    
    /**
     * 播放所有动画
     * @param {string} modelId 模型ID
     * @param {Object} options 播放选项
     * @returns {boolean} 是否成功
     */
    playAllAnimations(modelId, options = {}) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.playAllAnimations(modelId, this._normalizeAnimationOptions(options));
    }
    
    /**
     * 设置全局动画设置
     * @param {Object} settings 全局设置
     * @returns {boolean} 是否成功
     */
    setAnimationGlobalSettings(settings) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.setGlobalSettings(settings);
    }
    
    /**
     * 获取全局动画设置
     * @returns {Object|null} 全局设置
     */
    getAnimationGlobalSettings() {
        if (!this._isAnimationControllerReady()) return null;
        return this.engine.animationController.getGlobalSettings();
    }

    /**
     * 设置点击mesh触发动画播放的开关
     * @param {boolean} enabled - true启用点击mesh触发动画播放，false禁用
     * @returns {boolean} 是否成功
     */
    setClickMeshPlayAnimationEnabled(enabled) {
        if (!this._isAnimationControllerReady()) return false;
        return this.engine.animationController.setGlobalSettings({ clickMeshPlayAnimationEnabled: enabled });
    }

    /**
     * 获取点击mesh触发动画播放的状态
     * @returns {boolean} 是否启用点击mesh触发动画播放
     */
    isClickMeshPlayAnimationEnabled() {
        if (!this._isAnimationControllerReady()) return false;
        const settings = this.engine.animationController.getGlobalSettings();
        return settings?.clickMeshPlayAnimationEnabled ?? true; // 默认返回true
    }

    

    /**
     * 获取模型动画列表（兼容性方法）
     * @param {string} modelId - 模型ID
     * @returns {Array} 动画列表
     */
    getModelAnimations(modelId) {
        return this.getAnimationList(modelId);
    }

    /**
     * 获取模型中的所有mesh信息（默认只返回可见的mesh）
     * @param {string} modelId - 模型ID
     * @param {Object} options - 选项 { onlyVisible: true, hasMaterial: true }
     * @returns {Array} mesh信息数组 [{name, uuid, hasBinding, visible, ...}]
     */
    getModelMeshes(modelId, options = {}) {
        if (!this._isAnimationControllerReady()) return [];
        return this.engine.animationController.getModelMeshes(modelId, options);
    }

    /**
     * 点击模型监听事件接口
     * @param {Function} callback - 点击回调函数
     * @returns {Function} 返回取消监听的函数
     */
    onModelClick(callback) {
        if (!this.engine || !this.engine.inputManager) {
            console.warn('onModelClick: 引擎或输入管理器未初始化');
            return () => {};
        }

        // 确保射线检测开启
        this.engine.inputManager.setRaycastEnabled(true);

        // 转发到统一事件总线并回调
        const handler = (data) => {
            this.events.emit('model.click', data);
            if (typeof callback === 'function') callback(data);
        };

        this.on('mesh:click', handler);

        return () => {
            this.off('mesh:click', handler);
        };
    }



    /************************** 热点接口部分********************** */
    /**
     * 添加热点
     */
    addHotspot(opts = {}) {
        if(!this.engine?.hotspotController) {
            console.warn('addHotspot: 热点控制器未初始化');
            return null;
        }
        return this.engine.hotspotController.add(opts);
    }

    //删除热点
    removeHotspot(id) {
        if(!this.engine?.hotspotController) {
            console.warn('removeHotspot: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.remove(id);
    }

    //更新热点
    updateHotspot(id, opts) {
        if(!this.engine?.hotspotController) {
            console.warn('updateHotspot: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.updateHotspot(id, opts);
    }

    //设置热点大小
    setHotspotSize(id, size) {
        if(!this.engine?.hotspotController) {
            console.warn('setHotspotSize: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.updateHotspot(id, { size });
    }

    //获取热点位置
    getHotspotPosition(id) {
        if(!this.engine?.hotspotController) {
            console.warn('getHotspotPosition: 热点控制器未初始化');
            return null;
        }
        return this.engine.hotspotController.getHotspotPosition(id);
    }

    /**
     * 获取热点四元数（旋转信息，用于服务器存储）
     */
    getHotspotQuaternion(id) {
        if(!this.engine?.hotspotController) {
            console.warn('getHotspotQuaternion: 热点控制器未初始化');
            return null;
        }
        return this.engine.hotspotController.getHotspotQuaternion(id);
    }

    /**
     * 设置热点四元数（从服务器加载时使用）
     */
    setHotspotQuaternion(id, quaternion) {
        if(!this.engine?.hotspotController) {
            console.warn('setHotspotQuaternion: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.setHotspotQuaternion(id, quaternion);
    }

    /**
     * 获取热点法向量（世界空间，用于服务器存储）
     */
    getHotspotWorldNormal(id) {
        if(!this.engine?.hotspotController) {
            console.warn('getHotspotWorldNormal: 热点控制器未初始化');
            return null;
        }
        return this.engine.hotspotController.getHotspotWorldNormal(id);
    }

    /**
     * 设置热点法向量（从服务器加载时使用）
     */
    setHotspotWorldNormal(id, normal) {
        if(!this.engine?.hotspotController) {
            console.warn('setHotspotWorldNormal: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.setHotspotWorldNormal(id, normal);
    }

    /**
     * 获取热点旋转（欧拉角，度数，用于UI显示）
     */
    getHotspotRotation(id) {
        if(!this.engine?.hotspotController) {
            console.warn('getHotspotRotation: 热点控制器未初始化');
            return null;
        }
        return this.engine.hotspotController.getHotspotRotation(id);
    }

    /**
     * 设置热点旋转（欧拉角，度数，用于UI编辑）
     */
    setHotspotRotation(id, rotation) {
        if(!this.engine?.hotspotController) {
            console.warn('setHotspotRotation: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.setHotspotRotation(id, rotation);
    }

    /**
     * 增量旋转热点（基于当前旋转，避免欧拉角范围限制问题）
     */
    rotateHotspotBy(id, deltaRotation) {
        if(!this.engine?.hotspotController) {
            console.warn('rotateHotspotBy: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.rotateHotspotBy(id, deltaRotation);
    }

    /**
     * 获取当前选中的热点信息
     */
    getSelectedHotspot() {
        if(!this.engine?.hotspotController) {
            return null;
        }
        return this.engine.hotspotController.getSelectedHotspot();
    }

    //设置热点相机聚焦是否启用
    setHotspotCameraFocusEnabled(enabled) {
        if(!this.engine?.hotspotController) {
            console.warn('setHotspotCameraFocusEnabled: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.setCameraFocusEnabled(enabled);
    }

    //聚焦相机到热点
    focusCameraOnHotspot(hotspotId, options = {}) {
        if(!this.engine?.hotspotController) {
            console.warn('focusCameraOnHotspot: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.focusCameraOnHotspot(hotspotId, options);
    }

    //热点高亮接口
    highlightHotspot(id, highlighted = true) {
        if(!this.engine?.hotspotController) {
            console.warn('highlightHotspot: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.highlightHotspot(id, highlighted);
    }

    /**
     * 更新热点图标和序列帧参数
     */
    updateHotspotIcon(id, options = {}) {
        if(!this.engine?.hotspotController) {
            console.warn('updateHotspotIcon: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.updateHotspotIcon(id, options);
    }

    /**
     * 统一更新热点标签（文本、位置、对齐、显示状态）
     */
    updateHotspotLabel(id, options = {}) {
        if(!this.engine?.hotspotController) {
            console.warn('updateHotspotLabel: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.updateHotspotLabel(id, options);
    }

    /**
     * 切换热点渲染类型
     * @param {string} id - 热点ID
     * @param {number} newType - 新类型 1=Sprite(朝向相机), 2=Mesh(固定朝向)
     */
    switchHotspotType(id, newType) {
        if(!this.engine?.hotspotController) {
            console.warn('switchHotspotType: 热点控制器未初始化');
            return false;
        }
        return this.engine.hotspotController.switchHotspotType(id, newType);
    }

    /**
     * 锁定/解锁场景交互（旋转、缩放、平移）
     */
    setSceneInteractionLocked(locked = true) {
        if(!this.engine?.hotspotController) {
            console.warn('setSceneInteractionLocked: 热点控制器未初始化');
            return this;
        }
        this.engine.hotspotController.setInteractionLocked(locked);
        return this;
    }


    /**
     * 查询场景交互是否被锁定
     */
    isSceneInteractionLocked() {
        if(!this.engine?.hotspotController) {
            return false;
        }
        return this.engine.hotspotController.isInteractionLocked();
    }

    /**
     * 显示/隐藏所有热点
     */
    setAllHotspotsVisible(visible = true) {
        if(!this.engine?.hotspotController) {
            console.warn('setAllHotspotsVisible: 热点控制器未初始化');
            return this;
        }
        this.engine.hotspotController.setAllVisible(visible);
        return this;
    }

    /**
     * 进入 AR 模式
     * @param {Object} options - AR 选项
     * @returns {Promise<boolean>} 是否成功启动 AR
     */
    async enterAR(options = {}) {
        if (!this.xrCtrl) {
            const error = new Error('XR 控制器未初始化');
            console.error('enterAR:', error);
            this._handleError('XR 控制器未初始化', error, 'ar');
            return false;
        }

        try {
            const success = await this.xrCtrl.startAR(options);
            if (success) {
                this.events.emit('ar:started');
                console.log('AR 模式已启动');
            } else {
                console.warn('AR 启动失败');
            }
            return success;
        } catch (error) {
            console.error('enterAR 错误:', error);
            this._handleError('启动 AR 失败', error, 'ar');
            return false;
        }
    }

    /**
     * 退出 AR 模式
     * @returns {Promise<void>}
     */
    async exitAR() {
        if (!this.xrCtrl) {
            console.warn('XR 控制器未初始化');
            return;
        }

        try {
            await this.xrCtrl.endSession();
            this.events.emit('ar:ended');
            console.log('AR 模式已退出');
        } catch (error) {
            console.error('exitAR 错误:', error);
            this._handleError('退出 AR 失败', error, 'ar');
        }
    }

    /**
     * 释放资源
     * @returns {void}
     */
    dispose() {
        this.models.clear();
        this.environments.clear();
        this.engine?.dispose();
        this.engine = null;

        this.scene = null;
        this.camera = null;
        this.assets = null;
        this.modelCtrl = null;
        this.sceneLoader = null;
    }
}

/**
 * 创建引擎应用实例
 * @param {Object} config - 配置选项
 * @returns {F3dApp} 返回F3dApp实例
 */
export const createApp = config => new F3dApp(config);