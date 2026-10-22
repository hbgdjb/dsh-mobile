'use strict';

/**
 * DSH Mobile 的 Node 运行时入口。
 *
 * ============ 它是什么 ============
 *
 * DSH（桌面版）的插件是 cordis 插件：导出 `apply(ctx)`，用 node:fs、
 * node:http、cordis 容器。要在手机上跑它们，先得有一个真 Node。
 *
 * 这个脚本是那个 Node 的「宿主」，干四件事：
 *   1. 连上 Java 侧的通道（端口与口令由 argv 传入）；
 *   2. 建 cordis 迷你容器，提供宿主服务；
 *   3. 加载插件目录里的插件；
 *   4. 把插件注册的工具转发给页面 —— AI 助手因此多出一批能力。
 *
 * ============ argv 约定 ============
 *
 *   argv[2]  运行时目录（filesDir/node）
 *   argv[3]  通道端口（Java 侧监听）
 *   argv[4]  通道口令
 *   argv[5]  工作区根目录（插件代码在这里）
 *
 * ============ 为什么端口要由 Java 传进来 ============
 *
 * nativeStart 是阻塞调用 —— Java 线程卡在上面等 Node 退出。
 * 如果让 Node 去连 Java，Java 得先知道端口；而 Java 又得等 Node 起来
 * 才能拿到端口，成了死结。
 *
 * 所以反过来：Java 先起监听拿到端口，通过 argv 传给 Node，
 * Node 起来后主动连回去。
 */

const fs = require('fs');
const path = require('path');
const { connect } = require('./channel');
const { createContainer } = require('./cordis-lite');
const { createServices } = require('./ctx-services');
const { createHost } = require('./plugin-host');

const dataDir = process.argv[2] || process.cwd();
const port = parseInt(process.argv[3] || '0', 10);
const token = process.argv[4] || '';
const workspace = process.argv[5] || dataDir;

const alivePath = path.join(dataDir, 'alive.json');

/** 日志出口。Node 的 stdout 在 Android 上不可见，所以同时写进文件。 */
const logFile = path.join(dataDir, 'node.log');

function log(level, scope, message) {
  const tag = scope ? `[${scope}] ` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${tag}${message}`;
  try {
    // 只留最近 200 KB，免得日志把手机存储吃满
    let size = 0;
    try {
      size = fs.statSync(logFile).size;
    } catch (e) {
      size = 0;
    }
    if (size > 200 * 1024) {
      fs.writeFileSync(logFile, '');
    }
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) {
    /* 日志失败不能影响主流程 */
  }
  if (level === 'error' || level === 'warn') {
    console.error('[dsh-node]', tag + message);
  } else {
    console.log('[dsh-node]', tag + message);
  }
}

function beat() {
  const payload = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    at: new Date().toISOString(),
    dataDir,
    workspace,
    channelPort: port,
  };
  try {
    fs.writeFileSync(alivePath, JSON.stringify(payload, null, 2));
  } catch (err) {
    log('error', '', `心跳写入失败：${err && err.message}`);
  }
}

/* ---------------- 宿主服务与容器 ---------------- */

const container = createContainer({
  log: (level, scope, message) => log(level, scope, message),
});

/** 插件注册的工具要转发给页面。 */
function pushTools(tools) {
  if (!channel) return;
  channel.send({
    event: 'tools.changed',
    data: { tools },
  });
}

/** 插件工具注册服务依赖 host，先建 host 再把服务塞回容器。 */
let host = null;
const services = createServices({
  workspace,
  log: (level, scope, message) => log(level, scope, message),
});

/* ---------------- 通道 ---------------- */

let channel = null;

const handlers = {
  /** Java 调用：列出插件。 */
  'plugins.list': async () => {
    if (!host) return { plugins: [] };
    const list = host.listPlugins(workspace).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      kind: p.kind,
      loaded: host.loadedCount() > 0,
    }));
    return { plugins: list };
  },

  /** Java 调用：加载全部插件。 */
  'plugins.load': async () => {
    if (!host) throw new Error('插件宿主还没准备好');
    const r = await host.loadAll();
    pushTools(host.listTools());
    return r;
  },

  /** Java 调用：卸载全部插件。 */
  'plugins.unload': async () => {
    if (!host) return { ok: true };
    host.unloadAll();
    pushTools([]);
    return { ok: true };
  },

  /** Java 调用：调用插件注册的工具。 */
  'tool.call': async (params) => {
    if (!host) throw new Error('插件宿主还没准备好');
    const name = String((params && params.name) || '');
    if (!name) throw new Error('缺少工具名');
    const args = (params && params.args) || {};
    return await host.callTool(name, args);
  },

  /** Java 调用：运行时信息。 */
  'runtime.info': async () => ({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    dataDir,
    workspace,
    pluginCount: host ? host.loadedCount() : 0,
    toolCount: host ? host.listTools().length : 0,
  }),

  /** Java 调用：ping（连通性自检）。 */
  'ping': async () => ({ pong: true, at: new Date().toISOString() }),
};

if (port > 0) {
  channel = connect(port, token, {
    ...handlers,
    onConnect: async () => {
      log('info', '', `已连上宿主通道，端口 ${port}`);
      // 插件宿主会自己把 tools 服务装进容器（工具表归它管）
      host = createHost({
        workspace,
        container,
        log: (level, scope, message) => log(level, scope, message),
        onTools: pushTools,
      });
      // 其余宿主服务装进容器
      container.provide('slots', services.slots);
      container.provide('sessions', services.sessions);
      container.provide('modelDirectories', services.modelDirectories);
      container.provide('remote', services.remote);

      // 主动加载插件
      try {
        const r = await host.loadAll();
        log('info', '', `插件加载完成：成功 ${r.loaded} 个，失败 ${r.failed.length} 个`);
        for (const f of r.failed) log('warn', f.id, f.error);
        pushTools(host.listTools());
      } catch (e) {
        log('error', '', '插件加载异常：' + (e && e.message));
      }
    },
    onClose: () => {
      log('warn', '', '通道断开');
    },
  });
} else {
  log('warn', '', '没有拿到通道端口，只做本地心跳');
}

/* ---------------- 保活 ---------------- */

beat();
log('info', '', `启动成功 node=${process.version} arch=${process.arch}`);
log('info', '', `运行时目录 ${dataDir}`);
log('info', '', `工作区 ${workspace}`);

setInterval(beat, 30000);

process.on('uncaughtException', (err) => {
  log('error', '', '未捕获异常：' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', (err) => {
  log('error', '', '未处理的 rejection：' + err);
});
