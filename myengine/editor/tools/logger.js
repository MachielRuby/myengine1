/**
 * 日志工具 - 完整的单文件日志工具
 * @author GunGod
 */

// 日志级别常量
const LOG_LEVELS = {
    INFO: 'info',
    SUCCESS: 'success',
    WARN: 'warn',
    ERROR: 'error',
    DEBUG: 'debug'
};

// 时间格式常量
const TIME_FORMAT = {
    PAD_LENGTH: 2,
    MILLISECOND_PAD_LENGTH: 3,
    PAD_CHAR: '0'
};

/**
 * 日志工具类
 * @namespace Logger
 */
const Logger = (() => {
    /**
     * 日志样式配置
     * @type {Object}
     */
    const styles = {
        [LOG_LEVELS.INFO]: 'color: #2196F3; font-weight: bold',
        [LOG_LEVELS.SUCCESS]: 'color: #4CAF50; font-weight: bold',
        [LOG_LEVELS.WARN]: 'color: #FF9800; font-weight: bold',
        [LOG_LEVELS.ERROR]: 'color: #F44336; font-weight: bold',
        [LOG_LEVELS.DEBUG]: 'color: #9C27B0; font-weight: bold'
    };

    /**
     * 日志图标配置
     * @type {Object}
     */
    const icons = {
        [LOG_LEVELS.INFO]: 'ℹ',
        [LOG_LEVELS.SUCCESS]: '✓',
        [LOG_LEVELS.WARN]: '⚠',
        [LOG_LEVELS.ERROR]: '✗',
        [LOG_LEVELS.DEBUG]: '⚙'
    };

    /**
     * 获取格式化的时间字符串
     * @returns {string} 格式化的时间字符串 (HH:mm:ss.SSS)
     * @private
     */
    const getTimeString = () => {
        const now = new Date();
        const hours = now.getHours().toString().padStart(TIME_FORMAT.PAD_LENGTH, TIME_FORMAT.PAD_CHAR);
        const minutes = now.getMinutes().toString().padStart(TIME_FORMAT.PAD_LENGTH, TIME_FORMAT.PAD_CHAR);
        const seconds = now.getSeconds().toString().padStart(TIME_FORMAT.PAD_LENGTH, TIME_FORMAT.PAD_CHAR);
        const milliseconds = now.getMilliseconds().toString().padStart(TIME_FORMAT.MILLISECOND_PAD_LENGTH, TIME_FORMAT.PAD_CHAR);
        return `${hours}:${minutes}:${seconds}.${milliseconds}`;
    };

    /**
     * 统一的日志格式化函数
     * @param {string} type - 日志类型
     * @param {string} icon - 日志图标
     * @param {string} style - 日志样式
     * @param {string} msg - 日志消息
     * @param {Array} args - 额外参数
     * @private
     */
    const formatLog = (type, icon, style, msg, args) => {
        if (typeof msg !== 'string') {
            console.warn('[Logger] 日志消息应为字符串类型');
            return;
        }
        
        const timeStr = getTimeString();
        console.log(`%c[${icon}] ${timeStr} ${type}:`, style, msg, ...args);
    };

    return {
        /**
         * 输出信息日志
         * @param {string} msg - 日志消息
         * @param {...*} args - 额外参数
         */
        info: (msg, ...args) => 
            formatLog('信息', icons[LOG_LEVELS.INFO], styles[LOG_LEVELS.INFO], msg, args),
        
        /**
         * 输出成功日志
         * @param {string} msg - 日志消息
         * @param {...*} args - 额外参数
         */
        success: (msg, ...args) => 
            formatLog('成功', icons[LOG_LEVELS.SUCCESS], styles[LOG_LEVELS.SUCCESS], msg, args),
        
        /**
         * 输出警告日志
         * @param {string} msg - 日志消息
         * @param {...*} args - 额外参数
         */
        warn: (msg, ...args) => 
            formatLog('警告', icons[LOG_LEVELS.WARN], styles[LOG_LEVELS.WARN], msg, args),
        
        /**
         * 输出错误日志
         * @param {string} msg - 日志消息
         * @param {...*} args - 额外参数
         */
        error: (msg, ...args) => 
            formatLog('错误', icons[LOG_LEVELS.ERROR], styles[LOG_LEVELS.ERROR], msg, args),
        
        /**
         * 输出调试日志
         * @param {string} msg - 日志消息
         * @param {...*} args - 额外参数
         */
        debug: (msg, ...args) => 
            formatLog('调试', icons[LOG_LEVELS.DEBUG], styles[LOG_LEVELS.DEBUG], msg, args)
    };
})();

/**
 * 导出日志工具
 * @module Logger
 */
export { Logger };