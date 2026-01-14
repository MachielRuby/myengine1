import {
    Color,
    PMREMGenerator,
    EquirectangularReflectionMapping,
    SphereGeometry,
    ShaderMaterial,
    BackSide,
    Mesh
} from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

/**
 * 场景加载器 - 负责场景环境设置和加载
 */
export class SceneLoader {
    backgroundMesh = null;
    envMap = null;
    
    /**
     * 创建场景加载器
     * @param {Engine} engine 引擎实例
     */
    constructor(engine) {
        this.engine = engine;
        this.scene = engine.mainScene;
        this.renderer = engine.renderer;
    }

    /**
     * 设置纯色背景
     * @param {number|string} color 颜色值
     */
    setColor(color) {
        this._clearBackground();
        if(color !== null && color != undefined)
        {
            this.scene.background = new Color(color);
        }
        return this;
    }

    /**
     * 设置渐变背景
     * @param {number|string} topColor 顶部颜色
     * @param {number|string} bottomColor 底部颜色
     */
    setGradient(topColor, bottomColor) {
        this._clearBackground();
        
        const geometry = new SphereGeometry(500, 32, 16);
        const material = new ShaderMaterial({
            uniforms: {
                topColor: { value: new Color(topColor) },
                bottomColor: { value: new Color(bottomColor) }
            },
            vertexShader: `
                varying vec3 vWorldPosition;
                void main() {
                    vec4 worldPos = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = worldPos.xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 topColor;
                uniform vec3 bottomColor;
                varying vec3 vWorldPosition;
                void main() {
                    float h = normalize(vWorldPosition).y * 0.5 + 0.5;
                    gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0);
                }
            `,
            side: BackSide
        });

        this.backgroundMesh = new Mesh(geometry, material);
        this.scene.add(this.backgroundMesh);
        return this;
    }

    /**
     * 加载HDR环境贴图
     * @param {string} url HDR贴图URL
     * @param {Object} options 选项
     */
    loadHDR(url, { intensity = 100.0, background = true } = {}) {
        if (!this.renderer) return Promise.reject('渲染器未初始化');
        
        const pmremGenerator = new PMREMGenerator(this.renderer);
        pmremGenerator.compileEquirectangularShader();

        return new Promise((resolve, reject) => {
            new RGBELoader()
                .load(url, texture => {
                    // 仅在需要设置背景时清除背景，避免破坏自定义CSS背景
                    if (background) {
                        this._clearBackground();
                    }
                    
                    texture.mapping = EquirectangularReflectionMapping;
                    const envMap = pmremGenerator.fromEquirectangular(texture).texture;
                    
                    // 设置环境贴图
                    this.envMap = envMap;
                    this.scene.environment = envMap;
                    
                    // 如果需要，同时设置为背景
                    if (background) {
                        this.scene.background = envMap;
                    }
                    
                    // 重要：将环境贴图应用到所有材质的 envMap 属性
                    this._applyEnvMapToMaterials(envMap);
                    
                    // 只设置新加载的材质，保持用户已调整的值
                    console.log('HDR环境贴图加载完成，保持现有材质的反射强度设置');
                    
                    texture.dispose();
                    pmremGenerator.dispose();
                    
                    resolve(envMap);
                }, undefined, reject);
        });
    }


    /**
     * 设置HDR环境光强度 (0-100)
     * 通过调整渲染器的toneMappingExposure来控制HDR环境光强度
     * @param {number} value 强度值 (0-100)
     */
    setEnvMapIntensity(value) {
        // 数据验证和规范化
        const numValue = Number(value);
        if (isNaN(numValue)) {
            console.warn("HDR强度值无效,使用默认值100");
            value = 0;
        } else {
            value = Math.max(0, Math.min(200, numValue)); // 限制在0-200范围内
        }
        
        // 线性映射：0-200 -> 0-3.0
        // 0 -> 0 (无曝光)
        // 100 -> 1.5 (标准曝光)  
        // 200 -> 3.0 (最大曝光)
        const exposure = Math.max(0, Math.min(3.0, (value / 200) * 3.0));
        
        // 通过渲染器的toneMappingExposure控制HDR环境光强度
        if (this.engine && this.engine.renderer) {
            this.engine.renderer.toneMappingExposure = exposure;
            console.log(`HDR环境光强度设置为: ${value} (exposure: ${exposure})`);
        } else {
            console.warn("渲染器未初始化,无法设置HDR环境光强度");
        }
        
        return this;
    }

    /**
     * 移除HDR环境贴图
     */
    removeHDR() {
        console.log('移除HDR环境贴图');
        
        // 清除环境贴图
        if (this.envMap) {
            this.envMap.dispose();
            this.envMap = null;
        }
        
        // 清除场景环境和背景
        this.scene.environment = null;
        this.scene.background = null;
        
        // 重置渲染器曝光值为默认值
        if (this.engine && this.engine.renderer) {
            this.engine.renderer.toneMappingExposure = 1.0;
        }
        
        console.log('HDR环境贴图已移除');
        return this;
    }

    /**
     * 旋转环境贴图
     * @param {number} angle 旋转角度
     */
    rotate(angle) {
        if (this.scene.background === this.envMap) {
            this.scene.background.rotation = angle;
        }
        return this;
    }


    /**
     * 清除背景
     * @private
     */
    _clearBackground() {
        if (this.backgroundMesh) {
            this.scene.remove(this.backgroundMesh);
            this.backgroundMesh.geometry?.dispose();
            this.backgroundMesh.material?.dispose();
            this.backgroundMesh = null;
        }
        this.scene.background = null;
    }

    
    /**
     * 将环境贴图应用到所有材质的 envMap 属性
     * @private
     */
    _applyEnvMapToMaterials(envMap) {
        if (!this.scene || !envMap) return;
        
        console.log('开始将环境贴图应用到所有材质...');
        let updatedCount = 0;
        
        this.scene.traverse(object => {
            if (!object.isMesh || !object.material) return;
            
            const materials = Array.isArray(object.material) 
                ? object.material 
                : [object.material];
                
            materials.forEach(material => {
                // 只对支持环境贴图的材质类型设置 envMap
                if (material.isMeshStandardMaterial || 
                    material.isMeshPhysicalMaterial || 
                    material.isMeshPhongMaterial ||
                    material.isMeshLambertMaterial) {
                    
                    // 仅设置环境贴图，不改动材质自身的反射强度参数
                    // 保持现有的 envMapIntensity/reflectivity，不做默认赋值，避免与随后回填/保存造成不一致
                    material.envMap = envMap;
                    
                    material.needsUpdate = true;
                    updatedCount++;
                    
                }
            });
        });
        
    }
    /**
     * 释放资源
     */
    dispose() {
        this._clearBackground();
        
        if (this.envMap) {
            this.envMap.dispose();
            this.envMap = null;
        }
        
    }
}
