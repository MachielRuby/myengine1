/**
 * 热点控制器 - 管理3D场景中的交互热点
 * @author AGan
 * @version 1.0
 */

import {
    TextureLoader,
    Color,
    Vector3,
    Box3,
    CanvasTexture,
    Matrix3,
    Matrix4,
    Quaternion,
    Euler,
    VideoTexture,
    Raycaster,
    Vector2,
    Frustum,
    PlaneGeometry,
    MeshBasicMaterial,
    Mesh,
    DoubleSide
} from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { EventBus } from "../core/events/eventEmitter.js";

export class HotspotController {
    constructor(engine) {
        this.engine = engine;

        this.CONFIG = {
            DEFAULT_SIZE: 0.2, // 默认大小
            SIZE_SCALE_FACTOR: 0.4, // 外部大小到内部大小的映射系数（外部1 -> 内部0.4）
            DEFAULT_OPACITY: 1.0,  // 默认透明度
            COLOR_INTENSITY: 1.2,  // 颜色增强系数
            HIGHLIGHT_COLOR: 0xff6600, // 高亮颜色
            FADE_THRESHOLD: 0.5,  // 增大阈值控制热点透明
            MIN_OFFSET: 0.08,     // 最小偏移系数
            BASE_OFFSET: 0.15,    // 基础偏移系数
            CAMERA_FOCUS_ENABLED: false,
            CAMERA_FOCUS_DISTANCE: 3.0,
            CAMERA_FOCUS_MIN_DISTANCE: 0.8,
            CAMERA_FOCUS_MAX_DISTANCE: 4.0,
            CAMERA_FOCUS_DURATION: 1200,
            ROTATE_BASE_ANGLE: 10,
            SKIP_IDLE_CAMERA: true,
            // 遮挡检测
            OCCLUSION_CHECK_PER_FRAME: 2,     // 每帧轮询检测的热点数量（仅影响 label）
            OCCLUSION_TOLERANCE: 0.05,        // 基础容差（会按距离动态放大）
            MESH_CACHE_DURATION: 500,         // 场景网格缓存时长（毫秒）
            HOVER_THROTTLE_MS: 50,            // 鼠标悬停节流时间（毫秒）
            MAX_INITIAL_OCCLUSION_COUNT: 50,   // 首次遮挡预计算的最大热点数
            SCREEN_SPACE_SIZE: true,           // 屏幕空间大小（前后移动时大小不变）
            SCREEN_SPACE_REFERENCE_DISTANCE: 5.0,  // 参考距离
            // 多点采样遮挡检测
            MULTI_POINT_SAMPLING: true,           // 是否启用多点采样
            OCCLUSION_SAMPLE_COUNT: 5,            // 采样点数量
            OCCLUSION_THRESHOLD: 0.5              // 遮挡阈值
        };

        this.events = new EventBus();
        this.loader = new TextureLoader();
        this.hotspots = new Map();
        this.labels = new Map();
        this.selectedId = null;
        this.dragState = null;

        this._cachedHotspotList = []; // 缓存热点列表
        this._dirtyList = false;      // 列表是否脏了
        this._checkIndex = 0;         // label 遮挡轮询索引
        
        // 场景对象缓存
        this._sceneMeshCache = null;
        this._sceneMeshCacheTime = 0;
        this._sceneObjectIdMap = null; // ID到对象的映射

        //控制接口
        this.mode = "editor"; // "editor" | "preview"

        // 射线检测
        this._raycaster = new Raycaster();
        // 屏幕坐标
        this._ndc = new Vector2();
        // 临时变量池
        this._temp = {
            vec1: new Vector3(),
            vec2: new Vector3(),
            vec3: new Vector3(),
            vec4: new Vector3(),
            vec5: new Vector3(),
            vec6: new Vector3(),
            mat3: new Matrix3(),
            mat4: new Matrix4(),
            box3: new Box3(),
            color: new Color(),
            frustum: new Frustum()
        };
        
        // 相机状态追踪
        this._lastCameraPos = new Vector3();
        this._lastCameraQuat = new Quaternion();
        this._cameraIsMoving = true;
        
        // 场景变化检测：动画播放期间不跳过 label 遮挡刷新
        this._lastSceneUpdateTime = 0;
        this._sceneChangeDetected = false;
        // 首次遮挡预计算：避免进入时 label 短暂“穿透”
        this._initialOcclusionDone = false;
        // 模型进入场景后：失效 mesh 缓存，下一帧触发一次预计算
        this._boundOnSceneModelLoaded = null;
        
        // 交互锁状态
        this._interactionLockState = {
            locked: false,
            editController: null
        };
        // UI/输入
        this._injectStyles();
        this._bindInput();
        this._hoveredHotspotId = null;

        // 监听模型加载：模型异步进入场景时，需要刷新 mesh 缓存并重新做一次 label 遮挡预计算
        const engineBus = this.engine?.events;
        if (engineBus?.on) {
            this._boundOnSceneModelLoaded = () => {
                // 模型进入场景后，mesh 缓存一定要失效，否则遮挡检测会沿用旧缓存
                this._invalidateMeshCache();
                // 重新触发一次全量遮挡预计算（下一帧执行）
                this._initialOcclusionDone = false;
                // 立刻把现有标签隐藏，避免在"模型已出现但尚未跑遮挡"的这 1 帧内穿透显示
                if (this.labels?.size) {
                    for (const id of this.labels.keys()) this._hideLabel(id);
                }
                // 恢复所有热点的绑定
                this._restoreAllHotspotBindings();
            };
            engineBus.on('scene:model', this._boundOnSceneModelLoaded);
        }
    }
    
    /**
     * 恢复所有热点的绑定（模型加载后调用）
     * @private
     */
    _restoreAllHotspotBindings() {
        this.hotspots.forEach(hs => {
            if (hs.state?.bindMeshId && !hs.state?.targetObject) {
                this._restoreHotspotBinding(hs);
            }
        });
    }

    // 添加热点：根据配置创建并添加到场景中，支持sprite和mesh两种类型
    add(opts = {}) {
        const {
            id,
            iconUrl,
            videoUrl,
            size = 1,  // 外部默认大小为1
            scaleMode = 'adaptive',
            position,
            color = 0xffffff,
            label,
            enableCameraFocus = true,
            userData = {},
            type = 1, // 1: sprite热点, 2: 平面热点
            autoSelect = true, // 是否自动选中，默认为 true
            // 序列帧动画参数
            frameCount = null,      // 序列帧总数
            frameDuration = null,   // 每帧播放时长（秒）
            totalDuration = null,   // 总播放时长（秒）
    
            rx, ry, rz, rw,         // 四元数独立字段
            nx, ny, nz,             // 法向量独立字段
            bindMeshId = null     // 绑定的meshId
        } = opts;
        
        let quaternion = opts.quaternion ?? null;
        let worldNormal = opts.worldNormal ?? null;
        
        // 提供了独立字段但没有对象，则构建对象
        if (!quaternion && (rx !== undefined || ry !== undefined || rz !== undefined || rw !== undefined)) {
            quaternion = {
                rx: rx ?? 0,
                ry: ry ?? 0,
                rz: rz ?? 0,
                rw: rw ?? 1
            };
        }
        
        if (!worldNormal && (nx !== undefined || ny !== undefined || nz !== undefined)) {
            worldNormal = {
                worldNormalX: nx ?? 0,
                worldNormalY: ny ?? 0,
                worldNormalZ: nz ?? 1
            };
        }
        
        const internalSize = this._mapExternalSizeToInternal(size);
        const internalFrameDuration = frameDuration !== null ? frameDuration * 1000 : null;
        const internalTotalDuration = totalDuration !== null ? totalDuration * 1000 : null;

        if (!id) {
            console.error('HotspotController.add: id is required');
            return null;
        }

        if (this.hotspots.has(id)) {
            return this.updateHotspot(id, opts);
        }

        const { hotspotObject, material } = this._createHotspotObject(type, id);

        if (position) {
            if (position.x !== undefined) {
                hotspotObject.position.set(position.x, position.y ?? 0, position.z ?? 0);
            } else {
                hotspotObject.position.copy(position);
            }
        } else {
            const frontPos = this._calculateCameraFrontPosition();
            hotspotObject.position.copy(frontPos);
        }
        hotspotObject.scale.set(internalSize, internalSize, 1);
        hotspotObject.visible = !(iconUrl || videoUrl); 
        
        this.engine.mainScene.add(hotspotObject);
        hotspotObject.updateMatrixWorld(true);

        const hotspot = {
            id,
            sprite: hotspotObject,  
            material,
            opts: { 
                size: internalSize,  
                scaleMode, 
                enableCameraFocus,
                type,
                frameCount,
                frameDuration: internalFrameDuration,
                totalDuration: internalTotalDuration
            },
            state: {
                iconKind: null,
                animationData: null,
                currentFrame: 0,
                accumulatedTime: 0,
                canvas: null,
                ctx: null,
                texture: null,
                iconUrl: iconUrl || null,
                videoUrl: videoUrl || null,
                _userVisible: true,
                _isLoading: !!(iconUrl || videoUrl),
                _isOccluded: false, // 初始化遮挡状态
                _inFrustum: false  // 视锥体内标记
            },
            userData
        };
        this.hotspots.set(id, hotspot);

        // 应用四元数旋转
        if (quaternion && typeof quaternion === 'object' && type === 2) {
            if (quaternion.rx !== undefined || quaternion.ry !== undefined || 
                quaternion.rz !== undefined || quaternion.rw !== undefined) {
                const normalized = this._normalizeQuaternion(quaternion);
                hotspotObject.quaternion.set(
                    normalized.rx, normalized.ry, normalized.rz, normalized.rw
                );
                hotspotObject.updateMatrixWorld(true);
            }
        }

        // 应用法向量
        if (worldNormal && typeof worldNormal === 'object') {
            if (worldNormal.worldNormalX !== undefined || 
                worldNormal.worldNormalY !== undefined || 
                worldNormal.worldNormalZ !== undefined) {
                hotspot.state.worldNormal = new Vector3(
                    worldNormal.worldNormalX ?? 0,
                    worldNormal.worldNormalY ?? 0,
                    worldNormal.worldNormalZ ?? 1
                );
                hotspot.state.isSurfaceAttached = true;
                
                if (type === 2 && !quaternion) {
                    this._orientSpriteToNormal(hotspotObject, hotspot.state.worldNormal);
                }
            }
        }

        this._updateHotspotLabel(hotspot, label ?? null);
        
        // 恢复绑定的meshId
        if (bindMeshId) {
            hotspot.state.bindMeshId = bindMeshId;
            if (hotspot.state.worldNormal) {
                hotspot.state.isSurfaceAttached = true;
            }
            // 延迟恢复绑定
            this._restoreHotspotBinding(hotspot);
        }
        
        this._invalidateMeshCache();
        
        if (videoUrl) {
            this._applyVideoIcon(hotspot, videoUrl);
        } else if (iconUrl) {
            this._setIconFromUrl(id, iconUrl).catch(err => console.error('load icon:', err));
        }
        
        // 标记缓存列表需要更新
        this._dirtyList = true;

        this.events.emit('hotspot:added', { id });
        return hotspot;
    }
    
    /**
     * 恢复热点绑定（延迟执行，等待场景mesh加载完成）
     * @private
     * @param {Object} hs - 热点对象
     */
    _restoreHotspotBinding(hs) {
        if (!hs.state?.bindMeshId) return;
        
        const targetMesh = this._findMeshById(hs.state.bindMeshId);
        if (targetMesh && targetMesh.parent) {
            hs.state.targetObject = targetMesh;
            hs.state.localOffset = null;
            hs.state.localNormal = null;
            hs.state.isSurfaceAttached = true;
        }
    }

