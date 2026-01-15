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

            // ✅ 添加调试：检查场景中的对象
            console.log('🔍 AR 场景调试信息:', {
                sceneExists: !!this.scene,
                sceneChildren: this.scene?.children?.length || 0,
                children: this.scene?.children?.map(c => ({
                    name: c.name || c.type,
                    position: c.position,
                    visible: c.visible
                })).slice(0, 5)
            });

            // ✅ 创建一个测试立方体（确认渲染是否工作）
            if (this.scene && !this._testCube) {
                const { BoxGeometry, MeshStandardMaterial, Mesh } = await import('three');
                const geometry = new BoxGeometry(0.5, 0.5, 0.5);
                const material = new MeshStandardMaterial({ color: 0xff0000 }); // 红色
                this._testCube = new Mesh(geometry, material);
                this._testCube.position.set(0, 1.5, -2); // 用户前方2米，高度1.5米
                this._testCube.name = 'AR_TestCube';
                this.scene.add(this._testCube);
                console.log('✅ 已添加测试红色立方体到场景');
            }

            // ✅ 调整模型位置
            if (this.scene) {
                let modelFound = false;
                this.scene.traverse((child) => {
                    // 跳过测试立方体
                    if (child.name === 'AR_TestCube') return;
                    
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
                            modelFound = true;
                            // 移动到用户前方 2 米，高度 1.5 米
                            child.position.set(0, 1.5, -2);
                            child.visible = true;
                            child.updateMatrixWorld(true);
                            console.log('✅ AR: 模型已移动到视野内', {
                                name: child.name || child.type,
                                position: child.position,
                                visible: child.visible
                            });
                        }
                    }
                });
                
                if (!modelFound) {
                    console.warn('⚠️ AR: 场景中没有找到模型！');
                }
            }

            // ✅ 确保 Three.js 渲染循环运行
            // Three.js 的 setSession 会自动启动渲染循环
            // 但我们可以添加一个回调来确认
            this.renderer.setAnimationLoop(() => {
                // Three.js 会自动渲染，这里只是确认循环在运行
            });

            //监听会话结束
            session.addEventListener('end', () => { 
                this.isPresenting = false;
                this.session = null;
                
                // 清理测试立方体
                if (this._testCube && this.scene) {
                    this.scene.remove(this._testCube);
                    this._testCube.geometry.dispose();
                    this._testCube.material.dispose();
                    this._testCube = null;
                }
                
                this.events.emit("xr:ar:ended");
            });

            this.isPresenting = true;
            this.events.emit("xr:ar:started",{session});
            
            console.log('✅ AR 会话已启动');
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