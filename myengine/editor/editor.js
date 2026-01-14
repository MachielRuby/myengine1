/**
 * 编辑器类 - 管理编辑器界面和功能
 * @author GunGod
 * @class Editor
 * @description 提供编辑器核心功能，包括事件处理、API管理和工具集成
 */
import { Vector2 } from "three";
import { EventBus } from "../engine/core/events/eventEmitter.js";
import {cameraApi} from "./apis/cameraApi.js"

/**
 * 鼠标事件名称常量
 * @type {Object.<string, string>}
 */
const MOUSE_EVENTS = {
    DOWN: 'mouse.down',
    MOVE: 'mouse.move',
    UP: 'mouse.up'
};

/**
 * 引擎事件名称常量
 * @type {Object.<string, string>}
 */
const ENGINE_EVENTS = {
    SCENE_LOADED: 'scene.loaded'
};

export class Editor {
    /**
     * 引擎实例
     * @type {Engine}
     */
    engine;
    
    /**
     * 事件总线
     * @type {EventBus}
     */
    events;
    
    /**
     * 相机API实例
     * @type {cameraApi}
     */
    cameraApi;
    
    /**
     * 鼠标按下位置
     * @type {Vector2}
     */
    mouseDownPosition;
    
    /**
     * 鼠标抬起位置
     * @type {Vector2}
     */
    mouseUpPosition;
    
    /**
     * 当前鼠标位置
     * @type {Vector2}
     */
    mousePosition;
    
    /**
     * 创建编辑器实例
     * @param {Engine} engine 引擎实例
     */
    constructor(engine) {
        // 验证引擎实例
        if (!this._validateEngine(engine)) {
            return;
        }
        
        // 核心引用
        this.engine = engine;
        this.events = new EventBus();
        
        // 鼠标状态
        this.mouseDownPosition = new Vector2(0, 0);
        this.mouseUpPosition = new Vector2(0, 0);
        this.mousePosition = new Vector2(0, 0);
        
        // 初始化
        this.initAPIs();
        this.initTools();
        this.setupEvents();
        
        // 将编辑器引用添加到引擎
        if (this.engine) {
            this.engine.setEditor(this);
        }
    }
    
    /**
     * 初始化API接口
     * @returns {void}
     */
    initAPIs() {
        // 使用引擎的相机实例，而不是创建新的
        if (this.engine && this.engine.camera) {
            this.cameraApi = this.engine.camera;
        } else {
            // 备用方案：如果引擎相机不可用，创建新的
            this.cameraApi = new cameraApi();
        }
        
        // 如果引擎已初始化，设置控制器
        if (this.engine && this.engine.editController) {
            this.cameraApi.setControls(this.engine.editController);
        }
    }
    
    /**
     * 初始化工具
     * @description 预留方法，用于初始化编辑器工具集
     * @returns {void}
     */
    initTools() {
    }
    
    /**
     * 设置事件监听
     * @returns {void}
     */
    setupEvents() {
        // 监听引擎事件
        if (this.engine && this.engine.events) {
            this.engine.events.on(ENGINE_EVENTS.SCENE_LOADED, this.onSceneLoaded.bind(this));
        }
        
        // 设置DOM事件
        if (this.engine && this.engine.renderer) {
            const canvas = this.engine.renderer.domElement;
            canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
            canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
            canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
        }
    }
    
    /**
     * 鼠标按下事件处理
     * @param {MouseEvent} event 鼠标事件对象
     * @returns {void}
     */
    onMouseDown(event) {
        this.mouseDownPosition.set(event.clientX, event.clientY);
        this.events.emit(MOUSE_EVENTS.DOWN, { position: this.mouseDownPosition, event });
    }
    
    /**
     * 鼠标移动事件处理
     * @param {MouseEvent} event 鼠标事件对象
     * @returns {void}
     */
    onMouseMove(event) {
        this.mousePosition.set(event.clientX, event.clientY);
        this.events.emit(MOUSE_EVENTS.MOVE, { position: this.mousePosition, event });
    }
    
    /**
     * 鼠标抬起事件处理
     * @param {MouseEvent} event 鼠标事件对象
     * @returns {void}
     */
    onMouseUp(event) {
        this.mouseUpPosition.set(event.clientX, event.clientY);
        this.events.emit(MOUSE_EVENTS.UP, { position: this.mouseUpPosition, event });
    }
    
    /**
     * 场景加载完成处理
     * @param {Object} data 场景数据
     * @returns {void}
     */
    onSceneLoaded(data) {
        // 处理场景加载完成事件
    }
    
    /**
     * 清理资源
     * @returns {void}
     */
    dispose() {
        // 清理事件监听
        if (this.engine && this.engine.renderer) {
            const canvas = this.engine.renderer.domElement;
            canvas.removeEventListener('mousedown', this.onMouseDown);
            canvas.removeEventListener('mousemove', this.onMouseMove);
            canvas.removeEventListener('mouseup', this.onMouseUp);
        }
        
        // 清理引用
        this.engine = null;
        this.events = null;
    }
    
    /**
     * 验证引擎实例
     * @private
     * @param {Engine} engine 引擎实例
     * @returns {boolean} 验证结果
     */
    _validateEngine(engine) {
        if (!engine) {
            this._handleError('引擎实例不能为空');
            return false;
        }
        return true;
    }
    
    /**
     * 统一错误处理
     * @private
     * @param {string} message 错误信息
     */
    _handleError(message) {
        console.error(`[Editor] ${message}`);
    }
}