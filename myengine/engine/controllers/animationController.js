/**
 * 动画控制器 - 管理3D模型的动画播放和控制
 * @author AGan
 */
import { AnimationMixer, LoopRepeat, LoopOnce, LoopPingPong, AnimationClip } from "three";
import { EventBus } from "../core/events/eventEmitter.js";

// ==================== 常量定义 ======================
const CONSTANTS = {
    TIME_UNIT_THRESHOLD_MS: 30, // 时间单位阈值（毫秒）
    BOUNDS_UPDATE_INTERVAL: 10, // 边界更新间隔
    MINIMAL_DURATION: 1 / 60, // 最小持续时间
    DEFAULT_SPEED: 1.0, // 默认速度
    DEFAULT_WEIGHT: 1.0, // 默认权重
    TIME_EPSILON_RATIO: 0.005, // 时间误差比
    PREVIEW_TIME_RATIO: 0.25, // 预览时间比
    WEIGHT_UI_SCALE: 100, // UI权重范围 0-100
    TIME_EPSILON: 0.05, // 时间判断精度阈值
    FRAME_UPDATE_INTERVAL: 60, // 帧更新间隔（用于高亮尺寸更新）  
    MS_PER_SECOND: 1000,   
};

/**
 * 循环模式类型
 * @type {Object}
 */
const LoopModeType = {
    ONCE: 1,       // 播放一次
    REPEAT: 2,     // 循环播放
    PING_PONG: 3,  // 往返播放
};

const PlayMode = {
    SINGLE: 1,        // 单次播放
    PING_PONG: 2,     // 单次往返
    CLAMP_END: 3,     // 播放到结束停止
    CLICK_RETURN: 4,  // 点击返回
};

const LoopType = {
    ONCE: 1,       // 单次
    TWICE: 2,      // 两次
    MULTIPLE: 3,   // 多次
    INFINITE: 4,   // 无限次
};

export class AnimationController {
    _actionToInfo = new Map(); // Action -> { modelId, animationId, name }
    _mixerBoundSet = new Set(); // 已绑定finished事件的mixer集合
    _modelStates = null; // 存储模型初始状态
    _skinnedMeshCache = new Map(); // modelId -> SkinnedMesh[] 缓存
    _frameCount = 0; // 帧计数器
    _splitAnimationIds = new Set(); // 分割动画ID集合（使用clip.uuid）
    _splitCreationTime = new Map(); // 分割动画创建时间戳，用于选择最新
    
    _modelActiveCount = new Map(); // modelId -> number (活跃动画数量)
    _meshToModelIdCache = new WeakMap(); // mesh -> modelId 缓存
    _hoveredMesh = null; // 当前悬停的mesh
    
    animations = new Map(); // 存储动画配置
    mixers = new Map(); // 存储动画混合器
    actions = new Map(); // 存储动画动作
    events = new EventBus(); // 事件总线
    
    materialAnimationMap = new Map(); 
    materialAnimationEnabled = false; 

    // 动画关联mesh
    _meshAnimationBindings = new Map(); // mesh标识 -> {modelId, animationId, options, ...}
    _boundMeshes = new Set(); // 存储有绑定的mesh对象引用

    _highlightedMeshes = [];
    _highlightedMeshesSet = new Set();
    
    globalSettings = {
        enabled: true,
        autoPlay: true,
        interactionType: 1,
        autoPlayCount: 1,
        hoverHighlightEnabled: true, // 是否启用鼠标悬停高亮
        clickMeshPlayAnimationEnabled: true // 是否启用点击mesh触发动画播放
    };

    /**
     * 构造函数
     * @param {Engine} engine 引擎
     */
    constructor(engine) {
        this.engine = engine;
        this.scene = engine?.mainScene;
        
        engine?.addUpdateCallback('animationController', this.update.bind(this));
        
        this._bindEvents();

        this._bindingState = null;
        this._previewingBindingAnimationId = null;
    }
    
    /**
     * 获取EffectComposer
     * @returns {EffectComposer|null} 委托给 HighlightController
     */
    getComposer() {
        return this.engine?.highlightController?.getComposer?.() || null;
    }

    /**
     * 判断是否为分割动画ID
     * @private
     */
    _isSplitAnimationId(animationId) {
        return this._splitAnimationIds.has(animationId);
    }

    /**
     * 更新活跃计数器
     * @private
     */
    _updateActiveCount(modelId, delta) {
        const current = this._modelActiveCount.get(modelId) || 0;
        const next = Math.max(0, current + delta);
        this._modelActiveCount.set(modelId, next);
    }
    
    /**
     * 处理动画结束逻辑
     * @private
     */
    _handleAnimationFinished(config, info) {
        if (config && config.loopMode === 1) {
            // 只有在不是停留模式下，才恢复模型状态
            if (!config.clampWhenFinished) {
                this._restoreModelState(info.animationId);
            }
        }
        
        if (config) {
            if (config.enabled) {
                if (!config.clampWhenFinished) {
                    config.enabled = false;
                    this._updateActiveCount(info.modelId, -1);
                }
            }
        } else {
            // 分割动画处理逻辑
            const action = this.actions.get(info.animationId);
            
            // 检查 action 是否配置为结束后停留
            const isClamped = action && (action.clampWhenFinished || action._clampAtEnd);
            
            if (action && action.enabled) {
                if (!isClamped) {
                    action.enabled = false;
                    this._updateActiveCount(info.modelId, -1);
                }
            }
        }
        
        this.events.emit('animation:finished', {
            modelId: info.modelId,
            animationId: info.animationId,
            name: info.name
        });
    }
    
    _bindEvents() {
        if (this.engine?.events) {
            this.engine.events.on('scene:model', this._onModelLoaded.bind(this));
            this.engine.events.on('mesh:click', this._onMeshClick.bind(this));
            this.engine.events.on('input.mousemove', this._onMouseMoveHover.bind(this));
        }
    }

    /**
     * 方向归一化：支持 1/2（UI）与 1/-1（内部）
     * @private
     */
    _normalizeDirection(value) {
        const v = Number(value);
        if (v === -1) return -1;
        if (v === 2) return -1;
        return 1;
    }

    /**
     * 获取有效的播放方向
     * @private
     */
    _getEffectivePlayDirection(config) {
        if (config && config.playDirection !== undefined) {
            const d = Number(config.playDirection);
            return d === -1 ? -1 : 1;
        }
        if (config && config.playDirectionType !== undefined) {
            return this._normalizeDirection(config.playDirectionType);
        }
        return 1;
    }

    _onModelLoaded(data) {
        const { model, id } = this._extractModelData(data);
        if (!model || !model.animations?.length) {
            console.log("AnimationController: 模型或动画数据不足，跳过处理");
            return;
        }
        // 为整棵模型树固化稳定 ID（基于全路径命名，不依赖索引）
        this._initModelStableIds(model);
        this._setupModelAnimations(model, id);
    }

    _extractModelData(data) {
        if (data.model && data.id) {
            return { model: data.model, id: data.id };
        } else if (data.model) {
            return { model: data.model, id: data.url || 'unknown' };
        }
        return { model: null, id: null };
    }

    _setupModelAnimations(model, modelId) {
        if (this.mixers.has(modelId)) {
            return;
        }
        
        // 清除旧缓存
        this._skinnedMeshCache.delete(modelId);
        this._modelActiveCount.set(modelId, 0);
        
        const mixer = new AnimationMixer(model);
        this.mixers.set(modelId, mixer);

        this._bindMixerFinishedEvent(mixer);
        this._saveModelInitialState(model, modelId);
        this._createAnimationActions(model, modelId, mixer);
        this._emitAnimationsLoadedEvent(modelId);
    }

    /**
     * 绑定mixer的finished事件
     * @private
     */
    _bindMixerFinishedEvent(mixer) {
        if (!this._mixerBoundSet.has(mixer)) {
            mixer.addEventListener?.('finished', (event) => {
                try {
                    const action = event?.action;
                    const info = this._actionToInfo.get(action);
                    if (info) {
                        const config = this.animations.get(info.animationId);
                        this._handleAnimationFinished(config, info);
                    }
                } catch (e) {
                    console.warn('处理动画完成事件时出错:', e);
                }
            });
            this._mixerBoundSet.add(mixer);
        }
    }

    _createAnimationActions(model, modelId, mixer) {
        let validAnimations = 0;
        model.animations.forEach((clip, index) => {
            if (clip instanceof AnimationClip) {
                this._createAnimationAction(clip, modelId, index, mixer);
                validAnimations++;
            } else {
                console.warn("AnimationController: 跳过无效动画", { index, clip });
            }
        });
    }

    _emitAnimationsLoadedEvent(modelId) {
        const animations = this.getModelAnimations(modelId);
        this.events.emit('animations:loaded', {
            modelId,
            animations: animations
        });
    }

    _createAnimationAction(clip, modelId, index, mixer) {
        const action = mixer.clipAction(clip);
        const animationId = `${modelId}_animation_${index}`;
        
        this.actions.set(animationId, action);
        this._actionToInfo.set(action, { modelId, animationId, name: clip.name || `动画${index + 1}` });
        
        if (action) {
            action.clampWhenFinished = false;
        }
        
        const animationConfig = {
            id: animationId,
            modelId,
            name: clip.name || `动画${index + 1}`,
            duration: clip.duration,
            enabled: false,
            speed: 1.0,
            playDirection: 1,
            loopMode: 2,
            loopCount: -1,
            startDelay: 0,
            fadeInTime: 0,
            fadeOutTime: 0,
            weight: 1.0,
            clip,
            action,
            startDelayTimerId: null
        };
        
        this.animations.set(animationId, animationConfig);
    }

    
    /**
     * 获取模型的所有动画
     * @param {string} modelId 模型ID
     * @returns {Array} 动画列表
     */
    getModelAnimations(modelId) {
        const animations = [];
        this.animations.forEach((config) => {
            if (config.modelId === modelId) {
                animations.push({ ...config });
            } 
        });
        return animations;
    }

    /**
     * 获取动画详细信息
     * @param {string} animationId 动画ID
     * @returns {Object|null} 动画详细信息
     */
    getAnimationDetails(animationId) {
        const config = this.animations.get(animationId);
        if (!config) return null;
        
        return {
            id: config.id,
            name: config.name,
            duration: config.duration,
            enabled: config.enabled,
            speed: config.speed,
            playDirection: config.playDirection,
            loopMode: config.loopMode,
            loopCount: config.loopCount,
            startDelay: config.startDelay,
            fadeInTime: config.fadeInTime,
            fadeOutTime: config.fadeOutTime,
            weight: config.weight
        };
    }

    /**
     * 统一设置动画参数
     * @param {string} animationId 动画ID
     * @param {Object} params 参数对象
     * @returns {boolean} 是否成功
     */
    setAnimationParams(animationId, params) {
        const config = this.animations.get(animationId);
        if (!config) return false;
        
        const processedParams = this._processTimeParams(params);
        
        const shouldEnable = processedParams.enabled;
        delete processedParams.enabled;
        
        Object.assign(config, processedParams);
        
        if (config.action) {
            this._applyConfigToAction(config);
        }
        
        if (processedParams.weight !== undefined && config.action) {
            this._applyWeightImmediately(animationId);
        }
        
        if (shouldEnable !== undefined) {
            shouldEnable ? this._playAnimation(animationId) : this._stopAnimation(animationId);
        }
        
        this.events.emit('animation:updated', { animationId, params: { ...processedParams, enabled: shouldEnable } });
        return true;
    }

    /**
     * 统一处理动画参数
     * @private
     */
    _processTimeParams(params) {
        const processed = { ...params };
        const timeFields = ['startDelay', 'fadeInTime', 'fadeOutTime'];
        
        if (processed.startDelayTime !== undefined && processed.startDelay === undefined) {
            processed.startDelay = processed.startDelayTime;
        }
        
        timeFields.forEach(field => {
            if (processed[field] !== undefined) {
                const value = Number(processed[field]);
                if (value > 30) {
                    processed[field] = value / CONSTANTS.MS_PER_SECOND;
                } else {
                    processed[field] = value;
                }
            }
        });
        
        if (processed.playDirectionType !== undefined && processed.playDirection === undefined) {
            processed.playDirection = this._normalizeDirection(processed.playDirectionType);
            delete processed.playDirectionType;
        }
        
        if (processed.loopModeType !== undefined) {
            const lmt = Number(processed.loopModeType);
            switch (lmt) {
                case 1:
                    processed.loopMode = 1;
                    processed.loopCount = 1;
                    break;
                case 2:
                    processed.loopMode = 2;
                    if (processed.loopCount === undefined || processed.loopCount === null) {
                        processed.loopCount = 1;
                    }
                    break;
                case 3:
                    processed.loopMode = 2;
                    processed.loopCount = -1;
                    break;
                case 4:
                    processed.loopMode = 3;
                    if (processed.loopCount === undefined || processed.loopCount === null) {
                        processed.loopCount = 1;
                    }
                    break;
                case 5:
                    processed.loopMode = 3;
                    processed.loopCount = -1;
                    break;
                default:
                    processed.loopMode = 1;
                    processed.loopCount = 1;
            }
        }
        
        if (processed.loopCount !== undefined) {
            processed.loopCount = Number(processed.loopCount);
        }
        
        if (processed.weight === undefined && processed.baseWeight !== undefined) {
            processed.weight = Number(processed.baseWeight);
        }
        if (processed.weight !== undefined) {
            const weight = Number(processed.weight);
            processed.weight = Math.max(0, weight);
        }
        
        if (processed.enabled === undefined && processed.activeType !== undefined) {
            processed.enabled = Number(processed.activeType) === 1;
        }
        
        if (processed.speed !== undefined) {
            processed.speed = Number(processed.speed);
        }
        
        return processed;
    }

    
    /**
     * 播放指定动画
     * @param {string} animationId 动画ID
     * @param {Object} options 播放选项
     * @returns {boolean} 是否成功
     */
    playAnimation(animationId, options = {}) {
        const config = this.animations.get(animationId);
        if (!config) return false;
        
        this._stopAnimation(animationId);
        
        this._applyAnimationOptions(config, options);
        
        return this._playAnimation(animationId);
    }

    /**
     * 停止指定动画
     * @param {string} animationId 动画ID
     * @returns {boolean} 是否成功
     */
    stopAnimation(animationId) {
        return this.setAnimationParams(animationId, { enabled: false });
    }

    /**
     * 暂停指定动画（保留当前时间）
     * @param {string} animationId 动画ID
     * @returns {boolean} 是否成功
     */
    pauseAnimation(animationId) {
        const config = this.animations.get(animationId);
        if (!config?.action) return false;
        
        config.action.paused = true;
        if (config.startDelayTimerId) {
            this._clearTimer(config.startDelayTimerId);
            config.startDelayTimerId = null;
        }
        return true;
    }

    /**
     * 继续播放指定动画（从当前时间继续）
     * @param {string} animationId 动画ID
     * @returns {boolean} 是否成功
     */
    resumeAnimation(animationId) {
        const config = this.animations.get(animationId);
        if (!config?.action) return false;
        
        config.action.paused = false;
        config.action.play();
        try {
            this.setSpeed(animationId, config.speed);
        } catch (_) {}
        return true;
    }

    /**
     * 通过名称暂停动画
     * @param {string} modelId 模型ID
     * @param {string} animationName 动画名称
     * @returns {boolean} 是否成功
     */
    pauseAnimationByName(modelId, animationName) {
        const targetAnimation = this._findAnimationByName(modelId, animationName);
        return targetAnimation ? this.pauseAnimation(targetAnimation.id) : false;
    }

    /**
     * 通过名称继续动画
     * @param {string} modelId 模型ID
     * @param {string} animationName 动画名称
     * @returns {boolean} 是否成功
     */
    resumeAnimationByName(modelId, animationName) {
        const targetAnimation = this._findAnimationByName(modelId, animationName);
        return targetAnimation ? this.resumeAnimation(targetAnimation.id) : false;
    }

    /**
     * 设置循环模式
     * @param {string} animationId 动画ID
     * @param {number} loopMode 循环模式 1:播放一次 2:循环 3:往返
     * @param {number} loopCount 循环次数 -1:无限循环
     * @returns {boolean} 是否成功
     */
    setLoopMode(animationId, loopMode, loopCount = -1) {
        const config = this.animations.get(animationId);
        if (!config?.action) return false;
        
        config.loopMode = loopMode;
        config.loopCount = loopCount;
        
        let uiCount = Number(loopCount);
        if (!isFinite(uiCount)) uiCount = -1;
        
        if (loopMode === 1) {
            config.action.setLoop(LoopOnce, 1);
        } else if (loopMode === 2) {
            if (uiCount < 0) {
                config.action.setLoop(LoopRepeat, Infinity);
            } else {
                const base = Math.max(0, Math.floor(uiCount) - 1);
                const forwardComp = (config.playDirection === 1) ? 1 : 0;
                const repetitions = Math.max(0, base + forwardComp);
                config.action.setLoop(LoopRepeat, repetitions);
            }
        } else if (loopMode === 3) {
            if (uiCount < 0) {
                config.action.setLoop(LoopPingPong, Infinity);
            } else {
                let repetitions = Math.max(0, Math.floor(uiCount) * 2);
                const direction = this._getEffectivePlayDirection(config);
                if (direction === -1 && repetitions > 0) {
                    repetitions += 1;
                }
                
                config.action.setLoop(LoopPingPong, repetitions);
            }
        } else {
            if (uiCount < 0) {
                config.action.setLoop(LoopRepeat, Infinity);
            } else {
                const repetitions = Math.max(0, Math.floor(uiCount) - 1);
                config.action.setLoop(LoopRepeat, repetitions);
            }
        }
        
        return true;
    }

