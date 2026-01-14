/**
 * 输入管理器 - 处理键盘和鼠标输入
 * @author GunGod
 * @description 负责处理DOM元素的鼠标和键盘输入事件，提供射线检测、高亮显示和动画播放功能
 */
import { Raycaster, Vector2, Color, TextureLoader, MeshBasicMaterial } from "three";

/**
 * 鼠标按钮映射常量
 * @type {string[]}
 */
const MOUSE_BUTTON_MAP = ['left', 'middle', 'right'];

/**
 * 输入事件名称常量
 * @type {Object}
 */
const INPUT_EVENTS = {
    MOUSE_DOWN: 'input.mousedown',
    MOUSE_UP: 'input.mouseup',
    MOUSE_MOVE: 'input.mousemove',
    CLICK: 'input.click',
    DRAG: 'input.drag',
    DRAG_END: 'input.dragend',
    WHEEL: 'input.wheel',
    KEY_DOWN: 'input.keydown',
    KEY_UP: 'input.keyup',
    MESH_CLICK: 'mesh:click',
    ANIMATION_PLAY: 'animation:play'
};

/**
 * 默认配置常量
 * @type {Object}
 */
const DEFAULT_CONFIG = {
    CLICK_THRESHOLD: 5,
    HIGHLIGHT_TIMER: 1000,
    HIGHLIGHT_COLOR: 0xff6600
};

/**
 * 输入管理器类
 * 负责处理鼠标、键盘等输入事件，管理3D场景中的交互逻辑
 */
export class InputManager {
    /**
     * 创建输入管理器
     * @param {HTMLElement} domElement - DOM元素
     * @param {Object} engine - 引擎实例
     */
    constructor(domElement, engine) {
        // 参数验证
        this._validateDomElement(domElement);
        this._validateEngine(engine);
        
        this.domElement = domElement;
        this.engine = engine;
        
        // ==================== 状态管理 ====================
        this.mouse = {
            position: { x: 0, y: 0 },
            buttons: { left: false, middle: false, right: false },
            isDragging: false,
            dragStart: { x: 0, y: 0 }
        };
        
        this.keys = {
            pressed: new Set()
        };
        
        // ==================== 射线检测 ====================
        this.raycaster = new Raycaster();
        this.raycastMouse = new Vector2();
        this.selectedObject = null;
        this.raycastEnabled = true;
        
        // ==================== 高亮功能 ====================
        this.autoHighlight = true;
        this.originalMaterials = new Map();
        this.highlightColor = new Color(DEFAULT_CONFIG.HIGHLIGHT_COLOR);
        this.highlightedMeshes = new Set();
        this.currentMaterial = null;
        this.highlightTimer = null;
        
        // ==================== 动画播放 ====================
        this.animationPlayEnabled = true;
        this.clickPlayMode = 'first';
        this.clickPlayOptions = {
            speed: 1.0,
            playDirectionType: 1,
            loopModeType: 2,
            loopCount: 1,
            startDelayTime: 0,
            fadeInTime: 400,
            fadeOutTime: 400,
            weight: 50,
            activeType: 1
        };
        
        // 初始化事件监听
        this.bindEvents();
    }
    
    /**
     * 绑定事件监听器
     * @public
     * @returns {void}
     */
    bindEvents() {
        if (!this.domElement) return;
        
        // 鼠标事件
        this.domElement.addEventListener('mousedown', this.onMouseDown.bind(this));
        this.domElement.addEventListener('mouseup', this.onMouseUp.bind(this));
        this.domElement.addEventListener('mousemove', this.onMouseMove.bind(this));
        this.domElement.addEventListener('wheel', this.onWheel.bind(this));
        this.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
        
        // 键盘事件
        window.addEventListener('keydown', this.onKeyDown.bind(this));
        window.addEventListener('keyup', this.onKeyUp.bind(this));
        window.addEventListener('blur', this.resetState.bind(this));
    }
    
