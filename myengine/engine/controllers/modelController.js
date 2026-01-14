/**
 * 模型控制器 - 负责模型的行为控制，如旋转、移动等
 */
import { Box3, Vector3, Matrix4 } from "three";
import { EventBus } from "../core/events/eventEmitter.js";

export class ModelController {
    // 行为控制映射
    behaviors = {
        rotation: new Map() // 存储旋转行为的模型
    };

    events = new EventBus();

    //鼠标交互设置
    mouseInteraction = {
        isLeftPressed: false,
        resumeTimer: null,
        pausedModels: new Set()
    }

    // 存储绑定的事件处理器引用，用于正确解绑
    _boundHandlers = {
        onMouseDown: null,
        onMouseUp: null
    };

    /**
     * 创建模型控制器
     * @param {Engine} engine 引擎实例
     */
    constructor(engine) {
        this.engine = engine;
        this.scene = engine?.mainScene;

        // 注册更新回调
        engine?.addUpdateCallback('modelController', this.update.bind(this));

        //监听鼠标事件
        this._bindMouseEvents();
    }

    /**
     * 绑定鼠标事件监听
     */
    _bindMouseEvents() {
        // 保存handler以便解绑
        this._boundHandlers.onMouseDown = (data) => {
            if (data.button === 'left') {
                this._handleLeftMouseDown();
            }
        };
        this._boundHandlers.onMouseUp = (data) => {
            if (data.button === 'left') {
                this._handleLeftMouseUp();
            }
        };

        // 监听鼠标事件
        this.engine.events.on('input.mousedown', this._boundHandlers.onMouseDown);
        this.engine.events.on('input.mouseup', this._boundHandlers.onMouseUp);
    }

    /**
 * 处理左键按下事件
 * @private
 */
    _handleLeftMouseDown() {
        this.mouseInteraction.isLeftPressed = true;

        // 清除恢复计时器
        if (this.mouseInteraction.resumeTimer) {
            clearTimeout(this.mouseInteraction.resumeTimer);
            this.mouseInteraction.resumeTimer = null;
        }

        // 暂停所有正在旋转的模型
        this._pauseAllRotations();
    }

    /**
     * 处理左键抬起事件
     * @private
     */
    _handleLeftMouseUp() {
        this.mouseInteraction.isLeftPressed = false;

        // 设置1秒后恢复旋转的计时器
        this.mouseInteraction.resumeTimer = setTimeout(() => {
            this._resumeAllRotations();
            this.mouseInteraction.resumeTimer = null;
        }, 1500);
    }
    /**
     * 暂停所有旋转的模型
     * @private
     */
    _pauseAllRotations() {
        this.behaviors.rotation.forEach((config, modelId) => {
            if (config && config.enabled) {
                // 记录被暂停的模型
                this.mouseInteraction.pausedModels.add(modelId);
                // 暂时禁用旋转
                config.enabled = false;
            }
        });
    }

    /**
     * 恢复所有被暂停的模型旋转
     * @private
     */
    _resumeAllRotations() {
        this.mouseInteraction.pausedModels.forEach(modelId => {
            const config = this.behaviors.rotation.get(modelId);
            if (config) {
                // 恢复旋转
                config.enabled = true;
            }
        });

        // 清空暂停列表
        this.mouseInteraction.pausedModels.clear();
    }
    /**
     * 更新循环
     */
    update(deltaSeconds = 0.016) {
        this._updateRotations(deltaSeconds);
    }
    /**
     * 更新模型旋转
     * @private
     */
    _updateRotations(deltaSeconds) {
        this.behaviors.rotation.forEach((config, modelId) => {
            if (!config || !config.enabled) return;

            const model = this._getModel(modelId);
            if (!model) return;

            // 基于时间步长计算旋转角度（速度单位：弧度/秒）
            const speed = Number.isFinite(config.speed) ? config.speed : 1;
            const rotationAngle = speed * deltaSeconds;

            // 围绕模型的几何中心旋转
            // 只在第一次或模型位置改变时计算中心点
            if (!config.center) {
                const box = new Box3().setFromObject(model);
                config.center = new Vector3();
                box.getCenter(config.center);
            }

            // 使用缓存的中心点进行旋转
            const center = config.center;
            
            // 更通用的旋转方法：围绕世界坐标系的Y轴旋转
            // 1. 计算模型相对于中心点的偏移
            const offset = model.position.clone().sub(center);
            
            // 2. 围绕世界Y轴旋转偏移向量
            const rotatedOffset = offset.clone().applyAxisAngle(new Vector3(0, 1, 0), rotationAngle);
            
            // 3. 设置模型新位置
            model.position.copy(center).add(rotatedOffset);
            
            // 4. 同时旋转模型的朝向，保持模型本身不倾斜
            model.rotateY(rotationAngle);
        });
    }
    /**
     * 设置模型旋转
     * @param {string} modelId 模型ID
     * @param {boolean} enabled 是否启用旋转
     * @returns {boolean} 是否成功设置
     */
    setRotation(modelId, enabled) {
        const model = this._getModel(modelId);
        if (!model) return false;

        // 获取当前配置或创建新配置
        const config = this.behaviors.rotation.get(modelId) || { enabled: false, speed: 1 };
        // 只更新启用状态
        config.enabled = enabled;
        
        // 清除缓存的中心点，确保位置变化时重新计算
        if (config.center) {
            delete config.center;
        }
        
        this.behaviors.rotation.set(modelId, config);
        // 触发事件
        this.events.emit('rotation:change', { modelId, enabled, speed: config.speed });
        return true;
    }

