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

            //设置渲染器会话
            this.renderer.xr.enabled = true;
            await this.renderer.xr.setSession(session);

            //确保场景背景透明
            if(this.scene) {
                this.scene.background = null;
            }

            if(this.renderer) {
                this.renderer.setClearColor(0x000000, 0);
            }

            if (this.scene) {
                this.scene.traverse((child) => {
                    // 查找模型（有几何体的对象）
                    if (child.isGroup || child.isObject3D) {
                        let hasMesh = false;
                        child.traverse((obj) => {
                            if (obj.isMesh && obj.geometry) {
                                hasMesh = true;
                            }
                        });
                        
                        // 如果是模型，调整位置到用户前方
                        if (hasMesh && child.parent === this.scene) {
                            // 检查是否在原点附近（可能是刚加载的模型）
                            const pos = child.position;
                            if (Math.abs(pos.x) < 0.1 && Math.abs(pos.z) < 0.1) {
                                // 移动到用户前方 2 米，高度 1.5 米
                                child.position.set(0, 1.5, -2);
                                console.log('✅ AR: 模型已移动到视野内', child.position);
                            }
                        }
                    }
                });
            }

            //监听会话结束
            session.addEventListener('end', () => { 
                this.isPresenting = false;
                this.session = null;
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