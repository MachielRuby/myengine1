/**
 * WebXR AR 控制器 - 管理 AR 会话和交互
 * @author AGan
 * @version 1.0
 */

import {
    Vector3,
    Matrix4,
    Group,
    Object3D,
    Quaternion,
    RingGeometry,
    CircleGeometry,
    MeshBasicMaterial,
    Mesh,
    MeshStandardMaterial
} from "three";
import { EventBus } from "../core/events/eventEmitter.js";

export class XRController {
    constructor(engine) {
        this.engine = engine;
        this.renderer = engine?.renderer;
        this.scene = engine?.mainScene;
        this.camera = engine?.camera;

        // WebXR AR 状态
        this.session = null;
        this.isPresenting = false;
        
        // 事件总线
        this.events = new EventBus();
        
        // 控制器相关
        this.controllers = new Map(); // inputSource -> controller group
        this.controllerGrips = new Map(); // inputSource -> grip group
        
        // AR 相关
        this.hitTestSource = null;
        this.hitTestSourceRequested = false;
        this.referenceSpace = null; 
        this.viewerSpace = null;
        this.reticle = null; // 十字星对象
        this.currentHitMatrix = null; // 当前命中测试的矩阵
        this._hasHitTestResult = false; // 是否有 hit-test 结果
        
        // 锚点管理
        this.anchors = new Map(); // anchor -> Object3D
        this.anchoredObjects = new Map(); // Object3D -> anchor (反向映射)
        
        // 手部追踪
        this.handTrackingEnabled = false;
        this.hands = new Map(); // inputSource -> hand data
        
        // 配置选项
        this.config = {
            // AR 会话配置
            sessionOptions: {
                requiredFeatures: ['hit-test'],
                optionalFeatures: ['dom-overlay', 'light-estimation', 'anchors', 'hand-tracking', 'plane-detection']
            },
            // DOM 覆盖层配置
            domOverlay: null,
            // 控制器可视化
            showControllers: true,
            // 命中测试配置
            hitTestOptions: {
                space: null,
                offsetRay: null
            }
        };
        
        // 临时变量
        this._tempMatrix = new Matrix4();
        this._tempVector = new Vector3();
        this._tempQuaternion = new Quaternion();
        
        // 绑定方法
        this._onSessionEnd = this._onSessionEnd.bind(this);
        this._onInputSourcesChange = this._onInputSourcesChange.bind(this);
        this._onSelectStart = this._onSelectStart.bind(this);
        this._onSelectEnd = this._onSelectEnd.bind(this);
        this._onSelect = this._onSelect.bind(this);
        this._onSqueezeStart = this._onSqueezeStart.bind(this);
        this._onSqueezeEnd = this._onSqueezeEnd.bind(this);
        this._onSqueeze = this._onSqueeze.bind(this);
    }

    // ==================== 基础功能 ====================

    /**
     * 检查 WebXR 是否可用
     * @returns {boolean}
     */
    isAvailable() {
        return 'xr' in navigator;
    }

    /**
     * 检查是否支持 AR
     * @returns {Promise<boolean>}
     */
    async isARSupported() {
        if (!this.isAvailable()) return false;
        try {
            return await navigator.xr.isSessionSupported('immersive-ar');
        } catch (e) {
            console.warn('XRController: 检查 AR 支持失败:', e);
            return false;
        }
    }

    /**
     * 获取当前会话状态
     * @returns {Object} { isPresenting, session }
     */
    getSessionState() {
        return {
            isPresenting: this.isPresenting,
            session: this.session
        };
    }

    // ==================== AR 功能 ====================

