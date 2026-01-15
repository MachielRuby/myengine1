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
        
        await app.enterAR();
        arButton.style.display = 'none';
    } catch (error) {
        console.error('AR 启动失败:', error);
        alert('启动 AR 失败: ' + error.message);
        arButton.disabled = false;
        arButton.textContent = '进入 AR';
    }
});
