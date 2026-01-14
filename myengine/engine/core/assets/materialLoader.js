/**
 * GLB材质纹理管理器 - 修复版
 * 修复了WebGL错误和纹理加载问题
 * @author GunGod
 */
import * as THREE from "three";

// 常量定义
const MIN_TEXTURE_SIZE = 4; // 最小纹理尺寸
const DEFAULT_ANISOTROPY = 4; // 默认各向异性过滤值
const TEXTURE_QUALITY_SETTINGS = {
    low: { maxSize: 1024, anisotropy: 1 },
    medium: { maxSize: 2048, anisotropy: 4 },
    high: { maxSize: 4096, anisotropy: 8 },
    ultra: { maxSize: 8192, anisotropy: 16 }
};

export class MaterialLoader {
    constructor(engine = null, options = {}) {
        this.engine = engine;
        this.textureLoader = new THREE.TextureLoader();
        this.textureLoader.crossOrigin = 'anonymous';
        this.textureQuality = options.textureQuality || 'medium';  // 默认使用中等质量，减少内存占用
        this.maxTextureSize = this._getMaxTextureSize();
        this.maxAnisotropy = this._getMaxAnisotropy();
        // 服务器材质信息（不依赖全局变量）
        this.serverMaterials = options.serverMaterials || null;
    }

    /**
     * 设置服务器材质信息（用于从外部注入，避免依赖全局变量）
     * @param {Array} serverMaterials - 服务器材质数组
     */
    setServerMaterials(serverMaterials) {
        this.serverMaterials = serverMaterials || null;
    }

    /**
     * 获取最大纹理尺寸
     */
    _getMaxTextureSize() {
        const settings = TEXTURE_QUALITY_SETTINGS[this.textureQuality];
        return settings ? settings.maxSize : TEXTURE_QUALITY_SETTINGS.medium.maxSize;
    }

    /**
     * 获取最大各向异性过滤值
     * @private
     */
    _getMaxAnisotropy() {
        const settings = TEXTURE_QUALITY_SETTINGS[this.textureQuality];
        return settings ? settings.anisotropy : DEFAULT_ANISOTROPY;
    }


    /**
     * 导出模型的完整材质数据（用于数据库存储）
     * @param {Object} model - Three.js 模型对象
     * @param {Array} serverMaterials - 可选的服务器材质数组（用于获取服务器UUID，如果不传则使用实例中保存的值）
     */
    async exportMaterialsData(model, serverMaterials = null) {
        // 优先级：传入参数 > 实例属性
        const serverMats = serverMaterials !== null ? serverMaterials : this.serverMaterials;
        const materials = this.getMaterials(model, serverMats);
        const exportData = {
            exportTime: new Date().toISOString(),
            materials: []
        };

        for (const materialInfo of materials) {
            const material = materialInfo.material;
            let stableId = materialInfo.originalUuid;
            //服务器有就使用服务器的uuid赋值过来 否则使用threejs内部生成的
            if(serverMats && Array.isArray(serverMats) && serverMats.length > 0) 
            {
                const serverMaterial = serverMats.find(m => m.materialName === materialInfo.name);
                if(serverMaterial?.materialUuid) {
                    stableId = serverMaterial.materialUuid;
                }
            }
            const materialData = {
                uuid: stableId,  
                name: material.name,
                type: material.type,
                properties: this._serializeMaterialProperties(material),
                textures: await this._serializeTextures(material),
                meshBindings: materialInfo.meshes.map(m => ({
                    meshUuid: this._generateStableMeshId(m.mesh),  //生成稳定的网格ID
                    meshName: m.meshName,
                    materialIndex: m.materialIndex
                }))
            };
            
            exportData.materials.push(materialData);
        }

        return exportData;
    }

    /**
     * 生成稳定的材质ID
     */
    _generateStableMaterialId(material, modelId, _index, meshSignature = null) {
        const baseParts = [
            modelId || 'unknown_model',
            material?.name || 'unnamed',
            material?.type || 'Unknown'
        ];
        if (Array.isArray(meshSignature) && meshSignature.length > 0) {
            const sorted = [...meshSignature].sort();
            baseParts.push(this._hashString(sorted.join('|')));
        }
        return baseParts.join('_').toLowerCase().replace(/\s+/g, '-');
    }

    /**
     * 生成稳定的网格ID
     */
    _generateStableMeshId(mesh) {
        // 基于网格名称和几何体特征生成稳定ID
        const meshName = mesh.name || 'UnnamedMesh';
        const geometryInfo = mesh.geometry ? 
            `${mesh.geometry.attributes.position?.count || 0}_${mesh.geometry.index?.count || 0}` : 
            'nogeometry';
        return `mesh_${this._hashString(meshName + geometryInfo)}`;
    }