    /**
     * 获取标准化的鼠标位置
     * @public
     * @param {number} clientX - 客户端X坐标
     * @param {number} clientY - 客户端Y坐标
     * @returns {{x: number, y: number}} 标准化的坐标
     */
    getNormalizedPosition(clientX, clientY) {
        const rect = this.domElement.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((clientY - rect.top) / rect.height) * 2 + 1;
        return { x, y };
    }
    
    /**
     * 鼠标按下事件处理
     * @public
     * @param {MouseEvent} event - 鼠标事件对象
     * @returns {void}
     */
    onMouseDown(event) {
        this.mouse.position = this.getNormalizedPosition(event.clientX, event.clientY);
        
        // 更新按钮状态
        const button = MOUSE_BUTTON_MAP[event.button];
        if (button) this.mouse.buttons[button] = true;
        
        // 开始拖拽
        this.mouse.isDragging = true;
        this.mouse.dragStart = { x: event.clientX, y: event.clientY };
        
        // 触发事件
        this.engine.events.emit(INPUT_EVENTS.MOUSE_DOWN, {
            position: this.mouse.position,
            button: button,
            buttons: { ...this.mouse.buttons }
        });
    }
    
    /**
     * 鼠标抬起事件处理
     * @public
     * @param {MouseEvent} event - 鼠标事件对象
     * @returns {void}
     */
    onMouseUp(event) {
        this.mouse.position = this.getNormalizedPosition(event.clientX, event.clientY);
        
        // 更新按钮状态
        const button = MOUSE_BUTTON_MAP[event.button];
        if (button) this.mouse.buttons[button] = false;
        
        // 检查是否为点击
        const dragDistance = Math.hypot(
            event.clientX - this.mouse.dragStart.x,
            event.clientY - this.mouse.dragStart.y
        );
        
        if (dragDistance < DEFAULT_CONFIG.CLICK_THRESHOLD) {
            // 一次性执行所有射线检测（包括热点和模型）
            const allIntersects = this._performUnifiedRaycast(this.mouse.position);
            
            // 先检查是否点击到热点
            const hotspotHit = allIntersects.hotspot;
            const modelHit = allIntersects.model;
            
            // 触发点击事件
            this.engine.events.emit(INPUT_EVENTS.CLICK, {
                position: this.mouse.position,
                button: button,
                hotspot: hotspotHit,
                raycast: modelHit
            });
            
            // 如果没有点击到热点，才处理模型点击
            if (!hotspotHit && modelHit?.hit) {
                // 处理模型点击（高亮、触发事件等）
                this._handleModelClick(modelHit);
            }
        }
        
        // 结束拖拽
        if (this.mouse.isDragging) {
            this.engine.events.emit(INPUT_EVENTS.DRAG_END, {
                position: this.mouse.position,
                button: button,
                buttons: { ...this.mouse.buttons }
            });
        }
        
        this.mouse.isDragging = false;
        
        this.engine.events.emit(INPUT_EVENTS.MOUSE_UP, {
            position: this.mouse.position,
            button: button,
            buttons: { ...this.mouse.buttons }
        });
    }
    
    /**
     * 鼠标移动事件处理
     * @public
     * @param {MouseEvent} event - 鼠标事件对象
     * @returns {void}
     */
    onMouseMove(event) {
        this.mouse.position = this.getNormalizedPosition(event.clientX, event.clientY);
        
        this.engine.events.emit(INPUT_EVENTS.MOUSE_MOVE, {
            position: this.mouse.position,
            isDragging: this.mouse.isDragging,
            buttons: { ...this.mouse.buttons }
        });
        
        // 拖拽事件
        if (this.mouse.isDragging) {
            const dragDelta = {
                x: event.clientX - this.mouse.dragStart.x,
                y: event.clientY - this.mouse.dragStart.y
            };
            
            this.engine.events.emit(INPUT_EVENTS.DRAG, {
                position: this.mouse.position,
                delta: dragDelta,
                buttons: { ...this.mouse.buttons }
            });
        }
    }
    
