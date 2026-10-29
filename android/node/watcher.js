'use strict';

/**
 * 插件目录的自动重载。
 *
 * ============ 它解决什么 ============
 *
 * 写完插件要手动点「重载」，改一行代码、切出去、点一下、切回来 ——
 * 在手机上这个来回特别烦。这个模块盯着 plugins/ 目录，
 * 文件一改就自动重载对应的插件。
 *
 * ============ 三个必须处理的坑 ============
 *
 * 1. 编辑器不是原子写入
 *    保存时常见的是「清空 → 写 → 再写一遍」。第一次写入的瞬间
 *    文件是空的或半截的，这时候重载一定失败（语法错误）。
 *    所以不能一有事件就动，得等目录**稳定下来**：
 *    连续两次采样的 mtime/size 完全一致才认为写完了。
 *
 * 2. 一次保存会触发好几个事件
 *    fs.watch 在 Linux 上同一个文件常报 2-3 次。
 *    所以先做时间窗防抖（默认 400ms），窗口内的事件合并成一次。
 *
 * 3. 重载期间又改了文件
 *    重载是异步的（读文件、清缓存、重新 apply）。这期间用户又保存了，
 *    直接并发会撞上 cordis 的全局作用域串号（见 plugin-host 的 reloadChain）。
 *    所以同一个插件在一轮重载没结束时，只记一个「还得再来一次」，
 *    等这轮结束再跑。
 *
 * ============ 默认关闭 ============
 *
 * 监听会常驻一个 inotify 句柄，而且用户可能并不想要
 * 「改一下文件插件就重启」。所以必须显式打开。
 */

const fs = require('fs');
const path = require('path');

/** 事件之后等这么久没有新事件才动手（毫秒）。 */
const DEBOUNCE_MS = 400;

/**
 * 防抖的最长等待。
 *
 * ============ 为什么必须有这个上限 ============
 *
 * 纯防抖会被"一直在写"卡死：某个进程每 100ms 写一次文件，
 * 防抖窗口每 400ms 就被重置一次，于是永远不触发 ——
 * 既不重载，也不报错，用户完全不知道发生了什么。
 *
 * 所以超过这个时长就直接动手，稳定性交给 waitStable 判断：
 * 它要么等到文件写完（正常保存），要么明确说"一直在变，跳过"。
 */
const MAX_DEBOUNCE_MS = 1500;

/** 检查目录是否稳定的间隔。 */
const STABLE_POLL_MS = 120;

/** 最多等这么久还没稳定就放弃这一次（有进程在狂写时不要无限等）。 */
const STABLE_MAX_MS = 3000;

/** 一次签名计算最多看多少个文件，防止在大目录上卡住。 */
const MAX_FILES = 400;

/**
 * 忽略的路径。
 *
 * node_modules 一定要排 —— 插件依赖装完会写入上千个文件，
 * 每个都触发一次重载的话，装 npm 依赖那几分钟里设备会一直卡。
 */
const IGNORE = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])\.DS_Store$/,
  /~$/,
  /\.swp$/,
  /\.tmp$/,
  /(^|[\\/])\.#/,
];

function ignored(file) {
  return IGNORE.some((re) => re.test(file));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 目录的「指纹」：文件列表 + 大小 + mtime。
 *
 * 两次采样一致就认为写完了。只比 mtime 不够 ——
 * 某些编辑器保存后会保留 mtime，只改变大小。
 */
function signature(dir) {
  const parts = [];
  let count = 0;

  function walk(d) {
    let names;
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (count >= MAX_FILES) return;
      const full = path.join(d, name);
      if (ignored(full)) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else {
        count += 1;
        parts.push(`${name}:${st.size}:${Math.round(st.mtimeMs)}`);
      }
    }
  }

  walk(dir);
  return parts.join('|');
}

/**
 * 建一个监听器。
 *
 * @param {object} opts
 *   opts.workspace  工作区根目录
 *   opts.host       插件宿主
 *   opts.log        日志 (level, scope, message)
 *   opts.send       推送给页面 (event, data)
 * @returns {object} { start, stop, status, notify }
 */