    /**
     * 设置模型旋转速度
     * @param {string} modelId 模型ID
     * @param {number} speed 旋转速度
     * @returns {boolean} 是否成功设置
     */
    setRotationSpeed(modelId, speed) {
        const model = this._getModel(modelId);
        if (!model) return false;

        // 获取当前配置或创建新配置
        const config = this.behaviors.rotation.get(modelId) || { enabled: false, speed: 1 };
        // 只更新速度
        config.speed = speed;
        
        // 清除缓存的中心点，确保位置变化时重新计算
        if (config.center) {
            delete config.center;
        }
        
        this.behaviors.rotation.set(modelId, config);

        // 触发事件
        this.events.emit('rotation:speed', { modelId, speed, enabled: config.enabled });

        return true;
    }

    /**
     * 同时设置模型旋转开关与速度
     * @param {string} modelId 模型ID
     * @param {boolean} enabled 是否启用旋转
     * @param {number} speed 旋转速度
     * @returns {boolean} 是否成功设置
     */
    setRotationState(modelId, enabled, speed) {
        const model = this._getModel(modelId);
        if (!model) return false;

        const config = this.behaviors.rotation.get(modelId) || { enabled: false, speed: 1 };
        if (typeof enabled === 'boolean') {
            config.enabled = enabled;
        }
        if (typeof speed === 'number' && !Number.isNaN(speed)) {
            config.speed = speed;
        }

        if (config.center) {
            delete config.center;
        }

        this.behaviors.rotation.set(modelId, config);

        // 发出一次合并事件
        this.events.emit('rotation:change', { modelId, enabled: config.enabled, speed: config.speed });
        return true;
    }
    /**
     * 获取模型旋转状态
     * @param {string} modelId 模型ID
     * @returns {Object} 旋转状态配置
     */
    getRotationState(modelId) {
        return this.behaviors.rotation.get(modelId) || { enabled: false, speed: 1 };
    }

    /**
     * 从场景或资产管理器获取模型
     * @private
     */
    _getModel(modelId) {
        // 优先从资产管理器获取
        if (this.engine?.assetsManager) {
            const model = this.engine.assetsManager.getModel(modelId);
            if (model) return model;
        }
        // 尝试从场景中查找
        return this.scene?.getObjectByName(modelId) || null;
    }

    /**
     * 释放资源
     */
    dispose() {
        // 清除计时器
        if (this.mouseInteraction.resumeTimer) {
            clearTimeout(this.mouseInteraction.resumeTimer);
            this.mouseInteraction.resumeTimer = null;
        }
        // 解绑事件监听（使用保存的引用）
        if (this.engine?.events) {
            if (this._boundHandlers.onMouseDown) {
                this.engine.events.off('input.mousedown', this._boundHandlers.onMouseDown);
                this._boundHandlers.onMouseDown = null;
            }
            if (this._boundHandlers.onMouseUp) {
                this.engine.events.off('input.mouseup', this._boundHandlers.onMouseUp);
                this._boundHandlers.onMouseUp = null;
            }
        }
        // 清除行为映射
        Object.values(this.behaviors).forEach(map => map.clear());        
        // 清空暂停列表
        this.mouseInteraction.pausedModels.clear();

        // 移除更新回调
        this.engine?.removeUpdateCallback('modelController');

        this.engine = null;
        this.scene = null;
        this.events = null;
    }
}