    /**
     * 鼠标滚轮事件处理
     * @public
     * @param {WheelEvent} event - 滚轮事件对象
     * @returns {void}
     */
    onWheel(event) {
        event.preventDefault();
        
        this.mouse.position = this.getNormalizedPosition(event.clientX, event.clientY);
        const delta = Math.sign(event.deltaY);
        
        this.engine.events.emit(INPUT_EVENTS.WHEEL, {
            position: this.mouse.position,
            delta: delta
        });
    }
    
    /**
     * 键盘按下事件处理
     * @public
     * @param {KeyboardEvent} event - 键盘事件对象
     * @returns {void}
     */
    onKeyDown(event) {
        const key = event.key.toLowerCase();
        this.keys.pressed.add(key);
        
        this.engine.events.emit(INPUT_EVENTS.KEY_DOWN, {
            key: key,
            code: event.code,
            ctrl: event.ctrlKey,
            shift: event.shiftKey,
            alt: event.altKey
        });
    }
    
    /**
     * 键盘抬起事件处理
     * @public
     * @param {KeyboardEvent} event - 键盘事件对象
     * @returns {void}
     */
    onKeyUp(event) {
        const key = event.key.toLowerCase();
        this.keys.pressed.delete(key);
        
        this.engine.events.emit(INPUT_EVENTS.KEY_UP, {
            key: key,
            code: event.code,
            ctrl: event.ctrlKey,
            shift: event.shiftKey,
            alt: event.altKey
        });
    }
    
    /**
     * 重置状态
     * @public
     * @returns {void}
     */
    resetState() {
        this.mouse.buttons = { left: false, middle: false, right: false };
        this.mouse.isDragging = false;
        this.keys.pressed.clear();
    }
    
    /**
     * 检查按键是否被按下
     * @public
     * @param {string} key - 按键名称
     * @returns {boolean} 是否被按下
     */
    isKeyPressed(key) {
        return this.keys.pressed.has(key.toLowerCase());
    }
    
    /**
     * 检查鼠标按钮是否按下
     * @public
     * @param {string} button - 按钮名称 ('left'|'middle'|'right')
     * @returns {boolean} 是否被按下
     */
    isMousePressed(button) {
        return this.mouse.buttons[button] === true;
    }
    
    /**
     * 获取鼠标位置
     * @public
     * @returns {{x: number, y: number}} 鼠标位置坐标
     */
    getMousePosition() {
        return { ...this.mouse.position };
    }
    
    /**
     * 执行射线检测
     * @public
     * @param {{x: number, y: number}} normalizedPosition - 标准化的鼠标位置
     * @returns {Object} 射线检测结果
     */
    performRaycast(normalizedPosition) {
        if (!this.raycastEnabled || !this.engine.camera || !this.engine.mainScene) {
            return { hit: false };
        }
        
        // 设置射线检测参数
        this.raycastMouse.set(normalizedPosition.x, normalizedPosition.y);
        this.raycaster.setFromCamera(this.raycastMouse, this.engine.camera);
        
        // 更新场景矩阵和SkinnedMesh几何体
        this._updateSceneForRaycast();
        
        // 执行射线检测
        const intersects = this._performRaycastIntersection();
        
        if (intersects.length > 0) {
            const intersect = intersects[0];
            const clickedObject = intersect.object;
            
            // 检查是否点击到热点，如果是热点则不处理
            if (clickedObject.userData?.__isHotspot) {
                return { hit: false }; 
            }
            
            // 查找模型信息
            const modelInfo = this.findModelInfo(clickedObject);
            
            // 获取点击对象的材质
            const clickedMaterial = Array.isArray(clickedObject.material) ? 
                clickedObject.material[0] : clickedObject.material;
            
            return {
                hit: true,
                object: clickedObject,
                modelId: modelInfo.modelId,
                modelProxy: modelInfo.proxy,
                material: clickedMaterial,
                point: intersect.point,
                distance: intersect.distance,
                intersect: intersect
            };
        } else {
            // 点击空白区域
            this.clearAllHighlights();
            this.selectedObject = null;
            return { hit: false };
        }
    }

