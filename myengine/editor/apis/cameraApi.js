/**
 * 相机API - 提供相机控制和限制设置
 * @author GunGod
 */
import { PerspectiveCamera, Vector3, Box3 } from "three";

// 常量定义
const DEFAULT_FOV = 60;
const DEFAULT_NEAR = 0.1;
const DEFAULT_FAR = 1000;
const DEFAULT_MIN_DISTANCE = 0;
const DEFAULT_MAX_DISTANCE = 100;
const DEFAULT_MIN_POLAR_ANGLE = -Math.PI / 2;
const DEFAULT_MAX_POLAR_ANGLE = Math.PI / 2;
const DEFAULT_DAMPING_FACTOR = 0.05;
const SMOOTH_DAMPING_FACTOR = 0.1;
const DEFAULT_FIT_OFFSET = 2.0;

/**
 * 相机API类 - 提供相机控制和限制设置
 */
export class cameraApi extends PerspectiveCamera {

    constructor(fov = DEFAULT_FOV, aspect = window.innerWidth / window.innerHeight, near = DEFAULT_NEAR, far = DEFAULT_FAR, options = {}) {
        super(fov, aspect, near, far);
        
        /**
         * 轨道控制器实例
         * @type {Object|null}
         */
        this.controls = null;
        
        /**
         * 相机限制配置
         * @type {Object}
         * @property {number} minDistance - 最小距离 
         * @property {number} maxDistance - 最大距离
         * @property {number} minPolarAngle - 最小垂直角度
         * @property {number} maxPolarAngle - 最大垂直角度
         */
        this.limits = {
            minDistance: DEFAULT_MIN_DISTANCE,
            maxDistance: DEFAULT_MAX_DISTANCE,
            minPolarAngle: DEFAULT_MIN_POLAR_ANGLE,
            maxPolarAngle: DEFAULT_MAX_POLAR_ANGLE
        };
        
        this.target = new Vector3(0, 0, 0);
        
        // 应用选项
        if (options) {
            this.setLimits(options);
        }
    }
    
    setControls(controls) {
        this.controls = controls;
        
        // 确保控制器的目标点设置为世界坐标原点
        if (this.controls && this.target.equals(new Vector3(0, 0, 0))) {
            this.controls.target.set(0, 0, 0);
        } else if (this.controls) {
            this.controls.target.copy(this.target);
        }
        
        this.applyLimits();
        return this;
    }
    
    /**
     * 设置限制
     */
    setLimits(options) {
        if (options.minDistance !== undefined) this.limits.minDistance = options.minDistance;
        if (options.maxDistance !== undefined) this.limits.maxDistance = options.maxDistance;
        if (options.minPolarAngle !== undefined) this.limits.minPolarAngle = options.minPolarAngle;
        if (options.maxPolarAngle !== undefined) this.limits.maxPolarAngle = options.maxPolarAngle;
        
        this.applyLimits();
        return this;
    }
    
    /**
     * 设置最小垂直角度
     */
    setMinPolarAngle(value) {
        this.limits.minPolarAngle = value;
        if (this.controls) {
            this.controls.minPolarAngle = value;
            this.controls.update(); //更新控制器
        }
        return this;
    }
    /**
     * 设置最大垂直角度（弧度）
     */
    setMaxPolarAngle(value) {
        this.limits.maxPolarAngle = value;
        if (this.controls) {
            this.controls.maxPolarAngle = value;
            this.controls.update();
        }
        return this;
    }
    /**
     * 设置最小距离
     */
    setMinDistance(value) {
        this.limits.minDistance = value;
        if (this.controls) {
            this.controls.minDistance = value;
            this.controls.update();
        }
        return this;
    }
    /**
     * 设置最大距离
     */
    setMaxDistance(value) {
        this.limits.maxDistance = value;
        if (this.controls) {
            this.controls.maxDistance = value;
            this.controls.update();
        }
        return this;
    }
    
    /**
     * 获取当前所有限制
     */
    getLimits() {
        return { ...this.limits };
    }
    
