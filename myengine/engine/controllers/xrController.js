// webxr ar 控制器
import {
    Vector3,
    Matrix4,
    Group,
    Object3D,
    Quaternion,
    RingGeometry,
    CircleGeometry,
    PlaneGeometry,
    MeshBasicMaterial,
    Mesh,
    MeshStandardMaterial,
    Box3
} from "three";


// 事件系统导入
import { EventBus } from "../core/events/eventEmitter.js";

export class XRController {
    constructor(engine) {
        this.engine = engine;
        this.renderer = engine?.renderer;
        this.scene = engine?.mainScene;
        this.camera = engine?.camera;
        this.session = null;
        this.isPresenting = false; 
        this.events = new EventBus();
        
        // AR 相关
        this.referenceSpace = null;
        this.viewerSpace = null; // viewer 空间（用于 hit-test）
        this.hitTestSource = null;
        this.transientHitTestSource = null; // transient input hit-test
        this.models = []; // 存储所有模型引用
        this.modelScale = 0.5; // 默认缩放比例（缩小到 50%）
        this.modelPlaced = false; // 模型是否已放置
        this.testReticleActive = false; // 测试十字星是否激活
        
        // 可视化相关
        this.reticle = null; // 十字星（reticle）
        this.planeIndicator = null; // 平面指示器
        this.scanningIndicator = null; // 扫描提示面片（黄色，参考 webxr_test）
        this.currentHitPose = null; // 当前检测到的 hit pose
        this.currentHitMatrix = null; // 当前检测到的 hit matrix（用于放置模型）
    }

    // 检查是否支持ar
    async isARSupported() {
        if( !('xr' in navigator)) return false;
        try {
            return await navigator.xr.isSessionSupported('immersive-ar');
        }
        catch {
            return false;
        }
    }

