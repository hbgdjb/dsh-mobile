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
const { createHostServices } = require('./host-services');
const { createHost, diagnose } = require('./plugin-host');
const { createHmrService } = require('./hmr-service');
const { createLlmService } = require('./llm-service');
const { runAdapterStream } = require('./llm-chat');

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

/**
 * `llm` 服务 —— 模型供应方注册表。
 *
 * 插件注册的 adapter 落在 Node 侧的路由表里；路由集一变，
 * 就通过通道把新路由集报给页面，由页面并进手机端的模型表。
 */
const llm = createLlmService({
  ctx: container,
  log: (level, scope, message) => log(level, scope, message),
  onRoutes: (routes) => {
    if (!channel) return;
    channel.send({ event: 'llm.routes', data: { routes } });
  },
});

/** 插件注册的工具要转发给页面。 */
function pushTools(tools) {
  if (!channel) return;
  channel.send({
    event: 'tools.changed',
    data: { tools },
  });
}

/* ---------------- 模型调用（第 2 步：让插件模型真的能跑） ---------------- */

/**
 * 正在跑的对话：callId → { controller }。
 *
 * 为什么要记：页面上的「停止生成」要能真的停下来。
 * 不记的话，用户点了停止，HTTP 那头还在烧额度 —— 只是页面不显示了。
 */
const chats = new Map();

function sendEvent(event, data) {
  if (!channel) return;
  channel.send({ event, data });
}

/**
 * 把 adapter 的 chunk 攒一小会儿再推给页面。
 *
 * 文本增量是逐 token 来的，一条一推意味着一次回答要跨进程走几千趟
 * （Java → evaluateJavascript），手机上这是实打实的卡顿来源。
 *
 * 控制类 chunk（block-start / block-end / usage / finish）立即发 ——
 * 它们决定 UI 什么时候切状态，攒一下用户就看得出延迟。
 */
