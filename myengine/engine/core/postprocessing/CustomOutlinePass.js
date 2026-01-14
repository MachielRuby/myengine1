/**
 * CustomOutlinePass - 多对象独立边框渲染
 * @version 1.0.0
 * @author AGan
 */
import {
    AdditiveBlending,
    WebGLRenderTarget,
    LinearFilter,
    Vector3,
    Matrix4,
    Frustum,
    Box3
} from "three";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";

// 高亮边框重写Pass，支持多对象独立边框渲染
export class CustomOutlinePass extends OutlinePass {
    constructor(resolution, scene, camera, selectedObjects) {
        super(resolution, scene, camera, selectedObjects);
        this._tempRenderTarget = null;
        this._accumulationTarget = null;
        this.downSampleRatio = 1;

        this._frustum = new Frustum();
        this._projScreenMatrix = new Matrix4();
        this._tempBox = new Box3();
        this._corners = Array.from({length: 8}, () => new Vector3());
        
        this._cachedBatches = null;
        this._cachedObjectsHash = null;
        this._cacheFrameCount = 0;
        
        this._overlapThreshold = 0.30;
        this._maxBatches = 6;
        this._edgePadding = 8;
        this.version = '2.0.0';
    }

    _getObjectsHash(objects) {
        let hash = objects.length.toString();
        for (let i = 0; i < Math.min(objects.length, 10); i++) {
            hash += '_' + (objects[i].uuid || i);
        }
        return hash;
    }

    _isObjectVisible(object) {
        if (!object.visible) return false;
        if (object.isMesh && object.geometry) {
            if (!object.geometry.boundingSphere) {
                object.geometry.computeBoundingSphere();
            }
            if (object.geometry.boundingSphere) {
                return this._frustum.intersectsObject(object);
            }
        }
        return true;
    }

    _getWorldBox(object) {
        if (!object.geometry) return null;
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        
        this._tempBox.copy(object.geometry.boundingBox);
        this._tempBox.applyMatrix4(object.matrixWorld);
        
        return {
            min: { x: this._tempBox.min.x, y: this._tempBox.min.y, z: this._tempBox.min.z },
            max: { x: this._tempBox.max.x, y: this._tempBox.max.y, z: this._tempBox.max.z }
        };
    }

    _getBoxSurfaceDistance(boxA, boxB) {
        const gapX = Math.max(0, Math.max(boxA.min.x - boxB.max.x, boxB.min.x - boxA.max.x));
        const gapY = Math.max(0, Math.max(boxA.min.y - boxB.max.y, boxB.min.y - boxA.max.y));
        const gapZ = Math.max(0, Math.max(boxA.min.z - boxB.max.z, boxB.min.z - boxA.max.z));
        
        if (gapX > 0 && gapY > 0 && gapZ > 0) {
            return Math.sqrt(gapX * gapX + gapY * gapY + gapZ * gapZ);
        }
        if (gapX === 0 && gapY === 0 && gapZ === 0) return 0;
        
        return Math.sqrt(gapX * gapX + gapY * gapY + gapZ * gapZ);
    }
    
    /**
     * 冲突风险评估：距离风险(80%) + 包含检测 + 尺寸差异(20%)
     * @returns {number} 0~1，越高越需要分开渲染
     */
    _getConflictRisk(boxA, boxB) {
        const diagA = Math.sqrt(
            (boxA.max.x - boxA.min.x) ** 2 +
            (boxA.max.y - boxA.min.y) ** 2 +
            (boxA.max.z - boxA.min.z) ** 2
        );
        const diagB = Math.sqrt(
            (boxB.max.x - boxB.min.x) ** 2 +
            (boxB.max.y - boxB.min.y) ** 2 +
            (boxB.max.z - boxB.min.z) ** 2
        );
        
        const smallerDiag = Math.min(diagA, diagB);
        const largerDiag = Math.max(diagA, diagB);
        const surfaceDist = this._getBoxSurfaceDistance(boxA, boxB);
        
        // 距离风险：表面距离 < 小物体尺寸50%时风险高
        const criticalDistance = smallerDiag * 0.5;
        const distanceRisk = Math.max(0, 1 - surfaceDist / criticalDistance);
        
        const isAInsideB = 
            boxA.min.x >= boxB.min.x && boxA.max.x <= boxB.max.x &&
            boxA.min.y >= boxB.min.y && boxA.max.y <= boxB.max.y &&
            boxA.min.z >= boxB.min.z && boxA.max.z <= boxB.max.z;
        const isBInsideA = 
            boxB.min.x >= boxA.min.x && boxB.max.x <= boxA.max.x &&
            boxB.min.y >= boxA.min.y && boxB.max.y <= boxA.max.y &&
            boxB.min.z >= boxA.min.z && boxB.max.z <= boxA.max.z;
        
        if (isAInsideB || isBInsideA) {
            return Math.max(0.9, distanceRisk);
        }
        
        // 尺寸差异风险
        const sizeRatio = smallerDiag / largerDiag;
        const sizeRisk = (1 - sizeRatio) * 0.5;
        
        return distanceRisk * 0.8 + sizeRisk * 0.2;
    }
    