function createWatcher(opts) {
  const workspace = opts.workspace;
  const host = opts.host;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const send = typeof opts.send === 'function' ? opts.send : () => {};

  const pluginsDir = path.join(workspace, 'plugins');

  /** 每个插件一条：{ timer, busy, again, lastAt, lastError } */
  const jobs = new Map();

  let watcher = null;
  let running = false;
  let startedAt = 0;
  let events = 0;
  let reloads = 0;
  let lastEventAt = 0;
  /** 最近一次启动失败的原因（页面要显示"为什么监听没起来"）。 */
  let startError = '';

  /**
   * 从改动路径反查插件。
   *
   * 找不到清单也要给出目录名 —— 那说明是**新装的插件**，
   * 它的 apply 还没跑过，listPlugins 里可能还没有它。
   *
   * @returns {{id:string, dir:string, known:boolean}|null}
   */
  function pluginFor(file) {
    const rel = path.relative(pluginsDir, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const dirName = rel.split(path.sep)[0];
    const dir = path.join(pluginsDir, dirName);

    let metas = [];
    try {
      metas = host.listPlugins(workspace) || [];
    } catch {
      metas = [];
    }
    const hit = metas.find((m) => path.resolve(m.dir) === path.resolve(dir));
    if (hit) return { id: hit.id, dir, known: true };
    return { id: dirName, dir, known: false };
  }

  /** 等目录稳定。稳定返回 true。 */
  async function waitStable(dir) {
    let prev = null;
    for (let waited = 0; waited <= STABLE_MAX_MS; waited += STABLE_POLL_MS) {
      const sig = signature(dir);
      if (prev !== null && sig === prev) return true;
      prev = sig;
      await sleep(STABLE_POLL_MS);
    }
    return false;
  }

  /** 真正跑一次重载。 */
  async function run(entry, job) {
    if (job.busy) {
      // 上一轮还没完 —— 记一笔，等它完了再来
      job.again = true;
      return;
    }
    job.busy = true;
    try {
      // 目录没了 = 插件被删了
      if (!fs.existsSync(entry.dir)) {
        const r = host.unloadOne ? host.unloadOne(entry.id) : { ok: false };
        if (r && r.ok) {
          log('info', entry.id, '目录已删除，插件已卸载');
          send('watch.unloaded', { id: entry.id });
        }
        return;
      }

      const ok = await waitStable(entry.dir);
      if (!ok) {
        job.lastError = '文件一直在变，跳过这次自动重载';
        log('warn', entry.id, job.lastError);
        send('watch.error', { id: entry.id, error: job.lastError });
        return;
      }

      send('watch.reloading', { id: entry.id });
      const r = await host.reloadOne(entry.id);
      job.lastAt = Date.now();
      reloads += 1;

      if (r && r.ok) {
        job.lastError = '';
        log('info', entry.id, `自动重载完成（${r.mode || 'unknown'}）`);
        send('watch.reloaded', { id: entry.id, mode: r.mode || '', at: job.lastAt });
      } else {
        job.lastError = (r && r.error) || '重载失败';
        log('error', entry.id, `自动重载失败：${job.lastError}`);
        send('watch.error', { id: entry.id, error: job.lastError });
      }
    } catch (e) {
      job.lastError = (e && e.message) || String(e);
      log('error', entry.id, `自动重载异常：${job.lastError}`);
      send('watch.error', { id: entry.id, error: job.lastError });
    } finally {
      job.busy = false;
      if (job.again) {
        job.again = false;
        // 期间又改过：再排一次，仍然走防抖
        schedule(entry);
      }
    }
  }

  /** 防抖后触发。 */
  function schedule(entry) {
    let job = jobs.get(entry.id);
    if (!job) {
      job = { timer: null, busy: false, again: false, firstAt: 0, lastAt: 0, lastError: '' };
      jobs.set(entry.id, job);
    }
    if (!job.firstAt) job.firstAt = Date.now();

    // 一直在写：不再等静默，直接交给稳定性检查 ——
    // 否则防抖窗口被无限重置，什么都不会发生
    if (Date.now() - job.firstAt >= MAX_DEBOUNCE_MS) {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
      job.firstAt = 0;
      run(entry, job);
      return;
    }

    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      job.timer = null;
      job.firstAt = 0;
      run(entry, job);
    }, DEBOUNCE_MS);
  }

  /** 收到一个文件改动。 */
  function onChange(file) {
    events += 1;
    lastEventAt = Date.now();
    if (ignored(file)) return;

    const entry = pluginFor(file);
    if (!entry) return;
    schedule(entry);
  }

  /** 开始监听。 */
  function start() {
    if (running) return { ok: true, already: true };
    try {
      fs.mkdirSync(pluginsDir, { recursive: true });
    } catch (e) {
      /* 已存在 */
    }

    try {
      watcher = fs.watch(pluginsDir, { recursive: true }, (evt, file) => {
        if (!file) return;
        onChange(path.join(pluginsDir, String(file)));
      });
      watcher.on('error', (e) => {
        log('error', '', `目录监听出错：${(e && e.message) || e}`);
        send('watch.error', { id: '', error: `监听出错：${(e && e.message) || e}` });
      });
    } catch (e) {
      // Linux 上 recursive 从 Node 19.1 起支持；老内核 / 老 Node 会抛。
      // 这里如实报错，不假装开起来了。
      const msg = `无法监听插件目录：${(e && e.message) || e}`;
      startError = msg;
      log('error', '', msg);
      return { ok: false, error: msg };
    }

    running = true;
    startError = '';
    startedAt = Date.now();
    log('info', '', `已开始监听插件目录：${pluginsDir}`);
    send('watch.state', { running: true, dir: pluginsDir });
    return { ok: true };
  }

  /** 停止监听。 */
  function stop() {
    if (!running) return { ok: true, already: true };
    try {
      if (watcher) watcher.close();
    } catch {
      /* 已经关了 */
    }
    watcher = null;
    running = false;
    for (const job of jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
    }
    jobs.clear();
    log('info', '', '已停止监听插件目录');
    send('watch.state', { running: false, dir: pluginsDir });
    return { ok: true };
  }

  /** 当前状态。 */
  function status() {
    const rows = [];
    for (const [id, job] of jobs.entries()) {
      rows.push({
        id,
        busy: !!job.busy,
        pending: !!job.timer || !!job.again,
        lastAt: job.lastAt || 0,
        lastError: job.lastError || '',
      });
    }
    return {
      running,
      error: startError,
      dir: pluginsDir,
      startedAt,
      events,
      reloads,
      lastEventAt,
      plugins: rows,
    };
  }

  /**
   * 手动喂一个改动（测试用）。
   *
   * 走的是与 fs.watch 完全相同的那条路径 ——
   * 测试里不用真的去写文件等 inotify。
   */
  function notify(file) {
    onChange(String(file));
  }

  return { start, stop, status, notify, pluginsDir };
}

module.exports = { createWatcher, DEBOUNCE_MS };