    //开启ar会话
    async startAR(options = {})
    {
        if( this.isPresenting) {
            console.warn("AR 会话已启动");
            return false;
        }

        if(!this.renderer || !this.renderer.xr) {
            throw new Error("XR渲染器未初始化");
        }

        try {
            const sessionInit = {
                requiredFeatures: ['local-floor','hit-test'],
                optionalFeatures: ['hand-tracking', 'bounded-floor']
            };

            // 如果提供了 domOverlay 配置，添加到会话初始化选项中
            if (options.domOverlay) {
                sessionInit.optionalFeatures.push('dom-overlay');
                sessionInit.domOverlay = options.domOverlay;
            }

            const session = await navigator.xr.requestSession('immersive-ar', sessionInit);

            // 存储会话
            this.session = session;
            
            // 保存参考空间到实例属性（用于渲染和模型定位）
            this.referenceSpace = await session.requestReferenceSpace('local-floor');
            
            // 创建 viewer 空间（用于 hit-test，参考 webxr_test 的实现）
            try {
                this.viewerSpace = await session.requestReferenceSpace('viewer');
                console.log('✅ Viewer 空间已创建，用于 hit-test');
            } catch (e) {
                console.warn('⚠️ 无法创建 viewer 空间，将使用 referenceSpace:', e);
                this.viewerSpace = this.referenceSpace;
            }

            // 停止引擎的动画循环，避免与 XR 渲染冲突
            if (this.engine) {
                this.engine.stop();
            }

            //设置渲染器会话
            this.renderer.xr.enabled = true;
            await this.renderer.xr.setSession(session);

            //确保场景背景透明
            if(this.scene) {
                this.scene.background = null;
            }
            
            //设置渲染器背景透明
            if(this.renderer) {
                this.renderer.setClearColor(0x000000, 0);
            }

            //  准备模型（会隐藏所有模型）
            this._prepareModels();
            
            // 确保所有模型在 AR 启动时都是隐藏的（双重保险）
            // 递归隐藏模型及其所有子对象
            this.models.forEach(model => {
                model.visible = false;
                model.traverse((obj) => {
                    obj.visible = false;
                });
            });

            //  创建可视化指示器
            this._createVisualIndicators();
            
            // 初始显示扫描提示面片（提示用户正在扫描）
            if (this.scanningIndicator && !this.testReticleActive) {
                this.scanningIndicator.visible = true;
            }

            //  初始化 hit-test（立即开始平面检测）
            await this._initializeHitTest(session);
            
            // 确保测试十字星显示（如果 hit-test 不可用）
            if (!this.testReticleActive && (!this.hitTestSource && !this.transientHitTestSource)) {
                // 延迟一下，确保十字星已创建
                setTimeout(() => {
                    this._showTestReticle();
                }, 200);
            }
            
            // 确保测试十字星显示（如果 hit-test 不可用）
            if (!this.testReticleActive && (!this.hitTestSource && !this.transientHitTestSource)) {
                // 延迟一下，确保十字星已创建
                setTimeout(() => {
                    this._showTestReticle();
                }, 200);
            }

            //  添加点击事件监听（点击十字星放置模型）
            this._setupClickHandlers(session);

            let lastTime = null;
            this.renderer.setAnimationLoop((time, frame) => {
                if (!this.isPresenting || !this.scene || !this.camera) return;
                
                // 计算 deltaTime（time 是 DOMHighResTimeStamp，单位毫秒）
                if (lastTime === null) {
                    lastTime = time;
                }
                const deltaTime = (time - lastTime) / 1000;
                lastTime = time;
                
                //  处理 hit-test 和更新可视化（每帧执行）
                if (frame && !this.modelPlaced) {
                    this._handleHitTest(frame);
                }
                
                // 更新引擎控制器（模型旋转、动画、热点等）
                if (this.engine) {
                    // 执行更新回调
                    for (const key in this.engine.onUpdateList) {
                        const cb = this.engine.onUpdateList[key];
                        if (typeof cb === 'function') cb(deltaTime);
                    }
                    
                    // 更新模型控制器
                    this.engine.modelController?.update?.(deltaTime);
                    
                    // 更新热点控制器
                    this.engine.hotspotController?.update?.(deltaTime);
                    
                    // 更新动画控制器
                    this.engine.animationController?.update?.(deltaTime);
                }
                
                // 更新场景矩阵
                this.scene.updateMatrixWorld(true);
                
                // 渲染场景
                if (this.renderer && this.scene && this.camera) {
                    const composer = this.engine?.highlightController?.getComposer?.();
                    if (composer) {
                        composer.render();
                    } else {
                        this.renderer.render(this.scene, this.camera);
                    }
                    // 渲染标签
                    this.engine?.labelRenderer?.render?.(this.scene, this.camera);
                }
            });

            //监听会话结束
            session.addEventListener('end', () => { 
                this.isPresenting = false;
                this.session = null;
                this.referenceSpace = null;
                this.viewerSpace = null;
                this.hitTestSource = null;
                this.transientHitTestSource = null;
                this.modelPlaced = false;
                this.currentHitPose = null;
                this.testReticleActive = false;
                
                //  清理可视化指示器
                this._cleanupVisualIndicators();
                
                // 停止 XR 渲染循环
                if (this.renderer) {
                    this.renderer.setAnimationLoop(null);
                }
                
                // 恢复引擎动画循环
                if (this.engine) {
                    this.engine.start();
                }
                
                this.events.emit("xr:ar:ended");
            });

            this.isPresenting = true;
            this.events.emit("xr:ar:started",{session});
            
            return true;
        }
        catch(error) {
            console.error("AR 会话启动失败:", error);
            throw error;
        }
    }

    //结束会话
    async endSession()
    {
        if(this.session) {
            await this.session.end();
        }
    }

    //  准备模型：缩放大小并初始隐藏
    _prepareModels() {
        if (!this.scene) return;
        
        this.models = [];
        
        this.scene.traverse((child) => {
            // 跳过灯光和可视化指示器
            if (child.type === 'AmbientLight' || child.type === 'DirectionalLight') return;
            if (child === this.reticle || child === this.planeIndicator || child === this.scanningIndicator) return;
            
            // 查找模型
            if (child.isGroup || child.isObject3D) {
                let hasMesh = false;
                child.traverse((obj) => {
                    if (obj.isMesh && obj.geometry) {
                        hasMesh = true;
                    }
                });
                
                // 如果是模型
                if (hasMesh && child.parent === this.scene) {
                    // 计算模型包围盒并缩放
                    const box = new Box3();
                    box.setFromObject(child);
                    const size = box.getSize(new Vector3());
                    const maxSize = Math.max(size.x, size.y, size.z);
                    
                    // 如果模型太大（超过 1 米），进行缩放
                    if (maxSize > 1.0) {
                        const scale = this.modelScale / maxSize;
                        child.scale.multiplyScalar(scale);
                    } else if (maxSize < 0.1) {
                    // 如果模型太小，适当放大
                    const scale = 0.1 / maxSize;
                    child.scale.multiplyScalar(scale);
                }
                
                // 初始隐藏模型，等待用户点击放置（参考 webxr_test 的实现）
                // 递归隐藏模型及其所有子对象
                child.visible = false;
                child.traverse((obj) => {
                    obj.visible = false;
                });
                
                // 保存模型引用到数组
                this.models.push(child);
                }
            }
        });
    }

