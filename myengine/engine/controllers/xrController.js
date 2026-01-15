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

            // ✅ 关键：停止引擎的动画循环，避免与 XR 渲染冲突
            if (this.engine) {
                this.engine.stop();
                console.log('✅ 已停止引擎动画循环');
            }

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

            // ✅ 创建一个超大的测试立方体（确认渲染是否工作）
            // 使用 MeshBasicMaterial 不需要灯光，更容易看到
            if (this.scene && !this._testCube) {
                const { BoxGeometry, MeshBasicMaterial } = await import('three');
                const geometry = new BoxGeometry(2, 2, 2); // 2米 x 2米，超级大！
                const material = new MeshBasicMaterial({ 
                    color: 0xff0000  // 红色，不需要灯光
                });
                this._testCube = new Mesh(geometry, material);
                // 放在用户前方1米，高度0米（地面高度）
                this._testCube.position.set(0, 0, -1);
                this._testCube.name = 'AR_TestCube';
                this._testCube.visible = true;
                this._testCube.frustumCulled = false;
                this.scene.add(this._testCube);
            }

            // ✅ 调整模型位置 - 放在用户前方
            if (this.scene) {
                this.scene.traverse((child) => {
                    // 跳过测试立方体和灯光
                    if (child.name === 'AR_TestCube' || child.type === 'AmbientLight' || child.type === 'DirectionalLight') return;
                    
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
                            // 移动到用户前方 1 米，高度 0 米（地面）
                            child.position.set(0, 0, -1);
                            child.visible = true;
                            child.frustumCulled = false;
                            child.updateMatrixWorld(true);
                        }
                    }
                });
            }

            // ✅ 关键：设置 Three.js XR 渲染循环
            // 在 XR 模式下，必须手动调用 render
            this.renderer.setAnimationLoop((time, frame) => {
                if (!this.isPresenting || !this.scene || !this.camera) return;
                
                // 更新场景矩阵
                this.scene.updateMatrixWorld(true);
                
                // ✅ 必须手动调用 render（Three.js XR 需要）
                // 确保场景和相机正确传递
                if (this.renderer && this.scene && this.camera) {
                    this.renderer.render(this.scene, this.camera);
                }
            });

            //监听会话结束
            session.addEventListener('end', () => { 
                this.isPresenting = false;
                this.session = null;
                
                // ✅ 停止 XR 渲染循环
                if (this.renderer) {
                    this.renderer.setAnimationLoop(null);
                }
                
                // ✅ 恢复引擎动画循环
                if (this.engine) {
                    this.engine.start();
                    console.log('✅ 已恢复引擎动画循环');
                }
                
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