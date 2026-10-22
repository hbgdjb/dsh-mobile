'use strict';

/**
 * Node 侧的通道客户端。
 *
 * ============ 为什么是"Node 连 Java"而不是反过来 ============
 *
 * Java 侧先起一个 loopback 监听端口，把端口和口令通过 argv 传给 Node。
 * Node 起来后主动连过去。
 *
 * 反过来的话（Java 连 Node）有个致命的启动顺序问题：
 * Node 是用 node::Start 拉起来的，它启动时会立刻执行 main.js —— 那时
 * Java 还没机会去连（nativeStart 是阻塞调用，Java 线程正卡在上面）。
 * 只能反过来：Java 先监听，Node 再连。
 *
 * ============ 协议 ============
 *
 * 行分隔 JSON（NDJSON）。
 *
 *   发往 Java：{"id":"n1","method":"plugin.list","params":{}}
 *   收到响应：{"id":"n1","ok":true,"result":{...}}
 *              {"id":"n1","ok":false,"error":"原因"}
 *   收到推送：{"event":"tools.changed","data":{...}}
 *
 *   Java 反向调用：{"id":"j1","method":"host.fs.read","params":{...}}
 *   回应：         {"id":"j1","ok":true,"result":{...}}
 */

const net = require('net');

/** 收到响应后多久还没回就认为超时（毫秒）。 */
const CALL_TIMEOUT_MS = 30000;

/**
 * 建立与 Java 侧的连接。
 *
 * @param {number} port    Java 监听的端口
 * @param {string} token   连接口令，防止同机别的应用误连
 * @param {object} handlers 事件处理器表
 * @returns {object} 通道对象
 */
function connect(port, token, handlers) {
  const pending = new Map();
  const listeners = new Map();
  let socket = null;
  let seq = 0;
  let closed = false;
  /** 重连定时器（避免重复安排）。 */
  let reconnectTimer = null;

  function nextId() {
    seq += 1;
    return 'n' + seq;
  }

  function emit(event, data) {
    const list = listeners.get(event);
    if (!list) return;
    for (const fn of list) {
      try {
        fn(data);
      } catch (e) {
        console.error('[dsh-node] 事件处理失败：', e && e.message);
      }
    }
  }

  function send(obj) {
    if (!socket || socket.destroyed) return false;
    try {
      socket.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (e) {
      console.error('[dsh-node] 发送失败：', e && e.message);
      return false;
    }
  }

  /**
   * 调 Java 侧的方法。
   *
   * @returns {Promise<any>} 成功时 resolve 结果，失败时 reject Error
   */
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('宿主响应超时：' + method));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      if (!send({ id, method, params: params || {} })) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('通道未连接'));
      }
    });
  }

  /** 反向调用：Node 请 Java 代做一件事（如读工作区文件）。 */
  function request(method, params) {
    return call(method, params);
  }

  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.error('[dsh-node] 收到非法 JSON');
      return;
    }

    // Java 反向调用 Node
    if (msg.method && msg.id) {
      const fn = handlers && handlers[msg.method];
      if (!fn) {
        send({ id: msg.id, ok: false, error: '宿主没有这个方法：' + msg.method });
        return;
      }
      Promise.resolve()
        .then(() => fn(msg.params || {}))
        .then((result) => {
          send({ id: msg.id, ok: true, result: result === undefined ? null : result });
        })
        .catch((err) => {
          send({ id: msg.id, ok: false, error: String((err && err.message) || err) });
        });
      return;
    }

    // 响应
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) {
        p.resolve(msg.result);
      } else {
        p.reject(new Error(String(msg.error || '未知错误')));
      }
      return;
    }

    // 主动推送
    if (msg.event) {
      emit(msg.event, msg.data);
      const fn = handlers && handlers['on:' + msg.event];
      if (fn) {
        try {
          fn(msg.data);
        } catch (e) {
          console.error('[dsh-node] 推送处理失败：', e && e.message);
        }
      }
    }
  }

  function connectNow() {
    socket = net.connect({ port, host: '127.0.0.1' }, () => {
      closed = false;
      console.log('[dsh-node] 已连上宿主通道');
      // 第一条消息带口令，Java 校验通过才继续
      send({ hello: true, token });
      if (handlers && handlers.onConnect) {
        try {
          handlers.onConnect();
        } catch (e) {
          console.error('[dsh-node] 连接回调失败：', e && e.message);
        }
      }
    });

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      // NDJSON：按换行切分。buffer 里可能同时有多条。
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) handleLine(line);
      }
      // 防止对端发来无换行的巨块把内存吃光
      if (buffer.length > 4 * 1024 * 1024) {
        console.error('[dsh-node] 收到超长未分帧数据，断开');
        socket.destroy();
      }
    });

    socket.on('error', (err) => {
      console.error('[dsh-node] 通道错误：', err && err.message);
    });

    socket.on('close', () => {
      closed = true;
      console.warn('[dsh-node] 通道已断开');
      // 所有还在等的请求一次性拒掉 —— 不能让它们永远挂着
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('通道已断开'));
      }
      pending.clear();
      if (handlers && handlers.onClose) handlers.onClose();
      // 自动重连。
      //
      // ============ 为什么必须重连 ============
      //
      // Java 侧的 Node 崩溃后会被服务自动重启（退避重启），
      // 新进程会带着同一个端口重新连过来。
      // 如果这里不重连，Node 就永远连不上 —— 表现为
      // 「插件运行时明明是运行中的，工具却一直调不通」。
      //
      // 退避 1s → 2s → 4s，最多 30s：避免宿主刚起来时
      // 双方都在等对方，形成疯狂重连。
      if (reconnectTimer) return;
      let delay = 1000;
      const tryReconnect = () => {
        reconnectTimer = null;
        if (closed === false) return; // 已经被人重连上了
        connectNow();
      };
      reconnectTimer = setTimeout(tryReconnect, delay);
      delay = Math.min(delay * 2, 30000);
      if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
    });
  }

  connectNow();

  return {
    call,
    request,
    send,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return true;
    },
    isClosed() {
      return closed;
    },
  };
}

module.exports = { connect, CALL_TIMEOUT_MS };