    //  创建可视化指示器（参考 webxr_test 的实现）
    _createVisualIndicators() {
        // 1. 创建十字星（reticle）- 显示在检测到的平面上
        // 参考 webxr_test：使用内圈和外圈，更清晰
        const MODEL_TARGET_SIZE = 0.5;
        const RETICLE_SCALE = 0.25;
        const innerRadius = MODEL_TARGET_SIZE * RETICLE_SCALE * 0.8;
        const outerRadius = MODEL_TARGET_SIZE * RETICLE_SCALE * 1.2;
        const centerRadius = MODEL_TARGET_SIZE * RETICLE_SCALE * 0.5;
        
        // 创建十字星组
        const reticleGroup = new Group();
        reticleGroup.matrixAutoUpdate = false;
        reticleGroup.visible = false;
        
        // 外圈（需要旋转到水平面，贴合地面）
        const ringGeometry = new RingGeometry(innerRadius, outerRadius, 32);
        const reticleMaterial = new MeshBasicMaterial({ 
            color: 0xffffff, 
            transparent: true, 
            opacity: 0.8,
            depthWrite: false
        });
        const ring = new Mesh(ringGeometry, reticleMaterial);
        ring.rotation.x = -Math.PI / 2; 
        reticleGroup.add(ring);
        
        // 中心点（几乎贴地）
        const centerGeometry = new CircleGeometry(centerRadius, 32);
        const centerMaterial = new MeshBasicMaterial({ 
            color: 0xffffff, 
            transparent: true, 
            opacity: 1,
            depthWrite: false
        });
        const center = new Mesh(centerGeometry, centerMaterial);
        center.position.y = 0.001; // 稍微抬高，避免 z-fighting
        center.rotation.x = -Math.PI / 2; // 旋转到水平面
        reticleGroup.add(center);
        
        this.reticle = reticleGroup;
        this.scene.add(this.reticle);
        
        // 2. 创建扫描提示面片（黄色，参考 webxr_test 的实现）
        // 当未检测到平面时显示，提示用户正在扫描
        const scanningGeometry = new PlaneGeometry(1, 0.3);
        const scanningMaterial = new MeshBasicMaterial({ 
            color: 0xffff00, // 黄色
            transparent: true, 
            opacity: 0.8,
            side: 2 // DoubleSide
        });
        this.scanningIndicator = new Mesh(scanningGeometry, scanningMaterial);
        // 放置在用户前方，稍微偏上
        this.scanningIndicator.position.set(0, 0.5, -1);
        this.scanningIndicator.visible = false; // 初始隐藏，在扫描时显示
        this.scene.add(this.scanningIndicator);
        
        // 3. 移除旧的 planeIndicator，简化视觉
        if (this.planeIndicator) {
            this.scene.remove(this.planeIndicator);
            this.planeIndicator = null;
        }
    }

    //  初始化 hit-test（参考 webxr_test 的实现）
    async _initializeHitTest(session) {
        if (!this.viewerSpace && !this.referenceSpace) {
            console.warn('⚠️ 无法初始化 hit-test：缺少参考空间');
            this._showTestReticle();
            return;
        }
        
        try {
            // 方法1: 优先尝试使用 transient input hit-test
            try {
                this.transientHitTestSource = await session.requestHitTestSourceForTransientInput({
                    profile: 'generic-touchscreen'
                });
                console.log('✅ Transient input hit-test 已初始化');
            } catch (e) {
                console.log('ℹ️ Transient input hit-test 不可用，使用普通 hit-test:', e.message);
                
                // 方法2: 使用 viewer 空间进行 hit-test（参考 webxr_test 的实现）
                // 这是关键：必须使用 'viewer' 空间，而不是从 referenceSpace 创建偏移空间
                const hitTestSpace = this.viewerSpace || this.referenceSpace;
                
                if (!hitTestSpace) {
                    throw new Error('无法获取 hit-test 空间');
                }
                
                this.hitTestSource = await session.requestHitTestSource({ 
                    space: hitTestSpace 
                });
                console.log('✅ 普通 hit-test 已初始化（使用 viewer 空间）');
            }
        } catch (error) {
            console.error('❌ Hit-test 初始化失败:', error);
            // 如果都失败，使用测试模式：显示一个固定位置的十字星
            this.hitTestSource = null;
            this.transientHitTestSource = null;
            this._showTestReticle();
        }
    }