    // 更新热点：更新指定热点的属性（位置、大小、颜色、标签等）
    updateHotspot(id, opts) {
        let hs = this.hotspots.get(id);
        if (!hs) {
            console.warn(`Hotspot ${id} not found, creating new one`);
            return this.add({ ...opts, id });
        }

        if (opts.type !== undefined) {
            const currentType = hs.opts.type || 1; 
            if (opts.type !== currentType) {
                this.switchHotspotType(id, opts.type);
                hs = this.hotspots.get(id);
                if (!hs) return false;
            }
        }

        if (opts.position) {
            if (hs.state) {
                hs.state.localOffset = null;
                hs.state.localNormal = null;
                hs.state.targetObject = null;
            }
            Object.assign(hs.sprite.position, opts.position);
            hs.sprite.updateMatrixWorld(true);
            
            // 同步更新标签位置
            if (this.labels.has(hs.id)) {
                this._updateLabelTransform(hs);
            }
        }

        if (opts.size !== undefined) {
            const internalSize = this._mapExternalSizeToInternal(opts.size);
            hs.opts.size = internalSize;
            hs.sprite.scale.set(internalSize, internalSize, 1);
            this._refreshHotspotLabelOffset(hs);
        }

        // 颜色设置始终生效：选中状态不再改变热点本身颜色
        if (opts.color !== undefined) {
            hs.material.color.set(opts.color);
            hs.material.needsUpdate = true;
        }

        if (opts.scaleMode !== undefined) {
            hs.opts.scaleMode = opts.scaleMode;
        }

        if (opts.enableCameraFocus !== undefined) {
            hs.opts.enableCameraFocus = !!opts.enableCameraFocus;
        }

        if (opts.label !== undefined) {
            this._updateHotspotLabel(hs, opts.label);
        }

        if (opts.userData !== undefined) {
            hs.userData = opts.userData;
        }

        if (opts.frameCount !== undefined) hs.opts.frameCount = opts.frameCount;
        if (opts.frameDuration !== undefined) hs.opts.frameDuration = opts.frameDuration * 1000;
        if (opts.totalDuration !== undefined) hs.opts.totalDuration = opts.totalDuration * 1000;

        // 处理独立字段：将 rx/ry/rz/rw 和 nx/ny/nz 转换为对象形式（与 add 方法保持一致）
        let quaternion = opts.quaternion ?? null;
        let worldNormal = opts.worldNormal ?? null;
        
        const { rx, ry, rz, rw, nx, ny, nz, bindMeshId } = opts;
        
        // 提供了独立字段但没有对象，则构建对象
        if (!quaternion && (rx !== undefined || ry !== undefined || rz !== undefined || rw !== undefined)) {
            quaternion = {
                rx: rx ?? 0,
                ry: ry ?? 0,
                rz: rz ?? 0,
                rw: rw ?? 1
            };
        }
        
        if (!worldNormal && (nx !== undefined || ny !== undefined || nz !== undefined)) {
            worldNormal = {
                worldNormalX: nx ?? 0,
                worldNormalY: ny ?? 0,
                worldNormalZ: nz ?? 1
            };
        }

        // 恢复/更新绑定的 meshId（持久化字段）
        if (bindMeshId !== undefined) {
            if (!hs.state) hs.state = {};
            hs.state.bindMeshId = bindMeshId || null;
            hs.state.targetObject = null;
            hs.state.localOffset = null;
            hs.state.localNormal = null;
        }

        if (quaternion && typeof quaternion === 'object') {
            if (quaternion.rx !== undefined || quaternion.ry !== undefined || 
                quaternion.rz !== undefined || quaternion.rw !== undefined) {
                const fullQuaternion = {
                    rx: quaternion.rx ?? hs.sprite.quaternion.x,
                    ry: quaternion.ry ?? hs.sprite.quaternion.y,
                    rz: quaternion.rz ?? hs.sprite.quaternion.z,
                    rw: quaternion.rw ?? hs.sprite.quaternion.w
                };
                const normalized = this._normalizeQuaternion(fullQuaternion);
                hs.sprite.quaternion.set(
                    normalized.rx, normalized.ry, normalized.rz, normalized.rw
                );
                hs.sprite.updateMatrixWorld(true);
            }
        }

        if (worldNormal && typeof worldNormal === 'object') {
            if (worldNormal.worldNormalX !== undefined || 
                worldNormal.worldNormalY !== undefined || 
                worldNormal.worldNormalZ !== undefined) {
                if (!hs.state) hs.state = {};
                hs.state.worldNormal = new Vector3(
                    worldNormal.worldNormalX ?? 0,
                    worldNormal.worldNormalY ?? 0,
                    worldNormal.worldNormalZ ?? 1
                );
                hs.state.isSurfaceAttached = true;
                
                if (hs.opts.type === 2 && !quaternion) {
                    this._orientSpriteToNormal(hs.sprite, hs.state.worldNormal);
                }
            }
        }

        if (opts.videoUrl || opts.iconUrl) {
            if (hs.state) {
                hs.state._origColor = null;
            }
        }
        
        if (opts.videoUrl) {
            hs.state.videoUrl = opts.videoUrl;
            this._applyVideoIcon(hs, opts.videoUrl);
        } else if (opts.iconUrl) {
            hs.state.iconUrl = opts.iconUrl;
            this._setIconFromUrl(id, opts.iconUrl).catch(err => console.error('load icon:', err));
        }

        this.events.emit('hotspot:updated', { id });
        return hs;
    }

    // 删除热点：移除指定热点及其标签，清理相关资源
    remove(id) {
        const hs = this.hotspots.get(id);
        if (!hs) return false;

        // 如果热点被选中，先清除高亮
        if (this.selectedId === id) {
            this._setHighlight(hs, false);
            this.selectedId = null;
        }

        this._removeHotspotLabel(id);
        this._disposeResources(hs);
        this.engine.mainScene.remove(hs.sprite);
        this.hotspots.delete(id);

        this._invalidateMeshCache(); 
        // 标记缓存列表需要更新
        this._dirtyList = true;
        
        this.events.emit('hotspot:removed', { id });
        return true;
    }

    // 选择热点：选中指定热点并高亮显示
    select(id) {
        if (!id || !this.hotspots.has(id)) return;
        
        if (this.selectedId && this.selectedId !== id) {
            const prev = this.hotspots.get(this.selectedId);
            this._setHighlight(prev, false);
        }
        
        const hs = this.hotspots.get(id);
        this._setHighlight(hs, true);
        this.selectedId = id;
        this.events.emit('hotspot:selected', { id });
    }

    // 清除选择：取消当前选中的热点，恢复其原始状态
    clearSelection() {
        if (!this.selectedId) return;
        const hs = this.hotspots.get(this.selectedId);
        if (hs) this._setHighlight(hs, false);
        this.selectedId = null;
        this.events.emit('hotspot:cleared');
    }

    // 切换热点类型：在sprite和mesh两种类型之间切换，保留原有属性
    switchHotspotType(id, newType) {
        const hs = this.hotspots.get(id);
        if (!hs) return false;
        
        const currentType = hs.opts.type || 1;
        if (currentType === newType) return hs;
        
        const wasSelected = this.selectedId === id;
        
        // 保存四元数（旋转）
        let quaternion = null;
        if (hs.sprite) {
            quaternion = {
                rx: hs.sprite.quaternion.x,
                ry: hs.sprite.quaternion.y,
                rz: hs.sprite.quaternion.z,
                rw: hs.sprite.quaternion.w
            };
        }
        
        // 保存世界法向量（附着方向）
        let worldNormal = null;
        if (hs.state?.worldNormal) {
            worldNormal = {
                worldNormalX: hs.state.worldNormal.x,
                worldNormalY: hs.state.worldNormal.y,
                worldNormalZ: hs.state.worldNormal.z
            };
        }
        
        const savedState = {
            id,
            type: newType,
            position: hs.sprite.position.clone(),
            size: hs.opts.size / this.CONFIG.SIZE_SCALE_FACTOR,
            scaleMode: hs.opts.scaleMode,
            enableCameraFocus: hs.opts.enableCameraFocus,
            iconUrl: hs.state.iconUrl,
            videoUrl: hs.state.videoUrl,
            frameCount: hs.opts.frameCount,
            frameDuration: hs.opts.frameDuration ? hs.opts.frameDuration / 1000 : null,
            totalDuration: hs.opts.totalDuration ? hs.opts.totalDuration / 1000 : null,
            userData: hs.userData,
            autoSelect: false,  // 切换类型时不自动选中，由后续的 select 统一管理
            // 保存四元数和世界法向量，确保切换类型后方向不会丢失
            quaternion: quaternion,
            worldNormal: worldNormal,
            // 保留绑定 meshId（持久化字段），切换类型后仍可跟随动画
            bindMeshId: hs.state?.bindMeshId || null
        };
        
        const labelData = this.labels.get(id);
        if (labelData) {
            savedState.label = {
                text: labelData.options.text,
                align: labelData.options.align,
                offset: labelData.options.offset,
                visible: labelData.visible
            };
        }
        
        this.remove(id);
        const newHotspot = this.add(savedState);
        
        if (wasSelected) {
            this.select(id);
        }
        
        this.events.emit('hotspot:type:switched', { id, oldType: currentType, newType });
        return newHotspot;
    }

    // 设置所有热点可见性：批量控制所有热点的显示/隐藏状态
    setAllVisible(visible = true) {
        const flag = !!visible;
        this.hotspots.forEach(hs => {
            if (!hs.state) hs.state = {};
            hs.state._userVisible = flag;
            
            if (hs.sprite && hs.material) {
                const ht = hs.sprite.userData.__hotspotType;
                const isMesh = ht === 'mesh' || ht === 'billboard';
                if (isMesh) {
                    if (!flag) {
                        hs.material.opacity = 0;
                        hs.material.transparent = true;
                        hs.material.needsUpdate = true;
                        hs.sprite.visible = false;
                    } else {
                        hs.material.opacity = this.CONFIG.DEFAULT_OPACITY;
                        hs.material.needsUpdate = true;
                        hs.sprite.visible = true;
                    }
                    hs.material.depthTest = true;
                    hs.material.depthWrite = true;
                } else {
                    hs.sprite.visible = flag;
                }
            }
            
            // 隐藏时标记为遮挡
            if (!flag) {
                hs.state._isOccluded = true;
            }
            const label = this.labels.get(hs.id);
            if (label?.object) {
                label.visible = flag;
                if (!flag) {
                    // 隐藏时立即隐藏
                    label.object.visible = false;
                    const el = this._getLabelElement(label);
                    if (el) el.classList.add('is-hidden');
                } else {
                    // 显示时先隐藏，由update循环的遮挡检测决定是否真正显示
                    label.object.visible = false;
                    const el = this._getLabelElement(label);
                    if (el) el.classList.add('is-hidden');
                }
            }
        });
        this.events.emit('hotspots:visibility:changed', { visible: flag });
    }

    // 高亮热点：设置指定热点的选中/高亮状态
    highlightHotspot(id, highlighted = true) {
        const hs = this.hotspots.get(id);
        if (!hs) return false;
        
        if (highlighted) {
            this.select(id);
        } else {
            this.clearSelection();
        }
        return true;
    }

    // 获取热点位置：返回指定热点的3D位置坐标
    getHotspotPosition(id) {
        return this.hotspots.get(id)?.sprite?.position.clone() || null;
    }
    
    // 获取热点四元数：返回指定热点的旋转四元数
    getHotspotQuaternion(id) {
        const hs = this.hotspots.get(id);
        if (!hs?.sprite) return null;
        return { rx: hs.sprite.quaternion.x, ry: hs.sprite.quaternion.y, rz: hs.sprite.quaternion.z, rw: hs.sprite.quaternion.w };
    }
    
    // 设置热点四元数：设置指定热点的旋转四元数
    setHotspotQuaternion(id, quaternion) {
        const hs = this.hotspots.get(id);
        if (!hs?.sprite) return false;
        if (quaternion && typeof quaternion === 'object') {
            const normalized = this._normalizeQuaternion(quaternion);
            hs.sprite.quaternion.set(normalized.rx, normalized.ry, normalized.rz, normalized.rw);
            hs.sprite.updateMatrixWorld(true);
            if (!hs.state) hs.state = {};
            hs.state._hasCustomRotation = true;
            this.events.emit('hotspot:quaternion:updated', { id });
            return true;
        }
        return false;
    }
    
    // 获取热点世界法向量：返回指定热点所在表面的世界空间法向量
    getHotspotWorldNormal(id) {
        const hs = this.hotspots.get(id);
        if (!hs?.state?.worldNormal) return null;
        return { worldNormalX: hs.state.worldNormal.x, worldNormalY: hs.state.worldNormal.y, worldNormalZ: hs.state.worldNormal.z };
    }

    // 获取热点绑定的meshId：返回 mesh.userData.id
    getHotspotTargetMeshId(id) {
        return this.hotspots.get(id)?.state?.bindMeshId || null;
    }
    
    // 设置热点世界法向量：设置指定热点所在表面的世界空间法向量
    setHotspotWorldNormal(id, normal) {
        const hs = this.hotspots.get(id);
        if (!hs) return false;
        if (!hs.state) hs.state = {};
        if (normal && typeof normal === 'object') {
            hs.state.worldNormal = new Vector3(normal.worldNormalX ?? 0, normal.worldNormalY ?? 0, normal.worldNormalZ ?? 1);
            hs.state.isSurfaceAttached = true;
            if (hs.sprite.userData.__hotspotType === 'mesh') {
                this._orientSpriteToNormal(hs.sprite, hs.state.worldNormal);
            }
            this.events.emit('hotspot:worldnormal:updated', { id });
            return true;
        }
        return false;
    }

    // 获取热点旋转角度：返回指定热点的欧拉角旋转（度），支持360度连续旋转
    getHotspotRotation(id) {
        const hs = this.hotspots.get(id);
        if (!hs?.sprite) return null;
        const euler = new Euler().setFromQuaternion(hs.sprite.quaternion, 'XYZ');
        if (!hs.state) hs.state = {};
        
        // 将角度规范化到 0-360 度范围，并保持连续性（避免角度跳跃）
        const getContinuousAngle = (currentAngle, axis) => {
            const currentDeg = currentAngle * (180 / Math.PI);
            const lastAngle = hs.state[`_lastRotation${axis}`];
            
            // 如果没有上一次的角度值，初始化它
            if (lastAngle === undefined) {
                let normalized = currentDeg % 360;
                if (normalized < 0) normalized += 360;
                hs.state[`_lastRotation${axis}`] = normalized;
                return normalized;
            }
            
            // 规范化当前角度到 -180 到 180 度范围（Euler 的默认范围）
            let normalized = currentDeg % 360;
            if (normalized > 180) normalized -= 360;
            if (normalized < -180) normalized += 360;
            
            // 将上一次角度也规范化到 -180 到 180 度范围进行比较
            let lastNormalized = lastAngle % 360;
            if (lastNormalized > 180) lastNormalized -= 360;
            if (lastNormalized < -180) lastNormalized += 360;
            
            let rawDiff = normalized - lastNormalized;
            
            if (normalized === -180 && lastNormalized !== -180 && lastNormalized !== 180) {
                normalized = 180;
            }
            if (lastNormalized === -180 && normalized !== -180 && normalized !== 180) {
                lastNormalized = 180;
            }
            
            let diff = normalized - lastNormalized;
            // 需要使用原始差值来判断旋转方向
            if (diff === 0 && Math.abs(rawDiff) > 0.1) {
                // 使用原始差值，但需要规范化到合理范围
                diff = rawDiff;
                if (diff > 180) diff -= 360;
                if (diff < -180) diff += 360;
            } else if (Math.abs(diff) === 180) {
                // 如果差值正好是 ±180°，需要根据上一次累积角度判断旋转方向
                const lastAccumulated = lastAngle % 360;
                if (lastAccumulated < 180) {
                    // 从 0-180° 继续向后旋转，差值应该是 -180
                    diff = -180;
                } else if (lastAccumulated > 180) {
                    // 从 180-360° 继续向前旋转，差值应该是 +180
                    diff = 180;
                } else {
                    // 正好是 180°，根据原始差值判断（如果原始差值不是 0）
                    if (Math.abs(rawDiff) > 0.1) {
                        diff = rawDiff > 0 ? 180 : -180;
                    } else {
                        diff = 0;
                    }
                }
            } else {
                // 正常的差值调整
                if (diff > 180) diff -= 360;
                if (diff < -180) diff += 360;
            }
            
            // 累积角度值，保持连续性
            const accumulated = lastAngle + diff;
            hs.state[`_lastRotation${axis}`] = accumulated;
            
            // 规范化到 0-360 度范围返回
            let result = accumulated % 360;
            if (result < 0) result += 360;
            return result;
        };
        
        const xDeg = getContinuousAngle(euler.x, 'X');
        const yDeg = getContinuousAngle(euler.y, 'Y');
        const zDeg = getContinuousAngle(euler.z, 'Z');
        return { x: xDeg, y: yDeg, z: zDeg, rotationX: xDeg, rotationY: yDeg, rotationZ: zDeg };
    }
    