    /**
     * 启动 AR 会话
     * @param {Object} options - 会话选项
     * @param {Array<string>} options.requiredFeatures - 必需特性
     * @param {Array<string>} options.optionalFeatures - 可选特性
     * @param {Object} options.domOverlay - DOM 覆盖层配置
     * @returns {Promise<boolean>}
     */
    async startAR(options = {}) {
        if (this.isPresenting) {
            console.warn('XRController: 已有活跃会话');
            return false;
        }

        // 检查 WebXR 是否可用
        if (!this.isAvailable()) {
            const error = new Error('浏览器不支持 WebXR API。请使用 Chrome Android 或 Safari iOS');
            console.error('XRController:', error.message);
            this.events.emit('xr:error', { message: error.message, mode: 'ar', error });
            throw error;
        }

        // 检查渲染器是否支持 XR
        if (!this.renderer || !this.renderer.xr) {
            const error = new Error('渲染器不支持 XR。请确保使用 WebGLRenderer');
            console.error('XRController:', error.message);
            this.events.emit('xr:error', { message: error.message, mode: 'ar', error });
            throw error;
        }

        // 检查 AR 支持
        let isARSupported = false;
        try {
            isARSupported = await this.isARSupported();
        } catch (e) {
            const error = new Error(`检查 AR 支持时出错: ${e.message}`);
            console.error('XRController:', error.message, e);
            this.events.emit('xr:error', { message: error.message, mode: 'ar', error: e });
            throw error;
        }

        if (!isARSupported) {
            const error = new Error('设备不支持 AR 模式。请确保：1) 使用支持的浏览器（Chrome Android 或 Safari iOS）2) 设备支持 AR 功能 3) 通过 HTTPS 或 localhost 访问');
            console.error('XRController:', error.message);
            this.events.emit('xr:error', { message: error.message, mode: 'ar', error });
            throw error;
        }

        try {
            const sessionOptions = {
                requiredFeatures: options.requiredFeatures || this.config.sessionOptions.requiredFeatures,
                optionalFeatures: options.optionalFeatures || this.config.sessionOptions.optionalFeatures
            };

            if (options.domOverlay?.root || this.config.domOverlay?.root) {
                sessionOptions.domOverlay = options.domOverlay || this.config.domOverlay;
            }

            console.log('XRController: 正在请求 AR 会话，配置:', sessionOptions);
            const session = await navigator.xr.requestSession('immersive-ar', sessionOptions);
            console.log('XRController: AR 会话已创建，会话信息:', {
                mode: session.mode,
                enabledFeatures: session.enabledFeatures,
                inputSources: session.inputSources?.length || 0
            });
            
            // 初始化会话，如果失败会抛出错误
            const success = await this._initializeSession(session);
            if (!success) {
                throw new Error('会话初始化返回 false，但未抛出错误');
            }
            return success;
        } catch (e) {
            // 提供更详细的错误信息
            let errorMessage = '启动 AR 失败';
            if (e.name === 'SecurityError') {
                errorMessage = '安全错误：请确保通过 HTTPS 或 localhost 访问，并且用户手势触发了请求';
            } else if (e.name === 'NotSupportedError') {
                errorMessage = '不支持 AR：设备或浏览器不支持 immersive-ar 模式';
            } else if (e.name === 'InvalidStateError') {
                errorMessage = '无效状态：可能已有活跃的 XR 会话';
            } else if (e.message) {
                errorMessage = `启动 AR 失败: ${e.message}`;
            }
            
            console.error('XRController: 启动 AR 失败:', {
                name: e.name,
                message: e.message,
                stack: e.stack,
                error: e
            });
            
            const error = new Error(errorMessage);
            error.originalError = e;
            this.events.emit('xr:ar:error', { message: errorMessage, error: e });
            throw error;
        }
    }

    /**
     * 初始化命中测试
     * @param {Object} options - 选项
     * @returns {Promise<boolean>}
     */
    async initializeHitTest(options = {}) {
        if (!this.session) {
            console.warn('XRController: 需要 AR 会话才能初始化命中测试');
            return false;
        }

        if (this.hitTestSource) {
            return true; // 已经初始化
        }

        try {
            // 优先使用 viewer 空间进行 hit-test（参考 React Three XR 的实现）
            // viewer 空间是相对于设备相机的空间，更适合 hit-test
            let space = options.space;
            
            if (!space) {
                // 如果没有指定空间，尝试使用 viewer 空间
                if (!this.viewerSpace && this.session) {
                    try {
                        this.viewerSpace = await this.session.requestReferenceSpace('viewer');
                        console.log('XRController: 已创建 viewer 空间用于 hit-test');
                    } catch (e) {
                        console.warn('XRController: 无法创建 viewer 空间，使用 referenceSpace:', e);
                        this.viewerSpace = this.referenceSpace;
                    }
                }
                space = this.viewerSpace || this.referenceSpace;
            }
            
            if (!space) {
                console.error('XRController: 无法获取参考空间');
                return false;
            }

            // 使用 viewer 空间进行 hit-test（React Three XR 的推荐方式）
            const hitTestOptions = {
                space: space
            };

            this.hitTestSource = await this.session.requestHitTestSource(hitTestOptions);
            this.hitTestSourceRequested = true;
            
            console.log('XRController: 命中测试已初始化（使用 viewer 空间）');
            this.events.emit('xr:hit-test:initialized');
            return true;
        } catch (e) {
            console.warn('XRController: 初始化命中测试失败（将使用降级模式）:', e);
            // 命中测试失败不是致命错误，可以使用相机前方位置
            this.events.emit('xr:hit-test:failed', { error: e });
            return false;
        }
    }

    /**
     * 执行命中测试
     * @param {XRFrame} frame - XR 帧
     * @param {XRSpace} space - 参考空间（可选）
     * @returns {XRHitTestResult[]|null}
     */
    getHitTestResults(frame, space = null) {
        if (!this.hitTestSource || !frame) return null;
        
        const hitTestSpace = space || this.viewerSpace || this.referenceSpace;
        if (!hitTestSpace) return null;

        try {
            const hitTestResults = frame.getHitTestResults(this.hitTestSource);
            return Array.from(hitTestResults);
        } catch (e) {
            console.warn('XRController: 获取命中测试结果失败:', e);
            return null;
        }
    }