    //  处理 hit-test 并更新可视化（参考 webxr_test 的实现）
    _handleHitTest(frame) {
        if (!frame) {
            return;
        }
        
        // 如果测试模式激活，保持测试十字星显示，但确保模型隐藏（除非已放置）
        if (this.testReticleActive) {
            // 在测试模式下，如果模型未放置，确保模型隐藏（递归隐藏所有子对象）
            if (!this.modelPlaced) {
                this.models.forEach(model => {
                    model.visible = false;
                    model.traverse((obj) => {
                        obj.visible = false;
                    });
                });
            }
            return;
        }
        
        let hitPose = null;
        let hitMatrix = null;
        
        try {
            // 优先使用 transient input hit-test（更可靠）
            if (this.transientHitTestSource) {
                const hitTestResults = frame.getHitTestResultsForTransientInput(this.transientHitTestSource);
                
                // 遍历所有输入源的结果
                for (const inputSource of hitTestResults) {
                    const results = inputSource.results;
                    if (results && results.length > 0) {
                        const hit = results[0];
                        // 使用 referenceSpace（local-floor）来获取世界坐标
                        const pose = hit.getPose(this.referenceSpace);
                        if (pose) {
                            hitPose = pose;
                            hitMatrix = new Matrix4().fromArray(pose.transform.matrix);
                            break;
                        }
                    }
                }
            }
            
            // 如果 transient input 没有结果，使用普通 hit-test
            if (!hitPose && this.hitTestSource) {
                const hitTestResults = frame.getHitTestResults(this.hitTestSource);
                
                if (hitTestResults.length > 0) {
                    const hit = hitTestResults[0];
                    // 关键：使用 referenceSpace（local-floor）来获取世界坐标
                    // 虽然 hit-test source 是用 viewer 空间创建的，但获取 pose 时要用 referenceSpace
                    hitPose = hit.getPose(this.referenceSpace);
                    if (hitPose) {
                        hitMatrix = new Matrix4().fromArray(hitPose.transform.matrix);
                    }
                }
            }
            
            // 更新可视化
            if (hitPose && hitMatrix) {
                // 保存当前 hit pose 和 hit matrix（用于点击放置时使用）
                this.currentHitPose = hitPose;
                this.currentHitMatrix = hitMatrix.clone(); // 保存矩阵副本
                
                if (this.reticle) {
                    this.reticle.visible = true;
                    this.reticle.matrix.copy(hitMatrix);
                    this.reticle.matrixAutoUpdate = false;
                }
                
                // 隐藏扫描提示面片（已检测到平面）
                if (this.scanningIndicator) {
                    this.scanningIndicator.visible = false;
                }
                
                // 模型只在点击放置后才显示（参考 webxr_test 的实现，不显示预览）
                // 如果模型尚未放置，保持隐藏状态（递归隐藏所有子对象）
                if (!this.modelPlaced) {
                    this.models.forEach(model => {
                        model.visible = false; // 不显示预览，只在点击放置后显示
                        model.traverse((obj) => {
                            obj.visible = false;
                        });
                    });
                }
            } else {
                this.currentHitPose = null;
                this.currentHitMatrix = null; // 清除 hit matrix
                
                if (this.reticle) {
                    this.reticle.visible = false;
                }
                
                if (this.scanningIndicator && !this.modelPlaced) {
                    this.scanningIndicator.visible = true;
                }
                
                if (!this.modelPlaced) {
                    // 递归隐藏模型及其所有子对象
                    this.models.forEach(model => {
                        model.visible = false;
                        model.traverse((obj) => {
                            obj.visible = false;
                        });
                    });
                }
            }
        } catch (error) {
            // 记录错误以便调试
            console.warn('Hit-test 处理错误:', error);
        }
    }
    
