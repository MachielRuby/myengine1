import { EventBus } from "../events/eventEmitter.js";
import {ModelLoader} from "./modelLoader.js";
import { SceneLoader } from "./sceneLoader.js";
import { MaterialLoader } from "./materialLoader.js";
/**
 * 资产管理器 - 负责加载和管理3D资产
 */
export class AssetsManager {
    // 资产存储
    assets = {
        models: new Map(),
        environments: new Map()
    };

    // 状态
    pendingLoads = 0;
    events = new EventBus();
    
    // 资源加载策略（无并发限制，按需加载）
    retryAttempts = 3;
    retryDelay = 1000;
    /**
     * 创建资产管理器
     * @param {Engine} engine 引擎实例
     */
    constructor(engine) {
        this.engine = engine;
        this.engineEvents = engine?.events;
        // 初始化加载器
        this.modelLoader = new ModelLoader(engine?.renderer, this._onProgress.bind(this));
        this.sceneLoader = new SceneLoader(engine);
        this.materialLoader = new MaterialLoader(engine);
        
        // 设置模型加载回调
        if (this.modelLoader?.loadingManager) {
            this.modelLoader.loadingManager.onModelLoaded = (data) => {
                console.log("AssetsManager: 收到ModelLoader回调,发送model:loaded事件", data);
                this._emitEvent('model:loaded', data);
            };
        }
        
        // 场景加载配置
        this.sceneConfig = {
            models: [],
            environments: [],
            autoStart: true,
            onProgress: null,
            onComplete: null
        };
    }
    