    /**
     * 创建锚点
     * @param {XRHitTestResult} hitTestResult - 命中测试结果
     * @param {Object3D} object - 要锚定的对象
     * @returns {Promise<XRAnchor|null>}
     */
    async createAnchor(hitTestResult, object) {
        if (!this.session || !this.session.createAnchor) {
            console.warn('XRController: 会话不支持创建锚点');
            return null;
        }

        if (!hitTestResult || !object) {
            console.warn('XRController: 需要命中测试结果和对象');
            return null;
        }

        try {
            const anchor = await this.session.createAnchor(
                hitTestResult.getPose(this.referenceSpace),
                this.referenceSpace
            );

            this.anchors.set(anchor, object);
            this.events.emit('xr:anchor:created', { anchor, object });
            return anchor;
        } catch (e) {
            console.error('XRController: 创建锚点失败:', e);
            return null;
        }
    }

    /**
     * 删除锚点
     * @param {XRAnchor} anchor - 锚点
     */
    deleteAnchor(anchor) {
        if (!anchor) return;
        
        const object = this.anchors.get(anchor);
        if (object) {
            this.anchors.delete(anchor);
            this.events.emit('xr:anchor:deleted', { anchor, object });
        }
        
        try {
            anchor.delete();
        } catch (e) {
            console.warn('XRController: 删除锚点失败:', e);
        }
    }

    // ==================== 会话管理 ====================

    /**
     * 停止当前会话
     * @returns {Promise<void>}
     */
    async stop() {
        if (!this.session) return;

        try {
            await this.session.end();
        } catch (e) {
            console.error('XRController: 停止会话失败:', e);
        }
    }

