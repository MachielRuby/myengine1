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

// 监听 AR 放置事件，放置模型到指定位置
app.xrCtrl?.events.on('xr:place', async (data) => {
    const { matrix, position, hasHitTest } = data;
    
    // 获取当前场景中的模型（假设已经加载了模型）
    const models = app.models;
    if (models.size === 0) {
        console.warn('没有可放置的模型');
        // 显示提示
        const message = hasHitTest 
            ? '✅ 检测到平面！点击屏幕放置模型' 
            : '⚠️ 未检测到平面，将在相机前方2米处放置模型';
        console.log(message);
        return;
    }
    
    // 获取第一个模型
    const firstModelId = models.keys().next().value;
    const modelData = models.get(firstModelId);
    
    if (modelData && modelData.object) {
        // 克隆模型（避免移动原模型）
        const modelToPlace = modelData.object.clone();
        
        // 放置模型到AR空间（如果有hit-test才创建锚点）
        try {
            const anchor = await app.xrCtrl.placeObjectAtHit(modelToPlace, matrix, hasHitTest);
            
            if (anchor) {
                console.log('✅ 模型已放置到AR空间，并创建了锚点');
            } else {
                console.log(hasHitTest 
                    ? '✅ 模型已放置到AR空间（未创建锚点）' 
                    : '⚠️ 模型已放置在相机前方（降级模式）');
            }
        } catch (error) {
            console.error('放置模型失败:', error);
        }
    }
});

// 监听 hit-test 状态变化，显示提示
app.xrCtrl?.events.on('xr:hit-test:results', () => {
    console.log('✅ 检测到平面，白色十字星已显示');
});

app.xrCtrl?.events.on('xr:hit-test:failed', () => {
    console.log('⚠️ Hit-test 不可用，将使用降级模式（相机前方位置）');
});

// 也可以直接监听点击事件来放置模型
app.xrCtrl?.events.on('xr:object:placed', (data) => {
    console.log('对象已放置:', data);
});

console.log('F3dApp initialized', app);
