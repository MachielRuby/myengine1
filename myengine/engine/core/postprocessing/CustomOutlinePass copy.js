/**
 * 自定义轮廓描边 Pass - 支持多个 mesh 独立边框
 * 继承 OutlinePass，重写 render 方法以实现每个 mesh 的独立边框渲染
 * @author AGan
 */
import {
    OutlinePass,
    AdditiveBlending,
    NoBlending,
    WebGLRenderTarget,
    LinearFilter,
    Frustum,
    Matrix4,
    MeshBasicMaterial,
    Color,
    ShaderMaterial,
    Vector2,
    RGBAFormat
} from "f3d";

export class CustomOutlinePass extends OutlinePass {
    constructor(resolution, scene, camera, selectedObjects) {
        super(resolution, scene, camera, selectedObjects);
        this._tempRenderTarget = null;
        this._accumulationTarget = null;
        this._idRenderTarget = null; // ID渲染目标（用于一次性渲染）
        this._edgeMaterial = null; // 边缘检测材质
        this.downSampleRatio = 1;
        
        // 性能优化参数
        this.enableFrustumCulling = true; // 启用视锥剔除
        this.maxRenderObjects = 50; // 绝对最大渲染对象数量，超过则完全跳过
        this.useIdRendering = true; // 启用ID渲染优化（一次性渲染所有对象）
        this.idRenderingThreshold = 3; // 超过此数量使用ID渲染
    }

    render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
        if (this.selectedObjects.length === 0) {
            return;
        }

        const pixelRatio = renderer.getPixelRatio?.() ?? 1;
        const actualWidth = readBuffer.width || (this.resolution.x * pixelRatio);
        const actualHeight = readBuffer.height || (this.resolution.y * pixelRatio);
        
        if (Math.abs(this.resolution.x - actualWidth) > 1 || Math.abs(this.resolution.y - actualHeight) > 1) {
            this.resolution.set(actualWidth, actualHeight);
            this.setSize(actualWidth, actualHeight);
        }

        // 单个对象直接渲染
        if (this.selectedObjects.length === 1) {
            super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
            return;
        }
        
        // 性能优化：视锥剔除，过滤掉不在相机视野内的对象
        let visibleObjects = this.selectedObjects;
        if (this.enableFrustumCulling && this.camera) {
            visibleObjects = this._filterVisibleObjects(this.selectedObjects);
            if (visibleObjects.length === 0) {
                return;
            }
            if (visibleObjects.length === 1) {
                this.selectedObjects = visibleObjects;
                super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
                this.selectedObjects = this.selectedObjects; // 恢复原始数组引用
                return;
            }
        }
        
        // 性能保护：对象数量过多时完全跳过渲染（避免卡死）
        if (visibleObjects.length > this.maxRenderObjects) {
            console.warn(`CustomOutlinePass: 对象数量过多 (${visibleObjects.length}/${this.maxRenderObjects})，跳过渲染以保证性能`);
            return;
        }
        
        // 性能优化：使用ID渲染（一次性渲染所有对象的独立边框）
        if (this.useIdRendering && visibleObjects.length > this.idRenderingThreshold) {
            this._renderWithIdTexture(renderer, writeBuffer, readBuffer, visibleObjects, deltaTime, maskActive);
            return;
        }
        
        // 性能优化：根据对象数量动态调整分辨率
        let renderScale = 1.0;
        if (visibleObjects.length > 20) {
            renderScale = 0.5; // 超过 20 个对象，分辨率减半
        } else if (visibleObjects.length > 10) {
            renderScale = 0.75; // 10-20 个对象，分辨率降到 75%
        }
        
        const scaledWidth = Math.floor(actualWidth * renderScale);
        const scaledHeight = Math.floor(actualHeight * renderScale);