    /**
     * 进度回调
     * @private
     */
    _onProgress(url, itemsLoaded, itemsTotal, progress) {
        const progressData = {
            url, 
            itemsLoaded, 
            itemsTotal,
            progress: parseFloat(progress)
        };
        
        // 发送真实的三维加载进度事件
        this._emitEvent('load:progress', progressData);
        
        // 同时发送全局进度事件，供外部使用
        if (typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('f3d:progress', {
                detail: {
                    type: 'model',
                    url,
                    itemsLoaded,
                    itemsTotal,
                    progress: parseFloat(progress),
                    percentage: Math.round(parseFloat(progress))
                }
            }));
        }
    }
    
    /**
     * 获取加载器实例
     */
    getModelLoader() { return this.modelLoader; }
    getSceneLoader() { return this.sceneLoader; }
    getMaterialLoader() { return this.materialLoader; }
    
    /**
     * 加载资源并跟踪
     * @private
     */
    load(type, url, loader, options = {}) {
        const id = options.id || url;
        this._startLoading({ type, id, url });
        
        return loader(url, options)
            .then(asset => {
                this.assets[type]?.set(id, asset);
                this._emitEvent('asset:loaded', { type, id, url, asset });
                return asset;
            })
            .catch(error => {
                this._emitEvent('load:error', { type, id, url, error });
                throw error;
            })
            .finally(() => this._finishLoading());
    }
    
    /**
     * 加载模型
     */
    loadModel(url, id = url) {
        return this.load('models', url, 
            url => this.modelLoader.loadAsync(url), 
            { id }
        );
    }
    
    /**
     * 加载模型并添加到场景
     */
    loadModelToScene(url, options = {}) {
        const { id = url } = options;
        
        return this.load('models', url, 
            () => this.modelLoader.loadAsync(url)
                .then(model => {
                    if (!model) throw new Error('加载的模型为空');
                    
                    // 处理模型
                    this.modelLoader.processModel(model, options);
                    
                    // 添加到场景
                    if (options.addToScene !== false && this.engine?.mainScene) {
                        this.engine.mainScene.add(model);
                    }
                    
                    return model;
                }),
            { id }
        );
    }
    
    /**
     * 加载场景 - 整合加载多个资源
     * @param {Object} config 配置
     * @returns {Promise} 加载完成的Promise
     */
    loadScene(config = {}) {
        // 合并配置
        this.sceneConfig = {
            ...this.sceneConfig,
            ...config
        };
        
        const {
            models = [],
            environments = [],
            autoStart = true
        } = this.sceneConfig;
        
        // 计算总任务数
        const totalTasks = models.length + environments.length;
        if (totalTasks === 0) {
            return Promise.resolve({ models: [], environments: [] });
        }
        
        // 发送场景加载开始事件
        this._emitEvent('scene:loading', { 
            total: totalTasks,
            models: models.length,
            environments: environments.length
        });
        
        // 创建加载任务
        const modelPromises = models.map(modelConfig => {
            return this.loadModelToScene(modelConfig.url, modelConfig)
                .then(model => {
                    console.log("AssetsManager: 模型加载完成,准备发送事件", {
                        modelId: modelConfig.id || modelConfig.url,
                        modelType: model?.constructor?.name,
                        hasAnimations: !!model?.animations,
                        animationsCount: model?.animations?.length || 0
                    });
                    
                    // 发送单个模型加载完成事件
                    this._emitEvent('scene:model', { 
                        model, 
                        id: modelConfig.id || modelConfig.url 
                    });
                    
                    console.log("AssetsManager: scene:model 事件已发送");
                    return model;
                });
        });
        
        const envPromises = environments.map(envConfig => {
            return this.loadEnvironment(envConfig.url, envConfig)
                .then(env => {
                    this._emitEvent('scene:env', { 
                        environment: env, 
                        id: envConfig.id || envConfig.url 
                    });
                    return env;
                });
        });
        
        // 跟踪加载进度
        let completedTasks = 0;
        const updateProgress = () => {
            completedTasks++;
            const progress = (completedTasks / totalTasks) * 100;
            this._emitEvent('scene:progress', { 
                progress, 
                completed: completedTasks, 
                total: totalTasks 
            });
        };
        
        // 为每个Promise添加进度跟踪
        const trackedModelPromises = modelPromises.map(promise => 
            promise.then(result => {
                updateProgress();
                return result;
            })
        );
        
        const trackedEnvPromises = envPromises.map(promise => 
            promise.then(result => {
                updateProgress();
                return result;
            })
        );
        
        // 合并所有Promise
        return Promise.all([...trackedModelPromises, ...trackedEnvPromises])
            .then(results => {
                const modelResults = results.slice(0, models.length);
                const envResults = results.slice(models.length);
                
                const sceneData = {
                    models: modelResults,
                    environments: envResults
                };
                
                // 发送场景加载完成事件
                this._emitEvent('scene:loaded', sceneData);
                
                // 通过引擎事件系统广播
                if (this.engineEvents) {
                    this.engineEvents.emit('scene:loaded', sceneData);
                }
                
                // 处理加载完成后的操作
                if (autoStart && this.engine) {
                    this.engine.start();
                }
                
                // 调用完成回调
                if (typeof this.sceneConfig.onComplete === 'function') {
                    this.sceneConfig.onComplete(sceneData);
                }
                
                return sceneData;
            })
            .catch(error => {
                console.error('场景加载失败:', error);
                this._emitEvent('scene:error', { error });
                
                throw error;
            });
    }
    
    /**
     * 加载HDR环境
     */
    loadEnvironment(url, options = {background:false}) {
        const { id = url } = options;
        
        return this.load('environments', url,
            () => this.sceneLoader.loadHDR(url, options),
            { id }
        );
    }
    
    /**
     * 获取资产
     */
    getAsset(type, id) {
        return this.assets[type]?.get(id) || null;
    }
    
    getModel(id) { return this.getAsset('models', id); }
    getEnvironment(id) { return this.getAsset('environments', id); }
    
    // ============ 材质管理功能 ============
    //获取材质列表
    getMaterials(model, serverMaterials = null)
    {
        return this.materialLoader.getMaterials(model, serverMaterials);
    }
    //获取材质详细信息
    getMaterialDetails(model, materialUuid)
    {
        return this.materialLoader.getMaterialDetails(model, materialUuid);
    }
    //替换材质纹理
    replaceMaterialTexture(model, materialUuid, mapType, textureSource)
    {
        return this.materialLoader.replaceMaterialTexture(model, materialUuid, mapType, textureSource);
    }
    
    // 二进制纹理接口已移除,统一使用图片URL/本地路径/base64
    //移除材质纹理
    removeMaterialTexture(model, materialUuid, textureType)
    {
        return this.materialLoader.removeMaterialTexture(model, materialUuid, textureType);
    }
    
    //导出完整材质数据（包含纹理URL）
    /**
     * 导出模型的完整材质数据
     * @param {Object} model - 模型对象
     * @param {Array} serverMaterials - 可选的服务器材质数组（如果不传则使用MaterialLoader实例中保存的值）
     * @returns {Object} 导出的材质数据
     */
    exportMaterialsData(model, serverMaterials = null)
    {
        return this.materialLoader.exportMaterialsData(model, serverMaterials);
    }

    // importMaterialsData 已移除,避免冗余
    //修改材质颜色
    updateMaterialColor(model, materialUuid, colorType, colorValue)
    {
        return this.materialLoader.updateMaterialColor(model, materialUuid, colorType, colorValue);
    }
    //修改材质数值属性
    updateMaterialProperty(model, materialUuid, propertyName, value)
    {
        return this.materialLoader.updateMaterialProperty(model, materialUuid, propertyName, value);
    }
    //修改材质布尔属性
    updateMaterialBooleanProperty(model, materialUuid, propertyName, value)
    {
        return this.materialLoader.updateMaterialBooleanProperty(model, materialUuid, propertyName, value);
    }
    
    /**
     * 注册事件监听
     */
    on(event, callback) {
        return this.events.on(event, callback);
    }
    
    /**
     * 发送事件
     * @private
     */
    _emitEvent(event, data) {
        this.events.emit(event, data);
        this.engineEvents?.emit(event, data);
    }
    
    /**
     * 开始加载资源
     * @private
     */
    _startLoading(data) {
        this.pendingLoads++;
        this._emitEvent('load:start', data);
    }
    
    /**
     * 完成加载资源
     * @private
     */
    _finishLoading() {
        this.pendingLoads = Math.max(0, this.pendingLoads - 1);
        
        if (this.pendingLoads === 0) {
            this._emitEvent('load:complete', { timestamp: Date.now() });
        }
    }
    


    /**
     * 释放资源
     */
    dispose() {
        // 清除资产
        Object.values(this.assets).forEach(map => map.clear());
        
        // 释放加载器
        this.modelLoader?.dispose();
        this.sceneLoader?.dispose();
        
        // 无加载队列，略
        
        this.modelLoader = null;
        this.sceneLoader = null;
        this.materialLoader = null;
        this.pendingLoads = 0;
    }
}




