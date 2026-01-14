/**
 * 高亮控制器 - 统一管理所有后处理高亮效果
 * @author AGan
 */
import {
    Vector2,
    Color,
    WebGLRenderTarget,
    HalfFloatType
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { CustomOutlinePass } from "../core/postprocessing/CustomOutlinePass.js";

export class HighlightController {
    constructor(engine) {
        this.engine = engine;
        this.scene = engine?.mainScene;
        this.camera = engine?.camera;

        this._composer = null;
        this._renderPass = null;
        this._composerInitialized = false;
        this._fxaaPass = null;

        this._outlinePassHotspot = null;
        this._outlinePassWhite = null;
        this._outlinePassRed = null;
        this._outlinePassHover = null;

        this._breathingTime = 0;
    }

    _init() {
        if (!this.engine?.renderer || !this.engine?.camera) return;
        const scene = this.engine?.mainScene;
        if (!scene) return;
        if (this._composerInitialized) return;

        const pixelRatio = this.engine.renderer.getPixelRatio?.() ?? window.devicePixelRatio ?? 1;
        const isWebGL2 = this.engine.renderer.capabilities?.isWebGL2;
        
        let useMSAA = false;
        const size = new Vector2();
        this.engine.renderer.getSize(size);
        
        if (isWebGL2) {
            const target = new WebGLRenderTarget(size.width * pixelRatio, size.height * pixelRatio, { 
                samples: 4,
                type: HalfFloatType
            });
            this._composer = new EffectComposer(this.engine.renderer, target);
            useMSAA = true;
        } else {
            const target = new WebGLRenderTarget(size.width * pixelRatio, size.height * pixelRatio, { 
                type: HalfFloatType
            });
            this._composer = new EffectComposer(this.engine.renderer, target);
        }
        
        this._composer.setPixelRatio(pixelRatio);
        this._composer.setSize(size.width, size.height);

        this._renderPass = new RenderPass(scene, this.engine.camera);
        this._composer.addPass(this._renderPass);

        this._outlinePassHotspot = this._createOutlinePass(0xff6600, 4, 1, 1, 4);
        this._composer.addPass(this._outlinePassHotspot);

        this._outlinePassWhite = this._createOutlinePass(0xffffff, 4, 1, 1, 4);
        this._composer.addPass(this._outlinePassWhite);

        this._outlinePassRed = this._createOutlinePass(0xff2222, 4, 1, 1, 4);
        this._composer.addPass(this._outlinePassRed);

        this._outlinePassHover = this._createOutlinePass(0xffffff, 4, 1, 1, 4);
        this._composer.addPass(this._outlinePassHover);

        try {
            if (!useMSAA) {
                this._fxaaPass = new FXAAPass();
                this._composer.addPass(this._fxaaPass);
            }
            
            const outputPass = new OutputPass();
            this._composer.addPass(outputPass);
            this._outputPassIndex = this._composer.passes.length - 1;
        } catch (e) {
            console.warn("HighlightController: 无法添加 FXAA/OutputPass:", e);
            this._outputPassIndex = -1;
        }

        this._composerInitialized = true;
    }

    _createOutlinePass(colorHex, edgeStrength = 4, edgeGlow = 1, edgeThickness = 1, pulsePeriod = 4) {
        const size = new Vector2();
        this.engine.renderer.getSize(size);
        const scene = this.engine?.mainScene;
        if (!scene) return null;
        const pixelRatio = this.engine.renderer.getPixelRatio?.() ?? window.devicePixelRatio ?? 1;
        const resolution = new Vector2(size.x * pixelRatio, size.y * pixelRatio);
        const pass = new CustomOutlinePass(resolution, scene, this.engine.camera);
        pass.downSampleRatio = 2;
        
        const color = new Color(colorHex);
        pass.edgeStrength = edgeStrength;
        pass.edgeGlow = edgeGlow;
        pass.edgeThickness = edgeThickness;
        pass.pulsePeriod = pulsePeriod;
        pass.usePatternTexture = false;
        pass.visibleEdgeColor.set(color);
        pass.hiddenEdgeColor.set(color);
        pass.selectedObjects = [];
        
        return pass;
    }

    getComposer() {
        if (!this._composerInitialized) return null;
        
        const hasHotspot = this._outlinePassHotspot?.selectedObjects?.length > 0;
        const hasWhite = this._outlinePassWhite?.selectedObjects?.length > 0;
        const hasRed = this._outlinePassRed?.selectedObjects?.length > 0;
        const hasHover = this._outlinePassHover?.selectedObjects?.length > 0;
        
        // 动态启用/禁用Pass，避免空Pass影响渲染
        if (this._outlinePassHotspot) {
            this._outlinePassHotspot.enabled = hasHotspot;
        }
        if (this._outlinePassWhite) {
            this._outlinePassWhite.enabled = hasWhite;
        }
        if (this._outlinePassRed) {
            this._outlinePassRed.enabled = hasRed;
        }
        if (this._outlinePassHover) {
            this._outlinePassHover.enabled = hasHover;
        }
        return this._composer;
    }

    highlight(objects, options = {}) {
        this._init();
        if (!this._outlinePassHotspot) return false;

        const list = Array.isArray(objects) ? objects : [objects];
        const selected = list.filter(o => o && o.isObject3D);
        if (!selected.length) return false;

        // 只在 options 有值时更新参数，否则使用创建时的默认值
        if (options.edgeStrength != null) {
            this._outlinePassHotspot.edgeStrength = options.edgeStrength;
        }
        if (options.edgeGlow != null) {
            this._outlinePassHotspot.edgeGlow = options.edgeGlow;
        }
        if (options.edgeThickness != null) {
            this._outlinePassHotspot.edgeThickness = options.edgeThickness;
        }
        if (options.pulsePeriod != null) {
            this._outlinePassHotspot.pulsePeriod = options.pulsePeriod;
        }
        if (options.color != null) {
            const c = new Color(options.color);
            this._outlinePassHotspot.visibleEdgeColor.copy(c);
            this._outlinePassHotspot.hiddenEdgeColor.copy(c);
        }

        this._outlinePassHotspot.selectedObjects = selected;
        return true;
    }

    /**
     * 根据语义类型高亮物体，实现业务逻辑与视觉表现的解耦
     * @param {Object3D|Array} objects 需要高亮的物体或物体数组
     * @param {Object} options 选项 { type: 'hotspot'|'animation'|'error', ...其他通道参数 }
     * @returns {boolean} 是否成功
     */
    highlightByType(objects, options = {}) {
        const type = options.type || 'hotspot';
        const { type: _, ...restOptions } = options;
        switch (type) {
            case 'animation':
                return this.highlightAnimationMeshesWhite(objects, restOptions);
            case 'error':
                return this.highlightAnimationMeshesRed(objects, restOptions);
            case 'hotspot':
            default:
                return this.highlight(objects, options);
        }
    }

    clear(objects = null) {
        const passes = [
            this._outlinePassHotspot,
            this._outlinePassWhite,
            this._outlinePassRed,
            this._outlinePassHover
        ];

        const targetSet = objects ? new Set(Array.isArray(objects) ? objects : [objects]) : null;

        passes.forEach(pass => {
            if (!pass) return;
            if (!targetSet) {
                pass.selectedObjects = [];
            } else {
                pass.selectedObjects = pass.selectedObjects.filter(o => !targetSet.has(o));
            }
        });
    }


    /**
     * 清除所有高亮通道的所有对象
     */
    clearAll() {
        this.clear(null);
        this._breathingTime = 0;
    }
    
    /**
     * 清除所有动画相关的高亮
     */
    clearAnimationHighlights() {
        if (this._outlinePassWhite) {
            this._outlinePassWhite.selectedObjects = [];
        }
        if (this._outlinePassRed) {
            this._outlinePassRed.selectedObjects = [];
        }
    }

    /**
     * 高亮热点：统一使用描边效果，Sprite 和 Mesh 热点都沿着真实轮廓描边
     * @param {Object} hotspot 热点对象
     * @param {Object} options 高亮选项
     * @returns {boolean} 是否成功
     */
    highlightHotspot(hotspot, options = {}) {
        if (!hotspot?.sprite) return false;

        return this.highlight(hotspot.sprite, {
            color: options.color || 0xff6600,
            edgeStrength: options.edgeStrength ?? 4,
            edgeGlow: options.edgeGlow ?? 1,
            edgeThickness: options.edgeThickness ?? 1,
            pulsePeriod: options.pulsePeriod ?? 4
        });
    }

    /**
     * 清除热点高亮
     * @param {Object} hotspot 热点对象
     */
    clearHotspot(hotspot) {
        if (!hotspot?.sprite) return;
        this.clear(hotspot.sprite);
    }

    highlightAnimationMeshesWhite(meshes, options = {}) {
        this._init();
        if (!this._composer) return false;

        const list = Array.isArray(meshes) ? meshes : [meshes];
        
        return this._processHighlightAnimationMeshesWhite(list, options);
    }
    
    _processHighlightAnimationMeshesWhite(list, options) {
        return this._processHighlightAnimationMeshes(list, options, '_outlinePassWhite', 0xffffff);
    }

    highlightAnimationMeshesRed(meshes, options = {}) {
        this._init();
        if (!this._composer) return false;

        const list = Array.isArray(meshes) ? meshes : [meshes];
        
        return this._processHighlightAnimationMeshesRed(list, options);
    }

    _processHighlightAnimationMeshesRed(list, options) {
        return this._processHighlightAnimationMeshes(list, options, '_outlinePassRed', 0xff0000);
    }

    _processHighlightAnimationMeshes(list, options, passName, defaultColorHex) {
        // 确保初始化
        if (!this[passName]) {
            this._init();
        }
        if (!this[passName]) return false;

        let validMeshes = this._extractValidMeshes(list);
        
        if (validMeshes.length === 0) {
            this[passName].selectedObjects = [];
            return false;
        }


        const colorHex = typeof options.color === 'string' ? 
            parseInt(options.color.replace('#', ''), 16) : (options.color ?? defaultColorHex);
        const color = new Color(colorHex);
        
        const pass = this[passName];
        pass.visibleEdgeColor.set(color);
        pass.hiddenEdgeColor.set(color);
        
        pass.edgeStrength = options.edgeStrength ?? 4;
        pass.edgeGlow = options.edgeGlow ?? 1;
        pass.edgeThickness = options.edgeThickness ?? 1;
        pass.pulsePeriod = options.pulsePeriod ?? 4;
        pass.selectedObjects = validMeshes;
        
        return true;
    }

    _extractValidMeshes(objects) {
        const list = Array.isArray(objects) ? objects : [objects];
        const selected = [];
        const processed = new Set();
        let count = 0;
        
        // 性能保护：最大处理数量限制
        const MAX_MESHES = 100;
        
        for (const obj of list) {
            if (!obj) continue;
            // 过滤不可见物体，这对于性能至关重要
            if (obj.visible === false) continue;
            
            // 达到最大数量时停止收集
            if (count >= MAX_MESHES) {
                console.warn(`HighlightController: 达到最大高亮对象数量限制 (${MAX_MESHES})，部分对象将不会高亮`);
                break;
            }
            
            if (obj.isMesh) {
                const geom = obj.geometry;
                if (geom?.attributes?.position && !processed.has(obj)) {
                    processed.add(obj);
                    selected.push(obj);
                    count++;
                }
            } else if (obj.isObject3D) {
                obj.traverse((child) => {
                    // 同样过滤子物体的可见性
                    if (child.visible === false) return;
                    
                    // 达到最大数量时停止
                    if (count >= MAX_MESHES) return;
                    
                    if (child.isMesh) {
                        const geom = child.geometry;
                        if (geom?.attributes?.position && 
                            geom.attributes.position.count > 0 &&
                            !processed.has(child)) {
                            processed.add(child);
                            selected.push(child);
                            count++;
                        }
                    }
                });
            }
        }
        
        return selected;
    }

    /**
     * 查找OutputPass在composer中的索引位置
     * @private
     */
    _findOutputPassIndex() {
        if (!this._composer) return -1;
        
        for (let i = 0; i < this._composer.passes.length; i++) {
            if (this._composer.passes[i]?.constructor?.name === 'OutputPass') {
                return i;
            }
        }
        return -1;
    }

    setHoverObject(object, color = null) {
        this._init();
        if (!this._outlinePassHover) return;
        
        if (object && (object.isObject3D || object.isMesh)) {
            this._outlinePassHover.selectedObjects = [object];
            
            this._outlinePassHover.edgeStrength = 4;
            this._outlinePassHover.edgeGlow = 1;
            this._outlinePassHover.edgeThickness = 1;
            this._outlinePassHover.pulsePeriod = 4;
            this._outlinePassHover.downSampleRatio = 2;
            
            if (color != null) {
                const c = new Color(color);
                this._outlinePassHover.visibleEdgeColor.copy(c);
                this._outlinePassHover.hiddenEdgeColor.copy(c);
            } else {
                this._outlinePassHover.visibleEdgeColor.set(0xffffff);
                this._outlinePassHover.hiddenEdgeColor.set(0xffffff);
            }
        } else {
            this._outlinePassHover.selectedObjects = [];
        }
    }

    setSize(width, height) {
        if (!this._composerInitialized) return;

        const pixelRatio = this.engine.renderer.getPixelRatio?.() ?? window.devicePixelRatio ?? 1;
        this._composer.setPixelRatio(pixelRatio);
        this._composer.setSize(width, height);
        
        // 更新 FXAA 分辨率
        if (this._fxaaPass && this._fxaaPass.material && this._fxaaPass.material.uniforms) {
            this._fxaaPass.material.uniforms['resolution'].value.x = 1 / (width * pixelRatio);
            this._fxaaPass.material.uniforms['resolution'].value.y = 1 / (height * pixelRatio);
        }
    }

    dispose() {
        this._fxaaPass = null;
        
        if (this._composer) {
            try { this._composer.dispose(); } catch (e) {}
        }
        this._composer = null;
        this._renderPass = null;
        this._outlinePassHotspot = null;
        this._outlinePassWhite = null;
        this._outlinePassRed = null;
        this._outlinePassHover = null;
        this._composerInitialized = false;
    }
}