    /**
     * 更新场景以支持射线检测
     * @private
     */
    _updateSceneForRaycast() {
        // 强制更新场景中所有对象的矩阵
        this.engine.mainScene.updateMatrixWorld(true);
        
        // 关键修复：强制更新所有SkinnedMesh的几何体，确保动画顶点位置正确
        this.engine.mainScene.traverse((object) => {
            if (object.isSkinnedMesh) {
                // 强制更新SkinnedMesh的几何体顶点位置
                object.updateMatrix();
                object.updateMatrixWorld(true);
                // 重新计算几何体的边界体积
                if (object.geometry) {
                    object.geometry.computeBoundingBox();
                    object.geometry.computeBoundingSphere();
                }
                // 强制更新SkinnedMesh的顶点位置
                object.computeBoundingBox();
                object.computeBoundingSphere();
            }
        });
    }

    /**
     * 处理模型点击（高亮和触发事件）
     * @private
     */
    _handleModelClick(modelHit) {
        if (!modelHit || !modelHit.hit) return;
        
        const { object: clickedObject, material: clickedMaterial, modelId, modelProxy } = modelHit;
        
        // 设置选中对象
        this.selectedObject = clickedObject;
        
        // 自动高亮
        if (this.autoHighlight && clickedMaterial && modelProxy) {
            this.clearAllHighlights();
            this.highlightSameMaterial(clickedMaterial, modelProxy);
        }
        
        // 触发 MESH_CLICK 事件
        if (this.engine && this.engine.events && clickedMaterial) {
            this.engine.events.emit(INPUT_EVENTS.MESH_CLICK, {
                modelId: modelId,
                partName: clickedObject.name || clickedObject.type,
                material: clickedMaterial,
                object: clickedObject,
                position: this.mouse.position 
            });
        }
    }

