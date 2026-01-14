/**
 * 事件总线类
 * 提供事件的注册、触发、移除等功能，支持链式调用
 * @author GunGod
 * @version 1.0.0
 * @class
 */
export class EventBus {
    /**
     * 创建事件总线实例
     */
    constructor() {
      /**
       * 事件存储对象
       * @type {Object<string, Function[]>}
       */
      this.events = {};
    }
  
    /**
     * 添加事件监听
     * @public
     * @param {string} event - 事件名称
     * @param {Function} callback - 回调函数
     * @returns {Function} 返回取消监听的函数
     * @throws {Error} 当参数无效时抛出错误
     */
    on(event, callback) {
      try {
        this._validateEventName(event);
        this._validateCallback(callback);
        
        if (!this.events[event]) {
          this.events[event] = [];
        }
        
        this.events[event].push(callback);
        return () => this.off(event, callback);
      } catch (error) {
        this._handleError('on', error);
        throw error;
      }
    }
  
    /**
     * 触发事件
     * @public
     * @param {string} event - 事件名称
     * @param {*} data - 传递给回调函数的数据
     * @returns {EventBus} 返回实例自身，支持链式调用
     * @throws {Error} 当事件名称无效时抛出错误
     */
    emit(event, data) {
      try {
        this._validateEventName(event);
        
        const callbacks = this.events[event];
        if (callbacks) {
          callbacks.forEach(callback => {
            try {
              callback(data);
            } catch (callbackError) {
              this._handleError('emit.callback', callbackError);
            }
          });
        }
        return this;
      } catch (error) {
        this._handleError('emit', error);
        throw error;
      }
    }
  
    /**
     * 移除事件监听
     * @public
     * @param {string} event - 事件名称
     * @param {Function} [callback] - 要移除的回调函数，不提供则移除该事件的所有监听
     * @returns {EventBus} 返回实例自身，支持链式调用
     * @throws {Error} 当参数无效时抛出错误
     */
    off(event, callback) {
      try {
        this._validateEventName(event);
        if (callback) {
          this._validateCallback(callback);
        }
        
        const callbacks = this.events[event];
        if (!callbacks) return this;
        
        if (callback) {
          this.events[event] = callbacks.filter(cb => cb !== callback);
          if (this.events[event].length === 0) {
            delete this.events[event];
          }
        } else {
          delete this.events[event];
        }
        
        return this;
      } catch (error) {
        this._handleError('off', error);
        throw error;
      }
    }
  
    /**
     * 一次性事件监听
     * @public
     * @param {string} event - 事件名称
     * @param {Function} callback - 回调函数
     * @returns {Function} 返回取消监听的函数
     * @throws {Error} 当参数无效时抛出错误
     */
    once(event, callback) {
      try {
        this._validateEventName(event);
        this._validateCallback(callback);
        
        const onceWrapper = (data) => {
          callback(data);
          this.off(event, onceWrapper);
        };
        return this.on(event, onceWrapper);
      } catch (error) {
        this._handleError('once', error);
        throw error;
      }
    }
    
    /**
     * 移除所有事件监听
     * @public
     * @param {string} [event] - 指定要移除的事件名称，不提供则移除所有事件
     * @returns {EventBus} 返回实例自身，支持链式调用
     */
    removeAllListeners(event) {
      if (event) {
        delete this.events[event];
      } else {
        this.events = {};
      }
      return this;
    }

    /**
     * 验证事件名称
     * @private
     * @param {string} event - 事件名称
     * @throws {Error} 当事件名称无效时抛出错误
     */
    _validateEventName(event) {
      if (typeof event !== 'string' || event.trim() === '') {
        throw new Error('EventBus: 事件名称必须是非空字符串');
      }
    }

    /**
     * 验证回调函数
     * @private
     * @param {Function} callback - 回调函数
     * @throws {Error} 当回调函数无效时抛出错误
     */
    _validateCallback(callback) {
      if (typeof callback !== 'function') {
        throw new Error('EventBus: 回调函数必须是函数类型');
      }
    }

    /**
     * 统一错误处理
     * @private
     * @param {string} method - 方法名称
     * @param {Error} error - 错误对象
     */
    _handleError(method, error) {
      const errorMessage = `EventBus.${method}: ${error.message}`;
      console.error(errorMessage, error);
    }
  }