    // 设置热点旋转角度：设置指定热点的欧拉角旋转（度）
    // 内部使用增量旋转避免万向锁问题，支持360度连续旋转
    setHotspotRotation(id, rotation) {
        const hs = this.hotspots.get(id);
        if (!hs?.sprite) return false;
        if (rotation && typeof rotation === 'object') {
            const x = rotation.rotationX ?? rotation.x ?? 0;
            const y = rotation.rotationY ?? rotation.y ?? 0;
            const z = rotation.rotationZ ?? rotation.z ?? 0;
            
            // 将角度值规范化到 0-360 度范围，支持360度连续旋转
            const normalizeAngle = (angle) => {
                angle = angle % 360;
                if (angle < 0) angle += 360;
                return angle;
            };
            
            // 获取当前角度（使用累积角度值，避免万向锁问题）
            if (!hs.state) hs.state = {};
            const currentX = hs.state._lastRotationX ?? 0;
            const currentY = hs.state._lastRotationY ?? 0;
            const currentZ = hs.state._lastRotationZ ?? 0;
            
            const targetX = normalizeAngle(x);
            const targetY = normalizeAngle(y);
            const targetZ = normalizeAngle(z);
            
            const calculateDelta = (target, current) => {
                let delta = target - current;
                // 如果差值超过180度，选择更短的路径
                if (delta > 180) delta -= 360;
                if (delta < -180) delta += 360;
                return delta;
            };
            
            const deltaX = calculateDelta(targetX, currentX);
            const deltaY = calculateDelta(targetY, currentY);
            const deltaZ = calculateDelta(targetZ, currentZ);
            
            // 如果有任何角度变化，使用增量旋转（四元数，避免万向锁）
            if (Math.abs(deltaX) > 0.01 || Math.abs(deltaY) > 0.01 || Math.abs(deltaZ) > 0.01) {
                // 使用四元数增量旋转，避免万向锁问题
                const deltaXRad = deltaX * (Math.PI / 180);
                const deltaYRad = deltaY * (Math.PI / 180);
                const deltaZRad = deltaZ * (Math.PI / 180);
                
                let deltaQuaternion = new Quaternion();
                
                // 按 ZYX 顺序应用旋转（与 Euler 'XYZ' 顺序相反，因为四元数旋转是右乘）
                if (deltaZRad !== 0) {
                    const qz = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), deltaZRad);
                    deltaQuaternion = qz.clone();
                }
                if (deltaYRad !== 0) {
                    const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), deltaYRad);
                    if (deltaZRad !== 0) {
                        deltaQuaternion.multiplyQuaternions(deltaQuaternion, qy);
                    } else {
                        deltaQuaternion = qy.clone();
                    }
                }
                if (deltaXRad !== 0) {
                    const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), deltaXRad);
                    if (deltaZRad !== 0 || deltaYRad !== 0) {
                        deltaQuaternion.multiplyQuaternions(deltaQuaternion, qx);
                    } else {
                        deltaQuaternion = qx.clone();
                    }
                }
                
                // 应用增量旋转
                hs.sprite.quaternion.multiplyQuaternions(hs.sprite.quaternion, deltaQuaternion);
                hs.sprite.quaternion.normalize();
            } else {
                // 没有角度变化，但需要更新累积角度值
                // 直接使用目标角度创建欧拉角（用于更新状态）
                const euler = new Euler(
                    targetX * (Math.PI / 180),
                    targetY * (Math.PI / 180),
                    targetZ * (Math.PI / 180),
                    'XYZ'
                );
                hs.sprite.quaternion.setFromEuler(euler);
            }
            
            hs.sprite.updateMatrixWorld(true);
            hs.state._hasCustomRotation = true;
            
            hs.state._lastRotationX = targetX;
            hs.state._lastRotationY = targetY;
            hs.state._lastRotationZ = targetZ;
            
            this.events.emit('hotspot:rotation:updated', { id });
            return true;
        }
        return false;
    }
    
    // 增量旋转热点：按指定增量旋转热点
    rotateHotspotBy(id, deltaRotation) {
        const hs = this.hotspots.get(id);
        if (!hs?.sprite) return false;
        if (deltaRotation && typeof deltaRotation === 'object') {
            const baseAngle = this.CONFIG.ROTATE_BASE_ANGLE || 1.0;
            const deltaX = ((deltaRotation.rotationX ?? deltaRotation.x ?? 0) * baseAngle) * (Math.PI / 180);
            const deltaY = ((deltaRotation.rotationY ?? deltaRotation.y ?? 0) * baseAngle) * (Math.PI / 180);
            const deltaZ = ((deltaRotation.rotationZ ?? deltaRotation.z ?? 0) * baseAngle) * (Math.PI / 180);
            let deltaQuaternion = new Quaternion();
            if (deltaX !== 0) {
                const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), deltaX);
                deltaQuaternion = qx.clone();
            }
            if (deltaY !== 0) {
                const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), deltaY);
                if (deltaX !== 0) deltaQuaternion.multiplyQuaternions(qy, deltaQuaternion);
                else deltaQuaternion = qy.clone();
            }
            if (deltaZ !== 0) {
                const qz = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), deltaZ);
                if (deltaX !== 0 || deltaY !== 0) deltaQuaternion.multiplyQuaternions(qz, deltaQuaternion);
                else deltaQuaternion = qz.clone();
            }
            hs.sprite.quaternion.multiplyQuaternions(hs.sprite.quaternion, deltaQuaternion);
            hs.sprite.quaternion.normalize();
            hs.sprite.updateMatrixWorld(true);
            if (!hs.state) hs.state = {};
            hs.state._hasCustomRotation = true;
            this.events.emit('hotspot:rotation:updated', { id });
            return true;
        }
        return false;
    }

    // 动画更新：每帧调用，更新热点动画、可见性、遮挡检测等
    update(deltaTime) {
        const camera = this.engine?.camera;
        if (!camera) return;
        
        // 1. 维护缓存列表
        if (this._dirtyList) {
            this._cachedHotspotList = Array.from(this.hotspots.values());
            this._dirtyList = false;
        }
        
        const count = this._cachedHotspotList.length;
        if (count === 0) return;

        // 2. 检测相机是否移动 
        const EPSILON = 0.0001;
        const hasMoved = camera.position.distanceToSquared(this._lastCameraPos) > EPSILON ||
                         Math.abs(camera.quaternion.x - this._lastCameraQuat.x) > EPSILON;
        
        // 3. 检测场景/模型是否发生变化（动画播放等）
        const animationController = this.engine?.animationController;
        let sceneChanged = false;
        
        if (animationController) {
            // 检查是否有活跃的动画
            const hasActiveAnimations = Array.from(animationController.mixers.keys()).some(modelId => {
                return animationController._checkActiveAnimations(modelId);
            });
            
            if (hasActiveAnimations) {
                sceneChanged = true;
                this._sceneChangeDetected = true;
                this._lastSceneUpdateTime = Date.now();
            } else if (this._sceneChangeDetected) {
                // 动画刚结束，标记场景变化，持续一段时间（500ms）
                const timeSinceLastUpdate = Date.now() - this._lastSceneUpdateTime;
                if (timeSinceLastUpdate < 500) {
                    sceneChanged = true;
                } else {
                    this._sceneChangeDetected = false;
                }
            }
        }
        
        if (hasMoved) {
            this._lastCameraPos.copy(camera.position);
            this._lastCameraQuat.copy(camera.quaternion);
            this._cameraIsMoving = true;
            
            // 复用引擎的视锥体，避免重复计算
            if (this.engine?.frustum && typeof this.engine.updateFrustum === 'function') {
                this.engine.updateFrustum();
                this._temp.frustum = this.engine.frustum;
            } else {
                this._temp.mat4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
                this._temp.frustum.setFromProjectionMatrix(this._temp.mat4);
            }
        } else {
            this._cameraIsMoving = false;
            // 相机静止时也复用引擎的视锥体
            if (this.engine?.frustum) {
                this._temp.frustum = this.engine.frustum;
            }
        }

        // 首次进入：做一次全量预计算
        if (!this._initialOcclusionDone && count > 0) {
            this._initialOcclusionDone = true;

            // 确保视锥体是最新的
            if (this.engine?.frustum && typeof this.engine.updateFrustum === 'function') {
                this.engine.updateFrustum();
                this._temp.frustum = this.engine.frustum;
            } else {
                this._temp.mat4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
                this._temp.frustum.setFromProjectionMatrix(this._temp.mat4);
            }

            // 更新 mesh 缓存
            this._updateSceneMeshCache();

            // 如果热点数量过多，限制首次预计算的数量，避免卡顿
            const checkCount = Math.min(count, this.CONFIG.MAX_INITIAL_OCCLUSION_COUNT);

            for (let i = 0; i < checkCount; i++) {
                const hs = this._cachedHotspotList[i];
                if (!hs) continue;

                // 用户手动隐藏
                if (hs.state?._userVisible === false) {
                    this._ensureHotspotHidden(hs);
                    continue;
                }

                // 视锥体剔除
                if (hs.sprite) {
                    hs.state._inFrustum = this._checkHotspotInFrustum(hs, this._temp.frustum);
                }

                if (!hs.state?._inFrustum) {
                    this._hideLabel(hs.id);
                    continue;
                }

                // 热点遮挡检测
                hs.state._isOccluded = this._checkHotspotOcclusion(hs, camera);
                
                // 标签直接跟随热点的遮挡状态
                if (this.labels.has(hs.id)) {
                    this._updateLabelTransform(hs);
                    this._updateLabelVisibility(hs, camera);
                }
            }
            
            // 首次预计算完成后直接返回，避免本帧重复执行常规更新循环
            return;
        }

        // 相机静止且场景没变化时：跳过重计算
        const shouldSkipHeavyCalc = this.CONFIG.SKIP_IDLE_CAMERA && !this._cameraIsMoving && !sceneChanged;

        // 遮挡检测：轮询一小段，避免每帧全量射线
        const checksPerFrame = this.CONFIG.OCCLUSION_CHECK_PER_FRAME || 2;
        const checkStart = this._checkIndex;
        const checkEnd = Math.min(checkStart + checksPerFrame, count);
        
        // 遍历所有热点
        for (let i = 0; i < count; i++) {
            const hs = this._cachedHotspotList[i];
            
            // A. 基础检查：用户手动隐藏的热点
            if (hs.state?._userVisible === false) {
                this._ensureHotspotHidden(hs);
                continue;
            }

            // B. 更新序列帧动画
            if (hs.state.iconKind === 'spriteSheet') {
                this._updateSpriteAnimation(hs, deltaTime);
            }

            // --- Billboard：始终面向相机（视觉等同 Sprite，但支持 OutlinePass） ---
            if (hs.sprite?.userData?.__hotspotType === 'billboard') {
                hs.sprite.quaternion.copy(camera.quaternion);
                hs.sprite.updateMatrixWorld(true);
            }

            // 更新绑定到mesh的热点位置
            if (hs.state?.isSurfaceAttached === true && hs.state?.bindMeshId) {
                this._updateAttachedHotspotPosition(hs);
            }

            // --- 相机静止时，跳过以下重计算 ---
            if (shouldSkipHeavyCalc) {
                if (this.labels.has(hs.id)) {
                    const isBillboard = hs.sprite?.userData?.__hotspotType === 'billboard';
                    if (isBillboard) {
                        this._updateLabelTransform(hs);
                    }
                }
                continue;
            }

            // C. 视锥体剔除
            if (hs.sprite) {
                hs.state._inFrustum = this._checkHotspotInFrustum(hs, this._temp.frustum);
            }

            if (!hs.state._inFrustum) {
                this._hideLabel(hs.id);
                continue; // 视锥体外不更新
            }

            // D. 更新热点缩放
            if (hs.sprite && camera) {
                const ht = hs.sprite?.userData?.__hotspotType;
                if (this.CONFIG.SCREEN_SPACE_SIZE || 
                    hs.opts.screenSpaceSize === true ||
                    ((ht === 'mesh' || ht === 'billboard') && hs.opts.scaleMode === 'adaptive')) {
                    this._updateMeshScale(hs, camera);
                }
            }

            // E. 更新热点可见性
            if (hs.sprite) {
                this._updateViewBasedOpacity(hs, camera);
            }
            
            // F. 轮询遮挡检测
            if (i >= checkStart && i < checkEnd && hs.sprite) {
                hs.state._isOccluded = this._checkHotspotOcclusion(hs, camera);
            }
            
            // G. 同步标签
            if (this.labels.has(hs.id)) {
                this._updateLabelTransform(hs);
                this._updateLabelVisibility(hs, camera);
            }
        }
        
        // 更新轮询索引
        this._checkIndex = (checkEnd >= count) ? 0 : checkEnd;
    }

    // 确保热点隐藏：强制隐藏热点及其标签
    _ensureHotspotHidden(hs) {
        if (hs.sprite) {
            if (hs.sprite.visible !== false) hs.sprite.visible = false;
            // Mesh 类型额外设置透明度
            const ht = hs.sprite.userData.__hotspotType;
            if ((ht === 'mesh' || ht === 'billboard') && hs.material) {
                if (hs.material.opacity !== 0) {
                    hs.material.opacity = 0;
                    hs.material.transparent = true;
                    hs.material.needsUpdate = true;
                }
            }
        }
        this._hideLabel(hs.id);
    }

    _hideLabel(id) {
        const label = this.labels.get(id);
        if (label?.object && label.object.visible !== false) {
            label.object.visible = false;
            const el = this._getLabelElement(label);
            if (el) {
                el.style.opacity = '0';
                el.style.pointerEvents = 'none';
                el.classList.add('is-hidden');
            }
        }
    }

    // 获取选中的热点：返回当前选中的热点对象
    getSelectedHotspot() {
        if (!this.selectedId) return null;
        const hotspot = this.hotspots.get(this.selectedId);
        return hotspot ? { id: this.selectedId, hotspot } : null;
    }

    // 设置模式：切换编辑器模式或预览模式
    setMode(mode = 'editor') {
        if (mode !== 'editor' && mode !== 'preview') return;
        if (this.mode === mode) return;
        this.mode = mode;
        if (mode === 'preview') {
            this.clearSelection();
        }
    }

    // 获取模式：返回当前模式（editor或preview）
    getMode() { return this.mode; }

    // 清理资源：释放所有热点资源，解绑事件，清空缓存
    dispose() {
        // 解绑事件
        const bus = this.engine?.events;
        if (bus) {
            if (this._boundOnClick) bus.off('input.click', this._boundOnClick);
            if (this._boundOnMouseDown) bus.off('input.mousedown', this._boundOnMouseDown);
            if (this._boundOnMouseMove) bus.off('input.mousemove', this._boundOnMouseMove);
            if (this._boundOnMouseUp) bus.off('input.mouseup', this._boundOnMouseUp);
            if (this._boundOnMouseMoveHover) bus.off('input.mousemove', this._boundOnMouseMoveHover);
            if (this._boundOnSceneModelLoaded) {
                bus.off('scene:model', this._boundOnSceneModelLoaded);
            }
        }
        
        // 清理所有热点（添加错误处理，确保部分失败不影响整体清理）
        this.hotspots.forEach(hs => {
            try {
                this._removeHotspotLabel(hs.id);
                this._disposeResources(hs);
                if (hs.sprite?.parent) {
                    hs.sprite.parent.remove(hs.sprite);
                }
            } catch (e) {
                console.warn('Error disposing hotspot:', hs.id, e);
            }
        });
        
        // 清空集合
        this.hotspots.clear();
        this.labels.clear();
        
        // 清空缓存
        this._invalidateMeshCache();
        this._cachedHotspotList = [];
        this._dirtyList = false;
        
        // 清空引用
        this.selectedId = null;
        this.dragState = null;
        this._boundOnSceneModelLoaded = null;
        this._hoveredHotspotId = null;
    }

    // 更新热点图标：更新指定热点的图标URL或序列帧参数
    updateHotspotIcon(id, options = {}) {
        const hs = this.hotspots.get(id);
        if (!hs) return false;
        const { iconUrl, frameCount, frameDuration, totalDuration } = options;
        const hasParamUpdate = frameCount !== undefined || frameDuration !== undefined || totalDuration !== undefined;
        if (frameCount !== undefined) hs.opts.frameCount = frameCount;
        if (frameDuration !== undefined) hs.opts.frameDuration = frameDuration * 1000;
        if (totalDuration !== undefined) hs.opts.totalDuration = totalDuration * 1000;
        if (iconUrl) {
            hs.state.iconUrl = iconUrl;
            this._setIconFromUrl(id, iconUrl).catch(err => console.error('Failed to update hotspot icon:', err));
        } else if (hasParamUpdate && hs.state?.iconKind === 'spriteSheet') {
            const currentIconUrl = hs.state.iconUrl;
            if (currentIconUrl) {
                this._setIconFromUrl(id, currentIconUrl).catch(err => console.error('Failed to reload hotspot icon with new params:', err));
            }
        }
        this.events.emit('hotspot:icon:updated', { id, iconUrl, frameCount, frameDuration, totalDuration });
        return true;
    }
    
    // 更新热点标签：更新指定热点的标签文本、对齐方式、偏移等
    updateHotspotLabel(id, options = {}) {
        const hs = this.hotspots.get(id);
        if (!hs) return false;
        const labelData = this.labels.get(id);
        const { text, align, offset, visible } = options;
        if (!labelData) {
            const hasText = text && typeof text === 'string' && text.trim().length > 0;
            if (hasText) {
                this._updateHotspotLabel(hs, { text, align: align || 'top', offset: offset ?? 0, visible: visible !== false });
                return true;
            }
            return false;
        }
        if (typeof text === 'string') {
            labelData.options.text = text;
            const el = this._getLabelElement(labelData);
            if (el) el.textContent = text;
        }
        if (align && ['top', 'bottom', 'left', 'right'].includes(align)) {
            labelData.options.align = align;
            const el = this._getLabelElement(labelData);
            if (el) el.dataset.align = align;
        }
        if (offset !== undefined) labelData.options.offset = offset;
        const finalText = typeof text === 'string' ? text : (labelData.options.text || '');
        const hasValidText = finalText && finalText.trim().length > 0;
        if (visible !== undefined) this._setHotspotLabelVisible(id, !!visible && hasValidText);
        else this._setHotspotLabelVisible(id, hasValidText);
        const finalAlign = labelData.options.align || 'top';
        const finalOffset = labelData.options.offset ?? 0;
        this._applyLabelOffset(labelData.object, hs, finalAlign, finalOffset);
        return true;
    }
    
    // 设置交互锁定：锁定或解锁编辑控制器的交互功能
    setInteractionLocked(locked = true) {
        const flag = !!locked;
        if (this._interactionLockState.locked === flag) return this;
        this._interactionLockState.locked = flag;
        this._applyEditControllerLock(flag);
        return this;
    }
    
    // 检查交互锁定状态：返回当前交互是否被锁定
    isInteractionLocked() { return !!this._interactionLockState.locked; }
    
    // 设置相机聚焦启用：启用或禁用点击热点时的相机自动聚焦功能
    setCameraFocusEnabled(enabled) {
        this.CONFIG.CAMERA_FOCUS_ENABLED = !!enabled;
        return this;
    }

    // 聚焦相机到热点：将相机平滑移动到热点位置并聚焦
    focusCameraOnHotspot(hotspotId, options = {}) {
        return this._focusCameraOnHotspot(hotspotId, options);
    }
    
    // 内部聚焦相机：计算并执行相机聚焦到热点的操作
    _focusCameraOnHotspot(hotspotId, options = {}) {
        const hs = this.hotspots.get(hotspotId);
        if (!hs) return false;
        const focusAllowed = options.force === true || hs.opts?.enableCameraFocus !== false;
        if (!focusAllowed) return false;
        const camera = this.engine?.camera;
        if (!camera) return false;
        const duration = options.duration ?? this.CONFIG.CAMERA_FOCUS_DURATION;
        const focusData = this._calculateOptimalCameraPosition(hs, options);
        if (!focusData) return false;
        const { cameraPosition, lookAt } = focusData;
        if (camera.smoothMoveTo) camera.smoothMoveTo(cameraPosition, lookAt, duration);
        else {
            camera.position.copy(cameraPosition);
            if (camera.lookAt) camera.lookAt(lookAt);
        }
        this.events.emit('hotspot:camera:focus', { id: hotspotId, position: cameraPosition.clone(), target: lookAt.clone() });
        return true;
    }
    
    // 计算最优相机位置：根据热点位置和场景尺寸计算相机的最佳观察位置
    _calculateOptimalCameraPosition(hs, options = {}) {
        const camera = this.engine?.camera;
        if (!camera) return null;
        const hotspotPos = this._getHotspotWorldPosition(hs);
        const box = this._temp.box3.setFromObject(this.engine.mainScene);
        const boxSize = this._temp.vec5;
        box.getSize(boxSize);
        const modelCenter = this._temp.vec6;
        box.getCenter(modelCenter);
        const modelScale = Math.max(boxSize.x, boxSize.y, boxSize.z);
        const centerToHotspot = this._temp.vec1.subVectors(hotspotPos, modelCenter);
        const distCenterToHotspot = centerToHotspot.length();
        if (distCenterToHotspot < 1e-4) centerToHotspot.set(0, 0, 1);
        else centerToHotspot.normalize();
        let cameraDistanceFromHotspot = modelScale * 0.5;
        if (hs.state?.isSurfaceAttached && hs.state?.worldNormal && hs.state.worldNormal.lengthSq() > 0.1) {
            const normal = hs.state.worldNormal.clone().normalize();
            const dot = normal.dot(centerToHotspot);
            if (dot < 0.7) cameraDistanceFromHotspot *= 1.3;
        }
        const preferredDistance = options.distance ?? this.CONFIG.CAMERA_FOCUS_DISTANCE;
        const minDistance = options.minDistance ?? this.CONFIG.CAMERA_FOCUS_MIN_DISTANCE;
        const maxDistance = options.maxDistance ?? (modelScale * 2);
        const scaledDistance = cameraDistanceFromHotspot * (preferredDistance / this.CONFIG.CAMERA_FOCUS_DISTANCE);
        const finalDistance = Math.max(minDistance, Math.min(maxDistance, scaledDistance));
        const cameraPosition = hotspotPos.clone().addScaledVector(centerToHotspot, finalDistance);
        const lookAtTarget = modelCenter.clone();
        return { cameraPosition, lookAt: lookAtTarget };
    }

    // ==================== 私有方法 ====================

    // 映射外部大小到内部大小：将外部API的大小值转换为内部3D空间的大小
    _mapExternalSizeToInternal(externalSize) {
        return externalSize * this.CONFIG.SIZE_SCALE_FACTOR;
    }

    // 归一化四元数：确保四元数的长度为1
    _normalizeQuaternion(quaternion) {
        const rx = quaternion.rx ?? 0;
        const ry = quaternion.ry ?? 0;
        const rz = quaternion.rz ?? 0;
        const rw = quaternion.rw ?? 1;
        const length = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
        if (length < 0.0001) return { rx: 0, ry: 0, rz: 0, rw: 1 };
        return { rx: rx / length, ry: ry / length, rz: rz / length, rw: rw / length };
    }

    // 创建热点对象：根据类型创建热点对象及其材质
    _createHotspotObject(type, id) {
        const baseConfig = {
            color: 0xffffff,
            transparent: true,
            opacity: this.CONFIG.DEFAULT_OPACITY,
            depthTest: true,
            depthWrite: true,
            alphaTest: 0.1,
            toneMapped: true
        };

        let hotspotObject, material;

        material = new MeshBasicMaterial({ ...baseConfig, side: DoubleSide });
        const geometry = new PlaneGeometry(1, 1);
        hotspotObject = new Mesh(geometry, material);
        hotspotObject.userData.__hotspotType = (type === 1) ? 'billboard' : 'mesh';

        hotspotObject.userData.__isHotspot = true;
        hotspotObject.userData.__hotspotId = id;
        hotspotObject.renderOrder = 2;

        return { hotspotObject, material };
    }

    _invalidateMeshCache() {
        this._sceneMeshCache = null;
        this._sceneMeshCacheTime = 0;
        this._sceneObjectIdMap = null;
    }

    // 更新序列帧动画
    _updateSpriteAnimation(hs, deltaTime) {
        if (hs.state.iconKind !== 'spriteSheet' || !hs.state.animationData) return;
        
        // 如果不可见或不在视锥体内，不执行
        if (hs.sprite && (!hs.sprite.visible || !hs.state._inFrustum)) return;

        const { frames, delays } = hs.state.animationData;
        if (!frames?.length) return;

        hs.state.accumulatedTime = (hs.state.accumulatedTime || 0) + deltaTime * 1000;
        const delay = delays[hs.state.currentFrame] || 100;

        if (hs.state.accumulatedTime >= delay) {
            // 计算下一帧
            const nextFrame = (hs.state.currentFrame + 1) % frames.length;
            
            // 只有当帧真正发生变化时才执行昂贵的 putImageData
            if (nextFrame !== hs.state.currentFrame) {
                hs.state.currentFrame = nextFrame;
                hs.state.accumulatedTime = 0; // 重置时间

                if (hs.state.ctx && hs.state.canvas && hs.state.texture) {
                    const frameData = frames[hs.state.currentFrame];
                    if (frameData) {
                        hs.state.ctx.putImageData(frameData, 0, 0);
                        hs.state.texture.needsUpdate = true;
                    }
                }
            }
        }
    }

    _updateMeshScale(hs, camera) {
        if (!hs.sprite || !camera) return;
        
        const distance = camera.position.distanceTo(hs.sprite.position);
        const baseSize = hs.opts.size || this.CONFIG.DEFAULT_SIZE;
        
        if (this.CONFIG.SCREEN_SPACE_SIZE && hs.opts.screenSpaceSize !== false) {
            const referenceDistance = hs.opts.screenSpaceReferenceDistance || this.CONFIG.SCREEN_SPACE_REFERENCE_DISTANCE;
            const scaleFactor = distance / referenceDistance;
            const minScale = hs.opts.minScale || 0.1;
            const maxScale = hs.opts.maxScale || 10.0;
            const clampedScale = Math.max(minScale, Math.min(maxScale, scaleFactor));
            hs.sprite.scale.set(baseSize * clampedScale, baseSize * clampedScale, 1);
        } else if (hs.opts.scaleMode === 'adaptive') {
            const scaleFactor = Math.max(0.5, Math.min(2.0, distance * 0.3));
            hs.sprite.scale.set(baseSize * scaleFactor, baseSize * scaleFactor, 1);
        } else {
            hs.sprite.scale.set(baseSize, baseSize, 1);
        }
    }

    // 更新热点可见性和透明度
    _updateViewBasedOpacity(hs, camera) {
        if (!hs.sprite || !hs.material) return;
        if (hs.state?._userVisible === false || hs.state?._isLoading) {
            hs.sprite.visible = false;
            return;
        }

        const ht = hs.sprite.userData.__hotspotType;
        const isPlane = ht === 'mesh' || ht === 'billboard';
        
        // 非平面类型被遮挡时隐藏
        if (!isPlane && hs.state?._isOccluded) {
            hs.sprite.visible = false;
            return;
        }

        // 等待纹理加载完成
        const hasIconUrl = hs.state?.iconUrl || hs.state?.videoUrl;
        const hasTexture = !!hs.material.map;
        if (hasIconUrl && !hasTexture) {
            hs.sprite.visible = false;
            return;
        }

        // 显示热点
        if (hs.sprite.visible !== true) hs.sprite.visible = true;
        const targetOpacity = this.CONFIG.DEFAULT_OPACITY;
        if (hs.material.opacity !== targetOpacity) {
            hs.material.opacity = targetOpacity;
            hs.material.needsUpdate = true;
        }
    }

    // 单点遮挡检测：从相机向目标点发射射线
    _performOcclusionCheck(targetPos, camera, skipCacheUpdate = false) {
        if (!targetPos || !camera) return false;
        
        const dir = this._temp.vec1.subVectors(targetPos, camera.position);
        const dist = dir.length();
        if (dist < 0.01) return false;
        
        dir.normalize();
        
        if (!skipCacheUpdate) {
            this._updateSceneMeshCache();
        }
        
        if (!this._sceneMeshCache || this._sceneMeshCache.length === 0) {
            return false;
        }
        
        this._raycaster.set(camera.position, dir);
        const intersects = this._raycaster.intersectObjects(this._sceneMeshCache, false);
        
        if (intersects.length === 0) return false;
        
        // 动态容差
        const baseTolerance = this.CONFIG.OCCLUSION_TOLERANCE;
        const relativeTolerance = dist * 0.015;
        const finalTolerance = Math.max(baseTolerance, Math.min(relativeTolerance, dist * 0.05));
        const checkDistance = dist - finalTolerance;
        
        for (let i = 0; i < intersects.length; i++) {
            const intersect = intersects[i];
            if (intersect.distance >= checkDistance) break;
            
            const object = intersect.object;
            if (!object || !object.visible || !object.material) continue;
            
            if (!this._isObjectTransparent(object, intersect)) {
                return true;
            }
        }
        
        return false;
    }

    // 多点采样遮挡检测：返回遮挡比例 0.0-1.0
    _performMultiPointOcclusionCheck(centerPos, camera, radius = 0.05) {
        if (!centerPos || !camera) return 0;
        
        // 先更新一次缓存，后续检测跳过
        this._updateSceneMeshCache();
        
        const sampleCount = this.CONFIG.OCCLUSION_SAMPLE_COUNT || 5;
        
        if (sampleCount <= 1) {
            return this._performOcclusionCheck(centerPos, camera, true) ? 1.0 : 0.0;
        }
        
        const cameraRight = this._temp.vec5.set(1, 0, 0).applyQuaternion(camera.quaternion);
        const cameraUp = this._temp.vec6.copy(camera.up).normalize();
        
        // 复用临时向量进行采样检测，避免创建新对象
        const samplePos = this._temp.vec2;
        let occludedCount = 0;
        let checkedCount = 0;
        
        // 中心点
        if (this._performOcclusionCheck(centerPos, camera, true)) occludedCount++;
        checkedCount++;
        
        if (sampleCount >= 5 && checkedCount < sampleCount) {
            // 右
            samplePos.copy(centerPos).addScaledVector(cameraRight, radius);
            if (this._performOcclusionCheck(samplePos, camera, true)) occludedCount++;
            checkedCount++;
            // 左
            if (checkedCount < sampleCount) {
                samplePos.copy(centerPos).addScaledVector(cameraRight, -radius);
                if (this._performOcclusionCheck(samplePos, camera, true)) occludedCount++;
                checkedCount++;
            }
            // 上
            if (checkedCount < sampleCount) {
                samplePos.copy(centerPos).addScaledVector(cameraUp, radius);
                if (this._performOcclusionCheck(samplePos, camera, true)) occludedCount++;
                checkedCount++;
            }
            // 下
            if (checkedCount < sampleCount) {
                samplePos.copy(centerPos).addScaledVector(cameraUp, -radius);
                if (this._performOcclusionCheck(samplePos, camera, true)) occludedCount++;
                checkedCount++;
            }
        }
        
        if (sampleCount >= 9 && checkedCount < sampleCount) {
            const diag = radius * 0.707;
            // 右上
            samplePos.copy(centerPos).addScaledVector(cameraRight, diag).addScaledVector(cameraUp, diag);
            if (this._performOcclusionCheck(samplePos, camera, true)) occludedCount++;
            checkedCount++;
            // 左上
            if (checkedCount < sampleCount) {
                samplePos.copy(centerPos).addScaledVector(cameraRight, -diag).addScaledVector(cameraUp, diag);
                if (this._performOcclusionCheck(samplePos, camera, true)) occludedCount++;
                checkedCount++;
            }
            // 右下
            if (checkedCount < sampleCount) {
                samplePos.copy(centerPos).addScaledVector(cameraRight, diag).addScaledVector(cameraUp, -diag);
                if (this._performOcclusionCheck(samplePos, camera, true)) occludedCount++;
                checkedCount++;
            }
            // 左下
            if (checkedCount < sampleCount) {
                samplePos.copy(centerPos).addScaledVector(cameraRight, -diag).addScaledVector(cameraUp, -diag);
                if (this._performOcclusionCheck(samplePos, camera, true)) occludedCount++;
                checkedCount++;
            }
        }
        
        return occludedCount / checkedCount;
    }

    // 判断热点是否被遮挡
    _checkHotspotOcclusion(hs, camera) {
        const hotspotPos = this._getHotspotWorldPosition(hs);
        
        if (this.CONFIG.MULTI_POINT_SAMPLING) {
            const hotspotSize = hs.opts?.size || this.CONFIG.DEFAULT_SIZE;
            const samplingRadius = hotspotSize * 0.3;
            const occlusionRatio = this._performMultiPointOcclusionCheck(hotspotPos, camera, samplingRadius);
            const threshold = this.CONFIG.OCCLUSION_THRESHOLD || 0.6;
            return occlusionRatio > threshold;
        }
        
        return this._performOcclusionCheck(hotspotPos, camera);
    }

    /**
     * 计算热点的综合可见度因子 (0.0 - 1.0)
     * @private
     * @param {Vector3} targetPos - 目标位置（热点标签位置）
     * @param {Camera} camera - 相机
     * @returns {number} 可见度因子，0.0 = 完全不可见，1.0 = 完全可见
     */
    _calculateVisibilityFactor(targetPos, camera) {
        if (!targetPos || !camera) return 0;

        const dir = this._temp.vec1.subVectors(targetPos, camera.position);
        const dist = dir.length();
        if (dist < 0.01) return 1.0;
        
        dir.normalize();
        this._updateSceneMeshCache();
        
        // 如果场景中没有可遮挡的物体，直接返回完全可见
        if (!this._sceneMeshCache || this._sceneMeshCache.length === 0) {
            return 1.0;
        }
        
        this._raycaster.set(camera.position, dir);
        const intersects = this._raycaster.intersectObjects(this._sceneMeshCache, false);
        
        // 没有相交，完全可见
        if (intersects.length === 0) return 1.0;
        
        let visibility = 1.0;
        const baseTolerance = this.CONFIG.OCCLUSION_TOLERANCE;
        const relativeTolerance = dist * 0.015; // 1.5%
        const finalTolerance = Math.max(baseTolerance, Math.min(relativeTolerance, dist * 0.05));
        const checkDistance = dist - finalTolerance;

        for (let i = 0; i < intersects.length; i++) {
            const intersect = intersects[i];
            
            // 提前退出：超出目标点
            if (intersect.distance >= checkDistance) {
                break;
            }

            const obj = intersect.object;
            
            // 快速跳过：无效对象
            if (!obj || !obj.visible || !obj.material) {
                continue;
            }
            
            // 获取相交点的材质
            const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
            let materialIndex = intersect.face?.materialIndex ?? 0;
            if (materialIndex >= materials.length) materialIndex = 0;
            
            const mat = materials[materialIndex];
            if (!mat) continue;

            // 判断是否真正透明：必须同时满足 transparent=true 且 opacity<1
            const opacity = mat.opacity !== undefined ? mat.opacity : 1;
            const isTransparent = mat.transparent === true;
            const isActuallyTransparent = isTransparent && opacity < 1;
            
            // 不透明材质：完全遮挡，立即返回
            if (!isActuallyTransparent || opacity >= 0.98) {
                return 0.0;
            }
            
            // 透明材质：累积透过率
            if (isActuallyTransparent && opacity > 0.01) {
                visibility *= (1.0 - opacity);
                
                // 提前退出：可见度太低
                if (visibility < 0.01) {
                    return 0.0;
                }
            }
        }

        return Math.max(0.0, Math.min(1.0, visibility));
    }

    /**
     * 判断物体是否透明
     * 只有真正透明的材质（transparent=true且opacity<1）才被认为是透明的
     * 这样可以透过透明材质看到热点，同时不透明材质能正确遮挡热点
     * @private
     * @param {Object3D} object - 3D对象
     * @param {Object} intersect - 射线相交信息
     * @returns {boolean} 是否透明
     */
    _isObjectTransparent(object, intersect) {
        if (!object || !object.material) return false;
        
        // 不可见的物体视为透明（不遮挡）
        if (object.visible === false) {
            return true;
        }
        
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        let materialIndex = intersect?.face?.materialIndex ?? 0;
        if (materialIndex >= materials.length) materialIndex = 0;
        
        const material = materials[materialIndex];
        if (!material) return false;
        
        const opacity = material.opacity !== undefined ? material.opacity : 1;
        
        // 快速判断：opacity非常低（<0.1）认为是透明的
        if (opacity < 0.1) {
            return true;
        }
        
        if (material.transparent === true && opacity < 1) {
            return true;
        }
        
        // 检查颜色透明度（某些材质可能通过color.a控制透明度）
        if (material.color?.a !== undefined && material.color.a < 0.1) {
            return true;
        }
        
        // 其他情况：不透明，会遮挡热点
        return false;
    }

    /**
     * 检查热点是否在视锥体内
     * @private
     * @param {Object} hs - 热点对象
     * @param {Frustum} frustum - 视锥体对象
     * @returns {boolean} 是否在视锥体内
     */
    _checkHotspotInFrustum(hs, frustum) {
        if (!hs.sprite || !frustum) return true;
        
        // 扩大检测范围：基于热点大小和标签偏移
        const hotspotSize = hs.opts?.size || this.CONFIG.DEFAULT_SIZE;
        const labelOffset = this.labels.get(hs.id)?.options?.offset || 0;
        const expandRadius = Math.max(hotspotSize, labelOffset) * 1.5;
        
        // 创建扩展的包围球进行视锥体检测
        const worldPos = this._getHotspotWorldPosition(hs);
        const sphere = {
            center: worldPos,
            radius: expandRadius
        };
        
        // 使用视锥体的 intersectsSphere 方法（如果有）
        if (typeof frustum.intersectsSphere === 'function') {
            return frustum.intersectsSphere(sphere);
        }
        
        // 否则使用原来的方法
        if (hs.sprite.isSprite && typeof frustum.intersectsSprite === 'function') {
            return frustum.intersectsSprite(hs.sprite);
        } else if (typeof frustum.intersectsObject === 'function') {
            return frustum.intersectsObject(hs.sprite);
        }
        
        return true;
    }
    
    /**
     * 更新标签可见性（标签直接跟随热点的遮挡状态）
     * @private
     * @param {Object} hs - 热点对象
     * @param {Camera} camera - 相机对象
     */
    _updateLabelVisibility(hs, camera) {
        const label = this.labels.get(hs.id);
        if (!label?.object || !label.visible) return;
        
        const el = this._getLabelElement(label);
        
        // 检查基础条件：用户隐藏、视锥体外、热点遮挡
        if (hs.state?._userVisible === false || 
            !hs.state?._inFrustum || 
            hs.state?._isOccluded) {
            label.object.visible = false;
            if (el) {
                el.style.opacity = '0';
                el.style.pointerEvents = 'none';
                el.classList.add('is-hidden');
            }
            return;
        }
        
        // 热点可见，标签也可见
        // 对于透明材质的场景物体，计算透过率来调整标签透明度
        const hotspotPos = this._getHotspotWorldPosition(hs);
        const visibilityFactor = this._calculateVisibilityFactor(hotspotPos, camera);
        
        if (el) {
            const opacity = Math.max(0, Math.min(1, visibilityFactor));
            el.style.opacity = opacity.toFixed(3);
            
            if (opacity <= 0.01) {
                label.object.visible = false;
                el.style.pointerEvents = 'none';
                el.classList.add('is-hidden');
            } else {
                label.object.visible = true;
                el.style.pointerEvents = 'auto';
                el.classList.remove('is-hidden');
            }
        } else {
            label.object.visible = visibilityFactor > 0.01;
        }
    }
    
    // 设置高亮：设置或取消热点的选中高亮状态
    _setHighlight(hs, highlighted) {
        if (!hs?.sprite || !hs.material) return;
        const state = hs.state || (hs.state = {});
        const desired = !!highlighted;
        // 避免重复调用，但要允许"加载中 → 加载完成"后补齐描边
        if (state._isHighlighted === desired && state._outlineApplied === desired) return;

        if (desired) {
            if (state._userVisible === false || state._isLoading) {
                state._isHighlighted = true;
                state._outlineApplied = false;
                return;
            }
            
            const hl = this.engine?.highlightController;
            if (hl) {
                hl.highlightHotspot(hs);
                state._outlineApplied = true;
            }
        } else {
            const hl = this.engine?.highlightController;
            if (hl) {
                hl.clearHotspot(hs);
            }
            state._outlineApplied = false;
        }
        state._isHighlighted = desired;
        hs.material.needsUpdate = true;
    }
    
    // 获取场景中心：计算并返回场景的包围盒中心点
    _getSceneCenter() {
        this.engine.mainScene.updateMatrixWorld(true);
        const box = this._temp.box3.setFromObject(this.engine.mainScene);
        const center = this._temp.vec5;
        box.getCenter(center);
        return isFinite(center.x) ? center.clone() : new Vector3(0, 0, 0);
    }
    
    // 计算相机前方位置：计算相机正前方适合放置热点的位置
    _calculateCameraFrontPosition() {
        const camera = this.engine?.camera;
        const scene = this.engine?.mainScene;
        if (!camera || !scene) return this._getSceneCenter();
        
        scene.updateMatrixWorld(true);
        const box = this._temp.box3.setFromObject(scene);
        const boxCenter = this._temp.vec3;
        box.getCenter(boxCenter);
        
        const cameraPos = camera.position;
        const distanceToBox = cameraPos.distanceTo(boxCenter);
        const distance = distanceToBox * 0.2;
        
        const cameraDir = this._temp.vec1;
        camera.getWorldDirection(cameraDir);
        
        return this._temp.vec2.copy(cameraPos).addScaledVector(cameraDir, distance);
    }

    // ==================== 图标加载相关 ====================

    // 从URL设置图标：异步加载图片并应用为热点图标，支持sprite sheet检测
    async _setIconFromUrl(id, url) {
        const hs = this.hotspots.get(id);
        if (!hs) return;
        try {
            const img = await this._loadImage(url);
            const hasCORS = img._hasCORS !== false;
            const customFrameCount = hs.opts?.frameCount;
            const customFrameDuration = hs.opts?.frameDuration;
            const customTotalDuration = hs.opts?.totalDuration;
            let frameCount = customFrameCount || Math.round(img.height / img.width);
            const isValidSpriteSheet = hasCORS && frameCount > 1 && 
                (customFrameCount || Math.abs(img.height / img.width - frameCount) < 0.01);
            if (isValidSpriteSheet) {
                const spriteData = this._parseSpriteSheet(img, frameCount, customFrameDuration, customTotalDuration);
                await this._applySpriteSheetIcon(hs, spriteData);
            } else {
                if (!hasCORS && customFrameCount) console.warn(`Image loaded without CORS support, sprite sheet animation is disabled for ${url}`);
                await this._applyImageIcon(hs, url);
            }
        } catch (err) {
            console.error('Failed to load icon:', err);
            // 加载失败时，标记状态并触发错误事件
            if (hs.state) {
                hs.state._isLoading = false;
                hs.state.iconKind = 'error';
            }
            if (hs.sprite) hs.sprite.visible = false;
            this.events.emit('hotspot:icon:error', { id, url, error: err });
        }
    }

    // 加载图片：使用多种策略加载图片（CORS、fetch、无CORS）
    _loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => { img._hasCORS = true; resolve(img); };
            img.onerror = () => {
                console.warn(`CORS load failed for ${url}, trying fetch strategy`);
                fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-cache' })
                .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.blob(); })
                .then(blob => {
                    const objectUrl = URL.createObjectURL(blob);
                    const img2 = new Image();
                    img2.crossOrigin = 'anonymous';
                    img2.onload = () => { URL.revokeObjectURL(objectUrl); img2._hasCORS = true; resolve(img2); };
                    img2.onerror = () => { URL.revokeObjectURL(objectUrl); this._loadWithoutCORS(url).then(resolve).catch(reject); };
                    img2.src = objectUrl;
                })
                .catch(err => {
                    console.warn('Fetch strategy failed:', err);
                    this._loadWithoutCORS(url).then(resolve).catch(reject);
                });
            };
            img.src = url;
        });
    }

    // 无CORS加载：不使用CORS策略加载图片（最后备选方案）
    _loadWithoutCORS(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => { img._hasCORS = false; resolve(img); };
            img.onerror = () => { reject(new Error(`All loading strategies failed for ${url}`)); };
            const cacheBuster = url.includes('?') ? `&_nocors=${Date.now()}` : `?_nocors=${Date.now()}`;
            img.src = url + cacheBuster;
        });
    }

    // 应用图片图标：将加载的图片纹理应用到热点材质
    _applyImageIcon(hs, url) {
        return new Promise((resolve, reject) => {
            this.loader.load(url, texture => {
                this._resetVisuals(hs);
                texture.colorSpace = 'srgb';
                hs.material.map = texture.clone();
                const baseSize = hs.opts.size;
                if ((hs.sprite.userData.__hotspotType === 'mesh' || hs.sprite.userData.__hotspotType === 'billboard') && texture.image) {
                    const aspect = texture.image.width / texture.image.height;
                    hs.sprite.scale.set(baseSize * aspect, baseSize, 1);
                } else {
                    hs.sprite.scale.set(baseSize, baseSize, 1);
                }
                hs.material.color.setRGB(1.0, 1.0, 1.0);
                if (this.CONFIG.COLOR_INTENSITY > 1.0) hs.material.color.multiplyScalar(this.CONFIG.COLOR_INTENSITY);
                hs.material.opacity = this.CONFIG.DEFAULT_OPACITY;
                hs.material.needsUpdate = true;
                hs.state.iconKind = 'image';
                this._showSprite(hs);
                resolve();
            }, undefined, error => { this._showSprite(hs); reject(error); });
        });
    }

    // 应用视频图标：创建视频纹理并应用到热点材质
    _applyVideoIcon(hs, url) {
        const video = document.createElement('video');
        Object.assign(video, { src: url, loop: true, muted: true, playsInline: true, autoplay: true });
        video.onloadeddata = () => {
            video.play().catch(() => {});
            const texture = new VideoTexture(video);
            texture.colorSpace = 'srgb';
            this._resetVisuals(hs);
            hs.material.map = texture;
            const baseSize = hs.opts.size;
            if ((hs.sprite.userData.__hotspotType === 'mesh' || hs.sprite.userData.__hotspotType === 'billboard') && video.videoWidth) {
                const aspect = video.videoWidth / video.videoHeight;
                hs.sprite.scale.set(baseSize * aspect, baseSize, 1);
            } else {
                hs.sprite.scale.set(baseSize, baseSize, 1);
            }
            hs.material.color.setRGB(1.0, 1.0, 1.0);
            if (this.CONFIG.COLOR_INTENSITY > 1.0) hs.material.color.multiplyScalar(this.CONFIG.COLOR_INTENSITY);
            hs.material.opacity = this.CONFIG.DEFAULT_OPACITY;
            hs.material.needsUpdate = true;
            hs.state.iconKind = 'video';
            this._showSprite(hs);
        };
        video.onerror = () => { this._showSprite(hs); };
    }

    // 应用序列帧图标：将sprite sheet数据应用到热点，创建canvas纹理
    async _applySpriteSheetIcon(hs, spriteData) {
        const { frames, delays, width, height } = spriteData;
        if (!frames?.length) throw new Error('Invalid sprite data');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.putImageData(frames[0], 0, 0);
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = 'srgb';
        texture.needsUpdate = true;
        this._resetVisuals(hs);
        const baseSize = hs.opts.size;
        if ((hs.sprite.userData.__hotspotType === 'mesh' || hs.sprite.userData.__hotspotType === 'billboard') && width && height) {
            const aspect = width / height;
            hs.sprite.scale.set(baseSize * aspect, baseSize, 1);
        } else {
            hs.sprite.scale.set(baseSize, baseSize, 1);
        }
        Object.assign(hs.state, {
            iconKind: 'spriteSheet',
            animationData: { frames, delays },
            currentFrame: 0,
            accumulatedTime: 0,
            canvas, ctx, texture
        });
        hs.material.map = texture;
        hs.material.color.setRGB(1.0, 1.0, 1.0);
        if (this.CONFIG.COLOR_INTENSITY > 1.0) hs.material.color.multiplyScalar(this.CONFIG.COLOR_INTENSITY);
        hs.material.opacity = this.CONFIG.DEFAULT_OPACITY;
        hs.material.needsUpdate = true;
        this._showSprite(hs);
    }

    // 解析序列帧：从图片中提取每一帧的ImageData和延迟时间
    _parseSpriteSheet(img, frameCount, frameDuration = null, totalDuration = null) {
        const frameHeight = Math.floor(img.height / frameCount);
        const frameWidth = img.width;
        const frames = [];
        const canvas = document.createElement('canvas');
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        for (let i = 0; i < frameCount; i++) {
            ctx.clearRect(0, 0, frameWidth, frameHeight);
            ctx.drawImage(img, 0, i * frameHeight, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
            frames.push(ctx.getImageData(0, 0, frameWidth, frameHeight));
        }
        let perFrameDuration = 100;
        if (frameDuration !== null && frameDuration > 0) perFrameDuration = frameDuration;
        else if (totalDuration !== null && totalDuration > 0) perFrameDuration = totalDuration / frameCount;
        return { frames, delays: new Array(frameCount).fill(perFrameDuration), width: frameWidth, height: frameHeight };
    }

    // 重置视觉效果：清理热点的纹理、动画数据等视觉资源
    _resetVisuals(hs) {
        if (!hs) return;
        if (hs.material?.map && hs.material.map !== hs.state.texture) hs.material.map.dispose();
        if (hs.state?.texture) hs.state.texture.dispose();
        if (hs.state) {
            hs.state._origColor = null;
            hs.state.animationData = null;
            hs.state.iconKind = null;
        }
        hs.state.canvas = null;
        hs.state.ctx = null;
        hs.state.texture = null;
    }

    // 释放资源：释放热点相关的所有资源（材质、几何体、纹理等）
    _disposeResources(hs) {
        if (!hs) return;
        
        // 清理视频纹理
        if (hs.state?.videoUrl && hs.material?.map) {
            const video = hs.material.map.image;
            if (video && video.pause) {
                video.pause();
                video.src = '';
                video.load();
            }
        }
        
        // 清理 canvas 和上下文
        if (hs.state?.canvas) {
            const ctx = hs.state.ctx;
            if (ctx) {
                ctx.clearRect(0, 0, hs.state.canvas.width, hs.state.canvas.height);
            }
        }
        
        // 清理纹理
        hs.material?.map?.dispose();
        hs.state?.texture?.dispose();
        
        // 清理材质
        hs.material?.dispose();
        
        // 清理几何体
        hs.sprite?.geometry?.dispose();
        
        // 清理状态数据
        if (hs.state) {
            hs.state.canvas = null;
            hs.state.ctx = null;
            hs.state.texture = null;
            hs.state.animationData = null;
            hs.state.iconKind = null;
            hs.state._origColor = null;
        }
    }

    // ==================== 表面贴合相关 ====================

    // 处理热点贴合：将热点贴合到场景表面的指定位置
    _handleHotspotAttachment(intersect, hotspotId, options = {}) {
        const hs = this.hotspots.get(hotspotId);
        if (!hs || !intersect) return;

        // 1. 计算贴合后的点 / 法线 / UV
        const { point, normal, uv } = this._calculateSurfaceAttachment(
            intersect,
            hs.opts?.size || this.CONFIG.DEFAULT_SIZE
        );

        // 2. 移动热点到贴合点
        hs.sprite.position.copy(point);

        // 3. 是否跟随法线旋转
        const shouldOrient =
            options.orientToNormal !== undefined
                ? options.orientToNormal
                : !this._hasCustomRotation(hs);

        if (shouldOrient) {
            this._orientSpriteToNormal(hs.sprite, normal);
            if (hs.state) hs.state._hasCustomRotation = false;
        }

        // 4. 写入状态
        if (!hs.state) hs.state = {};
        hs.state.worldNormal = normal.clone();
        hs.state.isSurfaceAttached = true;
        if (uv) hs.state.uv = uv.clone();

        // 5. 保存绑定的meshId
        const targetObject = intersect.object;
        const bindMeshId = this._getHitObjectUserDataId(targetObject);
        if (bindMeshId) {
            hs.state.bindMeshId = bindMeshId;
            if (targetObject && targetObject.parent) {
                targetObject.updateMatrixWorld(true);
                const invMatrix = this._temp.mat4.copy(targetObject.matrixWorld).invert();
                hs.state.localOffset = point.clone().applyMatrix4(invMatrix);
                hs.state.targetObject = targetObject; 

                try {
                    const invNormalMatrix = this._temp.mat3.getNormalMatrix(invMatrix);
                    hs.state.localNormal = normal.clone().applyMatrix3(invNormalMatrix).normalize();
                } catch (_) {
                    hs.state.localNormal = null;
                }
            }
        }

        if (hs.material) {
            hs.material.depthTest = true;
            hs.material.depthWrite = true;
            hs.material.needsUpdate = true;
        }
        if (hs.sprite) {
            hs.sprite.renderOrder = 2;
            hs.sprite.updateMatrixWorld(true);
        }

        if (this.labels.has(hs.id)) {
            this._updateLabelTransform(hs);
        }

        // 6. 对外发事件（带上完整信息）
        this.events.emit('hotspot:attached', {
            id: hs.id,                             // 热点 id
            point: point.clone(),                  // 贴合后的世界坐标
            uv: uv?.clone() || null,               // UV（如果有）
            bindMeshId,                          // 从 userData.id 向上找到的 id
            targetObjectUuid: targetObject.uuid,   // three 对象 uuid
            targetObjectName: targetObject.name || targetObject.type || ''
        });
    }

    /**
     * 从命中的 object 一路向上找 userData.id，返回第一个找到的 id
     * @private
     */
    _getHitObjectUserDataId(object) {
        let current = object;
        while (current) {
            if (current.userData && current.userData.id != null) {
                return current.userData.id;
            }
            current = current.parent || null;
        }
        return null;
    }

    // 计算表面贴合：计算热点贴合到表面的位置、法向量和UV坐标
    _calculateSurfaceAttachment(intersect, hotspotSize) {
        let normal = this._getInterpolatedNormal(intersect);
        const camera = this.engine?.camera;
        if (camera) {
            const viewDir = this._temp.vec1.subVectors(camera.position, intersect.point).normalize();
            const normalDotView = normal.dot(viewDir);
            if (normalDotView < 0) normal = normal.clone().negate();
        }
        const offset = this._calculateSurfaceOffset(intersect.point, normal, hotspotSize);
        const finalPoint = intersect.point.clone().addScaledVector(normal, offset);
        return { point: finalPoint, normal, uv: intersect.uv?.clone() || null };
    }

    // 计算表面偏移：根据相机位置和法向量计算热点与表面的偏移距离
    _calculateSurfaceOffset(point, normal, hotspotSize) {
        const camera = this.engine?.camera;
        if (!camera) return hotspotSize * this.CONFIG.BASE_OFFSET;
        const dist = camera.position.distanceTo(point);
        const viewDir = this._temp.vec1.subVectors(camera.position, point).normalize();
        const normalDotView = normal.dot(viewDir);
        const absNormalDotView = Math.abs(normalDotView);
        let offset = hotspotSize * (0.15 + Math.min(dist * 0.015, 0.2));
        if (absNormalDotView < 0.6) offset *= (1.0 + (0.6 - absNormalDotView) * 1.2);
        const minOffset = hotspotSize * 0.15;  
        const maxOffset = hotspotSize * 0.6;   
        return Math.max(minOffset, Math.min(offset, maxOffset));
    }

    // 获取插值法向量：使用重心坐标插值计算交点的精确法向量
    _getInterpolatedNormal(intersect) {
        if (!intersect?.face || !intersect?.object) return new Vector3(0, 0, 1);
        const { object, face, point } = intersect;
        const geometry = object.geometry;
        if (geometry?.attributes?.normal && geometry?.attributes?.position) {
            const { a, b, c } = face;
            const positions = geometry.attributes.position;
            const normals = geometry.attributes.normal;
            try {
                const va = this._temp.vec1.fromBufferAttribute(positions, a).applyMatrix4(object.matrixWorld);
                const vb = this._temp.vec2.fromBufferAttribute(positions, b).applyMatrix4(object.matrixWorld);
                const vc = this._temp.vec3.fromBufferAttribute(positions, c).applyMatrix4(object.matrixWorld);
                const bary = this._computeBarycentric(point, va, vb, vc);
                if (bary) {
                    const na = this._temp.vec4.fromBufferAttribute(normals, a);
                    const nb = this._temp.vec5.fromBufferAttribute(normals, b);
                    const nc = this._temp.vec6.fromBufferAttribute(normals, c);
                    const localNormal = new Vector3().addScaledVector(na, bary.u).addScaledVector(nb, bary.v).addScaledVector(nc, bary.w).normalize();
                    const normalMatrix = this._temp.mat3.getNormalMatrix(object.matrixWorld);
                    return localNormal.applyMatrix3(normalMatrix).normalize();
                }
            } catch (e) { console.log(e); }
        }
        if (face.normal) {
            const normal = face.normal.clone();
            const normalMatrix = this._temp.mat3.getNormalMatrix(object.matrixWorld);
            return normal.applyMatrix3(normalMatrix).normalize();
        }
        return this._computeFaceNormal(object, face);
    }

    // ==================== Label 相关 ====================

    // 更新热点标签：创建或更新热点的文本标签
    _updateHotspotLabel(hs, label) {
        if (!hs) return;
        if (!label || !label.text) {
            this._removeHotspotLabel(hs.id);
            return;
        }
        const prev = this.labels.get(hs.id);
        const validAligns = ['top', 'bottom', 'left', 'right'];
        const align = validAligns.includes(label.align) ? label.align : 'top';
        const offset = label.offset != null ? label.offset : 0;
        const visible = label.visible !== false;
        if (prev) {
            const el = this._getLabelElement(prev);
            if (el) {
                el.textContent = label.text;
                el.dataset.align = align; 
            }
            prev.options = { text: label.text, align, offset };
            prev.visible = visible;
            this._applyLabelOffset(prev.object, hs, align, offset);
            return;
        }
        const container = document.createElement('div');
        container.className = 'hotspot-label-container';
        const el = document.createElement('div');
        el.className = 'hotspot-label';
        el.textContent = label.text;
        el.dataset.align = align;
        el.classList.add('is-hidden');
        container.appendChild(el);
        const obj = new CSS2DObject(container);
        obj.visible = false;
        this._attachLabelObject(obj, hs);
        this._applyLabelOffset(obj, hs, align, offset);
        this._updateLabelTransform(hs);
        this.labels.set(hs.id, { object: obj, element: el, options: { text: label.text, align, offset }, visible });
    }

    // 设置标签可见性：控制指定热点标签的显示/隐藏
    _setHotspotLabelVisible(id, visible) {
        const item = this.labels.get(id);
        if (!item) return false;
        const flag = !!visible;
        item.visible = flag;
        item.object.visible = flag;
        const el = this._getLabelElement(item);
        if (el) el.classList.toggle('is-hidden', !flag);
        return true;
    }

    // 移除热点标签：删除指定热点的标签及其DOM元素
    _removeHotspotLabel(id) {
        const item = this.labels.get(id);
        if (!item) return;
        if (item.object.parent) item.object.parent.remove(item.object);
        if (item.object.element?.remove) item.object.element.remove();
        this.labels.delete(id);
    }

    // 刷新标签偏移：重新计算并应用标签的偏移位置
    _refreshHotspotLabelOffset(hs) {
        if (!hs) return;
        const labelData = this.labels.get(hs.id);
        if (!labelData) return;
        const offset = labelData.options?.offset ?? 0;
        this._applyLabelOffset(labelData.object, hs, labelData.options?.align || 'top', offset);
    }

    // 获取标签元素：从标签数据中提取DOM元素
    _getLabelElement(labelData) {
        if (!labelData) return null;
        if (labelData.element) return labelData.element;
        if (labelData.object?.element) {
            const label = labelData.object.element.querySelector('.hotspot-label');
            return label || labelData.object.element;
        }
        return null;
    }

    // 应用标签偏移：根据对齐方式和偏移量设置标签位置
    _applyLabelOffset(labelObject, hs, align, offset = 0) {
        if (!labelObject) return;
        labelObject.userData.__labelAlign = align;
        labelObject.userData.__labelOffset = offset;
        this._updateLabelTransform(hs);
    }

    // 附加标签对象：将标签对象添加到场景或热点对象
    _attachLabelObject(labelObject, hs) {
        if (!labelObject) return;
        if (this.engine?.mainScene) this.engine.mainScene.add(labelObject);
        else if (hs?.sprite) hs.sprite.add(labelObject);
    }

    // 更新标签变换：同步标签位置到热点的世界坐标位置
    _updateLabelTransform(hs) {
        if (!hs) return;
        const labelData = this.labels.get(hs.id);
        if (!labelData?.object || !labelData.visible) return;
        
        const worldPos = this._getHotspotWorldPosition(hs);
        const offset = labelData.options?.offset || 0;
        const align = labelData.options?.align || 'top';
        
        // 计算标签位置（包含偏移）
        if (offset) {
            const offsetVec = this._calculateLabelWorldOffset(hs, align, offset);
            labelData.object.position.copy(worldPos).add(offsetVec);
        } else {
            labelData.object.position.copy(worldPos);
        }
    }

    // 获取热点世界位置：获取热点在世界坐标系中的位置
    _getHotspotWorldPosition(hs) {
        if (!hs?.sprite) return new Vector3();
        return hs.sprite.getWorldPosition(this._temp.vec4);
    }

    // 计算标签世界偏移：根据对齐方式计算标签在世界空间中的偏移向量
    _calculateLabelWorldOffset(hs, align, offset) {
        if (!offset || !this.engine?.camera) return this._temp.vec1.set(0, 0, 0);
        const camera = this.engine.camera;
        const basePos = this._temp.vec2.set(0, 0, 0);
        const up = this._temp.vec1.copy(camera.up).normalize();
        const right = this._temp.vec3.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
        switch (align) {
            case 'top': basePos.copy(up); break;
            case 'bottom': basePos.copy(up).negate(); break;
            case 'left': basePos.copy(right).negate(); break;
            case 'right': basePos.copy(right); break;
            default: return this._temp.vec1.set(0, 0, 0);
        }
        const responsiveOffset = this._computeResponsiveOffset(offset, hs, camera);
        return basePos.multiplyScalar(responsiveOffset);
    }

    // 计算响应式偏移：根据相机距离动态调整标签偏移量
    _computeResponsiveOffset(offset, hs, camera) {
        if (!camera || !hs?.sprite) return offset;
        const worldPos = this._getHotspotWorldPosition(hs);
        const distance = camera.position.distanceTo(worldPos);
        const minScale = 0.4;
        const maxScale = 1.6;
        const scale = Math.min(maxScale, Math.max(minScale, distance * 0.15));
        return offset * scale;
    }

    // 计算重心坐标：计算点在三角形内的重心坐标（u, v, w）
    _computeBarycentric(p, va, vb, vc) {
        const v0 = this._temp.vec1.subVectors(vc, va);
        const v1 = this._temp.vec2.subVectors(vb, va);
        const v2 = this._temp.vec3.subVectors(p, va);
        const d00 = v0.dot(v0);
        const d01 = v0.dot(v1);
        const d02 = v0.dot(v2);
        const d11 = v1.dot(v1);
        const d12 = v1.dot(v2);
        const denom = d00 * d11 - d01 * d01;
        if (Math.abs(denom) < 1e-6) return null;
        const invDenom = 1 / denom;
        const v = (d00 * d12 - d01 * d02) * invDenom;
        const w = (d11 * d02 - d01 * d12) * invDenom;
        const u = 1 - v - w;
        if (u < -0.01 || v < -0.01 || w < -0.01) return null;
        return { u, v, w };
    }

    // 应用编辑控制器锁定：锁定或解锁编辑控制器的交互功能
    _applyEditControllerLock(locked) {
        const controller = this.engine?.editController;
        if (!controller) return;
        if (locked) {
            if (!this._interactionLockState.editController) {
                this._interactionLockState.editController = {
                    enabled: controller.enabled !== undefined ? controller.enabled : true,
                    enableRotate: controller.enableRotate !== undefined ? controller.enableRotate : true,
                    enableZoom: controller.enableZoom !== undefined ? controller.enableZoom : true,
                    enablePan: controller.enablePan !== undefined ? controller.enablePan : false,
                    autoRotate: controller.getCameraAutoRotate?.() || { enabled: false, speed: 1.0 }  
                };
            }
            controller.enabled = false;
            if (controller.enableRotate !== undefined) controller.enableRotate = false;
            if (controller.enableZoom !== undefined) controller.enableZoom = false;
            if (controller.enablePan !== undefined) controller.enablePan = false;
            if (controller.forceDisableAutoRotate) controller.forceDisableAutoRotate();
        } else {
            const prev = this._interactionLockState.editController;
            if (prev) {
                controller.enabled = prev.enabled;
                if (controller.enableRotate !== undefined && prev.enableRotate !== undefined) controller.enableRotate = prev.enableRotate;
                if (controller.enableZoom !== undefined && prev.enableZoom !== undefined) controller.enableZoom = prev.enableZoom;
                if (controller.enablePan !== undefined && prev.enablePan !== undefined) controller.enablePan = prev.enablePan;
            } else {
                controller.enabled = true;
                if (controller.enableRotate !== undefined) controller.enableRotate = true;
                if (controller.enableZoom !== undefined) controller.enableZoom = true;
                if (controller.enablePan !== undefined) controller.enablePan = false;
            }
            if (controller.unforceDisableAutoRotate) controller.unforceDisableAutoRotate();
            if (prev && prev.autoRotate && controller.setCameraAutoRotate) controller.setCameraAutoRotate(prev.autoRotate.enabled, prev.autoRotate.speed);
            this._interactionLockState.editController = null;
        }
    }

    // 计算面法向量：根据面的三个顶点计算面的法向量
    _computeFaceNormal(object, face) {
        const { a, b, c } = face;
        const positions = object.geometry.attributes.position;
        const va = this._temp.vec4.fromBufferAttribute(positions, a);
        const vb = this._temp.vec5.fromBufferAttribute(positions, b);
        const vc = this._temp.vec6.fromBufferAttribute(positions, c);
        const v1 = this._temp.vec1.subVectors(vb, va);
        const v2 = this._temp.vec2.subVectors(vc, va);
        const normal = this._temp.vec3.crossVectors(v1, v2).normalize();
        const normalMatrix = this._temp.mat3.getNormalMatrix(object.matrixWorld);
        return normal.applyMatrix3(normalMatrix).normalize();
    }

    // 检查自定义旋转：判断热点是否有自定义的旋转设置
    _hasCustomRotation(hs) {
        if (!hs?.state) return false;
        if (hs.state._hasCustomRotation === true) return true;
        if (hs?.sprite) {
            const q = hs.sprite.quaternion;
            const isDefault = Math.abs(q.x) < 0.001 && Math.abs(q.y) < 0.001 && Math.abs(q.z) < 0.001 && Math.abs(q.w - 1) < 0.001;
            return !isDefault;
        }
        return false;
    }

    // 朝向法向量：将mesh热点旋转到与指定法向量对齐
    _orientSpriteToNormal(sprite, worldNormal) {
        if (!worldNormal || worldNormal.lengthSq() < 0.1) return;
        if (sprite.userData.__hotspotType !== 'mesh') return;
        const from = this._temp.vec5.set(0, 0, 1);
        const to = this._temp.vec6.copy(worldNormal).normalize();
        const q = new Quaternion().setFromUnitVectors(from, to);
        sprite.quaternion.copy(q);
    }
    
    /**
     * 更新绑定到mesh的热点位置（跟随动画）
     * @private
     * @param {Object} hs - 热点对象
     */
    _updateAttachedHotspotPosition(hs) {
        const state = hs?.state;
        const sprite = hs?.sprite;
        if (!state?.bindMeshId || !sprite) return;

        let targetMesh = state.targetObject;
        if (!targetMesh || !targetMesh.parent || !targetMesh.visible) {
            targetMesh = this._findMeshById(state.bindMeshId);
            if (!targetMesh) return;
            state.targetObject = targetMesh;
        }
        
        targetMesh.updateMatrixWorld(true);

        if (!state.localOffset) {
            try {
                const invMatrix = this._temp.mat4.copy(targetMesh.matrixWorld).invert();
                state.localOffset = sprite.position.clone().applyMatrix4(invMatrix);

                // 同时懒计算 localNormal（如果有 worldNormal）
                if (state.worldNormal && !state.localNormal) {
                    const invNormalMatrix = this._temp.mat3.getNormalMatrix(invMatrix);
                    state.localNormal = state.worldNormal.clone().applyMatrix3(invNormalMatrix).normalize();
                }
            } catch (_) {
                // 计算失败则清理绑定，避免后续反复异常
                state.bindMeshId = null;
                state.targetObject = null;
                state.localOffset = null;
                state.localNormal = null;
                return;
            }
        }
        
        // 将局部偏移转换为世界坐标
        const worldPos = this._temp.vec1.copy(state.localOffset).applyMatrix4(targetMesh.matrixWorld);
        sprite.position.copy(worldPos);
        
        // 如果需要跟随法线旋转
        if (state.isSurfaceAttached && !this._hasCustomRotation(hs)) {
            const srcLocal = state.localNormal;
            if (srcLocal && srcLocal.lengthSq() > 0.0001) {
                const normalMatrix = this._temp.mat3.getNormalMatrix(targetMesh.matrixWorld);
                const worldNormal = this._temp.vec2.copy(srcLocal).applyMatrix3(normalMatrix).normalize();
                this._orientSpriteToNormal(sprite, worldNormal);
            }
        }
        
        sprite.updateMatrixWorld(true);
    }
    
    /**
     * 通过meshId查找mesh对象
     * @private
     * @param {string} meshId - mesh的userData.id
     * @returns {Object3D|null} 找到的mesh对象
     */
    _findMeshById(meshId) {
        if (!this.engine?.mainScene || !meshId) return null;

        // 首选：走缓存映射（mesh 或 group，只要有稳定 userData.id）
        this._updateSceneMeshCache();
        const cached = this._sceneObjectIdMap?.get(meshId) || null;
        if (cached) return cached;

        // 兜底：遍历一次
        let found = null;
        this.engine.mainScene.traverse(obj => {
            if (found) return;
            if (!obj.userData?.__isHotspot && obj.userData?.id === meshId) {
                found = obj;
            }
        });
        return found;
    }
    

    // 注入样式：向页面注入热点标签的CSS样式
    _injectStyles() {
        if (document.getElementById('f3d-hotspot-styles')) return;
        const style = document.createElement('style');
        style.id = 'f3d-hotspot-styles';
        style.textContent = `
            .hotspot-label-container { position: absolute; pointer-events: none; }
            .hotspot-label { 
                position: absolute; 
                padding: 5px 12px; 
                border-radius: 999px; 
                background: rgba(0, 0, 0, 0.75); 
                color: #fff; 
                font-size: 13px; 
                line-height: 1.4; 
                text-align: center; 
                white-space: nowrap; 
                pointer-events: auto;
                cursor: default;
                /* 3D效果:阴影和边框 */
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), 
                            0 0 0 1px rgba(255, 255, 255, 0.1);
                /* 平滑的透明度和变换过渡 */
                transition: opacity 0.25s ease-out, 
                           transform 0.15s ease-out,
                           background 0.2s ease-out;
                will-change: opacity, transform;
                /* 防止文字选中 */
                -webkit-user-select: none;
                -moz-user-select: none;
                -ms-user-select: none;
                user-select: none;
                /* 文字抗锯齿 */
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
            }
            /* 鼠标悬停效果 */
            .hotspot-label:hover {
                background: rgba(0, 0, 0, 0.85);
                box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4), 
                            0 0 0 1px rgba(255, 255, 255, 0.15);
            }
            /* 对齐方式 */
            .hotspot-label[data-align="top"] { 
                transform: translate(-50%, calc(-100% - 5px)); 
            }
            .hotspot-label[data-align="bottom"] { 
                transform: translate(-50%, 5px); 
            }
            .hotspot-label[data-align="left"] { 
                transform: translate(calc(-100% - 5px), -50%); 
            }
            .hotspot-label[data-align="right"] { 
                transform: translate(5px, -50%); 
            }
            /* 隐藏状态 */
            .hotspot-label.is-hidden { 
                opacity: 0 !important; 
                pointer-events: none !important;
                transform: translate(-50%, calc(-100% - 5px)) scale(0.95) !important;
            }
            .hotspot-label[data-align="bottom"].is-hidden {
                transform: translate(-50%, 5px) scale(0.95) !important;
            }
            .hotspot-label[data-align="left"].is-hidden {
                transform: translate(calc(-100% - 5px), -50%) scale(0.95) !important;
            }
            .hotspot-label[data-align="right"].is-hidden {
                transform: translate(5px, -50%) scale(0.95) !important;
            }
        `;
        document.head.appendChild(style);
    }

    // ==================== 输入事件处理 ====================

    // 节流工具函数：创建节流函数，限制函数执行频率
    _throttle(func, limit) {
        let inThrottle;
        return function() {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        }
    }

    // 绑定输入事件：绑定鼠标点击、移动等输入事件处理器
    _bindInput() {
        const bus = this.engine?.events;
        if (!bus) return;
        
        this._boundOnClick = this._onClick.bind(this);
        this._boundOnMouseDown = this._onMouseDown.bind(this);
        this._boundOnMouseMove = this._onMouseMove.bind(this);
        this._boundOnMouseUp = this._onMouseUp.bind(this);
        
        // 鼠标 Hover 检测节流
        this._boundOnMouseMoveHover = this._throttle(this._onMouseMoveHover.bind(this), this.CONFIG.HOVER_THROTTLE_MS);
        
        bus.on('input.click', this._boundOnClick);
        bus.on('input.mousedown', this._boundOnMouseDown);
        bus.on('input.mousemove', this._boundOnMouseMove);
        bus.on('input.mouseup', this._boundOnMouseUp);
        bus.on('input.mousemove', this._boundOnMouseMoveHover);
    }

    _onClick({ position }) {
        if (!position || !this.engine?.mainScene) return false;
        const isEditor = this.mode === 'editor';
        const hit = this._intersectHotspotAt(position);
        if (hit?.hotspot) {
            if (isEditor) {
                this.select(hit.hotspot.id);
            } else {
                this.events.emit('hotspot:click', { id: hit.hotspot.id, hotspot: hit.hotspot, position });
                const hotspotFocusEnabled = hit.hotspot?.opts?.enableCameraFocus !== false;
                if (this.CONFIG.CAMERA_FOCUS_ENABLED && hotspotFocusEnabled) {
                    this._focusCameraOnHotspot(hit.hotspot.id);
                }
            }
            return true; 
        }
        if (isEditor && this.selectedId) {
            const meshResult = this._performRaycast(position);
            if (meshResult?.hit && meshResult.intersect && !meshResult.intersect.object?.userData?.__isHotspot) {
                this._handleHotspotAttachment(meshResult.intersect, this.selectedId);
                return true; 
            }
        }
        return false; 
    }

    // 鼠标按下事件：开始拖拽热点，记录拖拽状态
    _onMouseDown({ position, button }) {
        if (this.mode !== 'editor') return;
        if (!position || button !== 'left') return;
        const result = this._intersectHotspotAt(position);
        if (!result?.hotspot) return;
        const hs = result.hotspot;
        const cam = this.engine?.camera;
        if (!cam) return;
        const dist = hs.sprite.position.distanceTo(cam.position);
        this.dragState = { id: hs.id, dragging: true, distance: dist };
        hs.material.depthTest = true;
        hs.material.depthWrite = true;
        hs.sprite.renderOrder = 2;
        if (hs.state) {
            // 拖拽时清除绑定信息
            hs.state.isSurfaceAttached = false;
            hs.state.worldNormal = null;
            hs.state.bindMeshId = null;
            hs.state.targetObject = null;
            hs.state.localOffset = null;
        }
        if (this.engine?.editController?.enableRotate !== undefined) {
            this.dragState._cameraRotateEnabled = this.engine.editController.enableRotate;
            this.engine.editController.enableRotate = false;
        }
        this.select(hs.id);
        try {
            this.events.emit('hotspot:click', { id: hs.id, hotspot: hs, position });
        } catch (err) { console.warn('hotspot:click event handler error:', err); }
        this.events.emit('hotspot:drag:start', { id: hs.id });
    }

    // 鼠标移动事件：拖拽过程中更新热点位置
    _onMouseMove({ position }) {
        if (this.mode !== 'editor') return;
        if (!this.dragState?.dragging) return;
        const hs = this.hotspots.get(this.dragState.id);
        const cam = this.engine?.camera;
        if (!hs || !cam || !position) return;
        const vector = this._temp.vec1.set(position.x, position.y, 0.5);
        vector.unproject(cam);
        const dir = this._temp.vec2.subVectors(vector, cam.position).normalize();
        const d = this.dragState.distance || hs.sprite.position.distanceTo(cam.position);
        hs.sprite.position.copy(cam.position).addScaledVector(dir, d);
        hs.sprite.updateMatrixWorld(true);
        
        // 同步更新标签位置
        if (this.labels.has(hs.id)) {
            this._updateLabelTransform(hs);
        }
        
        this.events.emit('hotspot:drag:move', { id: hs.id, point: hs.sprite.position.clone() });
    }

    // 鼠标悬停事件：检测鼠标悬停的热点，更新鼠标样式
    _onMouseMoveHover({ position }) {
        if (!position) return;
        const hit = this._intersectHotspotAt(position);
        const canvas = this.engine?.renderer?.domElement;
        if (hit?.hotspot) {
            if (this._hoveredHotspotId !== hit.hotspot.id) {
                this._hoveredHotspotId = hit.hotspot.id;
                if (canvas) canvas.style.cursor = 'pointer';
            }
        } else {
            if (this._hoveredHotspotId !== null) {
                this._hoveredHotspotId = null;
                if (canvas) canvas.style.cursor = '';
            }
        }
    }

    // 鼠标释放事件：结束拖拽，恢复相机旋转控制
    _onMouseUp() {
        if (this.mode !== 'editor') return;
        if (!this.dragState) return;
        if (this.dragState.dragging) {
            const hs = this.hotspots.get(this.dragState.id);
            if (this.engine?.editController && this.dragState._cameraRotateEnabled !== undefined) {
                this.engine.editController.enableRotate = this.dragState._cameraRotateEnabled;
            }
            this.events.emit('hotspot:drag:end', { id: this.dragState.id, point: hs?.sprite?.position?.clone() });
        }
        this.dragState = null;
    }

    /**
     * 确保 mesh 的 BVH 已构建
     * @private
     * @param {THREE.Mesh} mesh - 3D mesh 对象
     */
    _ensureBVH(mesh) {
        if (mesh?.geometry && !mesh.geometry.boundsTree) {
            try {
                if (typeof mesh.geometry.computeBoundsTree === 'function') {
                    mesh.geometry.computeBoundsTree();
                }
            } catch (error) {
                // 静默失败，不影响功能
            }
        }
    }

    // 更新场景 mesh 缓存并确保 BVH 已构建
    _updateSceneMeshCache() {
        if (!this.engine?.mainScene) {
            this._sceneMeshCache = [];
            this._sceneObjectIdMap = null;
            return;
        }
        
        const now = Date.now();
        const cacheMs = this.CONFIG.MESH_CACHE_DURATION ?? 500;
        
        if (!this._sceneMeshCache || (now - this._sceneMeshCacheTime) > cacheMs) {
            this._sceneMeshCache = [];
            this._sceneObjectIdMap = new Map();
            
            this.engine.mainScene.traverse(obj => {
                // 跳过热点对象
                if (obj.userData?.__isHotspot) {
                    return;
                }
                
                // 构建ID映射（用于快速查找绑定的mesh）
                if (obj.userData?.id != null) {
                    this._sceneObjectIdMap.set(obj.userData.id, obj);
                }
                
                // 只缓存可见的mesh用于遮挡检测
                if (obj.isMesh && obj.visible) {
                    // 在缓存时就过滤完全透明的物体，提高性能并简化遮挡检测逻辑
                    const shouldInclude = this._shouldIncludeInOcclusionCheck(obj);
                    if (shouldInclude) {
                        this._ensureBVH(obj);  // BVH加速射线检测
                        this._sceneMeshCache.push(obj);
                    }
                }
            });
            
            this._sceneMeshCacheTime = now;
        }
    }

    /**
     * 判断物体是否应该参与遮挡检测
     * @private
     * @param {Object3D} obj - 3D对象
     * @returns {boolean} 是否应该参与遮挡检测
     */
    _shouldIncludeInOcclusionCheck(obj) {
        if (!obj.material) return false;
        
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        
        // 如果至少有一个材质不是完全透明的，就参与遮挡检测
        for (let i = 0; i < materials.length; i++) {
            const mat = materials[i];
            if (!mat) continue;
            
            // 检查是否完全透明
            const opacity = mat.opacity !== undefined ? mat.opacity : 1;
            
            // 快速判断：如果 opacity >= 0.01，认为可以参与遮挡检测
            if (opacity >= 0.01) {
                return true;
            }
            
            // 检查颜色alpha通道
            if (mat.color && mat.color.a !== undefined && mat.color.a >= 0.01) {
                return true;
            }
        }
        
        // 所有材质都完全透明，不参与遮挡检测
        return false;
    }
    // 射线检测热点：从屏幕坐标检测命中的热点，考虑遮挡
    _intersectHotspotAt(ndc) {
        if (!this.engine?.camera || this.hotspots.size === 0) return null;
        
        this._ndc.set(ndc.x, ndc.y);
        this._raycaster.setFromCamera(this._ndc, this.engine.camera);
        
        this._updateSceneMeshCache();
        
        const meshIntersects = this._raycaster.intersectObjects(this._sceneMeshCache, false);
        const closestMeshDistance = meshIntersects.length > 0 ? meshIntersects[0].distance : Infinity;
        
        // 使用缓存列表，避免 Map.values 产生垃圾
        if (this._dirtyList) {
            this._cachedHotspotList = Array.from(this.hotspots.values());
            this._dirtyList = false;
        }

        // 收集可见的热点 Sprite
        const sprites = [];
        const cacheLen = this._cachedHotspotList.length;
        for(let i = 0; i < cacheLen; i++) {
            const hs = this._cachedHotspotList[i];
            if (hs.sprite && hs.sprite.visible) {
                sprites.push(hs.sprite);
            }
        }
        
        if (sprites.length === 0) return null;
        
        const spriteIntersects = this._raycaster.intersectObjects(sprites, true);
        if (!spriteIntersects?.length) return null;
        
        const closestSprite = spriteIntersects[0];
        if (closestSprite.distance > closestMeshDistance) {
            return null; // 被遮挡
        }
        
        const id = closestSprite.object?.userData?.__hotspotId;
        if (!id) return null;
        
        return { type: "hotspot", hotspot: this.hotspots.get(id), distance: closestSprite.distance };
    }

    // 执行射线检测：委托给inputManager执行场景射线检测
    _performRaycast(normalizedPosition) {
        return this.engine?.inputManager?.performRaycast(normalizedPosition) || { hit: false };
    }

    // 显示热点
    _showSprite(hs) {
        if (!hs?.sprite || !hs.state) return;
        hs.state._isLoading = false;
        
        if (hs.state._userVisible === false) {
            this._ensureHotspotHidden(hs);
            return;
        }
        
        hs.sprite.visible = true;
        if (hs.state._isHighlighted) this._setHighlight(hs, true);
    }
}