        if (!this._tempRenderTarget ||
            Math.abs(this._tempRenderTarget.width - scaledWidth) > 1 ||
            Math.abs(this._tempRenderTarget.height - scaledHeight) > 1) {
            if (this._tempRenderTarget) {
                this._tempRenderTarget.dispose();
            }
            if (this._accumulationTarget) {
                this._accumulationTarget.dispose();
            }
            
            this._tempRenderTarget = new WebGLRenderTarget(scaledWidth, scaledHeight, {
                depthBuffer: false,
                stencilBuffer: false
            });
            this._tempRenderTarget.texture.name = 'CustomOutlinePass.temp';
            this._tempRenderTarget.texture.generateMipmaps = false;
            this._tempRenderTarget.texture.minFilter = LinearFilter;
            this._tempRenderTarget.texture.magFilter = LinearFilter;
            
            this._accumulationTarget = new WebGLRenderTarget(scaledWidth, scaledHeight, {
                depthBuffer: false,
                stencilBuffer: false
            });
            this._accumulationTarget.texture.name = 'CustomOutlinePass.accum';
            this._accumulationTarget.texture.generateMipmaps = false;
            this._accumulationTarget.texture.minFilter = LinearFilter;
            this._accumulationTarget.texture.magFilter = LinearFilter;
        }

        renderer.getClearColor(this._oldClearColor);
        this.oldClearAlpha = renderer.getClearAlpha();
        const oldAutoClear = renderer.autoClear;
        const oldRenderToScreen = this.renderToScreen;
        const oldCopyBlending = this.materialCopy.blending;

        renderer.autoClear = false;
        if (maskActive) renderer.state.buffers.stencil.setTest(false);

        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(this._accumulationTarget);
        renderer.clear(true, true, true);

        const originalSelectedObjects = this.selectedObjects;
        this.renderToScreen = false;

        // 保持独立边框渲染（性能优化：动态降低分辨率）
        for (let i = 0; i < visibleObjects.length; i++) {
            this.selectedObjects = [visibleObjects[i]];
            
            // 清除临时缓冲区
            renderer.setRenderTarget(this._tempRenderTarget);
            renderer.clear(true, true, true);
            
            // 渲染单个对象的边框（super.render 已包含边缘检测和模糊）
            super.render(renderer, this._tempRenderTarget, readBuffer, deltaTime, false);
            
            // 叠加到累积缓冲区（使用 AdditiveBlending 保证每个边框都可见）
            this._fsQuad.material = this.materialCopy;
            this.copyUniforms['tDiffuse'].value = this._tempRenderTarget.texture;
            this.materialCopy.blending = AdditiveBlending;
            renderer.setRenderTarget(this._accumulationTarget);
            this._fsQuad.render(renderer);
        }

        this.selectedObjects = originalSelectedObjects;

        if (maskActive) renderer.state.buffers.stencil.setTest(true);

        this._fsQuad.material = this.materialCopy;
        this.copyUniforms['tDiffuse'].value = this._accumulationTarget.texture;
        this.materialCopy.blending = AdditiveBlending;
        renderer.setRenderTarget(readBuffer);
        this._fsQuad.render(renderer);

        this.materialCopy.blending = oldCopyBlending;
        this.renderToScreen = oldRenderToScreen;

        if (this.renderToScreen) {
            this._fsQuad.material = this.materialCopy;
            this.copyUniforms['tDiffuse'].value = readBuffer.texture;
            renderer.setRenderTarget(null);
            this._fsQuad.render(renderer);
        }

