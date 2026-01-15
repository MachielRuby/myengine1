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
    MeshStandardMaterial
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
            
            //设置参考空间
            const referenceSpace = await session.requestReferenceSpace('local-floor');

            //  停止引擎的动画循环，避免与 XR 渲染冲突
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



            //  调整模型位置
            if (this.scene) {
                this.scene.traverse((child) => {
                    // 跳过灯光
                    if (child.type === 'AmbientLight' || child.type === 'DirectionalLight') return;
                    
                    // 查找模型
                    if (child.isGroup || child.isObject3D) {
                        let hasMesh = false;
                        child.traverse((obj) => {
                            if (obj.isMesh && obj.geometry) {
                                hasMesh = true;
                            }
                        });
                        
                        // 如果是模型，调整位置到用户前方
                        if (hasMesh && child.parent === this.scene) {
                            child.position.set(0, 0, -1);
                            child.visible = true;
                            // child.frustumCulled = false;
                            child.updateMatrixWorld(true);
                        }
                    }
                });
            }

            // 在 XR 模式下，必须手动调用 render 并更新控制器
            let lastTime = null;
            this.renderer.setAnimationLoop((time, frame) => {
                if (!this.isPresenting || !this.scene || !this.camera) return;
                
                // 计算 deltaTime（time 是 DOMHighResTimeStamp，单位毫秒）
                if (lastTime === null) {
                    lastTime = time;
                }
                const deltaTime = (time - lastTime) / 1000;
                lastTime = time;
                
                //  更新引擎控制器（模型旋转、动画、热点等）
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
                
                //  渲染场景
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
                
                //  停止 XR 渲染循环
                if (this.renderer) {
                    this.renderer.setAnimationLoop(null);
                }
                
                //  恢复引擎动画循环
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
}