    _getBoxVolume(box) {
        return (box.max.x - box.min.x) * (box.max.y - box.min.y) * (box.max.z - box.min.z);
    }
    
    /**
     * DSatur 图着色算法：将冲突的 mesh 分配到不同批次
     * 优先级：饱和度 > 度数 > 风险总和
     */
    _computeBatches(visibleInfo) {
        const n = visibleInfo.length;
        if (n === 0) return [];
        if (n === 1) return [{ objects: [visibleInfo[0].object] }];
        
        const RISK_THRESHOLD = 0.15;
        const conflicts = [];
        
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const risk = this._getConflictRisk(visibleInfo[i].box, visibleInfo[j].box);
                if (risk > RISK_THRESHOLD) {
                    conflicts.push({ i, j, risk });
                }
            }
        }
        
        if (conflicts.length > 0 && (!this._lastLogTime || Date.now() - this._lastLogTime > 1000)) {
            const topConflicts = conflicts.slice(0, 3).map(c => 
                `[${c.i}-${c.j}]: ${c.risk.toFixed(2)}`
            ).join(', ');
            console.log(`  High-risk pairs (${conflicts.length}): ${topConflicts}`);
        }
        
        conflicts.sort((a, b) => b.risk - a.risk);
        
        // 构建冲突图
        const adjacency = new Array(n);
        for (let i = 0; i < n; i++) adjacency[i] = new Map();
        for (const { i, j, risk } of conflicts) {
            adjacency[i].set(j, risk);
            adjacency[j].set(i, risk);
        }
        
        // DSatur 着色
        const colors = new Array(n).fill(-1);
        const degree = adjacency.map(adj => adj.size);
        const saturation = new Array(n).fill(0);
        let colored = 0;
        
        while (colored < n) {
            let bestIdx = -1, bestSat = -1, bestDeg = -1, bestRisk = -1;
            
            for (let i = 0; i < n; i++) {
                if (colors[i] === -1) {
                    const totalRisk = Array.from(adjacency[i].values()).reduce((sum, r) => sum + r, 0);
                    if (saturation[i] > bestSat ||
                        (saturation[i] === bestSat && degree[i] > bestDeg) ||
                        (saturation[i] === bestSat && degree[i] === bestDeg && totalRisk > bestRisk)) {
                        bestSat = saturation[i];
                        bestDeg = degree[i];
                        bestRisk = totalRisk;
                        bestIdx = i;
                    }
                }
            }
            
            if (bestIdx === -1) break;
            
            const usedColors = new Set();
            for (const [neighbor] of adjacency[bestIdx]) {
                if (colors[neighbor] !== -1) usedColors.add(colors[neighbor]);
            }
            
            let color = 0;
            while (usedColors.has(color)) {
                color++;
                if (this._maxBatches > 0 && color >= this._maxBatches) {
                    let bestColor = 0, minRiskSum = Infinity;
                    for (let c = 0; c < this._maxBatches; c++) {
                        let riskSum = 0;
                        for (const [neighbor, risk] of adjacency[bestIdx]) {
                            if (colors[neighbor] === c) riskSum += risk;
                        }
                        if (riskSum < minRiskSum) {
                            minRiskSum = riskSum;
                            bestColor = c;
                        }
                    }
                    color = bestColor;
                    break;
                }
            }
            
            colors[bestIdx] = color;
            colored++;
            
            for (const [neighbor] of adjacency[bestIdx]) {
                if (colors[neighbor] === -1) {
                    const neighborColors = new Set();
                    for (const [nn] of adjacency[neighbor]) {
                        if (colors[nn] !== -1) neighborColors.add(colors[nn]);
                    }
                    saturation[neighbor] = neighborColors.size;
                }
            }
        }

        // 按颜色分组
        const maxColor = Math.max(...colors);
        const batches = [];
        for (let c = 0; c <= maxColor; c++) {
            const batch = { objects: [] };
            for (let i = 0; i < n; i++) {
                if (colors[i] === c) batch.objects.push(visibleInfo[i].object);
            }
            if (batch.objects.length > 0) batches.push(batch);
        }
        
        return batches;
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

        if (this.selectedObjects.length === 1) {
            super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
            return;
        }

        if (!this._tempRenderTarget ||
            this._tempRenderTarget.width !== actualWidth ||
            this._tempRenderTarget.height !== actualHeight) {
            if (this._tempRenderTarget) {
                this._tempRenderTarget.dispose();
            }
            if (this._accumulationTarget) {
                this._accumulationTarget.dispose();
            }
            
            this._tempRenderTarget = new WebGLRenderTarget(actualWidth, actualHeight, {
                depthBuffer: false,
                stencilBuffer: false
            });
            this._tempRenderTarget.texture.name = 'CustomOutlinePass.temp';
            this._tempRenderTarget.texture.generateMipmaps = false;
            this._tempRenderTarget.texture.minFilter = LinearFilter;
            this._tempRenderTarget.texture.magFilter = LinearFilter;
            
            this._accumulationTarget = new WebGLRenderTarget(actualWidth, actualHeight, {
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

        const originalSelectedObjects = [...this.selectedObjects];
        this.renderToScreen = false;

        const camera = this.renderCamera || this.camera;
        this._projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

        const currentHash = this._getObjectsHash(originalSelectedObjects);
        this._cacheFrameCount++;
        
        let batches;
        // 缓存策略：物体变化或超过300帧(~5s @60fps)时重新计算
        if (this._cachedBatches && 
            this._cachedObjectsHash === currentHash && 
            this._cacheFrameCount < 300) {
            batches = this._cachedBatches;
        } else {
            const visibleInfo = [];
            for (const obj of originalSelectedObjects) {
                if (this._isObjectVisible(obj)) {
                    const box = this._getWorldBox(obj);
                    if (box) visibleInfo.push({ object: obj, box });
                }
            }

            if (visibleInfo.length === 0) {
                this.selectedObjects = originalSelectedObjects;
                renderer.setClearColor(this._oldClearColor, this.oldClearAlpha);
                renderer.autoClear = oldAutoClear;
                return;
            }

            batches = this._computeBatches(visibleInfo);
            this._cachedBatches = batches;
            this._cachedObjectsHash = currentHash;
            this._cacheFrameCount = 0;
            
            if (!this._lastLogTime || Date.now() - this._lastLogTime > 1000) {
                const batchSizes = batches.map(b => b.objects.length).join('+');
                console.log(`CustomOutlinePass: ${visibleInfo.length} objects → ${batches.length} batches [${batchSizes}]`);
                console.log(`  Max batches: ${this._maxBatches || '∞'}, Risk threshold: 0.15`);
                this._lastLogTime = Date.now();
            }
        }
        for (const batch of batches) {
            this.selectedObjects = batch.objects;
            
            renderer.setClearColor(0x000000, 0);
            renderer.setRenderTarget(this._tempRenderTarget);
            renderer.clear(true, true, true);
            
            super.render(renderer, this._tempRenderTarget, readBuffer, deltaTime, false);
            
            this._fsQuad.material = this.overlayMaterial;
            this.overlayMaterial.uniforms['maskTexture'].value = this.renderTargetMaskBuffer.texture;
            this.overlayMaterial.uniforms['edgeTexture1'].value = this.renderTargetEdgeBuffer1.texture;
            this.overlayMaterial.uniforms['edgeTexture2'].value = this.renderTargetEdgeBuffer2.texture;
            this.overlayMaterial.uniforms['patternTexture'].value = this.patternTexture;
            this.overlayMaterial.uniforms['edgeStrength'].value = this.edgeStrength;
            this.overlayMaterial.uniforms['edgeGlow'].value = this.edgeGlow;
            this.overlayMaterial.uniforms['usePatternTexture'].value = this.usePatternTexture;

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

    setSize(width, height) {
        this.resolution.set(width, height);
        super.setSize(width, height);
        
        if (this._tempRenderTarget) {
            this._tempRenderTarget.setSize(width, height);
        }
        if (this._accumulationTarget) {
            this._accumulationTarget.setSize(width, height);
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
        this._cachedBatches = null;
        this._cachedObjectsHash = null;
        this._corners = null;
    }
    
    // === Public API ===
    
    invalidateCache() {
        this._cachedBatches = null;
        this._cachedObjectsHash = null;
    }
    
    setOverlapThreshold(threshold) {
        this._overlapThreshold = Math.max(0, Math.min(threshold, 1));
        this.invalidateCache();
    }
    
    getOverlapThreshold() {
        return this._overlapThreshold;
    }
    
    setMaxBatches(max) {
        this._maxBatches = Math.max(0, Math.floor(max));
        this.invalidateCache();
    }
    
    getMaxBatches() {
        return this._maxBatches;
    }
    
    getPerformanceStats() {
        return {
            version: this.version,
            batchCount: this._cachedBatches?.length || 0,
            objectCount: this.selectedObjects?.length || 0,
            maxBatches: this._maxBatches,
            riskThreshold: 0.15,
            cacheFrameCount: this._cacheFrameCount,
            cacheMaxFrames: 300
        };
    }
}