    /**
     * 初始化会话（内部方法）
     * @private
     * @param {XRSession} session - XR 会话
     * @returns {Promise<boolean>}
     */
    async _initializeSession(session) {
        try {
            this.session = session;

            // 检查渲染器 XR 支持
            if (!this.renderer.xr || typeof this.renderer.xr.setSession !== 'function') {
                throw new Error('渲染器不支持 XR.setSession');
            }

            const referenceSpaceTypes = ['local', 'local-floor', 'bounded-floor', 'unbounded'];
            let referenceSpaceInitialized = false;
            let selectedSpaceType = null;
            
            for (const spaceType of referenceSpaceTypes) {
                try {
                    console.log(`XRController: 尝试请求参考空间类型: ${spaceType}`);
                    this.referenceSpace = await session.requestReferenceSpace(spaceType);
                    selectedSpaceType = spaceType;
                    console.log(`XRController: 成功使用参考空间类型: ${spaceType}`);
                    referenceSpaceInitialized = true;
                    break;
                } catch (e) {
                    console.warn(`XRController: 参考空间类型 ${spaceType} 不支持:`, e.message);
                    // 继续尝试下一个类型
                }
            }
            
            if (!referenceSpaceInitialized) {
                throw new Error(`设备不支持任何可用的参考空间类型。尝试的类型: ${referenceSpaceTypes.join(', ')}`);
            }

            try {
                if (this.renderer.xr.setReferenceSpaceType) {
                    this.renderer.xr.setReferenceSpaceType(selectedSpaceType);
                    console.log(`XRController: 设置渲染器参考空间类型为: ${selectedSpaceType}`);
                } else {
                    console.warn('XRController: 渲染器不支持 setReferenceSpaceType，使用默认设置');
                }
                
                // 设置会话
                await this.renderer.xr.setSession(session);
                console.log('XRController: 渲染器 XR 会话已设置');
                
                // 验证 Three.js 使用的参考空间是否与我们请求的一致
                if (this.renderer.xr.getReferenceSpace) {
                    const rendererSpace = this.renderer.xr.getReferenceSpace();
                    if (rendererSpace) {
                        console.log('XRController: 渲染器参考空间已确认');
                        // 如果 Three.js 创建了自己的参考空间，使用它
                        if (!this.referenceSpace || rendererSpace !== this.referenceSpace) {
                            console.log('XRController: 使用渲染器创建的参考空间');
                            this.referenceSpace = rendererSpace;
                        }
                    }
                }
            } catch (e) {
                // 如果设置会话失败，尝试不同的参考空间类型
                if (e.message && (e.message.includes('reference space') || e.message.includes('ReferenceSpace'))) {
                    console.warn('XRController: 设置会话时出现参考空间错误，尝试其他参考空间类型');
                    
                    // 尝试其他参考空间类型
                    const fallbackTypes = referenceSpaceTypes.filter(t => t !== selectedSpaceType);
                    let fallbackSuccess = false;
                    
                    for (const fallbackType of fallbackTypes) {
                        try {
                            console.log(`XRController: 尝试降级到参考空间类型: ${fallbackType}`);
                            this.referenceSpace = await session.requestReferenceSpace(fallbackType);
                            
                            if (this.renderer.xr.setReferenceSpaceType) {
                                this.renderer.xr.setReferenceSpaceType(fallbackType);
                            }
                            
                            await this.renderer.xr.setSession(session);
                            console.log(`XRController: 使用 ${fallbackType} 参考空间成功`);
                            fallbackSuccess = true;
                            selectedSpaceType = fallbackType;
                            break;
                        } catch (e2) {
                            console.warn(`XRController: ${fallbackType} 也失败:`, e2.message);
                        }
                    }
                    
                    if (!fallbackSuccess) {
                        throw new Error(`设置渲染器 XR 会话失败: ${e.message}。所有参考空间类型都尝试失败`);
                    }
                } else {
                    throw new Error(`设置渲染器 XR 会话失败: ${e.message}`);
                }
            }
            
            // 创建 viewer 空间（用于命中测试）
            try {
                this.viewerSpace = await this.referenceSpace.getOffsetReferenceSpace(
                    new XRRigidTransform({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 })
                );
            } catch (e) {
                console.warn('XRController: 创建 viewer 空间失败，使用 referenceSpace:', e);
                this.viewerSpace = this.referenceSpace;
            }

            // 绑定会话事件
            session.addEventListener('end', this._onSessionEnd);
            session.addEventListener('inputsourceschange', this._onInputSourcesChange);

            // 初始化控制器
            this._setupControllers(session.inputSources);

            // 初始化 AR 功能
            try {
                await this.initializeHitTest();
                console.log('XRController: 命中测试已初始化');
            } catch (e) {
                console.warn('XRController: 初始化命中测试失败（非致命）:', e);
                // 命中测试失败不是致命错误，继续执行
            }

            // 创建十字星（用于显示可放置位置）
            this._createReticle();
            
            // 设置点击事件监听（点击时直接放置模型）
            this._setupClickHandler();

            // 设置 Three.js XR 渲染循环
            if (this.renderer && this.renderer.setAnimationLoop) {
                this.renderer.setAnimationLoop((time, frame) => {
                    if (frame) {
                        // 在AR模式下，调用update方法更新十字星和锚点
                        this.update(frame);
                    }
                });
                console.log('XRController: XR 渲染循环已设置');
            } else {
                console.warn('XRController: 渲染器不支持 setAnimationLoop');
            }

            this.isPresenting = true;
            this.events.emit('xr:ar:started', { session });
            console.log('XRController: AR 会话初始化完成');

            return true;
        } catch (e) {
            console.error('XRController: 初始化会话失败:', {
                name: e.name,
                message: e.message,
                stack: e.stack,
                error: e
            });
            
            // 清理会话
            this.session = null;
            this.referenceSpace = null;
            this.viewerSpace = null;
            
            // 抛出错误，让调用者知道具体原因
            const error = new Error(`初始化 AR 会话失败: ${e.message || '未知错误'}`);
            error.originalError = e;
            this.events.emit('xr:ar:error', { message: error.message, error: e });
            throw error;
        }
    }

    /**
     * 会话结束处理（内部方法）
     * @private
     */
    _onSessionEnd() {
        this.isPresenting = false;
        
        // 恢复正常的渲染循环
        if (this.renderer && this.renderer.setAnimationLoop) {
            this.renderer.setAnimationLoop(null);
            console.log('XRController: 已恢复正常渲染循环');
        }
        
        // 清理
        this._cleanup();
        
        this.events.emit('xr:ar:ended');
    }