    /**
     * 统一的射线检测（同时检测热点和模型）
     * @private
     */
    _performUnifiedRaycast(normalizedPosition) {
        if (!this.engine.camera || !this.engine.mainScene) {
            return { hotspot: null, model: { hit: false } };
        }
        
        // 1. 优先检测热点
        let hotspotHit = null;
        if (this.engine.hotspotController) {
            hotspotHit = this.engine.hotspotController._intersectHotspotAt(normalizedPosition);
        }
        
        // 2. 只有没点击到热点时，才检测模型
        let modelHit = { hit: false };
        if (!hotspotHit && this.raycastEnabled) {
            // 直接调用射线检测逻辑，不走 performRaycast（避免重复）
            this.raycastMouse.set(normalizedPosition.x, normalizedPosition.y);
            this.raycaster.setFromCamera(this.raycastMouse, this.engine.camera);
            this._updateSceneForRaycast();
            
            const intersects = this._performRaycastIntersection();
            
            if (intersects.length > 0) {
                const intersect = intersects[0];
                const clickedObject = intersect.object;
                
                // 再次确认不是热点
                if (!clickedObject.userData?.__isHotspot) {
                    const modelInfo = this.findModelInfo(clickedObject);
                    const clickedMaterial = Array.isArray(clickedObject.material) ? 
                        clickedObject.material[0] : clickedObject.material;
                    
                    modelHit = {
                        hit: true,
                        object: clickedObject,
                        modelId: modelInfo.modelId,
                        modelProxy: modelInfo.proxy,
                        material: clickedMaterial,
                        point: intersect.point,
                        distance: intersect.distance,
                        intersect: intersect
                    };
                }
            }
        }
        
        return { hotspot: hotspotHit, model: modelHit };
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

    /**
     * 执行射线检测交集计算（图形算法优化：使用 BVH 加速）
     * @private
     */
    _performRaycastIntersection() {
        // 收集所有mesh进行射线检测
        const allMeshes = [];
        this.engine.mainScene.traverse((object) => {
            if (object.isMesh && !object.userData?.__isHotspot) {
                // 过滤掉隐藏的mesh
                if (!object.visible) {
                    return;
                }
                
                // 过滤掉被隔离控制且不可见的mesh
                if (object.userData?.__isolationControlled === true) {
                    const isolationVisible = object.userData?.__isolationVisible;
                    if (isolationVisible === false) {
                        return; // 被隔离隐藏的mesh，不参与射线检测
                    }
                }
                
                
                allMeshes.push(object);
            }
        });
        
        let intersects = this.raycaster.intersectObjects(allMeshes, true);
        
        // 如果没找到，尝试通过assetsManager
        if (intersects.length === 0 && this.engine.assetsManager?.assets?.models) {
            const models = [];
            this.engine.assetsManager.assets.models.forEach((model) => {
                if (model) {
                    
                    models.push(model);
                }
            });
            if (models.length > 0) {
                const allIntersects = this.raycaster.intersectObjects(models, true);
                // 过滤掉热点对象、隐藏对象和被隔离隐藏的对象
                intersects = allIntersects.filter(item => {
                    const obj = item.object;
                    if (obj?.userData?.__isHotspot) return false;
                    if (!obj?.visible) return false;
                    if (obj?.userData?.__isolationControlled === true) {
                        if (obj.userData?.__isolationVisible === false) return false;
                    }
                    return true;
                });
            }
        }
        
        return intersects;
    }

    /**
     * 查找物体对应的模型信息
     * @public
     * @param {THREE.Object3D} object - 3D对象
     * @returns {{modelId: string|null, proxy: Object|null}} 模型信息
     */
    findModelInfo(object) {
        if (!this.engine.assetsManager) {
            return { modelId: null, proxy: null };
        }
        
        // 向上遍历找到根模型
        let current = object;
        while (current && current.parent && current.parent.type !== 'Scene') {
            current = current.parent;
        }
        
        // 从assetsManager获取模型信息
        const models = this.engine.assetsManager.assets?.models;
        if (models) {
            for (const [modelId, model] of models.entries()) {
                if (model === current || this.isChildOf(object, model)) {
                    return {
                        modelId: modelId,
                        proxy: this.engine.assetsManager.getModel(modelId)
                    };
                }
            }
        }
        
        return { modelId: null, proxy: null };
    }
    
    /**
     * 高亮mesh对象
     * @public
     * @param {THREE.Mesh} mesh - 要高亮的mesh
     * @returns {void}
     */
    highlightMesh(mesh) {
        if (!mesh || !mesh.material) return;
        
        // 保存原始材质
        if (!this.originalMaterials.has(mesh.uuid)) {
            this.originalMaterials.set(mesh.uuid, mesh.material);
        }
        
        // 添加到高亮集合
        this.highlightedMeshes.add(mesh);
        
        // 获取原始材质的side属性，保持一致的渲染方式
        const originalMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const originalSide = originalMaterial ? originalMaterial.side : 2; // 默认为双面渲染
        
        // 创建全新的纯色高亮材质，保持原始材质的side属性
        const highlightMat = new MeshBasicMaterial({
            color: this.highlightColor,
            transparent: false,
            opacity: 1.0,
            toneMapped: false,
            side: originalSide // 使用原始材质的side属性
        });
        
        // 直接替换材质
        if (Array.isArray(mesh.material)) {
            mesh.material = mesh.material.map(() => highlightMat);
        } else {
            mesh.material = highlightMat;
        }
    }
    
    /**
     * 取消高亮mesh对象
     * @public
     * @param {THREE.Mesh} mesh - 要取消高亮的mesh
     * @returns {void}
     */
    unhighlightMesh(mesh) {
        if (!mesh) return;

        // 1) 若使用“替换材质”方案，高亮结束需恢复原材质
        const originalMaterial = this.originalMaterials?.get(mesh.uuid);
        if (originalMaterial) {
            mesh.material = originalMaterial;
            this.originalMaterials.delete(mesh.uuid);
        }

        // 2) 若存在覆盖层（兼容旧实现），一起清理
        const overlay = mesh.userData && mesh.userData.__highlightOverlay;
        if (overlay) {
            try {
                if (overlay.material && typeof overlay.material.dispose === 'function') {
                    overlay.material.dispose();
                }
            } catch (_) {}
            mesh.remove(overlay);
            delete mesh.userData.__highlightOverlay;
        }

        // 3) 从高亮集合移除
        if (this.highlightedMeshes) {
            this.highlightedMeshes.delete(mesh);
        }
    }
        
    /**
     * 检查是否为子对象
     * @public
     * @param {THREE.Object3D} child - 子对象
     * @param {THREE.Object3D} parent - 父对象
     * @returns {boolean} 是否为子对象
     */
    isChildOf(child, parent) {
        let current = child;
        while (current) {
            if (current === parent) return true;
            current = current.parent;
        }
        return false;
    }
    
    /**
     * 清除高亮
     * @public
     * @returns {void}
     */
    clearHighlight() {
        if (this.selectedObject && this.autoHighlight) {
            this.unhighlightMesh(this.selectedObject);
        }
    }
    
    /**
     * 清除所有高亮
     * @public
     * @returns {void}
     */
    clearAllHighlights() {
        // 清除定时器
        if (this.highlightTimer) {
            clearTimeout(this.highlightTimer);
            this.highlightTimer = null;
        }
        
        // 取消所有高亮的mesh
        this.highlightedMeshes.forEach(mesh => {
            this.unhighlightMesh(mesh);
        });
        this.highlightedMeshes.clear();
        this.currentMaterial = null;
    }
    
    /**
     * 高亮相同材质的所有mesh
     * @param {THREE.Material} material - 目标材质
     * @param {THREE.Object3D} rootObject - 根对象
     */
    highlightSameMaterial(material, rootObject) {
        if (!material || !rootObject) return;

        // 遍历所有子节点，找到使用同一材质（对象、uuid或同名）的mesh
        rootObject.traverse(child => {
            if (child.isMesh && child.material) {
                const childMaterial = Array.isArray(child.material) ? child.material[0] : child.material;
                if (
                    childMaterial === material ||
                    (childMaterial?.uuid && childMaterial.uuid === material.uuid) ||
                    (childMaterial?.name && material?.name && childMaterial.name === material.name)
                ) {
                    this.highlightMesh(child);
                }
            }
        });

        // 启动高亮定时器
        this.startHighlightTimer();
    }
    
    /**
     * 启动高亮定时器（1秒后自动取消高亮）
     * @public
     * @returns {void}
     */
    startHighlightTimer() {
        // 清除之前的定时器
        if (this.highlightTimer) {
            clearTimeout(this.highlightTimer);
        }
        
        // 设置定时器
        this.highlightTimer = setTimeout(() => {
            this.clearAllHighlights();
        }, DEFAULT_CONFIG.HIGHLIGHT_TIMER);
    }
    
    /**
     * 设置自动高亮
     * @public
     * @param {boolean} enabled - 是否启用自动高亮
     * @returns {void}
     */
    setAutoHighlight(enabled) {
        if (!enabled && this.autoHighlight) {
            this.clearAllHighlights();
        }
        this.autoHighlight = enabled;
    }
    
    /**
     * 设置射线检测开关
     * @public
     * @param {boolean} enabled - 是否启用射线检测
     * @returns {void}
     */
    setRaycastEnabled(enabled) {
        this.raycastEnabled = enabled;
    }

    /**
     * 设置动画播放功能开关
     * @public
     * @param {boolean} enabled - 是否启用动画播放
     * @returns {void}
     */
    setAnimationPlayEnabled(enabled = true) {
        this.animationPlayEnabled = enabled;
    }

    /**
     * 获取动画播放功能状态
     * @public
     * @returns {boolean} 是否启用动画播放
     */
    isAnimationPlayEnabled() {
        return this.animationPlayEnabled;
    }
    
    /**
     * 获取当前选中对象
     * @public
     * @returns {THREE.Object3D|null} 当前选中的对象
     */
    getSelectedObject() {
        return this.selectedObject;
    }
    
    /**
     * 通过指定材质触发1秒高亮
     * @public
     * @param {THREE.Material|string} material - 材质对象或材质名称
     * @param {THREE.Object3D|null} rootObject - 根对象，默认使用主场景
     * @returns {void}
     */
    highlightByMaterial(material, rootObject = null) {
        if (material === undefined || material === null) {
            console.warn('highlightByMaterial: 材质参数不能为空');
            return;
        }
        
        // 如果没有提供根对象，使用主场景
        const targetRoot = rootObject || this.engine.mainScene;
        if (!targetRoot) {
            console.warn('highlightByMaterial: 无法找到根对象');
            return;
        }
        
        let targetMaterial = null;
        
        // 如果传入的是字符串，按材质名称查找
        if (typeof material === 'string') {
            const materialName = material; 
            targetRoot.traverse(child => {
                if (child.isMesh && child.material && !targetMaterial) {
                    const childMaterial = Array.isArray(child.material) ? child.material[0] : child.material;
                    const childName = (childMaterial.name !== undefined && childMaterial.name !== null) ? String(childMaterial.name) : '';
                    if (childName === materialName) {
                        targetMaterial = childMaterial;
                    }
                }
            });

            if (!targetMaterial) {
                return;
            }
        } else {
            targetMaterial = material;
        }
        
        // 先清除所有高亮
        this.clearAllHighlights();
        
        // 高亮指定材质的所有mesh
        this.highlightSameMaterial(targetMaterial, targetRoot);
    }

    /**
     * 验证引擎实例
     * @private
     * @param {Object} engine - 引擎实例
     * @throws {Error} 当引擎实例无效时抛出错误
     */
    _validateEngine(engine) {
        if (!engine) {
            throw new Error('InputManager: 引擎实例不能为空');
        }
        if (!engine.events) {
            throw new Error('InputManager: 引擎实例缺少事件系统');
        }
    }

    /**
     * 验证DOM元素
     * @private
     * @param {HTMLElement} domElement - DOM元素
     * @throws {Error} 当DOM元素无效时抛出错误
     */
    _validateDomElement(domElement) {
        if (!domElement) {
            throw new Error('InputManager: DOM元素不能为空');
        }
        if (!(domElement instanceof HTMLElement)) {
            throw new Error('InputManager: 必须提供有效的DOM元素');
        }
    }

    /**
     * 清理资源
     * @public
     * @returns {void}
     */
    dispose() {
        // 清除高亮
        this.clearAllHighlights();
        
        // 移除事件监听
        if (this.domElement) {
            this.domElement.removeEventListener('mousedown', this.onMouseDown);
            this.domElement.removeEventListener('mouseup', this.onMouseUp);
            this.domElement.removeEventListener('mousemove', this.onMouseMove);
            this.domElement.removeEventListener('wheel', this.onWheel);
        }
        
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.resetState);
        
        // 清除状态
        this.mouse = null;
        this.keys = null;
        this.domElement = null;
        this.engine = null;
        this.raycaster = null;
        this.raycastMouse = null;
        this.selectedObject = null;
    }
}