    /**
     * 设置动画启用状态
     * @param {string} animationId 动画ID
     * @param {boolean} enabled 是否启用
     * @returns {boolean} 是否成功
     */
    setAnimationEnabled(animationId, enabled) {
        const config = this.animations.get(animationId);
        if (!config) return false;
        
        config.enabled = enabled;
        enabled ? this._playAnimation(animationId) : this._stopAnimation(animationId);
        return true;
    }

    
    /**
     * 播放所有动画
     * @param {string} modelId 模型ID
     * @param {Object} options 播放选项
     * @returns {boolean} 是否成功
     */
    playAllAnimations(modelId, options = {}) {
        const animations = this.getModelAnimations(modelId);
        if (animations.length === 0) return false;
        
        let successCount = 0;
        animations.forEach(animation => {
            this._applyAnimationOptions(animation, options);
            if (this.playAnimation(animation.id)) {
                successCount++;
            }
        });
        
        return successCount > 0;
    }

    /**
     * 停止所有动画
     * @param {string} modelId 模型ID
     * @returns {boolean} 是否成功
     */
    stopAllAnimations(modelId) {
        const animations = this.getModelAnimations(modelId);
        animations.forEach(animation => {
            this.stopAnimation(animation.id);
        });
        return true;
    }

    /**
     * 设置所有动画参数
     * @param {string} modelId 模型ID
     * @param {Object} params 参数对象
     * @returns {number} 成功设置的数量
     */
    setAllAnimationParams(modelId, params) {
        const animations = this.getModelAnimations(modelId);
        let successCount = 0;
        
        animations.forEach(animation => {
            if (this.setAnimationParams(animation.id, params)) {
                successCount++;
            }
        });
        
        return successCount;
    }

    /**
     * 通过名称设置循环模式（UI传入1..5类型）
     * @param {string} modelId 模型ID
     * @param {string} animationName 动画名称
     * @param {number} loopModeType 循环类型
     * @param {number} [loopCount=1] 循环次数
     * @returns {boolean} 是否成功
     */
    setLoopModeByName(modelId, animationName, loopModeType, loopCount = 1) {
        const lmt = Number(loopModeType);
        let normalizedCount = loopCount;
        if (lmt === 1) {
            normalizedCount = 1;
        } else if (lmt === 3 || lmt === 5) {
            normalizedCount = -1;
        } else if (normalizedCount === undefined || normalizedCount === null || !isFinite(Number(normalizedCount))) {
            normalizedCount = 1;
        }
        return this.setAnimationParamsByName(modelId, animationName, { loopModeType: lmt, loopCount: Number(normalizedCount) });
    }
    
    /**
     * 为模型全部动画设置循环模式
     * @param {string} modelId 模型ID
     * @param {number} loopModeType 循环类型
     * @param {number} [loopCount=1] 循环次数
     * @returns {number} 成功数量
     */
    setAllLoopMode(modelId, loopModeType, loopCount = 1) {
        return this.setAllAnimationParams(modelId, { loopModeType, loopCount });
    }

    
    /**
     * 通过名称播放动画
     * @param {string} modelId 模型ID
     * @param {string} animationName 动画名称
     * @param {Object} options 播放选项
     * @returns {boolean} 是否成功
     */
    playAnimationByName(modelId, animationName, options = {}) {
        const targetAnimation = this._findAnimationByName(modelId, animationName);
        if (!targetAnimation) return false;
        
        this._stopAnimation(targetAnimation.id);
        
        const processedOptions = this._processTimeParams(options);
        this._applyAnimationOptions(targetAnimation, processedOptions);
        
        const shouldEnable = (processedOptions.enabled !== undefined)
            ? !!processedOptions.enabled
            : true; 
        
        return shouldEnable ? this._playAnimation(targetAnimation.id)
                             : this._stopAnimation(targetAnimation.id);
    }

    /**
     * 通过名称停止动画
     * @param {string} modelId 模型ID
     * @param {string} animationName 动画名称
     * @returns {boolean} 是否成功
     */
    stopAnimationByName(modelId, animationName) {
        const targetAnimation = this._findAnimationByName(modelId, animationName);
        return targetAnimation ? this.stopAnimation(targetAnimation.id) : false;
    }


    /**
     * 立刻停止动画（无淡出并清除延迟）
     * @param {string} modelId 模型ID
     * @param {string} animationName 动画名称
     * @returns {boolean} 是否成功
     */
    stopAnimationNowByName(modelId, animationName) {
        const targetAnimation = this._findAnimationByName(modelId, animationName);
        if (!targetAnimation) return false;
        
        const config = this.animations.get(targetAnimation.id);
        if (!config?.action) return false;
        
        if (config.startDelayTimerId) {
            this._clearTimer(config.startDelayTimerId);
            config.startDelayTimerId = null;
        }
        
        config.action.stop();
        config.action.reset();
        config.action.time = 0;
        
        if (config.enabled) {
            config.enabled = false;
            this._updateActiveCount(modelId, -1);
        }
        
        this._restoreModelState(targetAnimation.id);
        
        return true;
    }

    /**
     * 通过名称设置动画参数
     * @param {string} modelId 模型ID
     * @param {string} animationName 动画名称
     * @param {Object} params 参数对象
     * @returns {boolean} 是否成功
     */
    setAnimationParamsByName(modelId, animationName, params) {
        const targetAnimation = this._findAnimationByName(modelId, animationName);
        return targetAnimation ? this.setAnimationParams(targetAnimation.id, params) : false;
    }

    /**
     * 通过名称获取动画状态
     * @param {string} modelId 模型ID
     * @param {string} animationName 动画名称
     * @returns {Object|null} 动画状态
     */
    getAnimationStatusByName(modelId, animationName) {
        const targetAnimation = this._findAnimationByName(modelId, animationName);
        if (!targetAnimation) return null;
        
        const speedAbs = Math.abs(Number(targetAnimation.speed) || 1);
        const singleEffectiveDuration = (Number(targetAnimation.duration) || 0) / speedAbs;

        let plannedTotalDuration = null;
        if (Number(targetAnimation.loopCount) >= 0) {
            const lc = Math.max(1, Number(targetAnimation.loopCount) || 1);
            plannedTotalDuration = singleEffectiveDuration * lc;
        }

        return {
            name: targetAnimation.name,
            enabled: targetAnimation.enabled,
            speed: targetAnimation.speed,
            playDirection: targetAnimation.playDirection,
            loopMode: targetAnimation.loopMode,
            loopCount: targetAnimation.loopCount,
            startDelay: targetAnimation.startDelay,
            fadeInTime: targetAnimation.fadeInTime,
            fadeOutTime: targetAnimation.fadeOutTime,
            weight: targetAnimation.weight,
            isPlaying: targetAnimation.action?.isRunning() || false,
            time: targetAnimation.action?.time || 0,
            duration: targetAnimation.duration
        };

    }



    // ==================== Mesh-动画绑定系统 ====================
    
    /**
     * 生成绑定键（优先使用稳定的 userData.id）
     * @private
     * @param {THREE.Mesh} mesh - mesh对象
     * @param {string} modelId - 模型ID
     * @returns {string} 绑定键
     */
    _getBindingKey(mesh, modelId) {
        if (!mesh?.userData?.id) {
            console.warn('Mesh 缺少稳定 ID，无法生成绑定键:', {
                meshName: mesh?.name,
                meshUuid: mesh?.uuid,
                hasUserData: !!mesh?.userData
            });
            return null;
        }
        return `${modelId}_${mesh.userData.id}`;
    }
    
    /**
     * 在模型中查找mesh（支持通过 userData.id 或 uuid 查找）
     * @private
     * @param {Object} model - 模型对象
     * @param {string} meshIdentifier - mesh的userData.id或UUID
     * @returns {THREE.Mesh|null} 找到的mesh或null
     */
    _findMeshInModel(model, meshIdentifier) {
        let mesh = null;
        
        model.traverse((obj) => {
            if (!obj.isMesh) return;
            
            // 优先通过 userData.id 查找（最稳定）
            if (obj.userData?.id === meshIdentifier) {
                mesh = obj;
                return; // 找到后直接返回
            }
            
            // 兼容：通过 uuid 查找（只在未通过id找到时查找）
            if (!mesh && obj.uuid === meshIdentifier) {
                mesh = obj;
            }
        });
        
        return mesh;
    }
    
    /**
     * 通过名称查找动画
     * @private
     * @param {string} modelId - 模型ID
     * @param {string} animationName - 动画名称
     * @returns {Object|null} 完整的config对象或 {id, name, action} 或 null
     */
    _findAnimationByName(modelId, animationName) {
        const allActions = [];
        this.actions.forEach((act, actId) => {
            const info = this._actionToInfo.get(act);
            if(info && info.modelId === modelId && info.name === animationName) {
                allActions.push({
                    id: actId,
                    name: info.name,
                    action: act,
                    isSplit: this._isSplitAnimationId(actId)
                });
            }
        });
        
        if(allActions.length > 0) {
            const splitAnims = allActions.filter(anim => anim.isSplit);
            if(splitAnims.length > 0) {
                splitAnims.sort((a, b) => {
                    const timeA = this._splitCreationTime.get(a.id) || 0;
                    const timeB = this._splitCreationTime.get(b.id) || 0;
                    return Number(timeB) - Number(timeA);
                });
                const selected = splitAnims[0];
                // 对于分割动画，返回简化对象
                return { id: selected.id, name: selected.name, action: selected.action };
            } else {
                const selected = allActions[0];
                // 对于原始动画，尝试返回完整的config对象
                const config = this.animations.get(selected.id);
                return config || { id: selected.id, name: selected.name, action: selected.action };
            }
        } else {
            // 如果actions中没找到，尝试在animations中查找
            const animations = this.getModelAnimations(modelId);
            const targetAnim = animations.find(anim => anim.name === animationName);
            if(targetAnim) {
                // 返回完整的config对象
                return targetAnim;
            }
        }
        return null;
    }
    
    /**
     * 处理绑定选项（playMode、loopType等）
     * @private
     * @param {Object} options - 用户选项
     * @returns {Object} 处理后的选项 {loopModeType, loopCount, clampWhenFinished, clickBehavior}
     */
    _processBindingOptions(options) {
        let loopModeType = options.loopModeType;
        let loopCount = options.loopCount;
        let clampWhenFinished = options.clampWhenFinished;
        let clickBehavior = options.clickBehavior;
        
        if (options.playMode !== undefined) {
            const playMode = Number(options.playMode);
            const loopType = options.loopType !== undefined ? Number(options.loopType) : LoopType.ONCE;
            const defaultLoopCount = (loopType === LoopType.MULTIPLE && options.loopCount === undefined) ? 3 : 1;
            const loopCountValue = options.loopCount !== undefined ? Number(options.loopCount) : defaultLoopCount;
            
            switch (playMode) {
                case PlayMode.SINGLE:
                    loopModeType = LoopModeType.ONCE;
                    loopCount = 1;
                    clampWhenFinished = false;
                    clickBehavior = clickBehavior || 'toggle';
                    break;
                case PlayMode.PING_PONG:
                    loopModeType = LoopModeType.PING_PONG;
                    loopCount = 1;
                    clampWhenFinished = false;
                    clickBehavior = clickBehavior || 'toggle';
                    break;
                case PlayMode.CLAMP_END:
                    loopModeType = LoopModeType.ONCE;
                    loopCount = 1;
                    clampWhenFinished = true;
                    clickBehavior = clickBehavior || 'toggle';
                    break;
                case PlayMode.CLICK_RETURN:
                    loopModeType = LoopModeType.ONCE;
                    loopCount = 1;
                    clampWhenFinished = true;
                    clickBehavior = 'restart-or-reverse';
                    break;
            }
            
            if (playMode === PlayMode.SINGLE || playMode === PlayMode.PING_PONG) {
                if (playMode === PlayMode.SINGLE) {
                    switch (loopType) {
                        case LoopType.ONCE:
                            loopModeType = LoopModeType.ONCE;
                            loopCount = 1;
                            break;
                        case LoopType.TWICE:
                            loopModeType = LoopModeType.REPEAT;
                            loopCount = 2;
                            break;
                        case LoopType.MULTIPLE:
                            loopModeType = LoopModeType.REPEAT;
                            loopCount = loopCountValue;
                            break;
                        case LoopType.INFINITE:
                            loopModeType = LoopModeType.REPEAT;
                            loopCount = -1;
                            break;
                    }
                } else if (playMode === PlayMode.PING_PONG) {
                    switch (loopType) {
                        case LoopType.ONCE:
                            loopCount = 1;
                            break;
                        case LoopType.TWICE:
                            loopCount = 2;
                            break;
                        case LoopType.MULTIPLE:
                            loopCount = loopCountValue;
                            break;
                        case LoopType.INFINITE:
                            loopCount = -1;
                            break;
                    }
                }
            }
        }
        
        return { loopModeType, loopCount, clampWhenFinished, clickBehavior };
    }
    
