/**
 * 编辑器控制器 - 管理相机移动和旋转
 * @author AGan
 */
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
export class EditorController extends OrbitControls {
    /**
     * 创建编辑器控制器
     */
    constructor(camera, domElement) {
        super(camera, domElement);
        
        // 控制器设置
        this.enableDamping = true;
        this.dampingFactor = 0.08;
        this.enablePan = false;
        
        // 距离限制
        this.minDistance = 0;
        this.maxDistance = 100;
        
        // 相机自动旋转状态
        this._autoRotateState = {
            enabled: false,
            speed: 2.0,
            pauseTimer: null,
            forceDisabled: false  // 强制禁用自动旋转
        };
        
        // 阻止右键菜单
        domElement.addEventListener("contextmenu", (e) => e.preventDefault());
        
        // 监听用户交互事件，实现暂停和恢复
        this._bindInteractionEvents();
    }

    /**
     * 绑定交互事件监听
     */
    _bindInteractionEvents() {
        // 监听开始交互
        this.addEventListener('start', () => {
            if (this._autoRotateState.enabled && this.autoRotate) {
                // 暂停自动旋转
                this.autoRotate = false;
                // 清除之前的恢复计时器
                if (this._autoRotateState.pauseTimer) {
                    clearTimeout(this._autoRotateState.pauseTimer);
                }
            }
        });
        
        // 监听结束交互
        this.addEventListener('end', () => {
            // 只有在启用且未被强制禁用时才恢复
            if (this._autoRotateState.enabled && !this._autoRotateState.forceDisabled) {
                // 延迟1秒后恢复自动旋转
                this._autoRotateState.pauseTimer = setTimeout(() => {
                    // 再次检查是否被强制禁用
                    if (!this._autoRotateState.forceDisabled) {
                        this.autoRotate = true;
                    }
                }, 1000);
            }
        });
    }

    /**
     * 更新控制器
     * @returns {EditorController} 控制器实例
     */
    update() {
        // 调用父类更新
        super.update();
        return this;
    }
    
    /**
     * 获取相机到目标的距离
     * @returns {Number} 距离值
     */
    getDistance() {
        if (this.object && this.target) {
            return this.object.position.distanceTo(this.target);
        }
        return 0;
    }

    /**
     * 设置相机自动旋转
     */
    setCameraAutoRotate(enabled, speed = 1.0) {
        this._autoRotateState.enabled = !!enabled;
        this._autoRotateState.speed = Number.isFinite(speed) ? speed : 1.0;
        this._autoRotateState.forceDisabled = false;  // 正常调用时，取消强制禁用
        
        // 清除之前的计时器
        if (this._autoRotateState.pauseTimer) {
            clearTimeout(this._autoRotateState.pauseTimer);
            this._autoRotateState.pauseTimer = null;
        }
        
        // 应用到OrbitControls
        this.autoRotate = !!enabled;
        this.autoRotateSpeed = speed * 20;
        
        return this;
    }

    /**
     * 获取相机自动旋转状态
     */
    getCameraAutoRotate() {
        return {
            enabled: this._autoRotateState.enabled,
            speed: this._autoRotateState.speed
        };
    }

    /**
     * 强制禁用自动旋转（用于热点详情、弹窗等场景）
     * 即使用户交互结束，也不会自动恢复旋转
     */
    forceDisableAutoRotate() {
        this._autoRotateState.forceDisabled = true;
        this.autoRotate = false;
        
        // 清除恢复计时器
        if (this._autoRotateState.pauseTimer) {
            clearTimeout(this._autoRotateState.pauseTimer);
            this._autoRotateState.pauseTimer = null;
        }
        
        return this;
    }

    /**
     * 取消强制禁用自动旋转
     * 如果之前是启用状态，将恢复自动旋转
     */
    unforceDisableAutoRotate() {
        this._autoRotateState.forceDisabled = false;
        
        // 如果之前是启用状态，恢复自动旋转
        if (this._autoRotateState.enabled) {
            this.autoRotate = true;
        }
        
        return this;
    }

    /**
     * 清理资源
     */
    dispose() {
        // 清除自动旋转计时器
        if (this._autoRotateState?.pauseTimer) {
            clearTimeout(this._autoRotateState.pauseTimer);
            this._autoRotateState.pauseTimer = null;
        }
        super.dispose();
    }
}