    /**
     * 简单字符串哈希函数
     */
    _hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return Math.abs(hash).toString(16);
    }

    /**
     * 通过稳定ID查找网格
     */
    _findMeshByStableId(model, stableId) {
        let foundMesh = null;
        model.traverse((child) => {
            if (child.isMesh && this._generateStableMeshId(child) === stableId) {
                foundMesh = child;
            }
        });
        return foundMesh;
    }
 
    /**
     * 获取模型的所有材质信息
     * @param {Object} model - Three.js 模型对象
     * @param {Array} serverMaterials - 可选的服务器材质数组（用于获取服务器UUID，如果不传则使用实例中保存的值）
     */
    getMaterials(model, serverMaterials = null) {
        // 检查model参数是否有效
        if (!model) {
            console.warn('getMaterials: model参数为null或undefined');
            return [];
        }
        // 优先级：传入参数 > 实例属性
        const serverMats = serverMaterials !== null ? serverMaterials : this.serverMaterials;
        // 用 Map 以 uuid 去重,确保唯一材质
        const materialsMap = new Map();
        let globalMaterialIndex = 0; // 全局材质计数器
        model.traverse(child => {
            if (child.isMesh && child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach((material, localMaterialIndex) => {
                    // 只统计唯一材质
                    if (!materialsMap.has(material.uuid)) {
                        try {
                            const op = typeof material.opacity === 'number' ? material.opacity : 1;
                            if (!material.userData) material.userData = {};
                            // 只在没有设置过时才设置原始透明度
                            if (!material.userData.hasOwnProperty('originalOpacity')) {
                                material.userData.originalOpacity = op;
                            }
                            // 只在没有设置过时才判断是否天然透明
                            if (!material.userData.hasOwnProperty('isNaturallyTransparent')) {
                                material.userData.isNaturallyTransparent = (material.transparent === true) || (op < 1);
                            }
                            
                            const isActuallyTransparent = material.transparent === true && op < 1;
                            if ('depthWrite' in material) {
                                material.depthWrite = isActuallyTransparent ? false : true;
                            }
                            
                            // 确保深度测试开启
                            if ('depthTest' in material) {
                                material.depthTest = true;
                            }
                        } catch (_) {}
                        
                        let materialName = material.name;
                        materialsMap.set(material.uuid, {
                            uuid: '',  
                            originalUuid: material.uuid,  
                            name: materialName,
                            type: material.type,
                            material: material,
                            meshes: [],
                            properties: this._getBasicProperties(material),
                            textures: this._getTextureInfo(material),
                            globalIndex: globalMaterialIndex // 记录全局索引
                        });
                        globalMaterialIndex++; // 只有新材质才增加计数器
                    }
                    // 记录 mesh 绑定关系
                    materialsMap.get(material.uuid).meshes.push({
                        mesh: child,
                        meshUuid: this._generateStableMeshId(child),  // 使用稳定的网格ID
                        originalMeshUuid: child.uuid,  
                        meshName: child.name || `Mesh_${child.uuid.slice(0, 8)}`,
                        materialIndex: localMaterialIndex
                    });
                });
                
                // 设置初始 renderOrder
                this._updateMeshRenderOrder(child.material, child);
            }
        });
        // 绑定收集完毕后，生成真正稳定的UUID并补全默认名称
        const modelId = model.userData?.modelId || model.name || 'default_model';
        const finalized = Array.from(materialsMap.values()).map((materialInfo) => {
            let stableId = materialInfo.originalUuid;
            if(serverMats && Array.isArray(serverMats) && serverMats.length > 0) 
            {
                const serverMaterial = serverMats.find(m => m.materialName === materialInfo.name);
                if(serverMaterial?.materialUuid) {
                    stableId = serverMaterial.materialUuid;
                }
            }
            return {
                ...materialInfo,
                uuid: stableId,
                name: materialInfo.name,
                index: materialInfo.globalIndex,
                meshCount: materialInfo.meshes.length,
                isShared: materialInfo.meshes.length > 1
            };
        });

        // 返回唯一材质列表,按照材质名称排序
        return finalized
            .sort((a, b) => {
                // 首先按照材质名称排序
                const nameA = (a.name || '').toLowerCase();
                const nameB = (b.name || '').toLowerCase();
                if (nameA < nameB) return -1;
                if (nameA > nameB) return 1;
                // 如果名称相同,按照全局索引排序
                return a.index - b.index;
            });
    }

    /**
     * 替换指定材质的纹理 
     */
    async replaceMaterialTexture(model, materialUuid, textureType, textureSource) {
        try {
            // 获取目标材质（统一的查找顺序：uuid -> originalUuid -> name）
            const materials = this.getMaterials(model);
            const targetMaterial = materials.find(m => (
                m.uuid === materialUuid ||
                m.originalUuid === materialUuid ||
                m.name === materialUuid
            ));
            
            if (!targetMaterial) {
                console.warn(`未找到材质: ${materialUuid}`);
                return false;
            }
            
            const material = targetMaterial.material;
            
            if (!this._isValidTextureType(textureType)) {
                console.warn(`无效的纹理类型: ${textureType}`);
                return false;
            }

            // 获取原始纹理用于后续释放，并保存其参数
            const originalTexture = material[textureType];
            let originalTextureParams = null;
            if (originalTexture) {
                originalTextureParams = {
                    offset: originalTexture.offset ? originalTexture.offset.clone() : new THREE.Vector2(0, 0),
                    repeat: originalTexture.repeat ? originalTexture.repeat.clone() : new THREE.Vector2(1, 1),
                    wrapS: originalTexture.wrapS || THREE.RepeatWrapping,
                    wrapT: originalTexture.wrapT || THREE.RepeatWrapping,
                    minFilter: originalTexture.minFilter || THREE.LinearFilter,
                    magFilter: originalTexture.magFilter || THREE.LinearFilter,
                    generateMipmaps: originalTexture.generateMipmaps !== false,
                    // 追加的保持一致性参数
                    colorSpace: originalTexture.colorSpace,
                    encoding: originalTexture.encoding,
                    flipY: originalTexture.flipY,
                    anisotropy: originalTexture.anisotropy || 1,
                    rotation: originalTexture.rotation || 0,
                    center: originalTexture.center ? originalTexture.center.clone() : new THREE.Vector2(0.5, 0.5)
                };
            }
            
            // 保存材质的透明度相关属性，避免替换纹理时丢失透明度
            const materialProperties = {
                transparent: material.transparent,
                opacity: material.opacity,
                alphaTest: material.alphaTest,
                side: material.side,
                depthWrite: material.depthWrite,
                depthTest: material.depthTest
            };

            // 加载新纹理
            const newTexture = await this._loadTextureFromSource(textureSource, textureType);
            
            if (!newTexture) {
                throw new Error('纹理加载失败');
            }

            // 等待纹理真正完成加载
            await new Promise((resolve, reject) => {
                if (newTexture.image && newTexture.image.complete) {
                    resolve();
                } else {
                    newTexture.onLoad = resolve;
                    newTexture.onError = reject;
                    // 如果纹理已经有内容，手动触发加载完成
                    if (newTexture.image && newTexture.image.width > 0) {
                        resolve();
                    }
                }
            });

            // 验证新纹理质量
            if (!this._validateTextureQuality(newTexture, textureType)) {
                // console.warn(`纹理质量验证失败: ${textureType}, 但继续使用该纹理`);
            }

            // 释放旧纹理
            if (originalTexture && originalTexture.dispose) {
                originalTexture.dispose();
            }

            // 应用新纹理
            material[textureType] = newTexture;
            
            // 正确设置纹理参数 - 保持原始参数或使用默认值
            if (newTexture) {
                if (originalTextureParams) {
                    // 保持原始纹理的UV参数
                    newTexture.offset.copy(originalTextureParams.offset);
                    newTexture.repeat.copy(originalTextureParams.repeat);
                    newTexture.rotation = originalTextureParams.rotation;
                    newTexture.center.copy(originalTextureParams.center);
                    newTexture.wrapS = originalTextureParams.wrapS;
                    newTexture.wrapT = originalTextureParams.wrapT;
                    newTexture.minFilter = originalTextureParams.minFilter;
                    newTexture.magFilter = originalTextureParams.magFilter;
                    newTexture.generateMipmaps = originalTextureParams.generateMipmaps;
                    newTexture.anisotropy = originalTextureParams.anisotropy;
                    if (typeof originalTextureParams.flipY !== 'undefined') newTexture.flipY = originalTextureParams.flipY;
                    // 保持原始的颜色空间/编码（向后兼容）
                    if (typeof originalTextureParams.colorSpace !== 'undefined') {
                        newTexture.colorSpace = originalTextureParams.colorSpace;
                    }
                    if (typeof originalTextureParams.encoding !== 'undefined') {
                        newTexture.encoding = originalTextureParams.encoding;
                    }
                } else {
                    // 只有在没有原始纹理时才使用默认值
                    newTexture.offset.set(0, 0);
                    newTexture.repeat.set(1, 1);
                    newTexture.wrapS = THREE.RepeatWrapping;
                    newTexture.wrapT = THREE.RepeatWrapping;
                    newTexture.minFilter = THREE.LinearFilter;
                    newTexture.magFilter = THREE.LinearFilter;
                    newTexture.generateMipmaps = true;
                    // 根据纹理类型设置合理色彩空间
                    this._setCorrectColorSpace(newTexture, textureType);
                }
                newTexture.needsUpdate = true;
            }
                        
            // 如果此材质绑定在任何SkinnedMesh上，确保开启skinning 以正确响应骨骼动画
            if (targetMaterial.meshes && Array.isArray(targetMaterial.meshes)) {
                targetMaterial.meshes.forEach(meshInfo => {
                    const mesh = meshInfo.mesh;
                    if (mesh && mesh.isSkinnedMesh && 'skinning' in material) {
                        material.skinning = true;
                    }
                });
            }
            
            // 恢复透明度等属性
            if (materialProperties) {
                material.transparent = materialProperties.transparent;
                material.opacity = materialProperties.opacity;
                material.alphaTest = materialProperties.alphaTest;
                material.side = materialProperties.side;
                material.depthWrite = materialProperties.depthWrite;
                material.depthTest = materialProperties.depthTest;
            }
            
            material.needsUpdate = true;
            
            // 强制更新所有使用此材质的mesh
            targetMaterial.meshes.forEach(meshInfo => {
                const mesh = meshInfo.mesh;
                if (mesh && mesh.isMesh) {
                    if (Array.isArray(mesh.material)) {
                        mesh.material[meshInfo.materialIndex] = material;
                    } else {
                        mesh.material = material;
                    }
                }
            });

            // 通知外部：材质纹理替换完成（通过引擎事件系统）
            if (this.engine && this.engine.events) {
                try {
                    this.engine.events.emit('material:textureReplaced', {
                        materialUuid,
                        textureType,
                        success: true
                    });
                } catch (e) {
                    // 静默处理事件派发中的异常，避免影响主流程
                }
            }

            return true;
        } catch (error) {
            console.error('纹理替换失败:', error);
            // 通过引擎事件系统发送错误事件
            if (this.engine && this.engine.events) {
                try {
                    this.engine.events.emit('material:textureReplaced', {
                        materialUuid,
                        textureType,
                        success: false,
                        error: error.message || error
                    });
                } catch (e) {
                    // 忽略事件派发错误
                }
            }
            return false;
        }
    }

    /**
     * 移除材质纹理
     */
    removeMaterialTexture(model, materialUuid, textureType) {
        try {
            const materials = this.getMaterials(model);
            // 首先尝试通过稳定UUID查找,如果找不到则尝试通过原始UUID查找,最后尝试通过name查找
            let targetMaterial = materials.find(m => m.uuid === materialUuid);
            if (!targetMaterial) {
                targetMaterial = materials.find(m => m.originalUuid === materialUuid);
            }
            if (!targetMaterial) {
                targetMaterial = materials.find(m => m.name === materialUuid);
            }
            
            if (!targetMaterial) {
                console.warn(`未找到材质: ${materialUuid}`);
                return false;
            }

            const material = targetMaterial.material;
            
            // 检查纹理类型是否有效
            if (!this._isValidTextureType(textureType)) {
                console.warn(`无效的纹理类型: ${textureType}`);
                return false;
            }

            // 释放旧纹理
            if (material[textureType]) {
                const oldTexture = material[textureType];
                oldTexture.dispose();
                material[textureType] = null;
                material.needsUpdate = true;
                
                // 清理纹理缓存
                if (oldTexture.uuid && THREE.Cache.enabled) {
                    THREE.Cache.remove(oldTexture.uuid);
                }
            }

            return true;
        } catch (error) {
            console.error('纹理移除失败:', error);
            return false;
        }
    }



    /**
     * 批量替换纹理
     */
    async replaceMultipleTextures(model, replacements) {
        const results = [];
        for (const { materialUuid, textureType, textureSource } of replacements) {
            const success = await this.replaceMaterialTexture(model, materialUuid, textureType, textureSource);
            results.push({ materialUuid, textureType, success });
        }
        return results;
    }

    /**
     * 获取材质详细信息
     */
    getMaterialDetails(model, materialUuid) {
        const materials = this.getMaterials(model);
        // 首先尝试通过稳定UUID查找,如果找不到则尝试通过原始UUID查找,最后尝试通过name查找
        let materialInfo = materials.find(m => m.uuid === materialUuid);
        if (!materialInfo) {
            materialInfo = materials.find(m => m.originalUuid === materialUuid);
            if (materialInfo) {
                console.warn(`通过原始UUID找到材质: ${materialUuid},建议使用稳定UUID: ${materialInfo.uuid}`);
            }
        }
        if (!materialInfo) {
            materialInfo = materials.find(m => m.name === materialUuid);
            if (materialInfo) {
                console.warn(`通过name找到材质: ${materialUuid},建议使用稳定UUID: ${materialInfo.uuid}`);
            }
        }
        return materialInfo;
    }

    /**
     * 修改材质颜色属性
     */
    updateMaterialColor(model, materialUuid, colorType, colorValue) {
        return this._updateMaterialProperty(model, materialUuid, colorType, colorValue, 'color');
    }

    /**
     * 修改材质数值属性
     */
    updateMaterialProperty(model, materialUuid, propertyName, value) {
        return this._updateMaterialProperty(model, materialUuid, propertyName, value, 'number');
    }

    /**
     * 修改材质布尔属性
     */
    updateMaterialBooleanProperty(model, materialUuid, propertyName, value) {
        return this._updateMaterialProperty(model, materialUuid, propertyName, value, 'boolean');
    }

    /**
     * 规范化纹理属性（colorSpace/encoding 与 flipY），确保编辑端/预览端观感一致
     */
    normalizeTextureAfterReplace(model, materialUuid, mapType, opts = {}) {
        try {
            const mats = this.getMaterials(model);
            const target = mats.find(m => m.uuid === materialUuid);
            if (!target || !target.material) return;
            const tex = target.material[mapType];
            if (!tex) return;

            // 颜色通道使用 sRGB，数据通道使用 Linear
            const isColorMap = (mapType === 'map' || mapType === 'emissiveMap');
            
            // 优先使用新的 colorSpace 属性
            if (typeof tex.colorSpace !== 'undefined') {
                if (isColorMap && THREE?.SRGBColorSpace !== undefined) {
                    tex.colorSpace = THREE.SRGBColorSpace;
                } else if (!isColorMap && THREE?.LinearSRGBColorSpace !== undefined) {
                    tex.colorSpace = THREE.LinearSRGBColorSpace;
                }
            } else if (typeof tex.encoding !== 'undefined') {
                // 保持向后兼容
                if (isColorMap && THREE?.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
                if (!isColorMap && THREE?.LinearEncoding !== undefined) tex.encoding = THREE.LinearEncoding;
            }

            // 同步 flipY（若传入）
            if (opts.flipY === false) {
                tex.flipY = false;
            }

            tex.needsUpdate = true;
        } catch (_) {}
    }

    /**
     * 通用材质属性更新方法
     */
    _updateMaterialProperty(model, materialUuid, propertyName, value, type) {
        try {
            const materials = this.getMaterials(model);
            // 首先尝试通过稳定UUID查找,如果找不到则尝试通过原始UUID查找,最后尝试通过name查找
            let targetMaterial = materials.find(m => m.uuid === materialUuid);
            if (!targetMaterial) {
                targetMaterial = materials.find(m => m.originalUuid === materialUuid);
            }
            if (!targetMaterial) {
                targetMaterial = materials.find(m => m.name === materialUuid);
            }
            
            if (!targetMaterial) {
                return false;
            }

            const material = targetMaterial.material;
            let processedValue = value;

            // 根据类型处理值
            if (type === 'color') {
                if (typeof value === 'string' && !value.startsWith('#') && value.length === 6) {
                    processedValue = '#' + value;
                }
                const colorObj = new THREE.Color(processedValue);
                
                switch (propertyName) {
                    case 'color':
                    case 'baseColor':
                        if (material.color && material.color.isColor) {
                            material.color.set(colorObj);
                        } else if ('color' in material) {
                            material.color = colorObj;
                        } else {
                            console.warn(`材质不支持 color 属性: ${material.type}`);
                            return false;
                        }
                        break;
                    case 'emissive':
                    case 'emissiveColor':
                        if (material.emissive && material.emissive.isColor) {
                            material.emissive.set(colorObj);
                        } else if ('emissive' in material) {
                            material.emissive = colorObj;
                        } else {
                            console.warn(`材质不支持 emissive 属性: ${material.type}`);
                            return false;
                        }
                        break;
                    default:
                        console.warn(`不支持的颜色类型: ${propertyName}`);
                        return false;
                }
            } else if (type === 'number') {
                processedValue = Number(value);
                if (isNaN(processedValue)) {
                    console.warn(`无效的数值: ${value}`);
                    return false;
                }
                
                switch (propertyName) {
                    case 'roughness':
                    case 'metalness':
                    case 'opacity':
                    case 'aoMapIntensity':
                    case 'emissiveIntensity':
                        if (propertyName in material) {
                            // 直接使用0-1范围的值
                            const clamped = Math.max(0, Math.min(1, processedValue));
                        if (propertyName === 'opacity') {
                            // 设置透明度值
                            material.opacity = clamped;
                            
                            // 判断是否真正透明：transparent=true 且 opacity<1
                            const isActuallyTransparent = clamped < 1;
                            
                            // 保守的透明度处理：只在必要时修改transparent属性
                            if (isActuallyTransparent && !material.transparent) {
                                // 只有当透明度小于1且当前不是透明时才设置为透明
                                if ('transparent' in material) material.transparent = true;
                            } else if (!isActuallyTransparent && material.transparent) {
                                // 只有当透明度为1且当前是透明时才设置为不透明
                                const isNaturallyTransparent = material.userData?.isNaturallyTransparent || false;
                                if (!isNaturallyTransparent) {
                                    if ('transparent' in material) material.transparent = false;
                                }
                            }
                            
                            if ('depthWrite' in material) {
                                if (isActuallyTransparent) {
                                    material.depthWrite = false;
                                } else {
                                    material.depthWrite = true;
                                }
                            }
                            
                            // 确保深度测试开启
                            if ('depthTest' in material) {
                                material.depthTest = true;
                            }
                            
                            // 更新所有使用此材质的 mesh 的 renderOrder
                            targetMaterial.meshes.forEach(meshInfo => {
                                this._updateMeshRenderOrder(material, meshInfo.mesh);
                            });
                        } else {
                                material[propertyName] = clamped;
                            }
                        }
                        break;
                    case 'envMapIntensity': {
                        // 直接使用输入值，不进行自动转换
                        const clampedValue = Math.max(0, Math.min(1, processedValue));
                        // 设置环境反射强度
                        material.envMapIntensity = clampedValue;
                        
                        // 确保有环境贴图
                        try {
                            const scene = this.engine?.mainScene;
                            if (scene && scene.environment) {
                                material.envMap = scene.environment;
                            }
                        } catch (_) {}
                        
                        // 强制更新材质
                        material.needsUpdate = true;
                        break; }
                    default:
                        console.warn(`不支持的数值属性: ${propertyName}`);
                        return false;
                }
            } else if (type === 'boolean') {
                // 更稳健的布尔解析：支持 true/false、1/0、"1"/"0"
                if (typeof value === 'string') {
                    processedValue = value === '1' || value.toLowerCase() === 'true';
                } else if (typeof value === 'number') {
                    processedValue = value === 1;
                } else {
                    processedValue = value === true;
                }
                
                switch (propertyName) {
                    case 'transparent': {
                        // 区分天然透明材质和普通材质的处理
                        const isNaturallyTransparent = material.userData?.isNaturallyTransparent || false;
                        const currentOpacity = material.opacity !== undefined ? material.opacity : 1;
                        const isActuallyTransparent = processedValue && currentOpacity < 1;
                        
                        if (processedValue) {
                            // 开启：保持当前透明度值，启用透明渲染
                            if ('transparent' in material) material.transparent = true;
                        } else {
                            // 关闭：根据材质类型处理
                            if (isNaturallyTransparent) {
                                // 天然透明材质：即使开关关闭，也保持当前透明度（玻璃等）
                                if ('transparent' in material) material.transparent = true;
                            } else {
                                // 普通材质：设置透明度为1，关闭透明渲染
                                material.opacity = 1;
                                if ('transparent' in material) material.transparent = false;
                            }
                        }
                        
                        // 设置深度写入：根据实际透明度状态
                        if ('depthWrite' in material) {
                            if (isActuallyTransparent) {
                                // 透明材质：不写入深度
                                material.depthWrite = false;
                            } else {
                                // 不透明材质：写入深度
                                material.depthWrite = true;
                            }
                        }
                        
                        // 确保深度测试开启
                        if ('depthTest' in material) {
                            material.depthTest = true;
                        }
                        
                        // 更新所有使用此材质的 mesh 的 renderOrder
                        targetMaterial.meshes.forEach(meshInfo => {
                            this._updateMeshRenderOrder(material, meshInfo.mesh);
                        });
                        
                        break; }
                    case 'wireframe':
                        material[propertyName] = processedValue;
                        break;
                    case 'side':
                        material.side = value ? THREE.DoubleSide : THREE.FrontSide;
                        break;
                    default:
                        console.warn(`不支持的布尔属性: ${propertyName}`);
                        return false;
                }
            }

            material.needsUpdate = true;
            
            // 强制刷新所有使用此材质的网格
            targetMaterial.meshes.forEach(meshInfo => {
                const mesh = meshInfo.mesh;
                if (mesh && mesh.isMesh) {
                    mesh.matrixWorldNeedsUpdate = true;
                    if (mesh.geometry) {
                        mesh.geometry.attributesNeedUpdate = true;
                    }
                }
            });
            
            return true;
        } catch (error) {
            console.error('修改材质属性失败:', error);
            return false;
        }
    }

    // ========== 私有方法 ==========
    /**
     * 根据材质透明状态更新 mesh 的 renderOrder
     * 渲染顺序：不透明 mesh = 0，热点和透明 mesh = 2
     * @private
     * @param {THREE.Material|Array} material - 材质或材质数组
     * @param {THREE.Mesh} mesh - mesh 对象
     */
    _updateMeshRenderOrder(material, mesh) {
        if (!mesh || !mesh.isMesh) return;
        
        const materials = Array.isArray(material) ? material : [material];
        const hasTransparent = materials.some(mat => 
            mat && mat.transparent === true && 
            mat.opacity !== undefined && 
            mat.opacity < 1
        );
        
        mesh.renderOrder = hasTransparent ? 2 : 0;
    }

    /**
     * 获取基础材质属性
     */
    _getBasicProperties(material) {
        const props = {
            transparent: material.transparent,
            opacity: material.opacity,
            originalOpacity: material.userData?.originalOpacity ?? material.opacity, // 保存原始透明度值
            wireframe: material.wireframe || false
        };

        if (material.color) {
            props.color = '#' + material.color.getHexString();
        }
        if ('metalness' in material) {
            props.metalness = material.metalness;
        }
        if ('roughness' in material) {
            props.roughness = material.roughness;
        }
        if (material.emissive) {
            props.emissive = '#' + material.emissive.getHexString();
        }
        
        // 统一使用环境反射强度属性
        if ('envMapIntensity' in material) {
            props.envMapIntensity = material.envMapIntensity;
        }

        return props;
    }

    /**
     * 获取纹理信息
     */
    _getTextureInfo(material) {
        const textureTypes = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];
        const textures = {};

        textureTypes.forEach(type => {
            textures[type] = {
                hasTexture: !!material[type],
                texture: material[type] || null
            };
        });

        return textures;
    }

    /**
     * 检查纹理类型是否有效
     */
    _isValidTextureType(type) {
        const validTypes = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];
        return validTypes.includes(type);
    }

    /**
     * 验证纹理质量
     * @param {THREE.Texture} texture - 纹理对象
     * @param {string} textureType - 纹理类型
     * @returns {boolean} 纹理质量是否合格
     */
    _validateTextureQuality(texture, textureType) {
        if (!texture || !texture.image) {
            console.warn(`纹理验证失败: ${textureType} - 纹理或图像为空`);
            return false;
        }
        
        const img = texture.image;
        const minSize = 256; // 最小尺寸要求
        
        if (img.width < minSize || img.height < minSize) {
            // console.warn(`纹理尺寸过小: ${textureType} - ${img.width}x${img.height}, 可能影响质量`);
            return false;
        }
        
        // 检查是否为缩略图（通过文件名或URL判断）
        if (texture.image.src) {
            const src = texture.image.src.toLowerCase();
            if (src.includes('thumb') || src.includes('small') || src.includes('_s.') || src.includes('_m.')) {
                console.warn(`检测到缩略图: ${textureType} - ${src}`);
                return false;
            }
        }
        
        return true;
    }

    /**
     * 从不同源加载纹理 
     */
    async _loadTextureFromSource(source, textureType = 'map') {
        return new Promise((resolve, reject) => {
            if (source === null || source === undefined) {
                resolve(null);
                return;
            }
            
            if (typeof source === 'string') {
                if (source.startsWith('data:')) {
                    // 处理base64数据
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.onload = () => {
                        try {
                            const optimizedImage = this._adjustTexturePowerOfTwo(img);
                            const texture = new THREE.Texture(optimizedImage);
                            this._optimizeTexture(texture, textureType);
                            this._setCorrectColorSpace(texture, textureType);
                            texture.needsUpdate = true;
                            resolve(texture);
                        } catch (error) {
                            reject(new Error('纹理创建失败: ' + error.message));
                        }
                    };
                    img.onerror = () => reject(new Error('base64图片加载失败'));
                    img.src = source;
                    
                } else if (source.startsWith('http://') || source.startsWith('https://')) {
                    // 使用多种策略加载跨域图片，确保在控制台关闭时也能正常工作
                    const loadWithRetry = async (retryCount = 0) => {
                        const maxRetries = 3;
                        const retryDelay = 1000 * (retryCount + 1); // 递增延迟
                        
                        try {
                            // 策略1：直接使用fetch + blob（最可靠）
                            const response = await fetch(source, { 
                                mode: 'cors',
                                credentials: 'omit',
                                cache: 'no-cache',
                                headers: {
                                    'Accept': 'image/*'
                                }
                            });
                            
                            if (!response.ok) {
                                throw new Error(`HTTP ${response.status}`);
                            }
                            
                            const blob = await response.blob();
                            const objectUrl = URL.createObjectURL(blob);
                            
                            const img = new Image();
                            img.crossOrigin = 'anonymous';
                            
                            return new Promise((imgResolve, imgReject) => {
                                img.onload = () => {
                                    try {
                                        const optimizedImage = this._adjustTexturePowerOfTwo(img);
                                        const texture = new THREE.Texture(optimizedImage);
                                        this._optimizeTexture(texture, textureType);
                                        this._setCorrectColorSpace(texture, textureType);
                                        texture.needsUpdate = true;
                                        URL.revokeObjectURL(objectUrl);
                                        imgResolve(texture);
                                    } catch (error) {
                                        URL.revokeObjectURL(objectUrl);
                                        imgReject(error);
                                    }
                                };
                                
                                img.onerror = () => {
                                    URL.revokeObjectURL(objectUrl);
                                    // CORS失败，尝试无CORS加载
                                    const fallbackImg = new Image();
                                    fallbackImg.crossOrigin = null;
                                    fallbackImg.onload = () => {
                                        try {
                                            const optimizedImage = this._adjustTexturePowerOfTwo(fallbackImg);
                                            const texture = new THREE.Texture(optimizedImage);
                                            this._optimizeTexture(texture, textureType);
                                            this._setCorrectColorSpace(texture, textureType);
                                            texture.needsUpdate = true;
                                            URL.revokeObjectURL(objectUrl);
                                            imgResolve(texture);
                                        } catch (error) {
                                            URL.revokeObjectURL(objectUrl);
                                            imgReject(error);
                                        }
                                    };
                                    fallbackImg.onerror = () => {
                                        URL.revokeObjectURL(objectUrl);
                                        imgReject(new Error('图片加载失败'));
                                    };
                                    fallbackImg.src = objectUrl;
                                };
                                
                                // 设置超时
                                setTimeout(() => {
                                    URL.revokeObjectURL(objectUrl);
                                    imgReject(new Error('图片加载超时'));
                                }, 10000);
                                
                                img.src = objectUrl;
                            });
                            
                        } catch (fetchError) {
                            console.warn(`纹理加载失败 (尝试 ${retryCount + 1}/${maxRetries + 1}):`, source, fetchError.message);
                            
                            if (retryCount < maxRetries) {
                                // 重试
                                await new Promise(resolve => setTimeout(resolve, retryDelay));
                                return loadWithRetry(retryCount + 1);
                            } else {
                                // 最后尝试：直接加载（无CORS）
                                console.warn('CORS fetch失败，尝试直接加载:', source);
                                return new Promise((imgResolve) => {
                                    const img = new Image();
                                    img.crossOrigin = null;
                                    
                                    img.onload = () => {
                                        try {
                                            // 将图片绘制到canvas上，清除跨域标记
                                            const canvas = document.createElement('canvas');
                                            const ctx = canvas.getContext('2d');
                                            canvas.width = img.width;
                                            canvas.height = img.height;
                                            // 启用高质量图像处理
                                            ctx.imageSmoothingEnabled = true;
                                            ctx.imageSmoothingQuality = 'high';
                                            ctx.drawImage(img, 0, 0);
                                            
                                            const optimizedImage = this._adjustTexturePowerOfTwo(canvas);
                                            const texture = new THREE.Texture(optimizedImage);
                                            this._optimizeTexture(texture, textureType);
                                            this._setCorrectColorSpace(texture, textureType);
                                            texture.needsUpdate = true;
                                            imgResolve(texture);
                                        } catch (error) {
                                            console.warn('Canvas处理失败:', error.message);
                                            imgResolve(null);
                                        }
                                    };
                                    
                                    img.onerror = () => {
                                        console.error('纹理加载完全失败:', source);
                                        imgResolve(null);
                                    };
                                    
                                    // 设置超时
                                    setTimeout(() => {
                                        console.error('纹理加载超时:', source);
                                        imgResolve(null);
                                    }, 8000);
                                    
                                    img.src = source;
                                });
                            }
                        }
                    };
                    
                    loadWithRetry().then(resolve).catch(() => resolve(null));
                } else {
                    // 处理本地路径 - 确保使用跨域设置
                    const loader = new THREE.TextureLoader();
                    loader.crossOrigin = 'anonymous';
                    loader.load(source, (texture) => {
                        try {
                            const optimizedImage = this._adjustTexturePowerOfTwo(texture.image);
                            texture.image = optimizedImage;
                            this._optimizeTexture(texture, textureType);
                            this._setCorrectColorSpace(texture, textureType);
                            texture.needsUpdate = true;
                            resolve(texture);
                        } catch (error) {
                            reject(new Error('纹理处理失败: ' + error.message));
                        }
                    }, undefined, reject);
                }
            } else if (source instanceof File) {
                // 处理文件对象
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = new Image();
                    img.crossOrigin = 'anonymous'; // 添加跨域设置
                    img.onload = () => {
                        try {
                            const optimizedImage = this._adjustTexturePowerOfTwo(img);
                            const texture = new THREE.Texture(optimizedImage);
                            this._optimizeTexture(texture, textureType);
                            this._setCorrectColorSpace(texture, textureType);
                            texture.needsUpdate = true;
                            resolve(texture);
                        } catch (error) {
                            reject(new Error('纹理创建失败: ' + error.message));
                        }
                    };
                    img.onerror = () => reject(new Error('文件图片加载失败'));
                    img.src = e.target.result;
                };
                reader.onerror = () => reject(new Error('文件读取失败'));
                reader.readAsDataURL(source);
                
            } else if (source instanceof Blob || source instanceof ArrayBuffer) {
                // 不再支持直接二进制输入，请先转为URL/base64或File
                reject(new Error('不支持的纹理源类型(二进制). 请提供URL/base64或File'));
            } else {
                reject(new Error('不支持的纹理源类型'));
            }
        });
    }

    /**
     * 序列化材质属性
     */
    _serializeMaterialProperties(material) {
        const props = {
            transparent: material.transparent || false,
            opacity: (material.opacity ?? 1),
            side: (material.side ?? THREE.FrontSide),
            wireframe: material.wireframe || false,
            ...this._getMaterialSpecificProperties(material)
        };

        if (material.color) {
            props.color = '#' + material.color.getHexString();
        }
        if (material.emissive) {
            props.emissive = '#' + material.emissive.getHexString();
            props.emissiveIntensity = material.emissiveIntensity || 1;
        }

        return props;
    }

    /**
     * 获取材质特定属性
     */
    _getMaterialSpecificProperties(material) {
        const props = {};

        if (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) {
            props.metalness = (material.metalness ?? 0);
            props.roughness = (material.roughness ?? 1);
            // 材质环境反射强度独立于HDR环境光强度，使用材质自身的值或默认值1.0
            props.envMapIntensity = (material.envMapIntensity ?? 1.0);
        }
        
        if (material.isMeshPhongMaterial) {
            props.shininess = (material.shininess ?? 30);
            // 统一使用环境反射强度属性
            props.envMapIntensity = (material.envMapIntensity ?? 1.0);
        }
        
        if (material.isMeshLambertMaterial) {
            if (material.envMap) {
                // 材质环境反射强度独立于HDR环境光强度，使用材质自身的值或默认值1.0
                props.envMapIntensity = (material.envMapIntensity ?? 1.0);
            }
        }

        return props;
    }

    /**
     * 序列化纹理数据（记录URL与完整纹理参数）
     */
    async _serializeTextures(material) {
        const textures = {};
        const textureTypes = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'];
    
        for (const type of textureTypes) {
            if (material[type]) {
                const texture = material[type];
                
                // 保存原始 colorSpace
                const originalColorSpace = texture.colorSpace;
                const originalEncoding = texture.encoding;
                
                const originalUrl = texture.image && texture.image.src ? texture.image.src : null;
                let thumbUrl = null;
                let url = null;
                
                // 判断纹理类型
                const isColorTexture = (type === 'map' || type === 'emissiveMap');
                const isDataTexture = !isColorTexture; // normalMap, roughnessMap, metalnessMap
    
                try {
                    const img = texture.image;
                    if (img && img.width && img.height) {
                        // 1. 生成缩略图（所有类型都生成，用于UI预览）
                        const max = 256;
                        const s = Math.min(max / img.width, max / img.height, 1);
                        const w = Math.max(1, (img.width * s) | 0);
                        const h = Math.max(1, (img.height * s) | 0);
                        const thumbCanvas = document.createElement('canvas');
                        thumbCanvas.width = w;
                        thumbCanvas.height = h;
                        const thumbCtx = thumbCanvas.getContext('2d');
                        if (thumbCtx && thumbCtx.drawImage) {
                            thumbCtx.imageSmoothingEnabled = true;
                            thumbCtx.imageSmoothingQuality = 'high';
                            thumbCtx.drawImage(img, 0, 0, w, h);
                            thumbUrl = thumbCanvas.toDataURL('image/png');
                        }
    
                        // 2. 处理原图
                        if (isDataTexture && originalUrl && !originalUrl.startsWith('data:')) {
                            // 数据纹理：直接使用原始 URL，避免 Canvas 破坏数据
                            url = originalUrl;
                            console.log(`[数据纹理保护] ${type} 使用原始URL，避免gamma损坏`);
                        } else {
                            // 颜色纹理或已经是base64：正常处理
                            const canvas = document.createElement('canvas');
                            canvas.width = img.width;
                            canvas.height = img.height;
                            const ctx = canvas.getContext('2d');
                            if (ctx && ctx.drawImage) {
                                ctx.imageSmoothingEnabled = false;
                                ctx.drawImage(img, 0, 0, img.width, img.height);
                                url = canvas.toDataURL('image/png');
                            }
                        }
                    }
                } catch (e) {
                    console.warn('生成纹理数据失败:', e);
                    url = originalUrl;
                }
    
                textures[type] = {
                    hasTexture: true,
                    uuid: this._generateStableTextureId(texture, type),
                    name: texture.name || '',
                    url: url || originalUrl,
                    thumbUrl: thumbUrl,
                    originalUrl: originalUrl,  // 保存原始URL备用
                    repeat: texture.repeat ? texture.repeat.toArray() : [1, 1],
                    offset: texture.offset ? texture.offset.toArray() : [0, 0],
                    rotation: typeof texture.rotation === 'number' ? texture.rotation : 0,
                    center: texture.center ? texture.center.toArray() : [0.5, 0.5],
                    wrapS: texture.wrapS,
                    wrapT: texture.wrapT,
                    minFilter: texture.minFilter,
                    magFilter: texture.magFilter,
                    anisotropy: texture.anisotropy || 1,
                    generateMipmaps: texture.generateMipmaps !== false,
                    flipY: typeof texture.flipY === 'boolean' ? texture.flipY : true,
                    
                    // 保存完整色彩空间信息
                    colorSpace: originalColorSpace,
                    encoding: originalEncoding,
                    isDataTexture: isDataTexture  // 标记类型
                };
            }
        }
    
        return textures;
    }
    /**
     * 生成稳定的纹理ID
     */
    _generateStableTextureId(texture, textureType) {
        // 基于纹理名称、类型和图片尺寸生成稳定ID
        const textureName = texture.name || 'UnnamedTexture';
        const imageInfo = texture.image ? 
            `${texture.image.width}x${texture.image.height}` : 
            'noimage';
        return `texture_${this._hashString(textureName + textureType + imageInfo)}`;
    }


    /**
     * 根据纹理类型设置合适的色彩空间/编码
     * @param {THREE.Texture} texture
     * @param {string} textureType
     */
    _setCorrectColorSpace(texture, textureType) {
        try {
            const isColorMap = (textureType === 'map' || textureType === 'emissiveMap');
            if (typeof texture.colorSpace !== 'undefined') {
                if (isColorMap && THREE?.SRGBColorSpace !== undefined) {
                    texture.colorSpace = THREE.SRGBColorSpace;
                } else if (!isColorMap && THREE?.LinearSRGBColorSpace !== undefined) {
                    texture.colorSpace = THREE.LinearSRGBColorSpace;
                }
            } else if (typeof texture.encoding !== 'undefined') {
                if (isColorMap && THREE?.sRGBEncoding !== undefined) {
                    texture.encoding = THREE.sRGBEncoding;
                } else if (!isColorMap && THREE?.LinearEncoding !== undefined) {
                    texture.encoding = THREE.LinearEncoding;
                }
            }
        } catch (_) {}
    }

    /**
     * 优化纹理属性设置
     */
    _optimizeTexture(texture, textureType) {
        // GLB模型的关键设置
        texture.flipY = false;
        
        // 检查图片是否存在和完整
        const image = texture.image;
        if (!image || !image.complete || image.naturalWidth === 0) {
            console.warn('纹理图片未完全加载');
            // 应用最安全的设置
            texture.generateMipmaps = false;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            return texture;
        }

        const width = image.width;
        const height = image.height;
        const isPowerOfTwo = this._isPowerOfTwo(width) && this._isPowerOfTwo(height);
        
        // 根据纹理类型设置格式和过滤器
        const isColorMap = (textureType === 'map' || textureType === 'emissiveMap');
        
        // 优先使用新的 colorSpace 属性
        if (typeof texture.colorSpace !== 'undefined') {
            if (isColorMap && THREE?.SRGBColorSpace !== undefined) {
                texture.colorSpace = THREE.SRGBColorSpace;
            } else if (!isColorMap && THREE?.LinearSRGBColorSpace !== undefined) {
                texture.colorSpace = THREE.LinearSRGBColorSpace;
            }
        } else if (typeof texture.encoding !== 'undefined') {
            // 保持向后兼容
            if (isColorMap && THREE?.sRGBEncoding !== undefined) texture.encoding = THREE.sRGBEncoding;
            if (!isColorMap && THREE?.LinearEncoding !== undefined) texture.encoding = THREE.LinearEncoding;
        }

        // 优化的Mipmap和过滤器设置
        const maxSize = this.maxTextureSize;
        const useHighQualityFiltering = this.textureQuality === 'high' || this.textureQuality === 'ultra';
        
        if (isPowerOfTwo && width >= MIN_TEXTURE_SIZE && height >= MIN_TEXTURE_SIZE && width <= maxSize && height <= maxSize) {
            texture.generateMipmaps = true;
            texture.minFilter = useHighQualityFiltering ? 
                THREE.LinearMipmapLinearFilter : THREE.LinearMipmapNearestFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
        } else if (width >= MIN_TEXTURE_SIZE && height >= MIN_TEXTURE_SIZE) {
            // 对于非2的幂次方但尺寸合理的纹理,仍使用较好的过滤
            texture.generateMipmaps = false;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
        } else {
            // 小尺寸纹理使用最安全设置
            texture.generateMipmaps = false;
            texture.minFilter = THREE.NearestFilter;
            texture.magFilter = THREE.NearestFilter;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
        }
        
        // 设置各向异性过滤（基于质量设置）
        texture.anisotropy = this.maxAnisotropy;
        
        return texture;
    }

    /**
     * 检查是否为2的幂次方
     * @private
     */
    _isPowerOfTwo(value) {
        return (value & (value - 1)) === 0 && value !== 0;
    }
    
        /**
     * 检查并调整纹理尺寸为2的幂次方
     */
    _adjustTexturePowerOfTwo(image) {
        try {
            // 图片无效直接返回
            if (!image || !image.width || !image.height) {
                console.warn('无效的图片对象');
                return image;
            }

            const width = image.width;
            const height = image.height;

            // 仅当超出最大纹理尺寸时按比例缩小，否则保持原图尺寸
            if (width <= this.maxTextureSize && height <= this.maxTextureSize) {
                return image;
            }

            // 超限时缩放，保持纵横比
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                console.warn('无法创建canvas上下文');
                return image;
            }

            const scale = Math.min(this.maxTextureSize / width, this.maxTextureSize / height);
            const newWidth = Math.max(1, Math.floor(width * scale));
            const newHeight = Math.max(1, Math.floor(height * scale));

            canvas.width = newWidth;
            canvas.height = newHeight;
            // 启用高质量图像缩放
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(image, 0, 0, newWidth, newHeight);
            return canvas;

        } catch (error) {
            console.warn('纹理尺寸处理失败,使用原始图片:', error.message);
            return image;
        }
    }

}

export default MaterialLoader;