    /**
     * 创建绑定配置对象
     * @private
     * @param {THREE.Mesh} mesh - mesh对象
     * @param {string} modelId - 模型ID
     * @param {string} animationName - 动画名称
     * @param {string} animationId - 动画ID
     * @param {Object} originalConfig - 原始动画配置
     * @param {Object} options - 用户选项
     * @param {Object} processedOptions - 处理后的选项
     * @returns {Object} 绑定配置对象
     */
    _createBindingConfig(mesh, modelId, animationName, animationId, originalConfig, options, processedOptions) {
        const { loopModeType, loopCount, clampWhenFinished, clickBehavior } = processedOptions;
        
        // 处理 hoverColor：支持 "#ffffff" 格式，转换为十六进制数字
        let hoverColor = options.hoverColor;
        if (hoverColor && typeof hoverColor === 'string') {
            // 移除 # 号并转换为十六进制数字
            const colorStr = hoverColor.replace(/^#/, '');
            hoverColor = parseInt(colorStr, 16);
            // 如果转换失败，设为 undefined
            if (isNaN(hoverColor)) {
                hoverColor = undefined;
            }
        }
        
        return {
            modelId,
            meshName: mesh.userData?.id || mesh.uuid,
            meshUuid: mesh.uuid,
            animationName,
            animationId,
            options: {
                // 先展开原始 options（保留所有原始属性）
                ...options,
                // 然后显式设置处理后的属性，确保优先级高于原始 options
                fadeIn: options.fadeIn !== undefined ? options.fadeIn : (originalConfig?.fadeInTime || 0),
                fadeOut: options.fadeOut !== undefined ? options.fadeOut : (originalConfig?.fadeOutTime || 0),
                speed: options.speed !== undefined ? options.speed : (originalConfig?.speed || CONSTANTS.DEFAULT_SPEED),
                playDirectionType: options.playDirectionType !== undefined ? options.playDirectionType : (originalConfig?.playDirection === -1 ? 2 : 1),
                // 关键：使用 processedOptions 处理后的值，覆盖原始 options 中的值
                loopModeType: loopModeType !== undefined ? loopModeType : (options.loopModeType !== undefined ? options.loopModeType : (originalConfig?.loopMode || LoopModeType.REPEAT)),
                loopCount: loopCount !== undefined ? loopCount : (options.loopCount !== undefined ? options.loopCount : (originalConfig?.loopCount !== undefined ? originalConfig.loopCount : -1)),
                startDelayTime: options.startDelayTime !== undefined ? options.startDelayTime : (originalConfig?.startDelay || 0),
                weight: options.weight !== undefined ? options.weight : (originalConfig?.weight !== undefined ? originalConfig.weight * CONSTANTS.WEIGHT_UI_SCALE : CONSTANTS.WEIGHT_UI_SCALE),
                activeType: options.activeType !== undefined ? options.activeType : 1,
                clampWhenFinished: clampWhenFinished !== undefined ? clampWhenFinished : (options.clampWhenFinished !== undefined && options.playMode !== PlayMode.CLAMP_END && options.playMode !== PlayMode.CLICK_RETURN ? options.clampWhenFinished : false),
                clickBehavior: clickBehavior || (options.clickBehavior !== undefined && options.playMode !== PlayMode.CLICK_RETURN ? options.clickBehavior : 'toggle'),
                playMode: options.playMode,
                loopType: options.loopType,
                hoverColor: hoverColor !== undefined ? hoverColor : undefined
            },
            mesh: mesh
        };
    }
    
    /**
     * 清理旧绑定
     * @private
     * @param {string} bindingKey - 绑定键
     */
    _cleanupOldBinding(bindingKey) {
        const existingBinding = this._meshAnimationBindings.get(bindingKey);
        if (!existingBinding) return;
        
        const oldAction = this.actions.get(existingBinding.animationId);
        if (oldAction) {
            try { oldAction.stop(); } catch (_) {}
            try { oldAction.reset(); } catch (_) {}
            oldAction.enabled = false;
            oldAction.paused = true;
            if (oldAction._clampAtEnd) delete oldAction._clampAtEnd;
            if (oldAction._playSplitFinishedHandler) {
                try { oldAction.removeEventListener?.('finished', oldAction._playSplitFinishedHandler); } catch (_) {}
                delete oldAction._playSplitFinishedHandler;
            }
        }
        if (!this._isSplitAnimationId(existingBinding.animationId)) {
            this._stopAnimation(existingBinding.animationId);
        }
        this._meshAnimationBindings.delete(bindingKey);
        this._boundMeshes.delete(existingBinding.mesh);
        if (existingBinding.mesh?.userData) {
            delete existingBinding.mesh.userData.__hasAnimationBinding;
            delete existingBinding.mesh.userData.__bindingKey;
        }
        this._meshToModelIdCache.delete(existingBinding.mesh);
    }
    
    /**
     * 应用绑定到mesh
     * @private
     * @param {Object} binding - 绑定配置
     * @param {string} bindingKey - 绑定键
     */
    _applyBindingToMesh(binding, bindingKey) {
        this._meshAnimationBindings.set(bindingKey, binding);
        this._boundMeshes.add(binding.mesh);
        
        if (!binding.mesh.userData) binding.mesh.userData = {};
        binding.mesh.userData.__hasAnimationBinding = true;
        binding.mesh.userData.__bindingKey = bindingKey;
        this._meshToModelIdCache.set(binding.mesh, binding.modelId);
        
        const eventData = {
            modelId: binding.modelId,
            meshName: binding.meshName,
            meshUuid: binding.meshUuid,
            meshId: binding.mesh?.userData?.id || null,
            animationName: binding.animationName,
            animationId: binding.animationId,
            bindingKey
        };
        
        this.events.emit('mesh:animation:bound', eventData);
        if (this.engine?.events) {
            this.engine.events.emit('mesh:animation:bound', eventData);
        }
    }
    
    /**
     * 绑定mesh和动画
     * @param {string} modelId - 模型ID
     * @param {string} meshIdentifier - mesh的userData.id或UUID（优先使用userData.id）
     * @param {string} animationName - 动画名称
     * @param {Object} options - 绑定选项 {
     *   playMode,                // 播放模式 1-单次播放, 2-单次往返, 3-播放到结束停止, 4-点击返回
     *   loopType,                 // 循环类型 1-单次, 2-两次, 3-多次, 4-无限次
     *   loopCount,                // 循环次数
     *   clampWhenFinished,        // 是否停在最后一帧
     *   clickBehavior,             // 点击行为
     * }
     * @returns {boolean} 是否成功
     */
    bindMeshAnimation(modelId, meshIdentifier, animationName, options = {}) {
        const model = this.engine?.assetsManager?.getModel(modelId);
        if(!model) {
            console.warn("找不到该模型: ",modelId);
            return false;
        }

        const mesh = this._findMeshInModel(model, meshIdentifier);
        if(!mesh) {
            console.warn("找不到该mesh: ", meshIdentifier);
            console.warn("模型ID: ", modelId);
            const allMeshIds = [];
            model.traverse((obj) => {
                if (obj.isMesh) {
                    allMeshIds.push({
                        uuid: obj.uuid,
                        id: obj.userData?.id || '无'
                    });
                }
            });
            console.warn("模型中的所有mesh (前10个):", allMeshIds.slice(0, 10));
            return false;
        }

        // === 兼容性处理：如果传入对象，提取 name 或 id ===
        let actualAnimationName = animationName;
        if (typeof animationName === 'object' && animationName !== null) {
            // 优先使用 name，如果没有则使用 id 或 animationName
            actualAnimationName = animationName.name || animationName.id || animationName.animationName;
            if (!actualAnimationName) {
                console.warn("传入的动画对象缺少 name、id 或 animationName 属性:", animationName);
                return false;
            }
        }
        // ==========================================

        // 支持通过动画名称或动画ID查找
        let targetAnim = this._findAnimationByName(modelId, actualAnimationName);
        
        // 如果通过名称找不到，尝试通过ID查找（用于splitByTime返回的ID）
        if (!targetAnim) {
            const action = this.actions.get(actualAnimationName);
            if (action) {
                const info = this._actionToInfo.get(action);
                if (info && info.modelId === modelId) {
                    const config = this.animations.get(actualAnimationName);
                    targetAnim = config || { id: actualAnimationName, name: info.name, action };
                }
            }
        }
        
        if(!targetAnim) {
            console.warn("找不到该动画: ", actualAnimationName, "(原始参数类型:", typeof animationName, ")");
            return false;
        }

        const animationId = targetAnim.id;
        const originalConfig = this.animations.get(animationId);
        const processedOptions = this._processBindingOptions(options);
        const binding = this._createBindingConfig(mesh, modelId, actualAnimationName, animationId, originalConfig, options, processedOptions);
        
        // 使用稳定的 userData.id 生成 bindingKey
        const bindingKey = this._getBindingKey(mesh, modelId);
        if (!bindingKey) {
            console.warn('无法生成绑定键，绑定失败');
            return false;
        }
        this._cleanupOldBinding(bindingKey);
        this._applyBindingToMesh(binding, bindingKey);
        
        return true;
    }

    /**
     * 开始绑定模式：等待用户点击mesh来绑定动画
     * @param {string|Array<string>} clipUuid - 动画clip的UUID（支持数组，自动取第一个）
     * @param {Object} options - 绑定选项（可选）
     * @returns {boolean} 是否成功进入绑定模式
     */
    startAnimationBinding(clipUuid, options = {}) {
        // 支持数组，自动取第一个元素
        const uuid = Array.isArray(clipUuid) ? clipUuid[0] : clipUuid;
        const animationInfo = this._findAnimationByClipUuid(uuid);
        if (!animationInfo) {
            console.warn(`找不到UUID为 ${uuid} 的动画`);
            return false;
        }

        //检查射线检测是否开启
        if (this.engine?.inputManager) {
            this.engine.inputManager.setRaycastEnabled(true);
            console.log("必须开启射线检测才能进入绑定模式")
        }

        // 规范化绑定选项，确保默认"单次播放一次"
        const normalizedOptions = { ...options };

        // 兼容外部传入的 playType，映射到内部的 playMode
        if (normalizedOptions.playMode === undefined && normalizedOptions.playType !== undefined) {
            normalizedOptions.playMode = Number(normalizedOptions.playType);
        }

        // 如果既没有 playMode / playType，也没有 loopType / loopCount，
        // 则默认：单次播放一次（不循环）
        if (
            normalizedOptions.playMode === undefined &&
            normalizedOptions.playType === undefined &&
            normalizedOptions.loopType === undefined &&
            normalizedOptions.loopCount === undefined
        ) {
            normalizedOptions.playMode = PlayMode.SINGLE;   // 单次播放
            normalizedOptions.loopType = LoopType.ONCE;     // 一次
        }
        
        this._bindingState = { clipUuid: uuid, animationInfo, options: normalizedOptions };
        
        // 1. 获取所有相关的 Mesh（使用动画ID）
        const relatedMeshes = this.getAnimationMeshes(animationInfo.modelId, animationInfo.animationId);
        
        if (relatedMeshes.length === 0) {
            console.warn('AnimationController: 该动画没有关联到任何可见 Mesh');
            return true; 
        }

        try {
            const action = this.actions.get(animationInfo.animationId);
            const mixer = this.mixers.get(animationInfo.modelId);

            if (action && mixer) {
                // 1) 清场：停止该 mixer 上所有动画，避免 Idle/其它动作权重干扰
                try { mixer.stopAllAction?.(); } catch (_) {}

                // 2) 彻底重置当前 Action
                try { action.stop?.(); } catch (_) {}
                try { action.reset?.(); } catch (_) {}

                // 3) 强制配置为单次播放，并停在结束处（避免 LoopRepeat 导致 time=duration 回到 0）
                try { action.setLoop?.(LoopOnce, 1); } catch (_) {}
                action.clampWhenFinished = true;

                // 4) 确保权重为 1
                action.enabled = true;
                try { action.setEffectiveWeight?.(1.0); } catch (_) {}
                try { action.fadeIn?.(0); } catch (_) {}

                // 5) 获取时长（兼容 f3d/three：优先 _clip，其次 getClip）
                let clip = action._clip;
                try { clip = clip || action.getClip?.(); } catch (_) {}
                const duration = clip ? (Number(clip.duration) || 0) : 0;

                // 6) 先 Play 激活，再暂停，再设时间（时序很关键）
                try { action.play?.(); } catch (_) {}
                action.paused = true;
                action.timeScale = 1;

                // 7) 设置时间到"最后一帧附近"
                const epsilon = 0.001;
                action.time = duration > 0 ? Math.max(0, duration - epsilon) : 0;

                // 8) 强制更新一次 Mixer，使末帧姿态立即生效
                try { mixer.update?.(0); } catch (_) {}

                // 9) 记录当前预览的动画ID，以便退出时恢复
                this._previewingBindingAnimationId = animationInfo.animationId;
            } else {
                console.warn(`[绑定预览] 无法找到动画 action 或 mixer，animationId: ${animationInfo.animationId}, modelId: ${animationInfo.modelId}`);
            }
        } catch (e) {
            console.warn("设置动画最后一帧预览失败:", e);
        }
        
        const hl = this.engine?.highlightController;
        if (!hl) {
            console.warn('HighlightController 未初始化');
            return false;
        }
        
        const whiteList = [];
        const redList = [];
        this._highlightedMeshesSet.clear();
        
        const model = this.engine?.assetsManager?.getModel(animationInfo.modelId);
        const processedMeshes = new Set();
        const logicalIdCache = new Map();
        const bindingKeyCache = new Map();
        
        for (let i = 0; i < relatedMeshes.length; i++) {
            const mesh = relatedMeshes[i].mesh;
            if (!mesh?.isMesh) continue;
            if (!mesh.geometry?.attributes?.position) continue;
            
            if (processedMeshes.has(mesh)) continue;
            processedMeshes.add(mesh);
            
            this._highlightedMeshesSet.add(mesh);
            
            let logicalInfo = logicalIdCache.get(mesh);
            if (!logicalInfo) {
                // 优先使用 getAnimationMeshes 返回的 cached logicalInfo
                if (relatedMeshes[i].logicalInfo) {
                    logicalInfo = relatedMeshes[i].logicalInfo;
                } else {
                    logicalInfo = this._findLogicalId(mesh, model);
                }
                logicalIdCache.set(mesh, logicalInfo);
            }
            
            if (logicalInfo?.node && logicalInfo.node !== mesh) {
                this._highlightedMeshesSet.add(logicalInfo.node);
            }
            
            let bindingKey = bindingKeyCache.get(mesh);
            if (!bindingKey) {
                bindingKey = this._getBindingKey(mesh, animationInfo.modelId);
                if (bindingKey) bindingKeyCache.set(mesh, bindingKey);
            }
            
            const hasBinding = (bindingKey && this._meshAnimationBindings.has(bindingKey)) || 
                              mesh.userData?.__hasAnimationBinding ||
                              (logicalInfo && logicalInfo.hasBinding);
            
            if (hasBinding) {
                redList.push(mesh);
            } else {
                whiteList.push(mesh);
            }
        }
        
        hl.highlightByType(whiteList, { type: 'animation' });
        hl.highlightByType(redList, { type: 'error' });
        
        this._highlightedMeshes.length = 0;
        this._highlightedMeshes.push(...whiteList, ...redList);
        
        return true;
    }

    /**
     * 取消绑定模式
     */
    cancelAnimationBinding() {
        if (this._previewingBindingAnimationId) {
            const animationId = this._previewingBindingAnimationId;
            const config = this.animations.get(animationId);
            
            // 使用现有的停止逻辑，它包含了 stop(), reset(), time=0 以及 restoreModelState
            if (config) {
                this._stopAnimation(animationId);
            } else {
                // 如果是 Split 动画（没有 config），需要手动重置
                const action = this.actions.get(animationId);
                if (action) {
                    action.stop();
                    action.reset();
                    action.time = 0;
                    action.paused = false; // 恢复暂停状态
                    action.enabled = false;
                }
                // 尝试恢复初始 PSR (Position/Scale/Rotation)
                this._restoreModelState(animationId);
            }
            
            // 强制刷新一次 mixer 确保回到初始 Pose
            if (this._bindingState && this._bindingState.animationInfo) {
                const mixer = this.mixers.get(this._bindingState.animationInfo.modelId);
                if (mixer) mixer.update(0);
            }

            this._previewingBindingAnimationId = null;
        }

        this.clearAnimationMeshHighlights();
        this._bindingState = null;
        this._highlightedMeshesSet.clear();
    }

    /**
     * 批量绑定mesh和动画
     * @param {Array} bindings - 绑定数组 [{modelId, mesh, animation, options}, ...]
     * @returns {number} 成功数量
     */
    bindMeshAnimations(bindings) {
        let successCount = 0;
        bindings.forEach(binding => {
            if (this.bindMeshAnimation(
                binding.modelId,
                binding.mesh,
                binding.animation,
                binding.options || {}
            )) {
                successCount++;
            }
        });
        return successCount;
    }

    /**
     * 解绑mesh和动画
     * @param {string} modelId - 模型ID
     * @param {string} meshIdentifier - mesh的userData.id或UUID（优先使用userData.id）
     * @returns {boolean} 是否成功
     */
    unbindMeshAnimation(modelId, meshIdentifier) {
        const model = this.engine?.assetsManager?.getModel(modelId);
        if (!model) return false;
        
        const mesh = this._findMeshInModel(model, meshIdentifier);
        if (!mesh) return false;
        
        // 使用稳定的 userData.id 生成 bindingKey
        const bindingKey = this._getBindingKey(mesh, modelId);
        if (!bindingKey) {
            console.warn('无法生成绑定键，解绑失败');
            return false;
        }
        const binding = this._meshAnimationBindings.get(bindingKey);
        
        if (binding) {
            this._meshAnimationBindings.delete(bindingKey);
            this._boundMeshes.delete(mesh);
            
            if (mesh.userData) {
                delete mesh.userData.__hasAnimationBinding;
                delete mesh.userData.__bindingKey;
            }
            this._meshToModelIdCache.delete(mesh);
            
            const eventData = { 
                modelId, 
                meshName: mesh.userData?.id || mesh.uuid, 
                meshUuid: mesh.uuid,
                meshId: mesh?.userData?.id || null,
                bindingKey 
            };
            this.events.emit('mesh:animation:unbound', eventData);
            if (this.engine?.events) {
                this.engine.events.emit('mesh:animation:unbound', eventData);
            }
            return true;
        }
        
        return false;
    }

    /**
     * 获取mesh的绑定信息
     * @param {string} modelId - 模型ID
     * @param {string} meshIdentifier - mesh的userData.id或UUID（优先使用userData.id）
     * @returns {Object|null} 绑定信息
     */
    getMeshBinding(modelId, meshIdentifier) {
        const model = this.engine?.assetsManager?.getModel(modelId);
        if (!model) return null;
        
        const mesh = this._findMeshInModel(model, meshIdentifier);
        if (!mesh) return null;
        
        // 使用稳定的 userData.id 生成 bindingKey
        const bindingKey = this._getBindingKey(mesh, modelId);
        if (!bindingKey) return null;
        return this._meshAnimationBindings.get(bindingKey) || null;
    }

    /**
     * 获取所有绑定信息
     * @returns {Array} 绑定列表
     */
    getAllBindings() {
        return Array.from(this._meshAnimationBindings.values());
    }

    getModelBindings(modelId) {
        return Array.from(this._meshAnimationBindings.values()).filter(b => b.modelId === modelId);
    }

    /**
     * 更新mesh绑定的参数（不重新绑定动画）
     * @param {string} modelId 模型ID
     * @param {string} meshIdentifier mesh的userData.id、名称或UUID（优先使用userData.id）
     * @param {Object} options 要更新的参数选项（部分更新）
     * @returns {boolean} 是否成功
     */
    updateMeshBinding(modelId, meshIdentifier, options = {}) {
        const model = this.engine?.assetsManager?.getModel(modelId);
        if (!model) {
            console.warn("找不到该模型: ", modelId);
            return false;
        }

        const mesh = this._findMeshInModel(model, meshIdentifier);
        if (!mesh) {
            console.warn("找不到该mesh: ", meshIdentifier);
            return false;
        }

        // 使用稳定的 userData.id 生成 bindingKey
        const bindingKey = this._getBindingKey(mesh, modelId);
        if (!bindingKey) {
            console.warn('无法生成绑定键，更新失败');
            return false;
        }
        const binding = this._meshAnimationBindings.get(bindingKey);

        if (!binding) {
            console.warn(`Mesh "${meshIdentifier}" 没有绑定动画，无法更新参数`);
            return false;
        }

        // 合并新的参数到现有options
        const oldOptions = { ...binding.options };
        binding.options = {
            ...binding.options,
            ...options
        };

        // 检查动画是否正在播放
        const isSplitAnimation = this._isSplitAnimationId(binding.animationId);
        const config = this.animations.get(binding.animationId);
        let action = null;
        let isPlaying = false;

        if (config && !isSplitAnimation) {
            // 原始动画
            action = config.action;
            isPlaying = config.enabled && action?.isRunning?.();
        } else if (isSplitAnimation) {
            // 分割动画
            action = this.actions.get(binding.animationId);
            isPlaying = action?.enabled && action?.isRunning?.();
        }

        // 如果正在播放，应用新参数
        if (isPlaying && action) {
            const speed = binding.options.speed || CONSTANTS.DEFAULT_SPEED;
            const isReverse = binding.options.playDirectionType === 2 || binding.options.playDirection === -1;
            const shouldClamp = binding.options.clampWhenFinished !== undefined 
                ? binding.options.clampWhenFinished 
                : (binding.options.loopModeType === 1 || binding.options.loopMode === 1);
            const weight = binding.options.weight !== undefined ? binding.options.weight / CONSTANTS.WEIGHT_UI_SCALE : 1.0;
            
            const loopModeType = binding.options.loopModeType !== undefined 
                ? binding.options.loopModeType 
                : (binding.options.loopMode !== undefined ? binding.options.loopMode : LoopModeType.ONCE);
            const loopCount = binding.options.loopCount !== undefined ? binding.options.loopCount : 1;

            // 更新action参数
            if (isSplitAnimation) {
                // 分割动画：直接更新action
                if (loopModeType === LoopModeType.ONCE) {
                    action.setLoop(LoopOnce, 1);
                } else if (loopModeType === LoopModeType.PING_PONG) {
                    const repetitions = loopCount === -1 ? Infinity : (loopCount > 0 ? loopCount * 2 - 1 : 0);
                    action.setLoop(LoopPingPong, repetitions);
                } else if (loopModeType === LoopModeType.REPEAT) {
                    const repetitions = loopCount === -1 ? Infinity : (loopCount > 0 ? loopCount - 1 : 0);
                    action.setLoop(LoopRepeat, repetitions);
                } else {
                    action.setLoop(LoopOnce, 1);
                }
                action.timeScale = Math.abs(speed) * (isReverse ? -1 : 1);
                action.clampWhenFinished = shouldClamp;
                action.setEffectiveWeight(Math.max(0, Math.min(1, weight)));
            } else if (config) {
                // 原始动画：更新config并应用
                // 映射绑定选项到config格式
                if (binding.options.speed !== undefined) {
                    config.speed = binding.options.speed;
                }
                if (binding.options.playDirectionType !== undefined) {
                    config.playDirection = binding.options.playDirectionType === 2 ? -1 : 1;
                } else if (binding.options.playDirection !== undefined) {
                    config.playDirection = binding.options.playDirection;
                }
                if (binding.options.loopModeType !== undefined) {
                    config.loopMode = binding.options.loopModeType;
                } else if (binding.options.loopMode !== undefined) {
                    config.loopMode = binding.options.loopMode;
                }
                if (binding.options.loopCount !== undefined) {
                    config.loopCount = binding.options.loopCount;
                }
                if (binding.options.clampWhenFinished !== undefined) {
                    config.clampWhenFinished = binding.options.clampWhenFinished;
                }
                if (binding.options.weight !== undefined) {
                    config.weight = binding.options.weight / CONSTANTS.WEIGHT_UI_SCALE; // 转换为0-1范围
                }
                if (binding.options.fadeIn !== undefined) {
                    config.fadeInTime = binding.options.fadeIn;
                }
                if (binding.options.fadeOut !== undefined) {
                    config.fadeOutTime = binding.options.fadeOut;
                }
                this._applyConfigToAction(config);
            }
        }

        // 触发更新事件
        const eventData = {
            modelId,
            meshName: binding.meshName,
            meshUuid: binding.meshUuid,
            meshId: binding.mesh?.userData?.id || null,
            animationName: binding.animationName,
            animationId: binding.animationId,
            oldOptions,
            newOptions: binding.options
        };
        this.events.emit('mesh:animation:updated', eventData);
        if (this.engine?.events) {
            this.engine.events.emit('mesh:animation:updated', eventData);
        }

        console.log(`更新绑定参数: Mesh "${meshIdentifier}" -> 动画 "${binding.animationName}"`);
        return true;
    }

    /**
     * 播放mesh绑定的动画
     * @param {THREE.Mesh} mesh - mesh对象
     * @param {string} modelId - 模型ID（可选）
     * @returns {boolean} 是否成功
     */
    playMeshAnimation(mesh, modelId = null) {
        if (!mesh) return false;
        
        if (!modelId) {
            if (this._meshToModelIdCache.has(mesh)) {
                modelId = this._meshToModelIdCache.get(mesh);
            } else {
                const bindingKey = mesh.userData?.__bindingKey;
                if (bindingKey) {
                    const binding = this._meshAnimationBindings.get(bindingKey);
                    if (binding) {
                        modelId = binding.modelId;
                    }
                }
                if (!modelId) {
                    modelId = this._findModelIdByMesh(mesh);
                }
                if (modelId) this._meshToModelIdCache.set(mesh, modelId);
            }
        }
        
        if (!modelId) {
            console.warn('无法确定模型ID');
            return false;
        }
        
        // 使用稳定的 userData.id 生成 bindingKey
        const bindingKey = this._getBindingKey(mesh, modelId);
        if (!bindingKey) {
            console.warn('Mesh 缺少稳定 ID，无法播放动画');
            return false;
        }
        const binding = this._meshAnimationBindings.get(bindingKey);
        
        if (!binding) {
            console.warn(`Mesh "${mesh.userData?.id || 'unknown'}" 没有绑定动画`);
            return false;
        }
        
        // 检查是原始动画还是分割动画
        const isSplitAnimation = this._isSplitAnimationId(binding.animationId);
        const config = this.animations.get(binding.animationId);
        let success = false;
        
        // 如果是分割动画，即使config存在也走分割动画的播放逻辑
        if (config && !isSplitAnimation) {
            // 原始动画：使用现有的playAnimationByName方法
            success = this.playAnimationByName(
                binding.modelId,
                binding.animationName,
                binding.options
            );
        } else {
            // 分割动画：直接使用action播放
            success = this._playSplitAnimation(binding);
        }
        
        if (success) {
            const eventData = {
                modelId: binding.modelId,
                meshName: binding.meshName,
                meshUuid: binding.meshUuid,
                meshId: binding.mesh?.userData?.id || null,
                animationName: binding.animationName,
                animationId: binding.animationId
            };
            this.events.emit('mesh:animation:played', eventData);
            if (this.engine?.events) {
                this.engine.events.emit('mesh:animation:played', eventData);
            }
        }
        
        return success;
    }

    /**
     * 查找mesh所属的模型ID
     * @private
     */
    _findModelIdByMesh(mesh) {
        if (this.engine?.assetsManager?.assets?.models) {
            for (const [modelId, model] of this.engine.assetsManager.assets.models) {
                let found = false;
                model.traverse((obj) => {
                    if (obj === mesh) found = true;
                });
                if (found) return modelId;
            }
        }
        return null;
    }

    /**
     * 处理mesh点击事件（包含点击过滤）
     * @private
     */
    _onMeshClick(data) {
        if (!data?.object || !data.object.geometry?.attributes?.position) return;
        
        // 先检查是否点击到热点，如果点击到热点则不处理mesh点击
        // 获取鼠标位置（从data.position或inputManager的当前鼠标位置）
        const position = data.position || (this.engine?.inputManager?.mouse?.position);
        if (position && this.engine?.hotspotController) {
            const hotspotHit = this.engine.hotspotController._intersectHotspotAt(position);
            if (hotspotHit?.hotspot) {
                // 点击到热点，不处理mesh点击，避免触发绑定的动画
                return;
            }
        }
        
        const originalMesh = data.object;
        const modelId = data.modelId;
        
        // 查找逻辑节点（用于后续操作）
        const model = this.engine?.assetsManager?.getModel(modelId);
        const logicalInfo = this._findLogicalId(originalMesh, model);
        const logicalMesh = logicalInfo ? logicalInfo.node : originalMesh;
        
        if (this._bindingState) {
            let isValidClick = this._highlightedMeshesSet.has(originalMesh);
            
            if (!isValidClick && logicalMesh) {
                isValidClick = this._highlightedMeshesSet.has(logicalMesh);
            }
            
            // 如果还没找到，向上遍历父节点链
            if (!isValidClick) {
                let current = originalMesh.parent;
                while (current && current !== model && current !== this.scene) {
                    if (this._highlightedMeshesSet.has(current)) {
                        isValidClick = true;
                        break;
                    }
                    current = current.parent;
                }
            }
            
            if (!isValidClick) {
                // 点击了无效区域，拦截操作
                console.log('点击无效区域，请点击高亮物体进行绑定');
                return;
            }
            
            // 绑定应该使用原始的 mesh（有 geometry 的），而不是逻辑节点
            // 因为 bindMeshAnimation 需要实际的 mesh 对象
            this._handleBindingClick(originalMesh, modelId, logicalMesh);
            return;
        }
        
        // === 普通模式逻辑 ===
        // 检查是否启用点击mesh触发动画播放
        if (!this.globalSettings.clickMeshPlayAnimationEnabled) {
            return;
        }
        
        if (logicalMesh.userData?.__hasAnimationBinding) {
            this._handleMeshAnimationClick(logicalMesh, modelId);
        } else if (originalMesh.userData?.__hasAnimationBinding) {
            this._handleMeshAnimationClick(originalMesh, modelId);
        }
    }

    /**
     * 处理绑定模式下的点击
     * @private
     * @param {THREE.Mesh} mesh 点击的原始 mesh 对象（已经高亮的 mesh）
     * @param {string} modelId 模型ID
     * @param {THREE.Object3D} [logicalMesh] 逻辑节点（可选，仅用于日志显示）
     */
    _handleBindingClick(mesh, modelId, logicalMesh = null) {
        if (!mesh || !mesh.isMesh) {
            console.warn('绑定失败：点击的对象不是有效的 Mesh', mesh);
            return;
        }
        
        const { animationInfo, options } = this._bindingState;
        if (modelId !== animationInfo.modelId) {
            console.warn(`mesh属于模型 ${modelId}，动画属于模型 ${animationInfo.modelId}`);
            return;
        }
        
        const meshIdentifier = mesh.userData?.id || mesh.uuid;
        // 使用稳定的 userData.id 生成 bindingKey
        const bindingKey = this._getBindingKey(mesh, modelId);
        if (!bindingKey) {
            console.warn('Mesh 缺少稳定 ID，无法绑定动画');
            return;
        }
        
        // 检查是否已经绑定
        const existingBinding = this._meshAnimationBindings.get(bindingKey);
        // console.error("existingBinding", existingBinding);
        if (existingBinding) {
            // 已经绑定，触发事件而不是替换绑定
            const eventData = {
                modelId: modelId,
                meshName: mesh.userData?.id || mesh.uuid,
                meshUuid: mesh.uuid,
                meshId: mesh?.userData?.id || null,
                animationName: existingBinding.animationName,
                animationId: existingBinding.animationId,
                bindingKey: bindingKey,
                binding: existingBinding, // 完整的绑定信息
                mesh: mesh, // mesh对象引用
                logicalMesh: logicalMesh // 逻辑节点
            };
            
            console.log(`点击了已绑定的mesh:`);
            console.log(`   Mesh ID: ${mesh.userData?.id || mesh.uuid}`);
            console.log(`   Mesh UUID: ${mesh.uuid}`);
            console.log(`   已绑定动画: "${existingBinding.animationName}"`);
            
            // 触发事件（使用明确的事件名，表示绑定模式下的点击）
            this.events.emit('mesh:animation:binding:clicked', eventData);
            if (this.engine?.events) {
                this.engine.events.emit('mesh:animation:binding:clicked', eventData);
            }
                
            return; 
        }
        
        // 未绑定，执行正常的绑定流程
        console.log(`点击绑定:`);
        console.log(`   Mesh ID: ${mesh.userData?.id || mesh.uuid}`);
        console.log(`   Mesh UUID: ${mesh.uuid}`);
        if (logicalMesh && logicalMesh !== mesh) {
            console.log(`   逻辑节点: ${logicalMesh.userData?.id || logicalMesh.type}`);
        }
        console.log(`   动画名称: "${animationInfo.animationName}"`);
        console.log(`   使用标识: "${meshIdentifier}"`);
        
        // 使用 userData.id 进行绑定
        const bindingIdentifier = mesh.userData?.id || mesh.uuid;
        if (this.bindMeshAnimation(modelId, bindingIdentifier, animationInfo.animationName, options || {})) {
            console.log(`动画 "${animationInfo.animationName}" 已成功绑定到 mesh "${meshIdentifier}"`);
            
            if (this._previewingBindingAnimationId) {
                const animationId = this._previewingBindingAnimationId;
                const config = this.animations.get(animationId);
                
                if (config) {
                    this._stopAnimation(animationId);
                } else {
                    // 针对 Split 动画的额外清理
                    const action = this.actions.get(animationId);
                    if (action) {
                        action.stop();
                        action.reset();
                        action.time = 0;
                        action.paused = false;
                        action.enabled = false;
                    }
                    this._restoreModelState(animationId);
                }
                
                // 强制刷新 Mixer
                const mixer = this.mixers.get(modelId);
                if (mixer) mixer.update(0);

                this._previewingBindingAnimationId = null;
            }

            this.clearAnimationMeshHighlights(); // 绑定成功后清除高亮
            this._bindingState = null; // 绑定成功后自动退出
        } else {
            console.warn(`动画 "${animationInfo.animationName}" 绑定失败到 mesh "${meshIdentifier}"`);
            console.warn(`   提示：请检查 mesh 标识是否正确`);
        }
    }

    /**
     * 获取action状态信息
     * @private
     * @param {Object} binding - 绑定配置
     * @returns {Object|null} {action, config, isRunning, isPaused, isFinishedAtEnd, ...} 或 null
     */
    _getActionState(binding) {
        const isSplitAnimation = this._isSplitAnimationId(binding.animationId);
        const config = this.animations.get(binding.animationId);
        
        let action = null;
        if (config) {
            action = config.action;
        } else if (isSplitAnimation) {
            action = this.actions.get(binding.animationId);
        }
        
        if (!action) return null;
        
        const isRunning = action.isRunning?.() || false;
        const isPaused = action.paused || false;
        const currentTime = action.time || 0;
        const duration = action._clip?.duration || config?.duration || 0;
        const clampWhenFinished = binding.options.clampWhenFinished !== undefined 
            ? binding.options.clampWhenFinished 
            : (config?.loopMode === 1);
        const currentTimeScale = action.timeScale || 1;
        const isCurrentlyReverse = currentTimeScale < 0;
        
        return {
            action,
            config,
            isRunning,
            isPaused,
            currentTime,
            duration,
            clampWhenFinished,
            isCurrentlyReverse
        };
    }
    
    /**
     * 检查动画是否已完成
     * @private
     * @param {Object} actionState - action状态
     * @returns {boolean} 是否已完成
     */
    _checkAnimationFinished(actionState) {
        const { currentTime, duration, clampWhenFinished, isCurrentlyReverse } = actionState;
        if (!clampWhenFinished) return false;
        
        const isAtEnd = duration > 0 && Math.abs(currentTime - duration) < CONSTANTS.TIME_EPSILON;
        const isAtStart = currentTime <= CONSTANTS.TIME_EPSILON;
        
        return (!isCurrentlyReverse && isAtEnd) || (isCurrentlyReverse && isAtStart);
    }
    
    /**
     * 处理点击行为
     * @private
     * @param {THREE.Mesh} mesh - mesh对象
     * @param {string} modelId - 模型ID
     * @param {Object} binding - 绑定配置
     * @param {Object} actionState - action状态
     */
    _handleClickBehavior(mesh, modelId, binding, actionState) {
        const clickBehavior = binding.options.clickBehavior || 'toggle';
        const { action, config, isRunning, isPaused, isCurrentlyReverse } = actionState;
        const isFinishedAtEnd = this._checkAnimationFinished(actionState);
        
        const pauseAction = () => {
            if (config) {
                this.pauseAnimation(config.id);
            } else {
                action.paused = true;
            }
        };
        
        const resumeAction = () => {
            if (config) {
                const savedTimeScale = action.timeScale;
                this.resumeAnimation(config.id);
                if (action.timeScale !== savedTimeScale) {
                    action.timeScale = savedTimeScale;
                }
            } else {
                action.paused = false;
                action.play();
            }
        };
        
        const toggleDirection = () => {
            const newDirection = !isCurrentlyReverse;
            binding.options.playDirectionType = newDirection ? 2 : 1;
            binding.options.playDirection = newDirection ? -1 : 1;
        };
        
        if (clickBehavior === 'toggle') {
            if (isFinishedAtEnd) {
                this.playMeshAnimation(mesh, modelId);
            } else if (isRunning && !isPaused) {
                pauseAction();
            } else if (isPaused) {
                resumeAction();
            } else {
                this.playMeshAnimation(mesh, modelId);
            }
        } else if (clickBehavior === 'restart') {
            this.playMeshAnimation(mesh, modelId);
        } else if (clickBehavior === 'reverse' || clickBehavior === 'restart-or-reverse') {
            if (isFinishedAtEnd) {
                toggleDirection();
                this.playMeshAnimation(mesh, modelId);
            } else if (isRunning && !isPaused) {
                pauseAction();
            } else if (isPaused) {
                resumeAction();
            } else {
                this.playMeshAnimation(mesh, modelId);
            }
        } else {
            this.playMeshAnimation(mesh, modelId);
        }
    }
    
    /**
     * 处理mesh动画点击（支持切换播放/暂停、重新播放、反向播放）
     * @private
     */
    _handleMeshAnimationClick(mesh, modelId) {
        // 使用稳定的 userData.id 生成 bindingKey
        const bindingKey = this._getBindingKey(mesh, modelId);
        if (!bindingKey) {
            console.warn('Mesh 缺少稳定 ID，无法处理点击');
            return;
        }
        const binding = this._meshAnimationBindings.get(bindingKey);
        
        if (!binding) return;
        
        // 触发点击有绑定动画的mesh回调事件
        const eventData = {
            mesh: mesh,
            modelId: modelId,
            meshId: mesh.userData?.id || null,
            meshUuid: mesh.uuid,
            animationName: binding.animationName,
            animationId: binding.animationId,
            binding: binding
        };
        this.events.emit('mesh:animation:clicked', eventData);
        if (this.engine?.events) {
            this.engine.events.emit('mesh:animation:clicked', eventData);
        }
        
        //注释掉点击动画播放逻辑
        // const actionState = this._getActionState(binding);
        // if (!actionState) {
        //     this.playMeshAnimation(mesh, modelId);
        //     return;
        // }
        
        // this._handleClickBehavior(mesh, modelId, binding, actionState);
    }

    /**
     * 获取模型中的所有mesh信息（默认只返回可见的mesh）
     * @param {string} modelId - 模型ID
     * @param {Object} options - 选项 { onlyVisible: true, hasMaterial: true }
     * @returns {Array} mesh信息数组 [{name, uuid, hasBinding, visible, ...}]
     */
    getModelMeshes(modelId, options = {}) {
        const model = this.engine?.assetsManager?.getModel(modelId);
        if (!model) {
            console.warn(`找不到模型: ${modelId}`);
            return [];
        }
        
        const meshList = [];
        model.traverse((obj) => {
            if (obj.isMesh) {
                // 只返回有具体几何体的mesh
                if (!obj.geometry || obj.geometry.attributes === undefined) {
                    return; // 跳过没有几何体的mesh
                }
                
                // 检查几何体是否有有效的顶点数据
                const positionAttr = obj.geometry.attributes.position;
                if (!positionAttr || positionAttr.count === 0) {
                    return; // 跳过没有顶点数据的mesh
                }
                
                meshList.push({
                    id: obj.userData?.id || null,
                    uuid: obj.uuid,
                    type: obj.type,
                    hasMaterial: !!obj.material,
                    hasBinding: !!obj.userData?.__hasAnimationBinding,
                    bindingKey: obj.userData?.__bindingKey || null,
                    vertexCount: positionAttr.count // 顶点数量
                });
            }
        });
        
        return meshList;
    }
    
    /**
     * 设置全局动画设置
     * @param {Object} settings 全局设置对象
     */
    setGlobalSettings(settings) {
        this.globalSettings = { ...this.globalSettings, ...settings };
        
        if (!this.globalSettings.enabled) {
            this._stopAllAnimations();
        } else if (this.globalSettings.autoPlay) {
            this._startAutoPlay();
        }
        
        this.events.emit('globalSettings:changed', this.globalSettings);
    }

    /**
     * 获取全局设置
     * @returns {Object} 全局设置对象
     */
    getGlobalSettings() {
        return { ...this.globalSettings };
    }

    
    /**
     * 动态调整动画速度
     * @param {string} animationId
     * @param {number} speed
     */
    setSpeed(animationId, speed) {
        const config = this.animations.get(animationId);
        if (!config || !config.action) return false;
        const newSpeed = Number(speed) || 1;
        const totalDuration = Math.max(0, Number(config.duration) || 0);
        const playedTime = Math.max(0, Math.min(totalDuration, config.action.time || 0));
        const playedProgress = totalDuration > 0 ? playedTime / totalDuration : 0;
        config.speed = newSpeed;
        config.action.timeScale = newSpeed * this._getEffectivePlayDirection(config);
        if (config.playDirection === -1 && config.action.isRunning()) {
            const currentTime = config.action.time;
            const duration = Number(config.duration) || 0;
            if (currentTime <= 0 || currentTime > duration) {
                config.action.time = duration;
            }
        }
        return true;
    }

    /**
     * 通过名称设置速度（不重启）
     * @param {string} modelId
     * @param {string} animationName
     * @param {number} speed
     */
    setSpeedByName(modelId, animationName, speed) {
        const target = this._findAnimationByName(modelId, animationName);
        if (!target) return false;
        return this.setSpeed(target.id, speed);
    }

    /** ==================动画时间分割 ================= */
        /**
     * 按时间手动分割动画Clip
     * @param {AnimationClip} sourceClip 源动画Clip
     * @param {string} name 新Clip名称
     * @param {number} startTime 开始时间
     * @param {number} endTime 结束时间
     * @returns {AnimationClip} 新的动画Clip
     */
    createSlicedClip(sourceClip, name, startTime, endTime) {
        const newTracks = [];
        const duration = endTime - startTime;

        for (const track of sourceClip.tracks) {
            const times = [];
            const values = [];
            const valueSize = track.getValueSize();
            const trackTimes = track.times;
            const trackValues = track.values;

            for (let i = 0; i < trackTimes.length; i++) {
                const t = trackTimes[i];
                if (t >= startTime && t <= endTime) {
                    times.push(t - startTime);
                    for (let j = 0; j < valueSize; j++) {
                        values.push(trackValues[i * valueSize + j]);
                    }
                }
            }

            if (times.length === 0 && trackValues.length > 0) {
                times.push(0);
                for (let j = 0; j < valueSize; j++) {
                    values.push(trackValues[j]);
                }
            }

            if (times.length > 0) {
                const TrackType = track.constructor;
                newTracks.push(new TrackType(track.name, times, values));
            }
        }

        const safeDuration = duration > 0 ? duration : 0.001;
        return new AnimationClip(name, safeDuration, newTracks);
    }


    /**
     * 按时间分割动画
     * @param {string} modelId 模型ID
     * @param {string} animationName 原始动画名称
     * @param {Array<Array<number>>} timeRanges 时间范围数组 [[startSec, endSec], ...]
     * @param {Array<string>} names 片段名称（用户自定义，用于后续绑定）
     * @returns {Array<string>} 分割后的动画ID数组（使用clip.uuid）
     */
    splitByTime(modelId, animationName, timeRanges = [], names = []) {
        const mixer = this.mixers.get(modelId);
        if (!mixer) return [];

        // 通过动画名称查找
        const sourceClip = this._findAnimationClipByName(modelId, animationName);
        
        if (!sourceClip) {
            console.warn(`找不到动画: ${animationName}`);
            return [];
        }
        
        const splitIds = [];
        timeRanges.forEach(([startSec, endSec], i) => {
            // 使用用户提供的名称，如果没有则自动生成
            const name = names[i] || `${sourceClip.name}_${startSec}to${endSec}s`;
            const subClip = this.createSlicedClip(sourceClip, name, startSec, endSec);
            
            if (subClip) {
                const action = mixer.clipAction(subClip);
                // 使用 Three.js 自带的 uuid 作为内部ID
                const internalId = `${subClip.uuid}`;
                
                this.actions.set(internalId, action);
                this._actionToInfo.set(action, { modelId, animationId: internalId, name });
                this._splitAnimationIds.add(internalId);
                this._splitCreationTime.set(internalId, Date.now());
                
                // 返回动画ID，避免同名冲突
                splitIds.push(internalId);
            }
        });

        return splitIds;
    }

    /**
     * 检查track的值是否有实际变化（过滤静止轨道）
     * @private
     * @param {KeyframeTrack} track 动画track
     * @returns {boolean} 是否有变化
     */
    _isTrackEffective(track) {
        if (!track || !track.values || track.values.length === 0) {
            return false;
        }
        
        if (track.times && track.times.length < 2) {
            return false;
        }
        
        const values = track.values;
        const valueSize = track.getValueSize();
        
        // 如果只有一个关键帧，认为没有变化
        if (values.length <= valueSize) {
            return false;
        }
        
        // 简单采样检查：允许小的浮点误差
        const epsilon = CONSTANTS.TIME_EPSILON_RATIO || 0.0001;
        for (let i = valueSize; i < values.length; i += valueSize) {
            for (let j = 0; j < valueSize; j++) {
                if (Math.abs(values[i + j] - values[j]) > epsilon) {
                    return true; // 发现变化
                }
            }
        }
        
        return false; // 所有值都相同，没有变化
    }
    
    /**
     * 通用辅助：向上冒泡查找逻辑ID节点
     * @private
     * @param {THREE.Object3D} object 起始节点
     * @param {THREE.Object3D} [rootModel] 模型根节点(可选)
     * @returns {Object|null} { id, node, hasBinding } 或 null
     */
    _findLogicalId(object, rootModel = null) {
        let current = object;
        while (current) {
            // 1. 优先检查绑定标记 (Mesh级别)
            if (current.userData?.__hasAnimationBinding) {
                return { 
                    id: current.userData?.id || null, 
                    node: current, 
                    hasBinding: true 
                };
            }
            
            // 2. 检查 ID 
            if (current.userData?.id) {
                return { 
                    id: current.userData.id, 
                    node: current, 
                    hasBinding: !!current.userData.__hasAnimationBinding 
                };
            }
            
            // 到达根节点或模型根节点时停止
            if ((rootModel && current === rootModel) || !current.parent) {
                break;
            }
            current = current.parent;
        }

        return null;
    }

    /**
     * @param {Object3D} model 模型根节点
     * @returns {Map<Object3D, Object>} 节点到逻辑信息的映射
     */
    _buildLogicalIdMap(model) {
        const map = new Map();
        if (!model) return map;

        // 递归遍历，向下传递当前的逻辑上下文
        const traverse = (node, currentLogicalInfo) => {
            let nextLogicalInfo = currentLogicalInfo;

            if (node.userData?.__hasAnimationBinding) {
                nextLogicalInfo = {
                    id: node.userData?.id || null,
                    node: node,
                    hasBinding: true
                };
            } else if (node.userData?.id) {
                nextLogicalInfo = {
                    id: node.userData.id,
                    node: node,
                    hasBinding: !!node.userData.__hasAnimationBinding
                };
            }

            // 记录当前节点的逻辑信息
            if (nextLogicalInfo) {
                map.set(node, nextLogicalInfo);
            }

            // 继续遍历子节点
            if (node.children) {
                for (let i = 0; i < node.children.length; i++) {
                    traverse(node.children[i], nextLogicalInfo);
                }
            }
        };

        traverse(model, null);
        return map;
    }

    /**
     * 纯净路径 ID 生成器
     * ID 格式：父ID-节点名
     * @param {THREE.Object3D} model 模型根节点
     */
    _initModelStableIds(model) {
        if (!model) return;

        const idRegistry = new Map();

        const traverseAndGenerate = (node, parentPathId) => {
            if (!node) return;

            let currentId = null;

            if (node.userData && node.userData.id && !node.userData.__generated) {
                currentId = node.userData.id;
            } 
            else {
                const safeName = this._slugifyName(node.name || node.type || 'node');
                
                let baseId = parentPathId ? `${parentPathId}-${safeName}` : safeName;
                
                let count = idRegistry.get(baseId) || 0;
                count++;
                idRegistry.set(baseId, count);

                if (count === 1) {
                    currentId = baseId;
                } else {
                    currentId = `${baseId}_#${count}`; 
                    console.warn(`检测到重名路径，已自动添加后缀: ${currentId}`);
                }

                if (!node.userData) node.userData = {};
                if (!node.userData.id) {
                    node.userData.id = currentId;
                    node.userData.__generated = true;
                } else {
                    currentId = node.userData.id;
                }
            }

            if (node.children && node.children.length > 0) {
                node.children.forEach(child => traverseAndGenerate(child, currentId));
            }
        };

        traverseAndGenerate(model, null);
    }

    /**
     * 名称清洗，适合作为路径片段
     * 中文通过哈希算法转换为字母数字组合
     * @private
     */
    _slugifyName(name) {
        if (!name) return 'node';
        
        let result = String(name);
        
        // 检测是否包含中文字符
        const hasChinese = /[\u4e00-\u9fa5]/.test(result);
        
        if (hasChinese) {
            // 对包含中文的字符串进行哈希转换
            const hash = this._hashString(result);
            // 转换为base36编码（0-9a-z），取前8位
            const hashStr = hash.toString(36).substring(0, 8);
            result = hashStr;
        } else {
            // 非中文：只做基本清洗
            result = result
                .replace(/\s+/g, '_')        // 空格 -> 下划线
                .replace(/[\/\\\.]/g, '-')   // 斜杠/点 -> 中划线
                .replace(/[:*?"<>|]/g, '')   // 移除特殊字符
                .replace(/^_+|_+$/g, '');    // 去首尾下划线
        }
        
        // 确保结果不为空
        return result || 'node';
    }
    
    /**
     * 简单的字符串哈希函数
     * 将字符串转换为数字，再转为base36编码
     * @private
     */
    _hashString(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash = hash & hash; // 转换为32位整数
        }
        // 确保返回正数
        return Math.abs(hash);
    }

    /**
     * 查找鼠标悬停的mesh
     * @private
     * @param {{x: number, y: number}} position - 鼠标位置
     * @returns {Object|null} {mesh, modelId, hasBinding, isHighlighted} 或 null
     */
    _findHoveredMesh(position) {
        if (!position || !this.engine?.inputManager) return null;
        
        // 先检查是否悬停在热点上，如果悬停在热点上则不检测mesh，避免高亮mesh
        if (this.engine?.hotspotController) {
            const hotspotHit = this.engine.hotspotController._intersectHotspotAt(position);
            if (hotspotHit?.hotspot) {
                // 悬停在热点上，不检测mesh，返回null
                return null;
            }
        }
        
        const raycastResult = this.engine.inputManager.performRaycast(position);
        if (!raycastResult?.hit || !raycastResult?.object) return null;
        
        const mesh = raycastResult.object;
        const modelId = raycastResult.modelId;
        const model = this.engine?.assetsManager?.getModel(modelId);
        const logicalInfo = this._findLogicalId(mesh, model);
        const logicalMesh = logicalInfo ? logicalInfo.node : mesh;
        
        const hasBinding = logicalMesh?.userData?.__hasAnimationBinding || 
                          mesh?.userData?.__hasAnimationBinding;
        
        // 在绑定模式下，检查是否悬停在高亮的 mesh 上
        let isHighlighted = false;
        if (this._bindingState && this._highlightedMeshesSet) {
            // 检查原始 mesh 或逻辑 mesh 是否在高亮列表中
            isHighlighted = this._highlightedMeshesSet.has(mesh) || 
                          this._highlightedMeshesSet.has(logicalMesh);
            
            // 如果还没找到，向上遍历父节点链检查
            if (!isHighlighted) {
                let current = mesh.parent;
                while (current && current !== model && current !== this.scene) {
                    if (this._highlightedMeshesSet.has(current)) {
                        isHighlighted = true;
                        break;
                    }
                    current = current.parent;
                }
            }
        }
        
        return { mesh, modelId, hasBinding, isHighlighted };
    }
    
    /**
     * 更新光标样式
     * @private
     * @param {boolean} shouldShowPointer - 是否显示手型（有绑定或在高亮列表中）
     */
    _updateCursorStyle(shouldShowPointer) {
        const canvas = this.engine?.renderer?.domElement;
        if (!canvas) return;
        canvas.style.cursor = shouldShowPointer ? 'pointer' : '';
    }
    
    /**
     * 更新悬停高亮
     * @private
     * @param {THREE.Mesh|null} mesh - mesh对象或null
     */
    _updateHoverHighlight(mesh) {
        if (!this.globalSettings.hoverHighlightEnabled) return;
        if (this._bindingState) {
            this.engine?.highlightController?.setHoverObject(null);
            return;
        }
        
        // 获取 mesh 的绑定信息，如果有自定义颜色则使用
        let hoverColor = null;
        if (mesh) {
            const modelId = this._meshToModelIdCache.get(mesh) || 
                           this._findModelIdByMesh(mesh);
            if (modelId) {
                const bindingKey = this._getBindingKey(mesh, modelId);
                if (bindingKey) {
                    const binding = this._meshAnimationBindings.get(bindingKey);
                    if (binding?.options?.hoverColor !== undefined) {
                        hoverColor = binding.options.hoverColor;
                    }
                }
            }
        }
        
        this.engine?.highlightController?.setHoverObject(mesh, hoverColor);
    }
    
    /**
     * 处理鼠标移动悬停（检测是否有绑定动画的mesh或在高亮列表中）
     * @private
     */
    _onMouseMoveHover({ position }) {
        // 先检查是否在热点上
        const isOnHotspot = this.engine?.hotspotController?._intersectHotspotAt(position)?.hotspot !== undefined;
        const hoverInfo = this._findHoveredMesh(position);
        
        if (hoverInfo) {
            const { mesh, hasBinding, isHighlighted } = hoverInfo;
            
            // 在绑定模式下，如果悬停在高亮的 mesh 上，也应该显示手型
            const shouldShowPointer = hasBinding || (this._bindingState && isHighlighted);
            
            if (shouldShowPointer) {
                // 更新手型光标
                if (this._hoveredMesh !== mesh) {
                    this._hoveredMesh = mesh;
                }
                this._updateCursorStyle(true);
                this._updateHoverHighlight(mesh);
            } 
            else {
                // 没有绑定动画或不在高亮列表中，重置cursor
                if (this._hoveredMesh !== null) {
                    this._hoveredMesh = null;
                }
                this._updateCursorStyle(false);
                this._updateHoverHighlight(null);
            }
        } 
        else {
            if (isOnHotspot) {
                // 在热点上时，清除mesh的高亮
                if (this._hoveredMesh !== null) {
                    this._hoveredMesh = null;
                    this._updateHoverHighlight(null);
                }
            } else {
                this._hoveredMesh = null;
                this._updateCursorStyle(false);
                this._updateHoverHighlight(null);
            }
        }
    }

    /**
     * 为模型节点建立索引，加速查找
     * @private
     * @param {THREE.Object3D} root 模型根节点
     * @returns {Map<string, Array<THREE.Object3D>>} 名称到节点的映射
     */
    _indexModelNodes(root) {
        const index = new Map();
        if (!root) return index;
        
        root.traverse(node => {
            if (node.name) {
                if (!index.has(node.name)) {
                    index.set(node.name, []);
                }
                index.get(node.name).push(node);
            }
        });
        return index;
    }

    /**
     * 从动画clip中提取涉及的mesh/object名称和userData.id
     * @param {AnimationClip} clip 动画clip
     * @param {Object3D} model 模型对象（可选，用于提取userData.id）
     * @returns {Object} {names: Set<string>, ids: Set<string>} 涉及的object名称和mesh的userData.id集合
     */
    _extractAffectedObjectNames(clip, model = null) {
        const objectNames = new Set();
        const meshIds = new Set();
        
        if(!clip || !clip.tracks) return { names: objectNames, ids: meshIds };
        
        // 预先建立索引，避免在循环中重复遍历
        const nodeIndex = model ? this._indexModelNodes(model) : null;
        
        const processedNames = new Set();
        
        for(const track of clip.tracks) {
            if(!track.name) continue;
            
            // 1. 过滤静止轨道
            if (!this._isTrackEffective(track)) {
                continue;
            }
            
            const match = track.name.match(/^([^.]+)/);
            if (!match) continue;
            
            const objectName = match[1];
            objectNames.add(objectName);
            
            // 如果提供了model，尝试提取userData.id
            if (model && !processedNames.has(objectName)) {
                processedNames.add(objectName);
                
                let foundObject = null;
                if (nodeIndex) {
                    const nodes = nodeIndex.get(objectName);
                    if (nodes && nodes.length > 0) {
                        foundObject = nodes[0];
                    }
                } else {
                    model.traverse((obj) => {
                        if (!foundObject && obj.name === objectName) {
                            foundObject = obj;
                        }
                    });
                }
                
                if (foundObject) {
                    const logicalInfo = this._findLogicalId(foundObject, model);
                    if (logicalInfo && logicalInfo.id) {
                        meshIds.add(logicalInfo.id);
                    }
                }
                // ===================================
            }
        }
        
        return { names: objectNames, ids: meshIds };
    }

    /**
     * 通过AnimationAction实际绑定的对象来识别受影响的mesh
     * @param {string} modelId 模型ID
     * @param {AnimationClip} clip 动画clip
     * @returns {Map} 受影响的mesh对象映射 {mesh: true}
     */
    _isolateAnimationMeshes(modelId, clip) {
        const model = this.engine?.assetsManager?.getModel(modelId);
        if (!model) return new Map();

        const mixer = this.mixers.get(modelId);
        if (!mixer || !clip || !clip.tracks || clip.tracks.length === 0) {
            console.warn(`[动画隔离] 无法获取动画数据，不进行隔离`);
            return new Map();
        }

        // 创建临时action来获取绑定信息
        const tempAction = mixer.clipAction(clip);
        // 直接使用model作为根对象
        const root = model;
        
        // 收集所有受动画影响的对象
        const affectedObjects = new Set();
        const processedNames = new Set(); 
        
        // 预先建立索引，避免在循环中重复遍历
        const nodeIndex = this._indexModelNodes(root);
        
        // 通过track.name解析并查找绑定的对象
        for (const track of clip.tracks) {
            if (!track.name) continue;
            
            const parts = track.name.split('.');
            if (parts.length === 0) continue;
            
            const objectName = parts[0];
            
            // 避免重复处理相同的对象名
            if (processedNames.has(objectName)) continue;
            processedNames.add(objectName);
            
            // 优先使用索引查找
            const exactMatches = nodeIndex.get(objectName);
            if (exactMatches) {
                exactMatches.forEach(obj => affectedObjects.add(obj));
            } else {
                for (const [name, nodes] of nodeIndex) {
                     if (name.startsWith(objectName + ' ') || name.startsWith(objectName + '.')) {
                         nodes.forEach(obj => affectedObjects.add(obj));
                         break; // 找到第一个匹配的名称就停止
                     }
                }
            }
        }
        
        if (affectedObjects.size === 0) {
            console.warn(`[动画隔离] 无法找到动画绑定的对象，不进行隔离`);
            tempAction.stop();
            mixer.uncacheAction(tempAction);
            return new Map();
        }
        
        // 收集所有受影响的mesh（包括没有userData.id的）
        const affectedMeshes = new Set();
        
        affectedObjects.forEach(obj => {
            // 如果对象本身就是mesh，直接添加
            if (obj.isMesh) {
                affectedMeshes.add(obj);
            }
            // 遍历子对象，收集所有mesh
            obj.traverse((child) => {
                if (child.isMesh) {
                    affectedMeshes.add(child);
                }
            });
        });
        
        // 收集受影响的mesh对象
        const visibilityState = new Map();
        affectedMeshes.forEach(mesh => {
            visibilityState.set(mesh, true);
        });
        
        // 清理临时action
        try {
            tempAction.stop();
            tempAction.reset();
            // 尝试清理action
            if (mixer.uncacheAction && typeof mixer.uncacheAction === 'function') {
                mixer.uncacheAction(tempAction);
            }
        } catch (e) {
            console.warn('[动画隔离] 清理临时action时出错:', e);
        }
        
        return visibilityState;
    }


    /**
     * 通过名称查找动画clip（内部方法，避免重复代码）
     * @private
     * @param {string} modelId 模型ID
     * @param {string} animationName 动画名称
     * @returns {AnimationClip|null} 动画clip
     */
    _findAnimationClipByName(modelId, animationName) {    
        if (!animationName) return null;
        
        // 先在actions中查找
        let foundAction = null;
        this.actions.forEach((act, actId) => {
            const info = this._actionToInfo.get(act);
            if (info && info.modelId === modelId && info.name === animationName) {
                foundAction = act;
            }
        });
        
        if (foundAction && foundAction._clip) {
            return foundAction._clip;
        }
        
        // 如果actions中没找到，尝试在animations中查找
        const animations = this.getModelAnimations(modelId);
        const anim = animations.find(a => a.name === animationName);
        if (anim && anim.clip) {
            return anim.clip;
        }
        
        return null;
    }

    /**
     * 通过动画ID查找动画clip（内部方法）
     * @private
     * @param {string} modelId 模型ID
     * @param {string} animationId 动画ID
     * @returns {AnimationClip|null} 动画clip
     */
    _findAnimationClipById(modelId, animationId) {
        if (!animationId) return null;
        
        // 先在actions中通过ID查找
        const action = this.actions.get(animationId);
        if (action && action._clip) {
            const info = this._actionToInfo.get(action);
            if (info && info.modelId === modelId) {
                return action._clip;
            }
        }
        
        // 如果actions中没找到，尝试在animations中查找
        const config = this.animations.get(animationId);
        if (config && config.modelId === modelId && config.clip) {
            return config.clip;
        }
        
        return null;
    }

    /**
     * 通过mesh的userData.id查找动画clip（用于getAnimationMeshes）
     * @private
     * @param {string} modelId 模型ID
     * @param {string} meshId mesh的userData.id
     * @returns {AnimationClip|null} 动画clip
     */
    _findAnimationClipByMeshId(modelId, meshId) {
        if (!meshId) return null;
        
        const model = this.engine?.assetsManager?.getModel(modelId);
        if (!model) return null;
        
        // 先找到对应的mesh
        let targetMesh = null;
        model.traverse((obj) => {
            if (!targetMesh && obj.isMesh && obj.userData && obj.userData.id === meshId) {
                targetMesh = obj;
            }
        });
        
        if (!targetMesh || !targetMesh.name) return null;
        
        const meshName = targetMesh.name;
        const mixer = this.mixers.get(modelId);
        if (!mixer) return null;
        
        // 遍历所有动画clip，查找包含该mesh的动画
        const modelAnimations = this.getModelAnimations(modelId);
        for (const animConfig of modelAnimations) {
            if (animConfig.clip) {
                const { names } = this._extractAffectedObjectNames(animConfig.clip, model);
                if (names.has(meshName)) {
                    return animConfig.clip;
                }
            }
        }
        
        // 也检查分割动画
        for (const [animationId, action] of this.actions.entries()) {
            if (this._isSplitAnimationId(animationId)) {
                const info = this._actionToInfo.get(action);
                if (info && info.modelId === modelId && action._clip) {
                    const { names } = this._extractAffectedObjectNames(action._clip, model);
                    if (names.has(meshName)) {
                        return action._clip;
                    }
                }
            }
        }
        
        return null;
    }

    /**
     * 获取动画相关的mesh列表（核心接口）
     * @param {string} modelId 模型ID
     * @param {string} animationIdOrNameOrMeshId 动画ID、动画名称或mesh的userData.id（原始动画或切割动画）
     * @returns {Array<Object>} mesh信息数组 [{name, uuid, id, visible, mesh}, ...]
     */
    getAnimationMeshes(modelId, animationIdOrNameOrMeshId) {
        const model = this.engine?.assetsManager?.getModel(modelId);
        if (!model) {
            console.warn("找不到该模型: ", modelId);
            return [];
        }
        
        // 查找动画clip的优先级：
        // 1. 先尝试通过mesh的userData.id查找动画
        // 2. 如果找不到，尝试通过动画ID查找
        // 3. 如果还找不到，尝试通过动画名称查找（兼容旧代码）
        let clip = this._findAnimationClipByMeshId(modelId, animationIdOrNameOrMeshId);
        if (!clip) {
            clip = this._findAnimationClipById(modelId, animationIdOrNameOrMeshId);
        }
        if (!clip) {
            clip = this._findAnimationClipByName(modelId, animationIdOrNameOrMeshId);
        }
        
        if (!clip) {
            console.warn("找不到该动画: ", animationIdOrNameOrMeshId);
            return [];
        }
        
        const visibilityState = this._isolateAnimationMeshes(modelId, clip);
        
        const logicalIdMap = this._buildLogicalIdMap(model);
        
        const affectedMeshes = [];
        
        const meshSet = new Set();
        
        visibilityState.forEach((value, mesh) => {
            if (mesh.isMesh && mesh.geometry && mesh.geometry.attributes) {
                if (meshSet.has(mesh)) return;
                meshSet.add(mesh);
                
                const logicalInfo = logicalIdMap.get(mesh);
                const logicalId = logicalInfo ? logicalInfo.id : null;
                
                affectedMeshes.push({
                    name: mesh.name,
                    uuid: mesh.uuid,
                    id: logicalId || null,
                    visible: mesh.visible,
                    mesh: mesh,
                    logicalInfo: logicalInfo
                });
            }
        });
        
        if (affectedMeshes.length === 0) {
            const { names: affectedNames } = this._extractAffectedObjectNames(clip, null);
            model.traverse((obj) => {
                if (obj.isMesh && obj.geometry && obj.geometry.attributes) {
                    const isAffected = affectedNames.has(obj.name) || 
                                       Array.from(affectedNames).some(name => 
                                           obj.name.startsWith(name + ' ') || 
                                           obj.name.startsWith(name + '.')
                                       );
                    if (isAffected && !meshSet.has(obj)) {
                        meshSet.add(obj);
                        
                        const logicalInfo = logicalIdMap.get(obj);
                        const logicalId = logicalInfo ? logicalInfo.id : null;
                        
                        affectedMeshes.push({
                            name: obj.name,
                            uuid: obj.uuid,
                            id: logicalId || null,
                            visible: obj.visible,
                            mesh: obj,
                            logicalInfo: logicalInfo 
                        });
                    }
                }
            });
        }
        
        return affectedMeshes;
    }

    /**
     * 获取指定动画相关的mesh id数组
     * @param {string} modelId 模型ID
     * @param {string} animationIdOrNameOrMeshId 动画ID、动画名称或mesh的userData.id（原始动画或切割动画）
     * @returns {Array<string>} mesh的userData.id数组，过滤掉null值并去重
     */
    getAnimationMeshIds(modelId, animationIdOrNameOrMeshId) {
        const meshes = this.getAnimationMeshes(modelId, animationIdOrNameOrMeshId);
        const ids = meshes
            .map(mesh => mesh.id)
            .filter(id => id !== null && id !== undefined);
        
        // 去重：使用 Set 去除重复的ID
        return Array.from(new Set(ids));
    }

    /**
     * 播放分割片段
     * @param {string} modelId - 模型ID
     * @param {string} animationIdOrName - 分割动画的ID或名称
     * @param {Object} opts - 选项 { 
     *   playMode,         // 播放模式 1-单次播放, 2-单次往返, 3-播放到结束停止, 4-点击返回
     *   loopType,         // 循环类型 1-单次, 2-两次, 3-多次, 4-无限次
     *   loopCount,         // 循环次数
     *   playDirectionType  // 播放方向 1=正向, 2=反向
     * }
     * @returns {boolean} 是否成功
     */
    playSplit(modelId, animationIdOrName, opts = {}) {
        // === 兼容性处理：如果传入对象，提取 name 或 id ===
        let actualAnimationIdOrName = animationIdOrName;
        if (typeof animationIdOrName === 'object' && animationIdOrName !== null) {
            // 优先使用 id，如果没有则使用 name 或 animationName
            actualAnimationIdOrName = animationIdOrName.id || animationIdOrName.name || animationIdOrName.animationName;
            if (!actualAnimationIdOrName) {
                console.warn("传入的动画对象缺少 id、name 或 animationName 属性:", animationIdOrName);
                return false;
            }
        }
        // ==========================================
        
        let action = null;
        let foundInfo = null;
    
        const directAction = this.actions.get(actualAnimationIdOrName);
        if (directAction) {
            const info = this._actionToInfo.get(directAction);
            if (info && info.modelId === modelId) {
                action = directAction;
                foundInfo = info;
            }
        }
    
        if (!action || !foundInfo) {
            this.actions.forEach((act, actId) => {
                const info = this._actionToInfo.get(act);
                if (info && info.modelId === modelId && info.name === actualAnimationIdOrName) {
                    action = act;
                    foundInfo = info;
                }
            });
        }
        
        if (!action || !foundInfo) {
            console.warn(`找不到动画: ${actualAnimationIdOrName} (模型: ${modelId}, 原始参数类型: ${typeof animationIdOrName})`);
            return false;
        }
    
        // 解析参数：按照数据库表结构
        let loopMode = LoopModeType.ONCE;  // 默认单次
        let loopCount = 1;  // 默认1次
        let shouldClamp = false;
        
        // PLAY_MODE: 1-单次播放, 2-单次往返, 3-播放到结束停止, 4-点击返回
        const playMode = opts.playMode !== undefined ? Number(opts.playMode) : PlayMode.SINGLE;
        
        // LOOP_TYPE: 1-单次, 2-两次, 3-多次, 4-无限次
        const loopType = opts.loopType !== undefined ? Number(opts.loopType) : LoopType.ONCE;
        
        // LOOP_COUNT: 循环次数
        const loopCountValue = opts.loopCount !== undefined ? Number(opts.loopCount) : 1;
        
        // 根据 PLAY_MODE 设置 clampWhenFinished 和循环模式
        switch (playMode) {
            case PlayMode.SINGLE: // 单次播放
                shouldClamp = false;
                break;
            case PlayMode.PING_PONG: // 往返播放
                loopMode = LoopModeType.PING_PONG;
                // 根据 loopType 设置往返次数
                switch (loopType) {
                    case LoopType.ONCE:
                        loopCount = 1;
                        break;
                    case LoopType.TWICE:
                        loopCount = 2;
                        break;
                    case LoopType.MULTIPLE:
                        loopCount = loopCountValue;
                        break;
                    case LoopType.INFINITE:
                        loopCount = -1;
                        break;
                    default:
                        loopCount = 1;
                }
                shouldClamp = false;
                break;
            case PlayMode.CLAMP_END: // 播放到结束停止
                loopMode = LoopModeType.ONCE;
                loopCount = 1;
                shouldClamp = true;
                break;
            case PlayMode.CLICK_RETURN: // 点击返回
                loopMode = LoopModeType.ONCE;
                loopCount = 1;
                shouldClamp = true;
                // 标记为点击返回模式，用于阻止 finished 事件
                if (action) {
                    action._isClickReturnMode = true;
                }
                break;
        }
        
        // 根据 LOOP_TYPE 设置循环模式
        if (playMode === PlayMode.SINGLE) {
            switch (loopType) {
                case LoopType.ONCE:
                    loopMode = LoopModeType.ONCE;
                    loopCount = 1;
                    break;
                case LoopType.TWICE:
                    loopMode = LoopModeType.REPEAT;
                    loopCount = 2;
                    break;
                case LoopType.MULTIPLE:
                    loopMode = LoopModeType.REPEAT;
                    loopCount = loopCountValue;
                    break;
                case LoopType.INFINITE:
                    loopMode = LoopModeType.REPEAT;
                    loopCount = -1;
                    break;
            }
        }
    
        // 检查action是否已经处于启用状态
        const isAlreadyPlaying = action.enabled;
        
        // 检查动画是否在最后一帧
        const currentTime = action.time || 0;
        const duration = action._clip?.duration || 0;
        const epsilon = CONSTANTS.TIME_EPSILON || 0.05;
        const isAtEnd = duration > 0 && (Math.abs(currentTime - duration) < epsilon || action._clampAtEnd === true);
        
        // 播放方向处理
        let playDirectionType = opts.playDirectionType !== undefined ? opts.playDirectionType : (opts.reverse ? 2 : 1);
        
        if (playMode === PlayMode.CLICK_RETURN && isAtEnd) {
            playDirectionType = 2; // 强制反向
            // 清除点击返回标记
            if (action) {
                action._isClickReturnMode = false;
            }
        }
        
        const isReverse = playDirectionType === 2;
        const timeScale = CONSTANTS.DEFAULT_SPEED;
        
        try {
            action.stop();
            action.reset();
            // 清除之前的固定标记
            if (action._clampAtEnd) {
                delete action._clampAtEnd;
            }
        } catch (_) {}
        
        // 先设置 clampWhenFinished
        action.clampWhenFinished = shouldClamp;
    
        // 设置循环模式
        const uiCount = Number(loopCount);
        const normalizedCount = !isFinite(uiCount) ? -1 : uiCount;
        
        if (loopMode === 1) {
            action.setLoop(LoopOnce, 1);
        } else if (loopMode === 2) {
            // 循环播放
            if (normalizedCount < 0) {
                action.setLoop(LoopRepeat, Infinity);
            } else {
                const base = Math.max(0, Math.floor(normalizedCount) - 1);
                const forwardComp = (playDirectionType === 1) ? 1 : 0;
                const repetitions = Math.max(0, base + forwardComp);
                action.setLoop(LoopRepeat, repetitions);
            }
        } else if (loopMode === 3) {
            // 往返播放
            if (normalizedCount < 0) {
                action.setLoop(LoopPingPong, Infinity);
            } else {
                let repetitions = Math.max(0, Math.floor(normalizedCount) * 2);
                if (playDirectionType === 2 && repetitions > 0) {
                    repetitions += 1;
                }
                action.setLoop(LoopPingPong, repetitions);
            }
        }
        
        // 设置播放方向和速度
        if (loopMode === 3) {
            // PingPong 模式：timeScale 始终为正
            action.timeScale = Math.abs(timeScale);
            if (isReverse && action._clip) {
                action.time = Math.max(0, action._clip.duration - 0.01);
            } else {
                action.time = 0;
            }
        } else {
            // 非 PingPong 模式：使用负 timeScale 实现反向
            action.timeScale = Math.abs(timeScale) * (isReverse ? -1 : 1);
            if (isReverse && action._clip) {
                action.time = action._clip.duration;
            } else {
                action.time = 0;
            }
        }
        
        action.clampWhenFinished = shouldClamp;
        action.setEffectiveWeight(1.0);
        action.enabled = true;
        action.paused = false;
        
        // 当 playMode=3/4 时，监听 finished 事件，确保停在最后一帧
        if (playMode === 3 || playMode === 4) {
            // 移除旧的 finished 监听器
            if (action._playSplitFinishedHandler) {
                action.removeEventListener?.('finished', action._playSplitFinishedHandler);
            }
            
            // 创建新的 finished 监听器
            const finishedHandler = () => {
                if (action && action._clip) {
                    // 固定在最后一帧
                    action.time = action._clip.duration;
                    action.paused = true;
                    
                    // 标记为已完成并需要固定在最后一帧
                    action._clampAtEnd = true;
                    
                    // 强制更新一次 mixer，确保状态生效
                    const mixer = this.mixers.get(modelId);
                    if (mixer) {
                        mixer.update(0);
                    }
                }
            };
            
            action._playSplitFinishedHandler = finishedHandler;
            action.addEventListener?.('finished', finishedHandler);
        }
        
        // 只有当之前没在播放时，才增加计数器
        if (!isAlreadyPlaying) {
            this._updateActiveCount(foundInfo.modelId, 1);
        }
        
        action.play();
        
        return true;
    }

    /**
     * 查找分割动画的 action（内部复用）
     * @private
     * @param {string} modelId 模型ID
     * @param {string} animationIdOrName 分割动画ID或名称
     * @returns {{action: AnimationAction, info: Object}|null}
     */
    _findSplitAction(modelId, animationIdOrName) {
        // === 兼容性处理：如果传入对象，提取 name 或 id ===
        let actualAnimationIdOrName = animationIdOrName;
        if (typeof animationIdOrName === 'object' && animationIdOrName !== null) {
            // 优先使用 id，如果没有则使用 name 或 animationName
            actualAnimationIdOrName = animationIdOrName.id || animationIdOrName.name || animationIdOrName.animationName;
            if (!actualAnimationIdOrName) {
                console.warn("传入的动画对象缺少 id、name 或 animationName 属性:", animationIdOrName);
                return null;
            }
        }
        // ==========================================
        
        let action = null;
        let foundInfo = null;

        // 1) 直接按 ID 查找（clip.uuid）
        const directAction = this.actions.get(actualAnimationIdOrName);
        if (directAction && this._isSplitAnimationId(actualAnimationIdOrName)) {
            const info = this._actionToInfo.get(directAction);
            if (info && info.modelId === modelId) {
                action = directAction;
                foundInfo = info;
            }
        }

        // 2) 按名称查找
        if (!action || !foundInfo) {
            this.actions.forEach((act, actId) => {
                const info = this._actionToInfo.get(act);
                if (info && info.modelId === modelId && this._isSplitAnimationId(actId)) {
                    if (info.name === actualAnimationIdOrName) {
                        action = act;
                        foundInfo = info;
                    }
                }
            });
        }

        if (!action || !foundInfo) {
            console.warn(`找不到分割动画: ${actualAnimationIdOrName} (模型: ${modelId}, 原始参数类型: ${typeof animationIdOrName})`);
            return null;
        }

        return { action, info: foundInfo };
    }

    /**
     * 暂停分割动画（按ID或名称）
     * @param {string} modelId 模型ID
     * @param {string} animationIdOrName 分割动画ID或名称
     * @returns {boolean} 是否成功
     */
    pauseSplit(modelId, animationIdOrName) {
        const result = this._findSplitAction(modelId, animationIdOrName);
        if (!result) return false;
        const { action } = result;
        action.paused = true;
        return true;
    }

    /**
     * 继续播放分割动画（从暂停位置继续）
     * @param {string} modelId 模型ID
     * @param {string} animationIdOrName 分割动画ID或名称
     * @returns {boolean} 是否成功
     */
    resumeSplit(modelId, animationIdOrName) {
        const result = this._findSplitAction(modelId, animationIdOrName);
        if (!result) return false;
        const { action } = result;
        action.paused = false;
        action.play();
        return true;
    }

    /**
     * 重置分割动画（停止并时间归零）
     * @param {string} modelId 模型ID
     * @param {string} animationIdOrName 分割动画ID或名称
     * @returns {boolean} 是否成功
     */
    resetSplit(modelId, animationIdOrName) {
        const result = this._findSplitAction(modelId, animationIdOrName);
        if (!result) return false;
        const { action, info } = result;
        
        // 如果之前是启用状态，需要减少计数器
        const wasEnabled = action.enabled;
        
        try { action.stop(); } catch (_) {}
        try { action.reset(); } catch (_) {}
        action.time = 0;
        action.enabled = false;
        action.paused = true;
        
        // 清除固定到末帧的标记
        if (action._clampAtEnd) {
            delete action._clampAtEnd;
        }
        
        // 如果之前是启用状态，更新计数器
        if (wasEnabled) {
            this._updateActiveCount(info.modelId, -1);
        }
        
        return true;
    }

    _applyConfigToAction(config) {
        
        if (config.loopMode === 1) {
            // 播放一次：使用LoopOnce，强制次数为1
            config.action.setLoop(LoopOnce, 1);
        } else if (config.loopMode === 2) {
            // 循环播放：使用LoopRepeat
            const uiCount = Number(config.loopCount);
            if (!isFinite(uiCount) || uiCount < 0) {
                config.action.setLoop(LoopRepeat, Infinity);
            } else {
                // 总播放次数 = repetitions + 1；对正向起步做+1补偿
                const base = Math.max(0, Math.floor(uiCount) - 1);
                const forwardComp = (config.playDirection === 1) ? 1 : 0;
                const repetitions = Math.max(0, base + forwardComp);
                config.action.setLoop(LoopRepeat, repetitions);
            }
        } else if (config.loopMode === 3) {
            // 来回播放：使用LoopPingPong
            const uiCount = Number(config.loopCount);
            if (!isFinite(uiCount) || uiCount < 0) {
                config.action.setLoop(LoopPingPong, Infinity);
            } else {
                // 基础 repetitions：来回N次 = 2N个方向
                let repetitions = Math.max(0, Math.floor(uiCount) * 2);
                const direction = this._getEffectivePlayDirection(config);
                if (direction === -1 && repetitions > 0) {
                    repetitions += 1;
                }
                
                config.action.setLoop(LoopPingPong, repetitions);
            }
        } else {
            // 默认情况：使用LoopRepeat
            const uiCount = Number(config.loopCount);
            if (!isFinite(uiCount) || uiCount < 0) {
                config.action.setLoop(LoopRepeat, Infinity);
            } else {
                const repetitions = Math.max(0, Math.floor(uiCount) - 1);
                config.action.setLoop(LoopRepeat, repetitions);
            }
        }
        
        const speedNum = Number(config.speed);
        const speedAbs = Math.abs(speedNum === 0 ? 0 : (isNaN(speedNum) ? 1 : speedNum));
        const direction = this._getEffectivePlayDirection(config);
        config.action.timeScale = speedAbs * direction;
        // 将权重值映射到0-1范围：权重值/100
        const effectiveWeight = Math.max(0, Math.min(1, config.weight / CONSTANTS.WEIGHT_UI_SCALE));
        config.action.setEffectiveWeight(effectiveWeight);
        
        // 设置是否保持在最后一帧
        if (config.clampWhenFinished !== undefined) {
            config.action.clampWhenFinished = config.clampWhenFinished;
        } else {
            config.action.clampWhenFinished = false;
        }
    }

    /**
     * 播放分割动画（提取公共逻辑）
     * @private
     */
    _playSplitAnimation(binding) {
        const action = this.actions.get(binding.animationId);
        if (!action) {
            console.warn(`找不到分割动画的action: ${binding.animationId}`);
            return false;
        }
        
        // 检查 action 是否已经处于启用状态，如果是，说明已经在播放并在计数中，不要重复添加
        const isAlreadyPlaying = action.enabled;
        
        try {
            action.stop();
            action.reset();
        } catch (_) {}
        
        const speed = binding.options.speed || CONSTANTS.DEFAULT_SPEED;
        const isReverse = binding.options.playDirectionType === 2 || binding.options.playDirection === -1;
        // 优先使用独立的 clampWhenFinished 参数，如果没有则根据循环模式判断
        const shouldClamp = binding.options.clampWhenFinished !== undefined 
            ? binding.options.clampWhenFinished 
            : (binding.options.loopModeType === LoopModeType.ONCE || binding.options.loopMode === LoopModeType.ONCE);
        const fadeIn = binding.options.fadeIn || 0;
        const fadeOut = binding.options.fadeOut || 0;
        const weight = binding.options.weight !== undefined ? binding.options.weight / CONSTANTS.WEIGHT_UI_SCALE : 1.0;
        
        // 根据 loopModeType 和 loopCount 设置循环模式
        const loopModeType = binding.options.loopModeType !== undefined 
            ? binding.options.loopModeType 
            : (binding.options.loopMode !== undefined ? binding.options.loopMode : LoopModeType.ONCE);
        const loopCount = binding.options.loopCount !== undefined 
            ? binding.options.loopCount 
            : 1;
        
        if (loopModeType === LoopModeType.ONCE) {
            action.setLoop(LoopOnce, 1);
        } else if (loopModeType === LoopModeType.PING_PONG) {
            // 往返播放：根据 loopCount 设置往返次数
            if (loopCount === -1) {
                action.setLoop(LoopPingPong, Infinity);
            } else {
                let repetitions = Math.max(0, Math.floor(loopCount) * 2);
                if (isReverse && repetitions > 0) {
                    repetitions += 1;
                }
                action.setLoop(LoopPingPong, repetitions);
            }
        } else if (loopModeType === LoopModeType.REPEAT) {
            // 循环播放：根据 loopCount 设置重复次数
            // 与 playSplit 方法保持一致的逻辑，对正向播放做补偿
            if (loopCount === -1) {
                action.setLoop(LoopRepeat, Infinity);
            } else {
                const base = Math.max(0, Math.floor(loopCount) - 1);
                const forwardComp = (!isReverse) ? 1 : 0;  // 正向播放补偿
                const repetitions = Math.max(0, base + forwardComp);
                action.setLoop(LoopRepeat, repetitions);
            }
        } else {
            action.setLoop(LoopOnce, 1);
        }
        
        // 设置播放方向和速度（根据循环模式不同处理）
        if (loopModeType === LoopModeType.PING_PONG) {
            // PingPong 模式：timeScale 始终为正，Three.js 会自动处理往返
            action.timeScale = Math.abs(speed);
            if (isReverse && action._clip) {
                action.time = Math.max(0, action._clip.duration - 0.01);
            } else {
                action.time = 0;
            }
        } else {
            // 非 PingPong 模式：使用负 timeScale 实现反向
            action.timeScale = Math.abs(speed) * (isReverse ? -1 : 1);
            if (isReverse && action._clip) {
                action.time = action._clip.duration;
            } else {
                action.time = 0;
            }
        }
        
        action.clampWhenFinished = shouldClamp;
        action.setEffectiveWeight(Math.max(0, Math.min(1, weight)));
        action.enabled = true;
        action.paused = false;
        
        // 只有当之前没在播放时，才增加计数器
        if (!isAlreadyPlaying) {
            this._updateActiveCount(binding.modelId, 1);
        }
        
        if (fadeIn > 0) {
            try { action.fadeIn(fadeIn); } catch (_) {}
        }
        
        action.play();
        
        if (fadeOut > 0 && shouldClamp && action._clip) {
            const duration = action._clip.duration || 0;
            if (duration > 0 && speed > 0) {
                const actualDuration = duration / Math.abs(speed);
                const fadeOutStart = Math.max(0, actualDuration - fadeOut);
                setTimeout(() => {
                    if (action && action.isRunning?.()) {
                        try { action.fadeOut(fadeOut); } catch (_) {}
                    }
                }, fadeOutStart * CONSTANTS.MS_PER_SECOND);
            }
        }
        
        const mixer = this.mixers.get(binding.modelId);
        if (mixer) mixer.update(0);
        
        return true;
    }

    /**
     * 设置动画的播放时间和速度（提取公共逻辑）
     * @private
     */
    _setActionTimeAndSpeed(config) {
        const duration = Number(config.duration) || 0;
        const epsilon = Math.max(0.01, duration * CONSTANTS.TIME_EPSILON_RATIO);
        const speed = Math.abs(Number(config.speed) || 1);
        const direction = this._getEffectivePlayDirection(config);
        
        if (config.loopMode === 3) {
            // PingPong 模式：timeScale 始终为正
            config.action.timeScale = speed;
            if (direction === -1) {
                config.action.time = Math.max(0, duration - epsilon);
                if (typeof config.action._timeDirection !== 'undefined') {
                    config.action._timeDirection = -1;
                }
            } else {
                config.action.time = Math.min(duration, epsilon);
                if (typeof config.action._timeDirection !== 'undefined') {
                    config.action._timeDirection = 1;
                }
            }
        } else {
            // 非 PingPong 模式：使用负 timeScale 实现反向
            if (direction === -1) {
                config.action.timeScale = -speed;
                config.action.time = duration;
            } else {
                config.action.timeScale = speed;
                config.action.time = 0;
            }
        }
    }

    /**
     * 安排淡出定时器（提取公共逻辑）
     * @private
     */
    _scheduleFadeOut(config) {
        try { clearTimeout(config._fadeOutTimerId); } catch (_) {}
        config._fadeOutTimerId = null;
        
        const fadeOutTime = Number(config.fadeOutTime) || 0;
        if (fadeOutTime > 0 && config.loopMode === 1) {
            const duration = Number(config.duration) || 0;
            const speed = Math.abs(Number(config.speed) || 1);
            if (speed > 0 && duration > 0) {
                const actualDuration = duration / speed;
                const fadeOutStart = Math.max(0, actualDuration - fadeOutTime);
                config._fadeOutTimerId = setTimeout(() => {
                    config._fadeOutTimerId = null;
                    if (config.action && config.enabled && config.action.isRunning?.()) {
                        try { config.action.fadeOut(fadeOutTime); } catch (_) {}
                    }
                }, fadeOutStart * CONSTANTS.MS_PER_SECOND);
            }
        }
    }

    _handleMinimalDurationAnimation(config) {
        const minimalDuration = CONSTANTS.MINIMAL_DURATION;
        const duration = Number(config.duration) || 0;
        const info = this._actionToInfo.get(config.action);
        
        if (duration <= minimalDuration && info) {
            const targetWeight = Math.max(0, Math.min(1, config.weight / CONSTANTS.WEIGHT_UI_SCALE));
            config.action.enabled = true;
            config.action.paused = true;
            
            const mixer = this.mixers.get(config.modelId);
            const fadeInTime = Number(config.fadeInTime) || 0;
            if (fadeInTime > 0) {
                try { config.action.fadeIn(fadeInTime); } catch (_) {}
            } else {
                config.action.setEffectiveWeight(targetWeight);
                mixer && mixer.update(0);
            }
            
            const fadeOutTime = Number(config.fadeOutTime) || 0;
            if (fadeOutTime > 0) {
                try { config.action.fadeOut(fadeOutTime); } catch (_) {}
            } else {
                setTimeout(() => {
                    try {
                        config.action.setEffectiveWeight(0);
                        config.action.enabled = false;
                        mixer && mixer.update(0);
                    } catch (_) {}
                    this.events.emit('animation:finished', {
                        modelId: info.modelId,
                        animationId: info.animationId,
                        name: info.name
                    });
                }, 0);
            }
            return true;
        }
        return false;
    }

    /**
     * 绑定动画事件处理器（提取公共逻辑）
     * @private
     */
    _bindAnimationEventHandlers(config) {
        try {
            if (!config.action) return;
            
            // 解绑旧事件
            if (config._onceFinishHandler) {
                config.action.removeEventListener?.('finished', config._onceFinishHandler);
            }
            if (config._loopHandler) {
                config.action.removeEventListener?.('loop', config._loopHandler);
            }
            
            // finished 事件
            const finishHandler = (event) => {
                const info = this._actionToInfo.get(config.action);
                if (!info) return;
                if (config.loopMode === 1) {
                    this._restoreModelState(info.animationId);
                }
                this.events.emit('animation:finished', {
                    modelId: info.modelId,
                    animationId: info.animationId,
                    name: info.name
                });
            };
            config._onceFinishHandler = finishHandler;
            config.action.addEventListener?.('finished', finishHandler);
            
            // loop 事件
            const loopHandler = (event) => {
                const info = this._actionToInfo.get(config.action);
                if (!info) return;
                this.events.emit('animation:loop', {
                    modelId: info.modelId,
                    animationId: info.animationId,
                    name: info.name,
                    loop: event?.loopCount,
                    repetitions: config.action?.repetitions
                });
            };
            config._loopHandler = loopHandler;
            config.action.addEventListener?.('loop', loopHandler);
        } catch (_) {}
    }

    /**
     * 播放动画
     * @private
     */
    _playAnimation(animationId) {
        const config = this.animations.get(animationId);
        if (!config?.action) return;
        
        // 清理旧定时器
        if (config.startDelayTimerId) {
            this._clearTimer(config.startDelayTimerId);
            config.startDelayTimerId = null;
        }
        if (config._fadeOutTimerId) {
            try { clearTimeout(config._fadeOutTimerId); } catch (_) {}
            config._fadeOutTimerId = null;
        }

        // 处理极短动画
        try {
            if (this._handleMinimalDurationAnimation(config)) {
                // 极短动画也需要更新计数器
                if (!config.enabled) {
                    config.enabled = true;
                    this._updateActiveCount(config.modelId, 1);
                }
                return;
            }
        } catch (_) {}
        
        if (!config.enabled) {
            config.enabled = true;
            this._updateActiveCount(config.modelId, 1);
        }
        
        // 预备淡入
        const targetWeight = Math.max(0, Math.min(1, config.weight / CONSTANTS.WEIGHT_UI_SCALE));
        const needFadeIn = config.fadeInTime > 0;
        if (needFadeIn) {
            try { config.action.fadeIn(config.fadeInTime); } catch (_) {}
        } else {
            config.action.setEffectiveWeight(targetWeight);
        }

        // 绑定事件处理器
        this._bindAnimationEventHandlers(config);
        
            // 播放逻辑
        const playLogic = () => {
            if (!config.enabled || !config.action) return;
            
            // 重置
            if (config.loopMode !== 3) {
                try { config.action.reset(); } catch (_) {}
            }
            
            // 应用配置
            this._applyConfigToAction(config);
            
            // 启用并取消暂停
            try { config.action.enabled = true; } catch (_) {}
            try { config.action.paused = false; } catch (_) {}
            
            // 淡入
            if (needFadeIn) {
                try { config.action.fadeIn(config.fadeInTime); } catch (_) {}
            }
            
            // 设置时间和速度
            this._setActionTimeAndSpeed(config);
            
            // PingPong模式强制更新
            if (config.loopMode === 3) {
                const mixer = this.mixers.get(config.modelId);
                if (mixer) mixer.update(0);
            }
            
            // 播放
            config.action.play();
            
            // 安排淡出
            this._scheduleFadeOut(config);
        };
        
        // 延迟或立即播放
        if (config.startDelay > 0) {
            config.startDelayTimerId = setTimeout(() => {
                config.startDelayTimerId = null;
                playLogic();
            }, config.startDelay * CONSTANTS.MS_PER_SECOND);
        } else {
            playLogic();
        }
    }

    /**
     * 停止动画
     * @private
     */
    _stopAnimation(animationId) {
        const config = this.animations.get(animationId);
        if (!config?.action) return;
        
        // 优先清理延迟定时器
        if (config.startDelayTimerId) {
            this._clearTimer(config.startDelayTimerId);
            config.startDelayTimerId = null;
        }
        
        // 完全停止动画，重置该动作
        config.action.stop();
        config.action.reset();
        config.action.time = 0;
        
        if (config.enabled) {
            config.enabled = false;
            this._updateActiveCount(config.modelId, -1);
        }
        
        const activeCount = this._modelActiveCount.get(config.modelId) || 0;
        if (activeCount <= 0) {
            this._restoreModelState(animationId);
        }
    }

    /**
     * 清理计时器
     * @private
     */
    _clearTimer(timerId) {
        if (timerId) {
            clearTimeout(timerId);
        }
    }

    /**
     * 立即应用权重变化到模型（无论动画是否启用）
     * @private
     */
    _applyWeightImmediately(animationId) {
        const config = this.animations.get(animationId);
        if (!config?.action) return;
        
        // 统一权重处理：UI传入0-100，转换为0-1
        const effectiveWeight = Math.max(0, Math.min(1, config.weight / CONSTANTS.WEIGHT_UI_SCALE));
        config.action.setEffectiveWeight(effectiveWeight);

        // 权重预览模式：即使动画未播放，也要显示权重效果
        if (effectiveWeight > 0) {
            config.action.enabled = true;
            
            const hasPendingDelayedPlay = !!config.startDelayTimerId;
            const isRunning = typeof config.action.isRunning === 'function' ? config.action.isRunning() : false;
            if (!isRunning) {
                if (config.enabled && hasPendingDelayedPlay) {
                    config.action.paused = false;
                } else {
                    const previewTime = this._getOptimalPreviewTime(config);
                    const safeTime = Math.max(0, Math.min(Number(config.duration) || 0, previewTime));
                    config.action.time = safeTime;
                    config.action.paused = true;
                }
            }
        } else {
            // 权重为0时，禁用动画
            config.action.enabled = false;
        }

        // 强制更新动画混合器，确保权重变化立即反映到模型上
        const mixer = this.mixers.get(config.modelId);
        if (mixer) {
            mixer.update(0);
        }
    }

    /**
     * 获取最佳预览时间点
     * @private
     */
    _getOptimalPreviewTime(config) {
        const duration = Number(config.duration) || 0;
        if (duration <= 0) return 0;
        
        // 优先使用用户设置的预览时间
        if (config.previewTime !== undefined) {
            return Math.max(0, Math.min(duration, config.previewTime));
        }
        
        // 默认使用25%位置，通常包含更多关键帧信息
        return duration * 0.25;
    }

    /**
     * 保存模型初始状态
     * @private
     */
    _saveModelInitialState(model, modelId) {
        if (!this._modelStates) {
            this._modelStates = new Map();
        }
        
        // 为每个动画保存相同的初始状态
        const initialState = {
            position: model.position.clone(),
            rotation: model.rotation.clone(),
            scale: model.scale.clone()
        };
        
        // 为每个动画保存初始状态
        model.animations.forEach((clip, index) => {
            const animationId = `${modelId}_animation_${index}`;
            this._modelStates.set(animationId, {
                position: initialState.position.clone(),
                rotation: initialState.rotation.clone(),
                scale: initialState.scale.clone()
            });
        });
        
        console.log('已保存模型初始状态:', modelId, initialState);
    }

    /**
     * 恢复模型状态
     * @private
     */
    _restoreModelState(animationId) {
        const config = this.animations.get(animationId);
        if (!config) return;
        
        const model = this.engine?.assetsManager?.getModel(config.modelId);
        if (!model || !this._modelStates) return;
        
        const savedState = this._modelStates.get(animationId);
        if (!savedState) return;
        
        // 恢复位置、旋转和缩放
        model.position.copy(savedState.position);
        model.rotation.copy(savedState.rotation);
        model.scale.copy(savedState.scale);
        
        // 更新模型矩阵
        model.updateMatrix();
        model.updateMatrixWorld();
        
        // console.log('已恢复动画完成后的模型状态:', animationId, savedState);
        
    }

    /**
     * 停止所有动画
     * @private
     */
    _stopAllAnimations() {
        this.animations.forEach((config, id) => {
            if (config.enabled) {
                this._stopAnimation(id);
            }
        });
    }

    /**
     * 开始自动播放
     * @private
     */
    _startAutoPlay() {
        this.animations.forEach((config, id) => {
            if (config.enabled) {
                this._playAnimation(id);
            }
        });
    }


    /**
     * 通过动画clip的UUID查找动画信息
     * @private
     * @param {string} clipUuid - 动画clip的UUID
     * @returns {Object|null} { modelId, animationId, animationName } 或 null
     */
    _findAnimationByClipUuid(clipUuid) {
        // 在animations中查找
        for (const [animationId, config] of this.animations.entries()) {
            if (config.clip?.uuid === clipUuid) {
                return {
                    modelId: config.modelId,
                    animationId,
                    animationName: config.name
                };
            }
        }
        
        // 在actions中查找
        for (const [animationId, action] of this.actions.entries()) {
            if (action._clip?.uuid === clipUuid) {
                const info = this._actionToInfo.get(action);
                if (info) {
                    return {
                        modelId: info.modelId,
                        animationId,
                        animationName: info.name
                    };
                }
            }
        }
        
        return null;
    }

    /**
     * 应用动画选项
     * @private
     */
    _applyAnimationOptions(animation, options) {
        if (!animation?.action) return;
        
        const processedOptions = this._processTimeParams(options);
        Object.assign(animation, processedOptions);
        // 确保新参数正确应用到AnimationAction上
        this._applyConfigToAction(animation);
    }

    /**
     * 高亮动画相关的mesh
     * @param {string} modelId 模型ID
     * @param {string} animationIdOrNameOrMeshId 动画ID、动画名称或mesh的userData.id
     * @param {Object} options 选项 { color: 0xffffff, edgeStrength: 5.0, edgeGlow: 0.5, edgeThickness: 2.0 }
     */
    highlightAnimationMeshes(modelId, animationIdOrNameOrMeshId, options = {}) {
        const meshIds = this.getAnimationMeshIds(modelId, animationIdOrNameOrMeshId);
        if (meshIds.length > 0) {
            this.highlightMeshes(meshIds, options);
        }
    }

    /**
     * 清除所有动画mesh的高亮边框
     */
    clearAnimationMeshHighlights() {
        const hl = this.engine?.highlightController;
        if (hl) {
            hl.clear(this._highlightedMeshes);
        }
        this._highlightedMeshes = [];
        this._highlightedMeshesSet.clear();
    }


    /**
     * 通过mesh的userData.id查找mesh对象和对应的modelId
     * @private
     * @param {string} meshId mesh的userData.id
     * @returns {Array<{mesh: THREE.Mesh, modelId: string}>} 找到的mesh和modelId数组
     */
    _findMeshesById(meshId) {
        const results = [];
        if (!meshId || !this.engine?.assetsManager?.assets?.models) {
            return results;
        }
        
        const normalizedId = meshId.replace(/\//g, '-');
        
        for (const [modelId, model] of this.engine.assetsManager.assets.models.entries()) {
            let targetObject = null;
            
            // 查找：支持精确匹配和格式转换匹配
            model.traverse((obj) => {
                if (!targetObject && obj.userData && obj.userData.id) {
                    const objId = obj.userData.id;
                    // 精确匹配或格式转换后匹配
                    if (objId === meshId || objId === normalizedId || 
                        objId.replace(/\//g, '-') === normalizedId) {
                        targetObject = obj;
                    }
                }
            });
            
            if (targetObject) {
                if (targetObject.isMesh) {
                    results.push({ mesh: targetObject, modelId });
                } else {
                    targetObject.traverse((child) => {
                        if (child.isMesh && child.geometry && child.geometry.attributes) {
                            const exists = results.some(r => r.mesh === child);
                            if (!exists) {
                                results.push({ mesh: child, modelId });
                            }
                        }
                    });
                }
            }
        }
        
        return results;
    }

    /**
     * 直接高亮指定的mesh（通过mesh的userData.id）
     * @param {string|Array<string>} meshIds mesh的userData.id（单个或数组）
     * @param {Object} options 选项 { color: 0xffffff, edgeStrength: 5.0, edgeGlow: 0.5, edgeThickness: 2.0 }
     * @returns {boolean} 是否成功
     */
    highlightMeshes(meshIds, options = {}) {
        const hl = this.engine?.highlightController;
        if (!hl) return false;
        
        const meshIdArray = Array.isArray(meshIds) ? meshIds : [meshIds];
        if (meshIdArray.length === 0) {
            return false;
        }
        
        this.clearAnimationMeshHighlights();
        
        const meshObjects = [];
        const meshSet = new Set();
        
        meshIdArray.forEach(meshId => {
            const found = this._findMeshesById(meshId);
            found.forEach(({ mesh }) => {
                if (mesh && mesh.geometry && mesh.geometry.attributes && !meshSet.has(mesh)) {
                    meshSet.add(mesh);
                    meshObjects.push(mesh);
                }
            });
        });
        
        if (meshObjects.length === 0) {
            console.warn('未找到有效的mesh对象，meshIds:', meshIdArray);
            return false;
        }
        
        // 统一使用语义化接口，AnimationController 不再关心具体颜色通道
        const highlightType = options.useAnimationHighlight !== false ? 'animation' : 'hotspot';
        hl.highlightByType(meshObjects, { ...options, type: highlightType });
        
        this._highlightedMeshes = meshObjects;
        this._highlightedMeshesSet = new Set(meshObjects);
        
        return true;
    }


    // ==================== 生命周期方法 ====================
    
    /**
     * 检查模型是否有活跃动画（基于实际 action 状态，不依赖手动计数器）
     * @private
     * @param {string} modelId - 模型ID
     * @returns {boolean} 是否有活跃动画
     */
    _checkActiveAnimations(modelId) {
        // 直接检查实际的 action 状态，不依赖手动维护的计数器
        // 这样更可靠，避免计数器不同步的问题
        
        // 检查原始动画
        for (const [, cfg] of this.animations) {
            if (cfg.modelId !== modelId) continue;
            const action = cfg.action;
            if (action && (
                action.enabled && action.isRunning?.() ||
                action.getEffectiveWeight?.() > 0
            )) {
                return true;
            }
        }
        
        // 检查分割动画
        for (const [actionId, action] of this.actions.entries()) {
            if (this._isSplitAnimationId(actionId)) {
                const info = this._actionToInfo.get(action);
                if (info && info.modelId === modelId) {
                    if (action && (
                        action.enabled && action.isRunning?.() ||
                        action.getEffectiveWeight?.() > 0
                    )) {
                        return true;
                    }
                }
            }
        }
        
        return false;
    }
    
    /**
     * 处理固定在最后一帧的动画
     * @private
     * @param {string} modelId - 模型ID
     */
    _processClampAtEndAnimations(modelId) {
        this.actions.forEach((action) => {
            if (action._clampAtEnd && action._clip) {
                const info = this._actionToInfo.get(action);
                if (info && info.modelId === modelId) {
                    if (action.time !== action._clip.duration) {
                        action.time = action._clip.duration;
                    }
                    if (!action.paused) {
                        action.paused = true;
                    }
                }
            }
        });
    }
    
    /**
     * 更新模型动画
     * @private
     * @param {string} modelId - 模型ID
     * @param {AnimationMixer} mixer - 动画混合器
     * @param {number} deltaTime - 时间增量
     * @param {boolean} shouldUpdateBounds - 是否更新边界
     */
    _updateMixerAnimations(modelId, mixer, deltaTime, shouldUpdateBounds) {
        mixer.update(deltaTime);
        
        // 更新后检查并固定时间（确保 clampAtEnd 的动画停留在最后一帧）
        this._processClampAtEndAnimations(modelId);
        
        if (shouldUpdateBounds) {
            this._updateSkinnedBounds(modelId);
        }
    }
    
    /**
     * 更新循环
     * @param {number} deltaTime 时间增量
     */
    update(deltaTime) {
        this._frameCount++;
        const shouldUpdateBounds = this._frameCount % 10 === 0;
        
        this.mixers.forEach((mixer, modelId) => {
            if (!mixer?.update) return;
            
            if (!this._checkActiveAnimations(modelId)) return;
            
            this._updateMixerAnimations(modelId, mixer, deltaTime, shouldUpdateBounds);
        });
        this._refreshHoverIfNeeded();
    }

    /**
     * 在必要时用当前鼠标位置刷新一次hover命中。
     * @private
     */
    _refreshHoverIfNeeded() {
        const im = this.engine?.inputManager;
        const pos = im?.mouse?.position;
        if (!pos) return;
        if (im?.mouse?.isDragging) return;

        const hasHovered = !!this._hoveredMesh;
        let hasActive = false;
        if (this._modelActiveCount?.size) {
            for (const c of this._modelActiveCount.values()) {
                if (c > 0) { hasActive = true; break; }
            }
        }
        if (!hasHovered && !hasActive) return;

        this._onMouseMoveHover({ position: pos });
    }
    
    /**
     * 更新模型的SkinnedMesh边界（使用缓存）
     * @private
     */
    _updateSkinnedBounds(modelId) {
        let meshes = this._skinnedMeshCache.get(modelId);
        if (!meshes) {
            meshes = [];
            const model = this.engine?.assetsManager?.getModel(modelId);
            model?.traverse(obj => obj.isSkinnedMesh && meshes.push(obj));
            this._skinnedMeshCache.set(modelId, meshes);
        }
        for (const mesh of meshes) {
            if (mesh.parent) {
                mesh.computeBoundingBox();
                mesh.computeBoundingSphere();
            }
        }
    }

    /**
     * 释放资源
     */
    dispose() {
        try {
            this._stopAllAnimations();
            
            // 清理动画混合器                                
            this.mixers.forEach((mixer, modelId) => {
                if (mixer) {
                    try {
                        mixer.stopAllAction();
                        mixer.uncacheRoot(mixer.getRoot());
                    } catch (error) {
                        console.warn('清理动画混合器时出错:', error);
                    }
                }
            });
            
            // 清理动画动作
            this.actions.forEach((action, actionId) => {
                if (action) {
                    try {
                        if (action._onceFinishHandler) {
                            action.removeEventListener?.('finished', action._onceFinishHandler);
                        }
                        if (action._loopHandler) {
                            action.removeEventListener?.('loop', action._loopHandler);
                        }
                        action.stop();
                        action.reset();
                    } catch (error) {
                        console.warn('清理动画动作时出错:', error);
                    }
                }
            });
            
            // 移除事件监听器
            if (this.engine?.events) {
                this.engine.events.off('scene:model', this._onModelLoaded.bind(this));
                this.engine.events.off('mesh:click', this._onMeshClick.bind(this));
                this.engine.events.off('input.mousemove', this._onMouseMoveHover.bind(this));
            }
            
            // 移除更新回调
            this.engine?.removeUpdateCallback('animationController');
            
            // 清理事件总线
            if (this.events) {
                this.events.removeAllListeners();
            }
            
            this.clearAnimationMeshHighlights();
            
            // 清除所有映射
            this.animations.clear();
            this.mixers.clear();
            this.actions.clear();
            this.materialAnimationMap.clear();
            this._skinnedMeshCache.clear();
            this._meshAnimationBindings.clear();
            this._boundMeshes.clear();
            this._modelActiveCount.clear();
            this._splitAnimationIds.clear();
            this._splitCreationTime.clear();
            this._highlightedMeshesSet.clear();
            
            // 清理模型状态
            if (this._modelStates) {
                this._modelStates.clear();
                this._modelStates = null;
            }

            // 清理引用
            this.engine = null;
            this.scene = null; 
            this.events = null;
            
        } catch (error) {
            console.error('释放动画控制器资源时出错:', error);
        }
    }
} 
