/**
 * WebXR AR 控制器 - 管理 AR 会话和交互
 * @author AGan
 * @version 1.0
 */

import {
    EventBus,
    Vector3,
    Matrix4,
    Group,
    Object3D,
    Quaternion
} from "f3d";

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
        
        // 锚点管理
        this.anchors = new Map(); // anchor -> Object3D
        
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

        if (!await this.isARSupported()) {
            console.error('XRController: 设备不支持 AR');
            this.events.emit('xr:error', { message: '设备不支持 AR', mode: 'ar' });
            return false;
        }

        try {
            const sessionOptions = {
                requiredFeatures: options.requiredFeatures || this.config.sessionOptions.requiredFeatures,
                optionalFeatures: options.optionalFeatures || this.config.sessionOptions.optionalFeatures
            };

            if (options.domOverlay?.root || this.config.domOverlay?.root) {
                sessionOptions.domOverlay = options.domOverlay || this.config.domOverlay;
            }

            const session = await navigator.xr.requestSession('immersive-ar', sessionOptions);
            return await this._initializeSession(session);
        } catch (e) {
            console.error('XRController: 启动 AR 失败:', e);
            this.events.emit('xr:ar:error', { message: e.message, error: e });
            return false;
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
            const space = options.space || this.viewerSpace || this.referenceSpace;
            if (!space) {
                console.error('XRController: 无法获取参考空间');
                return false;
            }

            this.hitTestSource = await this.session.requestHitTestSource({ space });
            this.hitTestSourceRequested = true;
            
            this.events.emit('xr:hit-test:initialized');
            return true;
        } catch (e) {
            console.error('XRController: 初始化命中测试失败:', e);
            this.events.emit('xr:ar:error', { message: '初始化命中测试失败', error: e });
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

            // 设置渲染器的 XR 会话
            await this.renderer.xr.setSession(session);

            // 初始化参考空间
            this.referenceSpace = await session.requestReferenceSpace('local');
            
            // 创建 viewer 空间（用于命中测试）
            this.viewerSpace = await this.referenceSpace.getOffsetReferenceSpace(
                new XRRigidTransform({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 })
            );

            // 绑定会话事件
            session.addEventListener('end', this._onSessionEnd);
            session.addEventListener('inputsourceschange', this._onInputSourcesChange);

            // 初始化控制器
            this._setupControllers(session.inputSources);

            // 初始化 AR 功能
            await this.initializeHitTest();

            this.isPresenting = true;
            this.events.emit('xr:ar:started', { session });

            return true;
        } catch (e) {
            console.error('XRController: 初始化会话失败:', e);
            this.session = null;
            this.events.emit('xr:ar:error', { message: '初始化会话失败', error: e });
            return false;
        }
    }

    /**
     * 会话结束处理（内部方法）
     * @private
     */
    _onSessionEnd() {
        this.isPresenting = false;
        
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
        if (!this.isPresenting || !frame) return;

        // 更新命中测试
        if (this.hitTestSource) {
            const hitTestResults = this.getHitTestResults(frame);
            if (hitTestResults && hitTestResults.length > 0) {
                this.events.emit('xr:hit-test:results', { results: hitTestResults, frame });
            }
        }

        // 更新锚点
        this._updateAnchors(frame);
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