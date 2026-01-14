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
    try {
        // 检查 xrCtrl 是否初始化
        if (!app.xrCtrl) {
            console.error('XR 控制器未初始化');
            alert('AR 功能初始化失败，请刷新页面重试');
            return;
        }

        // 显示加载状态
        arButton.disabled = true;
        arButton.textContent = '检查 AR 支持...';

        // 检查 AR 支持
        const supported = await app.xrCtrl.isARSupported();
        
        if (!supported) {
            arButton.disabled = false;
            arButton.textContent = '进入 AR';
            alert('当前设备或浏览器不支持 WebXR AR。\n\n请确保：\n1. 使用支持的浏览器（Chrome Android 或 Safari iOS）\n2. 设备支持 AR 功能\n3. 通过 HTTPS 访问');
            return;
        }

        // 尝试启动 AR
        arButton.textContent = '启动 AR...';
        try {
            const success = await app.enterAR();
            
            if (success) {
                arButton.style.display = 'none';
            } else {
                arButton.disabled = false;
                arButton.textContent = '进入 AR';
                alert('启动 AR 失败，请检查设备权限或稍后重试');
            }
        } catch (error) {
            // 捕获并显示详细错误信息
            arButton.disabled = false;
            arButton.textContent = '进入 AR';
            
            const errorMessage = error.message || '未知错误';
            console.error('AR 启动错误详情:', {
                message: error.message,
                name: error.name,
                stack: error.stack,
                originalError: error.originalError
            });
            
            // 显示友好的错误提示
            let userMessage = '启动 AR 失败\n\n';
            if (errorMessage.includes('不支持 WebXR')) {
                userMessage += '请使用支持的浏览器：\n• Chrome Android\n• Safari iOS\n• Edge Android';
            } else if (errorMessage.includes('不支持 AR')) {
                userMessage += '请确保：\n1. 使用支持的浏览器\n2. 设备支持 AR 功能\n3. 通过 HTTPS 或 localhost 访问';
            } else if (errorMessage.includes('安全错误') || errorMessage.includes('SecurityError')) {
                userMessage += '安全限制：\n1. 必须通过 HTTPS 或 localhost 访问\n2. 必须由用户手势触发（点击按钮）';
            } else {
                userMessage += errorMessage;
            }
            
            userMessage += '\n\n请查看浏览器控制台获取详细错误信息';
            alert(userMessage);
        }
    } catch (error) {
        console.error('AR 按钮点击错误:', error);
        arButton.disabled = false;
        arButton.textContent = '进入 AR';
        alert('启动 AR 时发生错误: ' + (error.message || '未知错误'));
    }
});

console.log('F3dApp initialized', app);