function makeChunkSink(callId) {
  let pending = [];
  let timer = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending.length) return;
    const chunks = pending;
    pending = [];
    sendEvent('llm.chunk', { callId, chunks });
  };

  return {
    push(chunk) {
      pending.push(chunk);
      const urgent =
        chunk.type === 'block-start' ||
        chunk.type === 'block-end' ||
        chunk.type === 'usage' ||
        chunk.type === 'finish';
      if (urgent) flush();
      else if (!timer) timer = setTimeout(flush, 40);
    },
    flush,
  };
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
    // 诊断信息在 host 还没建好时也要给 —— 那正是最需要它的时刻。
    const diagnostics = diagnose(workspace);
    if (!host) return { plugins: [], diagnostics };
    // 每个插件的真实加载状态 ——
    // active（已加载）/ pending（依赖未齐，cordis 语义下停在 PENDING）/
    // failed（加载失败）。
    //
    // 之前这里用的是 `host.loadedCount() > 0`，那对**每一个**插件都返回同一个值，
    // 完全没有信息量 —— 用户看不出「这个插件到底装上没有」。
    const status = new Map();
    for (const s of host.listStatus()) {
      status.set(s.id, s);
    }
    const list = host.listPlugins(workspace).map((p) => {
      const st = status.get(p.id);
      return {
        id: p.id,
        name: p.name,
        version: p.version,
        kind: p.kind,
        loaded: !!st && st.status === 'active',
        status: st ? st.status : 'not-loaded',
        pendingDeps: st ? st.pendingDeps : [],
        // 失败原因 —— 没有它，界面只能说「没装上」，
        // 用户根本不知道是语法错、依赖缺，还是别的。
        error: st ? st.error || '' : '',
        moduleKind: st ? st.moduleKind || '' : '',
      };
    });
    // 连同「Node 眼里的目录长什么样」一起报上去 ——
    // 列表为空时界面要靠它说清楚是目录不存在、还是目录里没东西。
    return { plugins: list, diagnostics };
  },

  /** Java 调用：加载全部插件。 */
  'plugins.load': async () => {
    if (!host) throw new Error('插件宿主还没准备好');
    const r = await host.loadAll();
    pushTools(host.listTools());
    return r;
  },

  /**
   * Java 调用：只加载还没加载过的插件。
   *
   * 装完一个插件后用它 —— 不能用 plugins.load：
   * 那会把已加载的插件再 apply 一遍，出现两个实例同时跑、
   * 宿主服务注册撞车的问题。
   */
  'plugins.loadnew': async () => {
    if (!host) throw new Error('插件宿主还没准备好');
    const r = await host.loadNew();
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

  /**
   * Java 调用：热重载插件。
   *
   * 传 id 就重载那一个，不传就重载全部。
   *
   * ============ 为什么不能靠 plugins.load 实现 ============
   *
   * `plugins.load` 只会再跑一遍 apply，**不卸载旧的**。
   * 于是：
   *   · 模块缓存没破 —— 代码改了但跑的还是旧的（假重载）
   *   · 旧 fiber 还在 —— 同一个插件有两个实例同时在跑
   *   · 宿主服务的注册会撞车（settings.register 抛「命名空间已注册」）
   *
   * 所以重载必须是「卸载 → 破缓存 → 重新加载」三步，
   * 而这三步都在 plugin-host.js 里。
   */
  'plugins.reload': async (params) => {
    if (!host) throw new Error('插件宿主还没准备好');
    const id = params && params.id ? String(params.id) : '';
    const r = id ? await host.reloadOne(id) : await host.reloadAll();
    pushTools(host.listTools());
    return r;
  },

  /** Java 调用：调用插件注册的工具。 */
  'tool.call': async (params) => {
    if (!host) throw new Error('插件宿主还没准备好');
    const name = String((params && params.name) || '');
    if (!name) throw new Error('缺少工具名');
    const args = (params && params.args) || {};
    return await host.callTool(name, args);
  },

  /**
   * Java 调用：一个插件的详情 —— 它到底带来了什么。
   *
   * 装完插件，用户第一个问题就是这个。列表里只有「名字 + 版本 + 工具数」，
   * 看不到它注册了哪些工具、提供了哪些模型、卡在哪个依赖上。
   */
  'plugins.detail': async (params) => {
    const id = String((params && params.id) || '');
    if (!id) throw new Error('缺少插件 id');
    if (!host) throw new Error('插件宿主还没准备好');

    const metas = host.listPlugins(workspace);
    const meta = metas.find((p) => p.id === id) || null;
    const status = host.listStatus().find((s) => s.id === id) || null;
    const tools = host.listTools().filter((t) => t.pluginId === id);

    // 归属：注册 adapter 时记录了当前作用域的 pluginId。
    // 老插件（升级前注册的）没有这个字段，所以可能是空的 —— 那就不猜。
    const routes = llm.listRoutes().filter((r) => r.pluginId === id);
    const detailRoutes = [];
    for (const r of routes) {
      let models = [];
      let error = '';
      try {
        // adapter 的 listModels 可能会真的发网络请求，不能无限等
        models = await Promise.race([
          llm.listModels(r.provider),
          new Promise((_, reject) => setTimeout(() => reject(new Error('查询超时（4s）')), 4000)),
        ]);
      } catch (e) {
        error = String((e && e.message) || e);
      }
      detailRoutes.push({ provider: r.provider, name: r.name, models, error });
    }

    return {
      plugin: meta
        ? {
            id: meta.id,
            name: meta.name,
            version: meta.version,
            kind: meta.kind,
            // 入口在手机上的绝对路径 —— 排查「它到底加载了哪个文件」时有用
            entry: meta.entry || '',
            dir: meta.dir || '',
            status: status ? status.status : 'not-loaded',
            pendingDeps: status ? status.pendingDeps || [] : [],
            // 失败原因 —— 没有它，详情页只能说「没加载起来」，
            // 用户看到的是一个状态而不是一个可处理的问题。
            error: status ? status.error || '' : '',
            moduleKind: status ? status.moduleKind || '' : '',
          }
        : { id, status: 'not-loaded' },
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description || '',
      })),
      routes: detailRoutes,
      routeCount: llm.listRoutes().length,
    };
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
    llmRoutes: llm.routeCount(),
  }),

  /** Java 调用：ping（连通性自检）。 */
  'ping': async () => ({ pong: true, at: new Date().toISOString() }),

  /**
   * Java 调用：问某个供应方提供了哪些模型。
   *
   * 用 `llm.listModels(provider)` —— 直接问 adapter，
   * 返回的每一项自带 provider，路由名天然一致。
   */
  'llm.models': async (params) => {
    const provider = String((params && params.provider) || '');
    if (!provider) throw new Error('缺少 provider');
    const models = await llm.listModels(provider);
    return { provider, models };
  },

  /** Java 调用：列出模型供应方。 */
  'llm.routes': async () => ({
    routes: llm.listRoutes(),
    directory: llm.listDirectory(),
    namespaces: llm.listDiscoveryNamespaces(),
  }),

  /**
   * Java 调用：让插件提供的模型真的跑一次。
   *
   * ============ 为什么是「立刻返回 + 事件推送」 ============
   *
   * 通道的调用是**一问一答**（channel.js 里的 call 有 30 秒超时）。
   * 一次生成可能跑几分钟，把它做成一个长 Promise 会有两个后果：
   *   1. 30 秒必然超时；
   *   2. 页面在拿到结果前一个字都看不到 —— 流式就没意义了。
   *
   * 所以这里只负责「起跑」，正文通过 `llm.chunk` 逐批推、收尾通过
   * `llm.done` 报。页面侧按 callId 对号入座。
   */
  'llm.chat': async (params) => {
    const callId = String((params && params.callId) || '');
    if (!callId) throw new Error('缺少 callId');
    if (chats.has(callId)) throw new Error('这个 callId 已经在跑了');

    const provider = String((params && params.provider) || '');
    const model = String((params && params.model) || '');
    if (!provider) throw new Error('缺少 provider');
    if (!model) throw new Error('缺少 model');

    const adapter = llm.getAdapter(provider);
    if (!adapter) {
      // 说清楚为什么 —— 最常见的原因是插件没加载起来，
      // 而不是「模型不存在」。
      throw new Error(`没有这个供应方：${provider}（插件可能没加载起来，看 plugins.list 的状态）`);
    }

    const controller = new AbortController();
    const sink = makeChunkSink(callId);
    chats.set(callId, { controller });

    (async () => {
      try {
        const r = await runAdapterStream({
          adapter,
          provider,
          model,
          messages: (params && params.messages) || [],
          tools: (params && params.tools) || [],
          system: (params && params.system) || '',
          temperature: params && params.temperature,
          maxTokens: params && params.maxTokens,
          reasoningEffort: params && params.reasoningEffort,
          signal: controller.signal,
          onChunk: (chunk) => sink.push(chunk),
        });
        sink.flush();
        if (r.failure) {
          sendEvent('llm.done', {
            callId,
            ok: false,
            error: String(r.failure.message || '模型调用失败'),
            code: String(r.failure.code || ''),
            usage: r.usage || null,
          });
        } else {
          sendEvent('llm.done', {
            callId,
            ok: true,
            finish: r.finish,
            usage: r.usage || null,
          });
        }
      } catch (e) {
        sink.flush();
        const aborted = controller.signal.aborted;
        sendEvent('llm.done', {
          callId,
          // 用户主动停的不算错误，页面据此区分「报错」和「我停的」
          ok: false,
          aborted,
          error: String((e && e.message) || e),
          code: aborted ? 'ABORTED' : 'TRANSPORT',
        });
      } finally {
        chats.delete(callId);
      }
    })();

    return { started: true, callId };
  },

  /** Java 调用：停掉一次正在跑的生成。 */
  'llm.abort': async (params) => {
    const callId = String((params && params.callId) || '');
    const running = chats.get(callId);
    if (!running) return { aborted: false };
    try {
      running.controller.abort();
    } catch (e) {
      /* 已经结束了 */
    }
    return { aborted: true };
  },
};