    /**
     * 应用限制到控制器
     */
    applyLimits() {
        if (!this.controls) return;
        this.controls.minDistance = this.limits.minDistance;
        this.controls.maxDistance = this.limits.maxDistance;
        this.controls.minPolarAngle = this.limits.minPolarAngle;
        this.controls.maxPolarAngle = this.limits.maxPolarAngle;
        this.controls.update();
    }
    
    /**
     * 设置相机位置
     */
    setPosition(x, y, z, smooth = false) {
        if (smooth && this.controls) {
            // 使用控制器的damping实现平滑
            const oldPos = this.position.clone();
            this.position.set(x, y, z);
            this.controls.update();
            this.position.copy(oldPos);
            this.controls.enableDamping = true;
            this.controls.dampingFactor = DEFAULT_DAMPING_FACTOR;
        } else {
            this.position.set(x, y, z);
            if (this.controls) this.controls.update();
        }
        return this;
    }
    
    /**
     * 设置相机目标
     */
    setTarget(x, y, z, smooth = false) {
        this.target.set(x, y, z);
        
        if (!this.controls) {
            this.lookAt(this.target);
            return this;
        }
        
        if (smooth) {
            this.controls.enableDamping = true;
            this.controls.dampingFactor = SMOOTH_DAMPING_FACTOR;
        }
        
        this.controls.target.copy(this.target);
        this.controls.update();
        return this;
    }
    
    /**
     * 获取相机位置
     */
    getPosition() {
        return this.position.clone();
    }
    
    /**
     * 获取相机目标点
     */
    getTarget() {
        if (this.controls) {
            return this.controls.target.clone();
        }
        return this.target.clone();
    }
    
    /**
     * 获取相机到目标的距离
     */
    getDistance() {
        if (this.controls) {
            return this.controls.getDistance();
        }
        return this.position.distanceTo(this.target);
    }
    
    /**
     * 获取相机当前垂直角度
     */
    getPolarAngle() {
        if (this.controls) {
            return this.controls.getPolarAngle();
        }
        
        // 计算垂直角度
        const direction = new Vector3(0, 0, -1).applyQuaternion(this.quaternion);
        return Math.PI/2 - Math.acos(direction.y);
    }
    
    /**
     * 重置相机
     */
    reset(smooth = false) {
        this.setPosition(0, 5, 10, smooth);
        this.setTarget(0, 0, 0, smooth);
        return this;
    }
    
    /**
     * 调整相机到合适的观察位置
     */
    fitToObject(object, offset = DEFAULT_FIT_OFFSET, smooth = true) {
        if (!object) return this;
        
        // 计算物体边界
        const boundingBox = object.getBoundingBox ? object.getBoundingBox() : null;
        if (!boundingBox && !object.geometry) return this;
        
        const box = boundingBox || new Box3().setFromObject(object);
        const size = new Vector3();
        box.getSize(size);
        
        // 计算物体中心
        const center = new Vector3();
        box.getCenter(center);
        
        // 计算合适的距离
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = this.fov * (Math.PI / 180);
        let distance = maxDim / (2 * Math.tan(fov / 2));
        distance *= offset;
        
        // 设置相机位置和目标
        const direction = new Vector3(0, 0, 1).applyQuaternion(this.quaternion);
        const position = center.clone().add(direction.multiplyScalar(distance));
        
        this.setTarget(center.x, center.y, center.z, smooth);
        this.setPosition(position.x, position.y, position.z, smooth);
        
        return this;
    }
    
    /**
     * 窗口大小调整处理
     */
    handleResize(width, height) {
        this.aspect = width / height;
        this.updateProjectionMatrix();
        return this;
    }
    
    /**
     * 平滑移动相机位置
     */
    smoothMoveTo(targetPosition, targetTarget, duration = 1000) {
        const startPosition = this.position.clone();
        const startTarget = this.target.clone();
        const startTime = Date.now();
        
        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // 使用缓动函数
            const easeProgress = this._easeInOutCubic(progress);
            
            // 插值位置
            this.position.lerpVectors(startPosition, targetPosition, easeProgress);
            this.target.lerpVectors(startTarget, targetTarget, easeProgress);
            
            if (this.controls) {
                this.controls.target.copy(this.target);
            }
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };
        
        animate();
        return this;
    }
    
    /**
     * 缓动函数
     */
    _easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
}

