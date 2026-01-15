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
        this.hitTestSource = null;
        this.transientHitTestSource = null; // transient input hit-test
        this.models = []; // 存储所有模型引用
        this.modelScale = 0.5; // 默认缩放比例（缩小到 50%）
        this.modelPlaced = false; // 模型是否已放置
        this.testReticleActive = false; // 测试十字星是否激活
        
        // 可视化相关
        this.reticle = null; // 十字星（reticle）
        this.planeIndicator = null; // 平面指示器
        this.currentHitPose = null; // 当前检测到的 hit pose
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
    async startAR()
    {
        if( this.isPresenting) {
            console.warn("AR 会话已启动");
            return false;
        }

        if(!this.renderer || !this.renderer.xr) {
            throw new Error("XR渲染器未初始化");
        }

        try {
            const session = await navigator.xr.requestSession('immersive-ar', {
                requiredFeatures: ['local-floor'],
                optionalFeatures: ['hand-tracking','hit-test', 'bounded-floor']
            });

            this.session = session;
            
            // 保存参考空间到实例属性
            this.referenceSpace = await session.requestReferenceSpace('local-floor');

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

            //  准备模型（缩放和初始隐藏）
            this._prepareModels();

            //  创建可视化指示器
            this._createVisualIndicators();

            //  初始化 hit-test（立即开始平面检测）
            await this._initializeHitTest(session);
            
            // ✅ 确保测试十字星显示（如果 hit-test 不可用）
            if (!this.testReticleActive && (!this.hitTestSource && !this.transientHitTestSource)) {
                // 延迟一下，确保十字星已创建
                setTimeout(() => {
                    this._showTestReticle();
                }, 200);
            }
            
            // ✅ 确保测试十字星显示（如果 hit-test 不可用）
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
            if (child === this.reticle || child === this.planeIndicator) return;
            
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
                    
                    // ✅ 关键：初始隐藏模型，等待点击放置
                    child.visible = false;
                    child.updateMatrixWorld(true);
                    
                    // 保存模型引用到数组
                    this.models.push(child);
                }
            }
        });
    }

    //  创建可视化指示器
    _createVisualIndicators() {
        // 1. 创建十字星（reticle）- 显示在检测到的平面上
        const ringGeometry = new RingGeometry(0.02, 0.03, 32);
        const circleGeometry = new CircleGeometry(0.005, 32);
        const reticleMaterial = new MeshBasicMaterial({ 
            color: 0xffffff, 
            transparent: true, 
            opacity: 0.8,
            depthWrite: false
        });
        
        // 外圈
        const outerRing = new Mesh(ringGeometry, reticleMaterial);
        // 中心点
        const centerDot = new Mesh(circleGeometry, reticleMaterial);
        centerDot.position.z = 0.001;
        
        this.reticle = new Group();
        this.reticle.add(outerRing);
        this.reticle.add(centerDot);
        this.reticle.visible = false; // 初始隐藏，检测到平面后显示
        this.scene.add(this.reticle);
        
        // 2. 创建平面指示器（半透明平面，显示检测到的平面）
        const planeGeometry = new PlaneGeometry(0.3, 0.3);
        const planeMaterial = new MeshBasicMaterial({ 
            color: 0x00ff00, 
            transparent: true, 
            opacity: 0.2,
            side: 2, // DoubleSide
            depthWrite: false
        });
        this.planeIndicator = new Mesh(planeGeometry, planeMaterial);
        this.planeIndicator.rotation.x = -Math.PI / 2; // 水平放置
        this.planeIndicator.visible = false;
        this.scene.add(this.planeIndicator);
        
    }

    //  初始化 hit-test
    async _initializeHitTest(session) {
        if (!this.referenceSpace) return;
        
        try {
            // 方法1: 优先尝试使用 transient input hit-test（从屏幕中心点检测，更可靠）
            try {
                this.transientHitTestSource = await session.requestHitTestSourceForTransientInput({
                    profile: 'generic-touchscreen'
                });
            } catch (e) {
                // 如果 transient input 不可用，使用普通 hit-test
                const viewerSpace = await this.referenceSpace.getOffsetReferenceSpace(
                    new XRRigidTransform(
                        { x: 0, y: 0, z: 0, w: 1 },
                        { x: 0, y: 0, z: 0 }
                    )
                );
                
                this.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
            }
        } catch (error) {
            // 如果都失败，使用测试模式：显示一个固定位置的十字星
            this.hitTestSource = null;
            this.transientHitTestSource = null;
            this._showTestReticle();
        }
    }

    //  处理 hit-test 并更新可视化
    _handleHitTest(frame) {
        if (!frame) {
            return;
        }
        
        // 如果测试模式激活，保持测试十字星显示
        if (this.testReticleActive) {
            return;
        }
        
        let hitPose = null;
        
        try {
            // 优先使用 transient input hit-test（更可靠）
            if (this.transientHitTestSource) {
                const hitTestResults = frame.getHitTestResultsForTransientInput(this.transientHitTestSource);
                
                // 遍历所有输入源的结果
                for (const inputSource of hitTestResults) {
                    const results = inputSource.results;
                    if (results && results.length > 0) {
                        const hit = results[0];
                        const pose = hit.getPose(this.referenceSpace);
                        if (pose) {
                            hitPose = pose;
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
                    hitPose = hit.getPose(this.referenceSpace);
                }
            }
            
            // 更新可视化
            if (hitPose) {
                // 保存当前 hit pose
                this.currentHitPose = hitPose;
                
                const position = new Vector3(
                    hitPose.transform.position.x,
                    hitPose.transform.position.y,
                    hitPose.transform.position.z
                );
                
                const orientation = new Quaternion(
                    hitPose.transform.orientation.x,
                    hitPose.transform.orientation.y,
                    hitPose.transform.orientation.z,
                    hitPose.transform.orientation.w
                );
                
                // 更新十字星位置
                if (this.reticle) {
                    this.reticle.position.copy(position);
                    this.reticle.quaternion.copy(orientation);
                    this.reticle.visible = true;
                }
                
                // 更新平面指示器位置
                if (this.planeIndicator) {
                    this.planeIndicator.position.copy(position);
                    this.planeIndicator.quaternion.copy(orientation);
                    this.planeIndicator.rotation.x = -Math.PI / 2; // 保持水平
                    this.planeIndicator.visible = true;
                }
            } else {
                // 没有检测到平面
                this.currentHitPose = null;
                
                // 隐藏指示器
                if (this.reticle) {
                    this.reticle.visible = false;
                }
                
                if (this.planeIndicator) {
                    this.planeIndicator.visible = false;
                }
            }
        } catch (error) {
            // 静默处理错误
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
            // 模型已放置，忽略后续点击
            return;
        }
        
        // 如果有测试十字星，使用测试位置
        if (this.testReticleActive && this.currentHitPose) {
            this._placeModels(this.currentHitPose.transform);
            if (this.reticle) {
                this.reticle.visible = false;
            }
            if (this.planeIndicator) {
                this.planeIndicator.visible = false;
            }
            this.modelPlaced = true;
            return;
        }
        
        if (!this.currentHitPose) {
            // 如果没有检测到平面，在默认位置放置模型
            this._placeModelsAtDefaultPosition();
            this.modelPlaced = true;
            return;
        }
        
        // 放置模型到检测到的位置
        this._placeModels(this.currentHitPose.transform);
        
        // 隐藏十字星和平面指示器
        if (this.reticle) {
            this.reticle.visible = false;
        }
        
        if (this.planeIndicator) {
            this.planeIndicator.visible = false;
        }
        
        this.modelPlaced = true;
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
        
        if (this.planeIndicator) {
            this.scene.remove(this.planeIndicator);
            this.planeIndicator = null;
        }
    }
}