    /**
     * 清理资源（内部方法）
     * @private
     */
    _cleanup() {
        // 清理控制器
        this.controllers.forEach((controller, inputSource) => {
            this._removeController(inputSource);
        });
        this.controllers.clear();
        this.controllerGrips.clear();

        // 清理命中测试
        if (this.hitTestSource) {
            this.hitTestSource.cancel();
            this.hitTestSource = null;
        }
        this.hitTestSourceRequested = false;

        // 清理锚点
        this.anchors.forEach((object, anchor) => {
            try {
                anchor.delete();
            } catch (e) {
                console.warn('XRController: 清理锚点失败:', e);
            }
        });
        this.anchors.clear();
        this.anchoredObjects.clear();

        // 清理十字星
        if (this.reticle) {
            this.scene.remove(this.reticle);
            this.reticle.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
            });
            this.reticle = null;
        }
        
        this.currentHitMatrix = null;
        
        // 移除点击监听器
        if (this._clickHandler && this.renderer && this.renderer.domElement) {
            this.renderer.domElement.removeEventListener('click', this._clickHandler);
            this._clickHandler = null;
        }

        // 清理手部追踪
        this.hands.clear();

        // 清理引用
        this.session = null;
        this.referenceSpace = null;
        this.viewerSpace = null;
    }

    // ==================== 控制器管理 ====================

    /**
     * 设置控制器（内部方法）
     * @private
     * @param {XRInputSourceArray} inputSources - 输入源数组
     */
    _setupControllers(inputSources) {
        for (const inputSource of inputSources) {
            this._addController(inputSource);
        }
    }

    /**
     * 添加控制器（内部方法）
     * @private
     * @param {XRInputSource} inputSource - 输入源
     */
    _addController(inputSource) {
        if (this.controllers.has(inputSource)) return;

        const controller = this.renderer.xr.getController(0);
        const controllerGrip = this.renderer.xr.getControllerGrip(0);

        // 创建控制器组
        const controllerGroup = new Group();
        controllerGroup.add(controller);
        if (this.config.showControllers && controllerGrip) {
            controllerGroup.add(controllerGrip);
        }

        this.scene.add(controllerGroup);

        // 绑定事件
        controller.addEventListener('connected', (event) => {
            this.events.emit('xr:controller:connected', { inputSource, controller: event.data });
        });

        controller.addEventListener('disconnected', (event) => {
            this.events.emit('xr:controller:disconnected', { inputSource, controller: event.data });
        });

        // 输入事件
        inputSource.addEventListener('selectstart', this._onSelectStart);
        inputSource.addEventListener('selectend', this._onSelectEnd);
        inputSource.addEventListener('select', this._onSelect);
        inputSource.addEventListener('squeezestart', this._onSqueezeStart);
        inputSource.addEventListener('squeezeend', this._onSqueezeEnd);
        inputSource.addEventListener('squeeze', this._onSqueeze);

        this.controllers.set(inputSource, controllerGroup);
        if (controllerGrip) {
            this.controllerGrips.set(inputSource, controllerGrip);
        }
    }

    /**
     * 移除控制器（内部方法）
     * @private
     * @param {XRInputSource} inputSource - 输入源
     */
    _removeController(inputSource) {
        const controllerGroup = this.controllers.get(inputSource);
        if (controllerGroup) {
            this.scene.remove(controllerGroup);
            controllerGroup.traverse((child) => {
                if (child.dispose) child.dispose();
            });
        }

        // 解绑事件
        inputSource.removeEventListener('selectstart', this._onSelectStart);
        inputSource.removeEventListener('selectend', this._onSelectEnd);
        inputSource.removeEventListener('select', this._onSelect);
        inputSource.removeEventListener('squeezestart', this._onSqueezeStart);
        inputSource.removeEventListener('squeezeend', this._onSqueezeEnd);
        inputSource.removeEventListener('squeeze', this._onSqueeze);

        this.controllers.delete(inputSource);
        this.controllerGrips.delete(inputSource);
    }

    /**
     * 输入源变化处理（内部方法）
     * @private
     * @param {XRInputSourceChangeEvent} event - 事件
     */
    _onInputSourcesChange(event) {
        // 添加新控制器
        for (const inputSource of event.added) {
            this._addController(inputSource);
        }

        // 移除断开连接的控制器
        for (const inputSource of event.removed) {
            this._removeController(inputSource);
        }
    }

    /**
     * 获取控制器组
     * @param {XRInputSource} inputSource - 输入源
     * @returns {Group|null}
     */
    getController(inputSource) {
        return this.controllers.get(inputSource) || null;
    }

    /**
     * 获取所有控制器
     * @returns {Map<XRInputSource, Group>}
     */
    getAllControllers() {
        return new Map(this.controllers);
    }

    // ==================== 输入事件处理 ====================

    /**
     * 选择开始（内部方法）
     * @private
     * @param {XRInputSourceEvent} event - 事件
     */
    _onSelectStart(event) {
        this.events.emit('xr:select:start', { inputSource: event.inputSource, frame: event.frame });
    }

    /**
     * 选择结束（内部方法）
     * @private
     * @param {XRInputSourceEvent} event - 事件
     */
    _onSelectEnd(event) {
        this.events.emit('xr:select:end', { inputSource: event.inputSource, frame: event.frame });
    }

    /**
     * 选择（内部方法）
     * @private
     * @param {XRInputSourceEvent} event - 事件
     */
    _onSelect(event) {
        this.events.emit('xr:select', { inputSource: event.inputSource, frame: event.frame });
    }

    /**
     * 挤压开始（内部方法）
     * @private
     * @param {XRInputSourceEvent} event - 事件
     */
    _onSqueezeStart(event) {
        this.events.emit('xr:squeeze:start', { inputSource: event.inputSource, frame: event.frame });
    }

    /**
     * 挤压结束（内部方法）
     * @private
     * @param {XRInputSourceEvent} event - 事件
     */
    _onSqueezeEnd(event) {
        this.events.emit('xr:squeeze:end', { inputSource: event.inputSource, frame: event.frame });
    }

    /**
     * 挤压（内部方法）
     * @private
     * @param {XRInputSourceEvent} event - 事件
     */
    _onSqueeze(event) {
        this.events.emit('xr:squeeze', { inputSource: event.inputSource, frame: event.frame });
    }

    // ==================== 工具方法 ====================

    /**
     * 创建 AR 按钮
     * @param {Object} options - 选项
     * @param {string} options.text - 按钮文本
     * @param {Function} options.onClick - 点击回调
     * @returns {HTMLButtonElement}
     */
    createButton(options = {}) {
        const button = document.createElement('button');
        button.textContent = options.text || 'Enter AR';
        button.style.cssText = `
            position: absolute;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            padding: 12px 24px;
            border: 1px solid #fff;
            border-radius: 4px;
            background: rgba(0,0,0,0.1);
            color: #fff;
            font: normal 13px sans-serif;
            text-align: center;
            opacity: 0.5;
            outline: none;
            z-index: 999;
            cursor: pointer;
        `;

        const onClick = options.onClick || (() => {
            this.startAR();
        });

        button.addEventListener('click', onClick);

        // 检查支持情况
        if (!this.isAvailable()) {
            button.disabled = true;
            button.textContent = 'WebXR Not Available';
            return button;
        }

        this.isARSupported().then(supported => {
            if (!supported) {
                button.disabled = true;
                button.textContent = 'AR Not Supported';
            }
        });

        return button;
    }

    /**
     * 更新方法（每帧调用）
     * @param {XRFrame} frame - XR 帧
     */
    update(frame) {
        if (!this.isPresenting) return;
        
        // 添加调试信息（每60帧输出一次）
        if (!this._updateCount) this._updateCount = 0;
        this._updateCount++;
        if (this._updateCount % 60 === 0) {
            console.log('XRController: update 被调用，hitTestSource:', !!this.hitTestSource, 'reticle:', !!this.reticle);
        }

        // 更新命中测试和十字星
        if (!this.reticle) {
            // 如果十字星未创建，尝试创建
            this._createReticle();
        }
        
        // 确保十字星始终可见
        if (this.reticle) {
            this.reticle.visible = true;
        }
        
        if (this.hitTestSource) {
            const hitTestResults = this.getHitTestResults(frame);
            
            if (hitTestResults && hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                const pose = hit.getPose(this.referenceSpace);
                
                if (pose && this.reticle) {
                    // 更新十字星位置 - 使用 hit-test 结果
                    const matrix = this._tempMatrix.fromArray(pose.transform.matrix);
                    
                    // 直接复制矩阵
                    this.reticle.matrix.copy(matrix);
                    this.reticle.matrixAutoUpdate = false;
                    this.reticle.visible = true;
                    
                    // 不透明显示（有 hit-test 结果）
                    this.reticle.traverse((child) => {
                        if (child.material) {
                            child.material.opacity = 1.0;
                            child.material.transparent = false;
                        }
                    });
                    
                    // 保存当前命中矩阵，用于点击时放置模型
                    this.currentHitMatrix = matrix.clone();
                    this._hasHitTestResult = true;
                    
                    this.events.emit('xr:hit-test:results', { results: hitTestResults, frame });
                }
            } else {
                // 没有命中测试结果，显示降级十字星（相机前方）
                this._showFallbackReticle(frame);
            }
        } else {
            // 没有hit-test源，显示降级十字星（相机前方）
            this._showFallbackReticle(frame);
        }

        // 更新锚点
        this._updateAnchors(frame);
    }
    
    /**
     * 显示降级十字星（相机前方固定位置）
     * @private
     * @param {XRFrame} frame - XR 帧（用于获取相机位置）
     */
    _showFallbackReticle(frame) {
        if (!this.reticle) return;
        
        if (!frame || !this.referenceSpace) {
            // 如果没有 frame，使用相机对象
            if (this.camera) {
                const distance = 2;
                const forward = new Vector3(0, 0, -1);
                forward.applyQuaternion(this.camera.quaternion);
                const position = new Vector3().copy(this.camera.position).add(forward.multiplyScalar(distance));
                
                this.reticle.position.copy(position);
                this.reticle.rotation.x = -Math.PI / 2;
                this.reticle.visible = true;
                
                // 半透明显示
                this.reticle.traverse((child) => {
                    if (child.material) {
                        child.material.opacity = 0.6;
                        child.material.transparent = true;
                    }
                });
                
                // 保存位置矩阵
                const matrix = new Matrix4();
                matrix.makeTranslation(position.x, position.y, position.z);
                const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
                matrix.makeRotationFromQuaternion(rotation);
                matrix.setPosition(position);
                this.currentHitMatrix = matrix;
            }
            return;
        }
        
        // 从 XRFrame 获取相机位置
        let cameraPosition = new Vector3(0, 0, 0);
        let cameraQuaternion = new Quaternion();
        
        try {
            const viewerPose = frame.getViewerPose(this.referenceSpace);
            if (viewerPose && viewerPose.transform) {
                const transform = viewerPose.transform;
                cameraPosition.setFromMatrixPosition(new Matrix4().fromArray(transform.matrix));
                cameraQuaternion.setFromRotationMatrix(new Matrix4().fromArray(transform.matrix));
            } else if (this.camera) {
                cameraPosition.copy(this.camera.position);
                cameraQuaternion.copy(this.camera.quaternion);
            } else {
                return;
            }
        } catch (e) {
            if (this.camera) {
                cameraPosition.copy(this.camera.position);
                cameraQuaternion.copy(this.camera.quaternion);
            } else {
                return;
            }
        }
        
        // 在相机前方2米处显示十字星
        const distance = 2;
        const forward = new Vector3(0, 0, -1);
        forward.applyQuaternion(cameraQuaternion);
        const position = new Vector3().copy(cameraPosition).add(forward.multiplyScalar(distance));
        
        // 水平放置
        this.reticle.position.copy(position);
        this.reticle.rotation.x = -Math.PI / 2;
        this.reticle.rotation.y = 0;
        this.reticle.rotation.z = 0;
        this.reticle.matrixAutoUpdate = true;
        this.reticle.visible = true;
        
        // 半透明显示
        this.reticle.traverse((child) => {
            if (child.material) {
                child.material.opacity = 0.6;
                child.material.transparent = true;
            }
        });
        
        // 保存位置矩阵
        const matrix = new Matrix4();
        matrix.makeTranslation(position.x, position.y, position.z);
        const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
        matrix.makeRotationFromQuaternion(rotation);
        matrix.setPosition(position);
        this.currentHitMatrix = matrix;
        this._hasHitTestResult = false;
    }
    
    /**
     * 创建十字星（内部方法）
     * @private
     */
    _createReticle() {
        if (this.reticle) return; // 已创建
        
        // 创建外圈
        const outerRing = new RingGeometry(0.08, 0.12, 32);
        const innerRing = new RingGeometry(0.04, 0.06, 32);
        const centerDot = new CircleGeometry(0.02, 32);
        
        const material = new MeshBasicMaterial({ 
            color: 0xffffff,
            side: 2 // DoubleSide
        });
        
        const reticleGroup = new Group();
        
        // 外圈
        const outerMesh = new Mesh(outerRing, material.clone());
        outerMesh.rotation.x = -Math.PI / 2;
        reticleGroup.add(outerMesh);
        
        // 内圈
        const innerMesh = new Mesh(innerRing, material.clone());
        innerMesh.rotation.x = -Math.PI / 2;
        reticleGroup.add(innerMesh);
        
        // 中心点
        const centerMesh = new Mesh(centerDot, material.clone());
        centerMesh.rotation.x = -Math.PI / 2;
        centerMesh.position.y = 0.001;
        reticleGroup.add(centerMesh);
        
        this.reticle = reticleGroup;
        this.reticle.visible = true; // 立即显示
        
        // 确保场景存在
        if (!this.scene) {
            console.error('XRController: 场景未初始化，无法添加十字星');
            return;
        }
        
        this.scene.add(this.reticle);
        
        // 设置初始位置（相机前方2米）
        this.reticle.position.set(0, 0, -2);
        this.reticle.rotation.x = -Math.PI / 2;
        
        // 半透明显示
        this.reticle.traverse((child) => {
            if (child.material) {
                child.material.opacity = 0.6;
                child.material.transparent = true;
            }
        });
        
        console.log('XRController: ✅ 十字星已创建并显示');
    }

    /**
     * 设置点击事件处理（内部方法）
     * @private
     */
    _setupClickHandler() {
        // 移除旧的监听器（如果存在）
        if (this._clickHandler) {
            this.renderer.domElement.removeEventListener('click', this._clickHandler);
        }
        
        // 创建新的点击处理器
        this._clickHandler = (event) => {
            if (!this.isPresenting) {
                return;
            }
            
            // 优先使用 hit-test 结果，否则使用相机前方位置
            if (this.currentHitMatrix) {
                // 使用 hit-test 结果的位置
                this.events.emit('xr:place', { 
                    matrix: this.currentHitMatrix.clone(),
                    position: new Vector3().setFromMatrixPosition(this.currentHitMatrix),
                    rotation: new Quaternion().setFromRotationMatrix(this.currentHitMatrix),
                    hasHitTest: true
                });
                
                console.log('XRController: ✅ 点击放置模型（hit-test位置）');
            } else {
                // 没有 hit-test 结果，使用相机前方2米处
                const distance = 2;
                const forward = new Vector3(0, 0, -1);
                
                // 获取相机位置和方向
                if (this.camera) {
                    forward.applyQuaternion(this.camera.quaternion);
                    const position = new Vector3().copy(this.camera.position).add(forward.multiplyScalar(distance));
                    
                    // 创建矩阵（水平放置）
                    const matrix = new Matrix4();
                    matrix.makeTranslation(position.x, position.y, position.z);
                    const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
                    matrix.makeRotationFromQuaternion(rotation);
                    matrix.setPosition(position);
                    
                    this.events.emit('xr:place', { 
                        matrix: matrix,
                        position: position,
                        rotation: rotation,
                        hasHitTest: false
                    });
                    
                    console.log('XRController: ✅ 点击放置模型（相机前方位置）');
                }
            }
        };
        
        // 添加点击监听
        this.renderer.domElement.addEventListener('click', this._clickHandler);
        console.log('XRController: 点击事件已设置（支持无hit-test放置）');
    }

    /**
     * 在命中位置放置对象
     * @param {Object3D} object - 要放置的对象
     * @param {Matrix4} matrix - 位置矩阵（可选，如果不提供则使用当前命中位置）
     * @param {boolean} createAnchor - 是否创建AR锚点
     * @returns {Promise<XRAnchor|null>} 返回创建的锚点（如果成功）
     */
    async placeObjectAtHit(object, matrix = null, createAnchor = true) {
        if (!this.isPresenting || !this.referenceSpace) {
            console.warn('XRController: AR 会话未激活，无法放置对象');
            return null;
        }

        const placementMatrix = matrix || this.currentHitMatrix;
        if (!placementMatrix) {
            console.warn('XRController: 没有可用的命中位置');
            return null;
        }

        // 设置对象位置
        object.position.setFromMatrixPosition(placementMatrix);
        object.quaternion.setFromRotationMatrix(placementMatrix);
        object.matrixAutoUpdate = false; // 固定位置，不自动更新
        
        // 添加到场景
        if (!this.scene.children.includes(object)) {
            this.scene.add(object);
        }

        // 创建AR锚点（如果支持）
        let anchor = null;
        if (createAnchor && this.session && this.session.requestAnchor) {
            try {
                // 创建锚点矩阵
                const anchorMatrix = new Float32Array(16);
                placementMatrix.toArray(anchorMatrix);
                
                // 请求锚点
                anchor = await this.session.requestAnchor(this.referenceSpace, {
                    pose: {
                        transform: {
                            matrix: anchorMatrix
                        }
                    }
                });
                
                // 保存锚点映射
                this.anchors.set(anchor, object);
                this.anchoredObjects.set(object, anchor);
                
                console.log('XRController: 对象已放置并创建锚点');
                this.events.emit('xr:object:placed', { object, anchor, matrix: placementMatrix });
            } catch (e) {
                console.warn('XRController: 创建锚点失败，对象仍会放置:', e);
                // 即使锚点创建失败，对象也会被放置
                this.events.emit('xr:object:placed', { object, anchor: null, matrix: placementMatrix });
            }
        } else {
            // 不使用锚点，直接放置
            console.log('XRController: 对象已放置（未创建锚点）');
            this.events.emit('xr:object:placed', { object, anchor: null, matrix: placementMatrix });
        }

        return anchor;
    }

    /**
     * 移除已放置的对象
     * @param {Object3D} object - 要移除的对象
     */
    removePlacedObject(object) {
        if (!object) return;

        // 移除锚点
        const anchor = this.anchoredObjects.get(object);
        if (anchor) {
            try {
                anchor.delete();
            } catch (e) {
                console.warn('XRController: 删除锚点失败:', e);
            }
            this.anchors.delete(anchor);
            this.anchoredObjects.delete(object);
        }

        // 从场景移除
        if (this.scene.children.includes(object)) {
            this.scene.remove(object);
        }

        this.events.emit('xr:object:removed', { object });
    }

    /**
     * 更新锚点（内部方法）
     * @private
     * @param {XRFrame} frame - XR 帧
     */
    _updateAnchors(frame) {
        if (!frame.trackedAnchors) return;

        for (const anchor of frame.trackedAnchors) {
            const object = this.anchors.get(anchor);
            if (!object) continue;

            try {
                const pose = frame.getPose(anchor.anchorSpace, this.referenceSpace);
                if (pose) {
                    // 更新对象位置和旋转
                    const matrix = this._tempMatrix.fromArray(pose.transform.matrix);
                    object.position.setFromMatrixPosition(matrix);
                    object.quaternion.setFromRotationMatrix(matrix);
                }
            } catch (e) {
                console.warn('XRController: 更新锚点失败:', e);
            }
        }
    }

    /**
     * 设置配置
     * @param {Object} config - 配置对象
     */
    setConfig(config) {
        Object.assign(this.config, config);
    }

    /**
     * 获取配置
     * @returns {Object}
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * 清理资源
     */
    dispose() {
        if (this.isPresenting) {
            this.stop();
        }
        this._cleanup();
        this.events.removeAllListeners();
    }
}