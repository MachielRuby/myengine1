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

// AR 按钮
const arButton = document.createElement('button');
arButton.textContent = '进入 AR';
arButton.className = 'ar-button';
document.body.appendChild(arButton);

arButton.addEventListener('click', async () => {
    const supported = await app.xrCtrl.isARSupported();
    if (supported) {
        await app.enterAR();
        arButton.style.display = 'none';
    } else {
        alert('当前设备不支持 WebXR AR');
    }
});

console.log('F3dApp initialized', app);