        renderer.setClearColor(this._oldClearColor, this.oldClearAlpha);
        renderer.autoClear = oldAutoClear;
    }

    /**
     * 视锥剔除：过滤掉相机视野外的对象
     */
    _filterVisibleObjects(objects) {
        if (!this.camera || !objects || objects.length === 0) {
            return objects;
        }
        
        // 对象数量较少时，跳过视锥剔除（直接渲染更快）
        if (objects.length <= 10) {
            return objects.filter(obj => obj && obj.visible !== false);
        }
        
        // Three.js Frustum 用于视锥剔除
        if (!this._frustum) {
            this._frustum = new Frustum();
            this._projScreenMatrix = new Matrix4();
        }
        
        this._projScreenMatrix.multiplyMatrices(
            this.camera.projectionMatrix,
            this.camera.matrixWorldInverse
        );
        this._frustum.setFromProjectionMatrix(this._projScreenMatrix);
        
        const visible = [];
        for (let i = 0; i < objects.length; i++) {
            const obj = objects[i];
            if (!obj || obj.visible === false) continue;
            
            // 快速检查：如果有包围球，使用它（不需要 updateMatrixWorld）
            if (obj.geometry?.boundingSphere?.center) {
                if (this._frustum.intersectsSphere(obj.geometry.boundingSphere)) {
                    visible.push(obj);
                }
            } else if (obj.geometry?.boundingBox) {
                if (this._frustum.intersectsBox(obj.geometry.boundingBox)) {
                    visible.push(obj);
                }
            } else {
                // 没有包围盒/球，保守处理：认为可见
                visible.push(obj);
            }
        }
        
        return visible.length > 0 ? visible : objects.filter(obj => obj && obj.visible !== false);
    }

    /**
     * 为对象生成唯一的ID颜色
     */
    _getIdColor(index, total) {
        // 使用更好的分布算法，确保相邻对象颜色差异明显
        const r = ((index * 127 + 50) % 256) / 255;
        const g = ((index * 73 + 100) % 256) / 255;
        const b = ((index * 199 + 150) % 256) / 255;
        return new Color(r, g, b);
    }

    /**
     * 使用ID渲染优化：一次性渲染所有对象的独立边框
     */
    _renderWithIdTexture(renderer, writeBuffer, readBuffer, visibleObjects, deltaTime, maskActive) {
        const actualWidth = readBuffer.width;
        const actualHeight = readBuffer.height;
        
        // 1. 创建或更新ID渲染目标
        if (!this._idRenderTarget || 
            this._idRenderTarget.width !== actualWidth || 
            this._idRenderTarget.height !== actualHeight) {
            if (this._idRenderTarget) {
                this._idRenderTarget.dispose();
            }
            this._idRenderTarget = new WebGLRenderTarget(actualWidth, actualHeight, {
                minFilter: LinearFilter,
                magFilter: LinearFilter,
                format: RGBAFormat,
                depthBuffer: true,
                stencilBuffer: false
            });
            this._idRenderTarget.texture.name = 'CustomOutlinePass.id';
        }
        
        // 2. 第一遍：渲染对象ID纹理
        const savedMaterials = [];
        const savedVisible = [];
        
        // 隐藏场景中其他对象
        if (this.renderScene) {
            this.renderScene.traverse(obj => {
                if (obj.isMesh && !visibleObjects.includes(obj)) {
                    savedVisible.push({ obj, visible: obj.visible });
                    obj.visible = false;
                }
            });
        }
        
        // 为每个对象分配唯一颜色ID
        for (let i = 0; i < visibleObjects.length; i++) {
            const obj = visibleObjects[i];
            savedMaterials.push(obj.material);
            
            // 创建ID材质（纯色）
            obj.material = new MeshBasicMaterial({
                color: this._getIdColor(i, visibleObjects.length),
                side: obj.material?.side || 0
            });
        }
        
        // 渲染ID纹理
        renderer.setRenderTarget(this._idRenderTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(this.renderScene, this.renderCamera);
        
        // 恢复原始材质
        for (let i = 0; i < visibleObjects.length; i++) {
            if (visibleObjects[i].material && visibleObjects[i].material.dispose) {
                visibleObjects[i].material.dispose();
            }
            visibleObjects[i].material = savedMaterials[i];
        }
        
        // 恢复其他对象的可见性
        for (const item of savedVisible) {
            item.obj.visible = item.visible;
        }
        
        // 3. 第二遍：基于ID纹理检测边缘并渲染边框
        this._detectEdgesFromIdTexture(renderer, writeBuffer, readBuffer);
    }

    /**
     * 基于ID纹理检测边缘
     */
    _detectEdgesFromIdTexture(renderer, writeBuffer, readBuffer) {
        const resolution = new Vector2(1 / readBuffer.width, 1 / readBuffer.height);
        
        // 创建边缘检测shader
        if (!this._edgeMaterial) {
            this._edgeMaterial = new ShaderMaterial({
                uniforms: {
                    tDiffuse: { value: null },
                    tId: { value: null },
                    resolution: { value: resolution },
                    edgeColor: { value: this.visibleEdgeColor },
                    edgeStrength: { value: this.edgeStrength },
                    edgeGlow: { value: this.edgeGlow },
                    edgeThickness: { value: this.edgeThickness }
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform sampler2D tDiffuse;
                    uniform sampler2D tId;
                    uniform vec2 resolution;
                    uniform vec3 edgeColor;
                    uniform float edgeStrength;
                    uniform float edgeGlow;
                    uniform float edgeThickness;
                    varying vec2 vUv;
                    
                    void main() {
                        vec4 center = texture2D(tId, vUv);
                        
                        // 如果中心像素是背景色（黑色），不绘制边框
                        if (length(center.rgb) < 0.01) {
                            gl_FragColor = texture2D(tDiffuse, vUv);
                            return;
                        }
                        
                        // Sobel边缘检测（检测ID颜色变化）
                        float edge = 0.0;
                        float thickness = edgeThickness * 2.0;
                        
                        // 采样周围8个像素
                        for (float y = -1.0; y <= 1.0; y += 1.0) {
                            for (float x = -1.0; x <= 1.0; x += 1.0) {
                                if (x == 0.0 && y == 0.0) continue;
                                
                                vec2 offset = vec2(x, y) * resolution * thickness;
                                vec4 neighbor = texture2D(tId, vUv + offset);
                                
                                // 计算颜色差异（不同ID或背景 = 边缘）
                                float diff = length(center.rgb - neighbor.rgb);
                                edge += diff;
                            }
                        }
                        
                        edge = edge * edgeStrength * 0.5;
                        edge = clamp(edge, 0.0, 1.0);
                        
                        // 边缘发光效果
                        edge = pow(edge, 1.0 - edgeGlow * 0.5);
                        
                        // 原始颜色 + 边框
                        vec4 baseColor = texture2D(tDiffuse, vUv);
                        vec3 finalColor = mix(baseColor.rgb, edgeColor, edge);
                        
                        gl_FragColor = vec4(finalColor, baseColor.a);
                    }
                `
            });
        } else {
            // 更新uniform值
            this._edgeMaterial.uniforms.resolution.value.copy(resolution);
            this._edgeMaterial.uniforms.edgeColor.value.copy(this.visibleEdgeColor);
            this._edgeMaterial.uniforms.edgeStrength.value = this.edgeStrength;
            this._edgeMaterial.uniforms.edgeGlow.value = this.edgeGlow;
            this._edgeMaterial.uniforms.edgeThickness.value = this.edgeThickness;
        }
        
        this._edgeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
        this._edgeMaterial.uniforms.tId.value = this._idRenderTarget.texture;
        
        this._fsQuad.material = this._edgeMaterial;
        
        if (this.renderToScreen) {
            renderer.setRenderTarget(null);
        } else {
            renderer.setRenderTarget(writeBuffer);
        }
        
        this._fsQuad.render(renderer);
    }

    setSize(width, height) {
        this.resolution.set(width, height);
        super.setSize(width, height);
        
        if (this._tempRenderTarget) {
            this._tempRenderTarget.setSize(width, height);
        }
        if (this._accumulationTarget) {
            this._accumulationTarget.setSize(width, height);
        }
        if (this._idRenderTarget) {
            this._idRenderTarget.setSize(width, height);
        }
    }

    dispose() {
        super.dispose();
        if (this._tempRenderTarget) {
            this._tempRenderTarget.dispose();
            this._tempRenderTarget = null;
        }
        if (this._accumulationTarget) {
            this._accumulationTarget.dispose();
            this._accumulationTarget = null;
        }
        if (this._idRenderTarget) {
            this._idRenderTarget.dispose();
            this._idRenderTarget = null;
        }
        if (this._edgeMaterial) {
            this._edgeMaterial.dispose();
            this._edgeMaterial = null;
        }
    }
}

