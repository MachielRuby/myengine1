import './style.css'
import { F3dApp } from '../myengine/f3dApp.js'

// 初始化应用
const app = new F3dApp({
    container: 'app',
    backgroundColor: '#263238', // 设置深色背景
    lights: {
        ambient: { color: 0xffffff, intensity: 0.5 },
        main: { color: 0xffffff, intensity: 1, position: { x: 5, y: 10, z: 7 }, castShadow: true }
    },
    camera: {
        position: { x: 3, y: 3, z: 5 }
    }
});

// 加载模型
app.loadModel('/model/01.glb', {
    autoScale: true,
    alignToGround: true
}).then(() => {
    console.log('Model loaded successfully');
}).catch(err => {
    console.error('Failed to load model:', err);
});


console.log('F3dApp initialized', app);

// AR 按钮
const arButton = document.createElement('button');
arButton.textContent = '进入 AR';
arButton.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 24px;
    background: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    z-index: 1000;
`;
document.body.appendChild(arButton);

arButton.addEventListener('click', async () => {
    try {
        arButton.disabled = true;
        arButton.textContent = '启动 AR...';
        
        const supported = await app.xrCtrl.isARSupported();
        if (!supported) {
            alert('当前设备不支持 AR');
            arButton.disabled = false;
            arButton.textContent = '进入 AR';
            return;
        }
        
        // 获取 overlay 元素
        const overlay = document.getElementById('ar-overlay');
        
        await app.enterAR({
            domOverlay: { root: overlay }
        });
        
        // 显示 overlay
        overlay.style.display = 'block';
        arButton.style.display = 'none';

        // 绑定滑动条事件
        const slider = document.getElementById('scale-slider');
        const scaleLabel = slider.previousElementSibling; // 获取 1x 标签
        
        // 记录初始缩放比例
        let baseScale = null;
        
        // 尝试获取模型，增加重试机制或查找逻辑
        let model = app.getModel('/model/01.glb');
        if (!model) {
            console.warn('Model not found by ID, searching in scene...');
            // 备用方案：遍历场景查找 Mesh
            app.scene.traverse(child => {
                if (child.isMesh && !model) {
                    // 找到最顶层的父对象（排除场景本身）
                    let parent = child;
                    while (parent.parent && parent.parent !== app.scene) {
                        parent = parent.parent;
                    }
                    model = parent;
                }
            });
        }

        if (model) {
            baseScale = model.scale.clone();
            console.log('Base scale captured:', baseScale);
            // 更新 UI 显示当前状态
            scaleLabel.textContent = `1.0x`;
        } else {
            console.error('Model not found for scaling!');
            scaleLabel.textContent = 'Error';
            scaleLabel.style.color = 'red';
        }

        // 监听滑动事件
        slider.oninput = (e) => {
            e.stopPropagation();
            const factor = parseFloat(e.target.value);
            
            // 更新标签文本
            if (baseScale) {
                 scaleLabel.textContent = factor.toFixed(1) + 'x';
            }

            if (model && baseScale) {
                // 基于初始大小进行缩放
                model.scale.copy(baseScale).multiplyScalar(factor);
                
                // 强制更新矩阵，确保渲染立即生效
                model.updateMatrix();
                model.updateMatrixWorld(true);
            }
        };

        // 防止触摸事件穿透到 AR 场景
        slider.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: false });
        slider.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });

    } catch (error) {
        console.error('AR 启动失败:', error);
        alert('启动 AR 失败: ' + error.message);
        arButton.disabled = false;
        arButton.textContent = '进入 AR';
    }
});