    // 显示测试十字星（用于调试，当 hit-test 不可用时）
    _showTestReticle() {
        if (!this.reticle) {
            // 如果十字星还没创建，等待一下再试
            setTimeout(() => {
                if (this.reticle) {
                    this._showTestReticle();
                }
            }, 100);
            return;
        }
        
        // 在用户前方 1.5 米，地面高度显示测试十字星
        this.reticle.position.set(0, 0, -1.5);
        this.reticle.quaternion.set(0, 0, 0, 1);
        this.reticle.visible = true;
        this.testReticleActive = true;
        
        // 隐藏扫描提示面片（测试模式下不需要）
        if (this.scanningIndicator) {
            this.scanningIndicator.visible = false;
        }
        
        // 在测试模式下，确保模型隐藏（除非已放置）
        // 测试模式只是为了显示十字星，不应该显示模型预览
        if (!this.modelPlaced) {
            // 递归隐藏模型及其所有子对象
            this.models.forEach(model => {
                model.visible = false;
                model.traverse((obj) => {
                    obj.visible = false;
                });
            });
        }
        
        // 创建一个假的 hit pose 用于点击测试
        this.currentHitPose = {
            transform: {
                position: { x: 0, y: 0, z: -1.5 },
                orientation: { x: 0, y: 0, z: 0, w: 1 }
            }
        };
    }

    //  设置点击事件处理
    _setupClickHandlers(session) {
        // 监听选择事件（点击/触摸）
        session.addEventListener('select', () => {
            this._onSelect();
        });
        
        // 也监听 selectstart 和 selectend（用于更好的交互反馈）
        session.addEventListener('selectstart', () => {
            // 可以在这里添加按下时的视觉反馈
        });
        
        session.addEventListener('selectend', () => {
            // 点击结束
        });
        
        console.log(' 点击事件监听已设置');
    }

    //  处理点击事件（点击十字星放置模型）
    _onSelect() {
        if (this.modelPlaced) {
            // 如果已经放置，点击可以重新进入"拾取"模式（可选）
            // this.modelPlaced = false; 
            return;
        }
        
        // 如果有测试十字星，使用测试位置
        if (this.testReticleActive && this.currentHitPose) {
            this.modelPlaced = true;
            if (this.reticle) this.reticle.visible = false;
            console.log('✅ 模型已放置在测试位置');
            return;
        }
        
        if (!this.currentHitPose || !this.currentHitMatrix) {
            // 如果没有检测到平面，不允许放置
            console.warn('⚠️ 无法放置模型：未检测到平面');
            return;
        }
        
        // 确认放置：使用当前 hit matrix 固定模型位置（参考 webxr_test 的实现）
        this.modelPlaced = true;
        
        // 使用保存的 hit matrix 固定模型位置（而不是 reticle.matrix）
        this.models.forEach(model => {
            // 固定模型位置（使用 hit-test 矩阵，参考 webxr_test）
            model.matrix.copy(this.currentHitMatrix);
            model.matrix.decompose(
                model.position,
                model.quaternion,
                model.scale
            );
            model.matrixAutoUpdate = false; // 固定位置，不再自动更新
            // 显示模型及其所有子对象（点击放置后才显示）
            model.visible = true;
            model.traverse((obj) => {
                obj.visible = true;
            });
        });
        
        // 隐藏十字星
        if (this.reticle) {
            this.reticle.visible = false;
        }
        
        console.log('✅ 模型已放置在真实平面（使用 hit-test 矩阵）');
    }
    
    // 在默认位置放置模型（当 hit-test 不可用时）
    _placeModelsAtDefaultPosition() {
        const defaultTransform = {
            position: { x: 0, y: 0, z: -1.5 },
            orientation: { x: 0, y: 0, z: 0, w: 1 }
        };
        this._placeModels(defaultTransform);
    }

    //  在指定位置放置模型
    _placeModels(transform) {
        const position = new Vector3(
            transform.position.x,
            transform.position.y,
            transform.position.z
        );
        
        const quaternion = new Quaternion(
            transform.orientation.x,
            transform.orientation.y,
            transform.orientation.z,
            transform.orientation.w
        );
        
        // 更新所有模型位置并显示
        this.models.forEach(model => {
            model.position.copy(position);
            model.quaternion.copy(quaternion);
            model.visible = true;
            model.updateMatrixWorld(true);
        });
    }

    //  清理可视化指示器
    _cleanupVisualIndicators() {
        if (this.reticle) {
            this.scene.remove(this.reticle);
            this.reticle = null;
        }
        
        if (this.scanningIndicator) {
            this.scene.remove(this.scanningIndicator);
            this.scanningIndicator = null;
        }
        
        if (this.planeIndicator) {
            this.scene.remove(this.planeIndicator);
            this.planeIndicator = null;
        }
    }
}