if (port > 0) {
  channel = connect(port, token, {
    ...handlers,
    onConnect: async () => {
      log('info', '', `已连上宿主通道，端口 ${port}`);
      // 先把 plugins/ 建出来。不建的话，Node 报「未找到插件」，
      // 而用户连「该把文件放哪」都无从确认 —— 目录存在本身就是一句说明书。
      try {
        fs.mkdirSync(path.join(workspace, 'plugins'), { recursive: true });
      } catch (e) {
        log('warn', '', '创建 plugins 目录失败：' + ((e && e.message) || e));
      }
      // 插件宿主会自己把 tools 服务装进容器（工具表归它管）
      host = createHost({
        workspace,
        container,
        log: (level, scope, message) => log(level, scope, message),
        onTools: pushTools,
      });
      // ============ 桌面版宿主服务 ============
      //
      // 这几个是插件 inject 里最常写的一些名字。缺一个，插件整棵 fiber
      // 就停在 PENDING —— apply 不执行，也不报错。
      //
      // 接口照抄桌面版包里的实现（dsh-settings / dsh-web / dsh-commands /
      // dsh-system-prompt / dsh-session-query），不是我们编的。
      const hostServices = createHostServices({
        ctx: container.root,
        workspace,
        // 设置文件放应用数据目录，不进工作区 —— 那是用户的文件空间
        dataDir,
        log: (level, scope, message) => log(level, scope, message),
      });
      container.provide('settings', hostServices.settings);
      container.provide('web', hostServices.web);
      container.provide('commands', hostServices.commands);
      container.provide('systemPrompt', hostServices.systemPrompt);
      container.provide('sessionQuery', hostServices.sessionQuery);

      // 其余宿主服务装进容器
      container.provide('slots', services.slots);
      container.provide('sessions', services.sessions);
      container.provide('modelDirectories', services.modelDirectories);
      container.provide('remote', services.remote);
      // 模型供应方注册表 —— 供 dsh-our-free-model 这类插件注册模型
      container.provide('llm', llm);
      // ============ 热重载服务 ============
      //
      // 插件改了自己的代码，想立刻生效时调 `ctx.hmr.reloadSelf()`。
      //
      // 不进 INTRINSIC_SERVICES —— 插件必须在 inject 里声明 'hmr' 才拿得到，
      // 和 settings / web / commands 一个规矩（cordis 语义：不声明不给）。
      container.provide(
        'hmr',
        createHmrService({
          ctx: container.root,
          host,
          // 默认只允许重载自己。放开跨插件等于让任意插件能掀掉
          // 别的插件的注册（宿主服务、模型路由……），那是个安全口子。
          allowOthers: false,
        })
      );

      // 主动加载插件
      try {
        const r = await host.loadAll();
        log('info', '', `插件加载完成：成功 ${r.loaded} 个，失败 ${r.failed.length} 个`);
        const wp = hostServices.web.listProviders();
        if (wp.search.length || wp.fetch.length) {
          log('info', '', `网页 provider：搜索 ${wp.search.length} 个，抓取 ${wp.fetch.length} 个`);
        }
        if (hostServices.commands.list().length) {
          log('info', '', `插件注册的命令：${hostServices.commands.list().map((c) => c.name).join('、')}`);
        }
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
// 把插件目录也打出来 —— 「未找到插件」时第一件要核对的就是它
// 和页面看到的是不是同一个地方。
log('info', '', `插件目录 ${path.join(workspace, 'plugins')}`);

setInterval(beat, 30000);

process.on('uncaughtException', (err) => {
  log('error', '', '未捕获异常：' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', (err) => {
  log('error', '', '未处理的 rejection：' + err);
});
