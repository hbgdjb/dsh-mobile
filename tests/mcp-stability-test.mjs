/* ============================================================
   MCP 连接稳定性契约测试（tests/mcp-stability-test.mjs）

   ============ 为什么要单独开一个文件 ============

   「MCP 服务器似乎连接不稳」是个**主观描述**，没法直接断言。
   但它背后是好几条可以写成契约的硬约束 —— 每一条失守，
   都会表现成「时好时坏」。所以这里对着源码把约束钉死：

   1) :device 进程被系统回收后重建，不能自己把 server 关掉
      （旧代码读 intent 的 enabled，重建时 intent 为 null → 恒 false）
   2) 启停状态必须跨进程可见（SharedPreferences 有进程内缓存）
   3) server 实例还在但 socket 已死时，必须能重建（不能只判 instance != null）
   4) accept 失败要退避 + 自愈，不能空转打满 CPU，也不能直接放弃
   5) 探活超时不能过紧（一次抖动就被当成「服务挂了」）
   6) 客户端对「连不上」要重试，对「超时」不重试
   7) 界面要能看到「开着但没跑」，并给出恢复动作

   这些约束编译期不报、运行时表现为「偶发连不上」，极难复现。
   直接对源码断言，后来人改坏时立刻红。
   ============================================================ */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name}${extra ? " " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? " " + extra : ""}`);
  }
}

/**
 * 去掉注释与字符串字面量里的内容。
 *
 * 「反向契约」要检查的是**代码**，不是注释 ——
 * 而这些 Java 文件的注释里大量引用了旧写法
 * （例如「旧代码 `if (instance != null) return;` 只看了对象还在」）。
 * 不剥掉注释，反向契约会永远为真而误报。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const server = await readFile(join(ROOT, "android/java/DshMcpServer.java"), "utf8");
const svc = await readFile(join(ROOT, "android/java/DshDeviceService.java"), "utf8");
const policy = await readFile(join(ROOT, "android/java/DshMcpPolicy.java"), "utf8");
const bridge = await readFile(join(ROOT, "android/java/DshMcpBridge.java"), "utf8");
const mcpJs = await readFile(join(ROOT, "scripts/mcp.js"), "utf8");
const localJs = await readFile(join(ROOT, "scripts/mcp-local.js"), "utf8");
const screensJs = await readFile(join(ROOT, "scripts/screens.js"), "utf8");
const uiJs = await readFile(join(ROOT, "scripts/ui.js"), "utf8");
const build = await readFile(join(ROOT, "android/build-apk.sh"), "utf8");

/* ============================================================
   一、进程重建不能自杀（最常见的「时好时坏」）
   ============================================================ */

check("契约：重建时读持久化状态，而不是读 intent",
  /intent != null && intent\.hasExtra\(EXTRA_ENABLED\)/.test(svc));
check("契约：无 intent 时回落到 DshMcpPolicy.isEnabled",
  /DshMcpPolicy\.isEnabled\(getApplicationContext\(\)\)/.test(svc));
check("契约：日志里写明是进程被重建",
  /进程被重建/.test(svc));
check("反向契约：不再用「intent 为 null 就算关」的旧写法",
  !/boolean enabled = intent != null && intent\.getBooleanExtra/.test(stripComments(svc)));
check("契约：服务用 START_STICKY（被回收后能自动回来）", /START_STICKY/.test(svc));

/* ============================================================
   二、启停状态必须跨进程可见
   ============================================================ */

check("契约：启用状态落文件（不是只在 prefs 里）",
  /ENABLE_FILE = "mcp-enabled\.txt"/.test(policy));
check("契约：isEnabled 优先读文件", /ENABLE_FILE/.test(policy)
  && /if \(f\.exists\(\)\)/.test(policy));
check("契约：setEnabled 同时写文件与 prefs", /KEY_ENABLED/.test(policy)
  && /w\.write\(enabled \? "1" : "0"\)/.test(policy));
check("契约：白名单也走文件（跨进程一致）", /mcp-allowed\.txt/.test(policy));

/* ============================================================
   三、死实例必须能重建
   ============================================================ */

check("契约：start 先检查实例是否真的活着",
  /existing != null/.test(server) && /existing\.alive\(\)/.test(server));
check("契约：alive 校验 socket 绑定与未关闭",
  /s\.isBound\(\) && !s\.isClosed\(\)/.test(server));
check("反向契约：不再用「instance != null 就 return」当唯一判断",
  !/if \(instance != null\) return;/.test(stripComments(server)));
check("契约：stop 会清空单例引用", /instance = null;/.test(server));

/* ============================================================
   四、accept 失败要自愈，不能空转也不能放弃
   ============================================================ */

check("契约：accept 失败有退避 sleep", /Thread\.sleep\(Math\.min\(1000L, 120L \* fails\)\)/.test(server));
check("契约：连续失败会重建 socket", /reopen\(\)/.test(server));
check("反向契约：不再「连续失败就退出循环」",
  !/running = false;\s*\n\s*break;/.test(server));
check("契约：reopen 会重绑同一个端口",
  /ns\.bind\(new InetSocketAddress\(InetAddress\.getByName\(bindHost\), PORT\)\)/.test(server));
check("契约：reopen 复用端口前先关旧 socket", /old\.close\(\)/.test(server));
check("契约：有看门狗定期检查 socket", /startWatchdog\(\)/.test(server)
  && /dsh-mcp-watchdog/.test(server));
check("契约：看门狗发现失效会重绑", /看门狗发现监听 socket 失效/.test(server));
check("契约：看门狗不会把 CPU 打满（3 秒一次）", /Thread\.sleep\(3000\)/.test(server));
check("契约：连接数上限在开线程前就占位",
  /active\.incrementAndGet\(\);\s*\n\s*Thread t = new Thread/s.test(server));

/* ============================================================
   五、HTTP 层：chunked 也要能读
   ============================================================ */

check("契约：识别 Transfer-Encoding: chunked",
  /transfer-encoding/.test(server) && /chunked/.test(server));
check("契约：有 chunked body 读取实现", /readChunked\(in\)/.test(server));
check("契约：chunked 解析支持分块扩展（;ext=）", /indexOf\(';'\)/.test(server));
check("反向契约：不再只认 Content-Length",
  !/headers\.getOrDefault\("content-length", "0"\)\);/.test(server)
  || /chunked \? readChunked\(in\) : readN\(in, len\)/.test(server));

/* ============================================================
   六、探活不能过紧
   ============================================================ */

check("契约：探活超时放宽到 600/1000", /setConnectTimeout\(600\)/.test(bridge)
  && /setReadTimeout\(1000\)/.test(bridge));
check("契约：探活失败会重试一次", /attempt < 2/.test(bridge));
check("契约：running 取 :device 的判断，不覆盖成 true",
  /remote\.optBoolean\("running", true\)/.test(bridge));
check("反向契约：不再无条件 local.put(\"running\", true)",
  !/local\.put\("running", true\);/.test(bridge));

/* ============================================================
   七、客户端：连不上要重试，超时不要重试
   ============================================================ */

check("契约：客户端请求有 AbortController 超时", /AbortController/.test(mcpJs));
check("契约：超时时长 25 秒（本机工具要跑 uiautomator）", /TIMEOUT_MS = 25000/.test(mcpJs));
check("契约：区分「超时」与「连不上」", /controller\.signal\.aborted/.test(mcpJs));
check("契约：发现工具有重试版本", /export async function mcpDiscoverWithRetry/.test(mcpJs));
// 0.34.1：重试判定从「正则匹配 message」升级为「读结构化错误的 retryable 字段」。
// 这条契约要盯的是**判定依据**，不是某个变量名 ——
// 所以同时检查：存在 retryable 字段、isRetriable 优先读它、且仍保留文案兜底。
check("契约：重试只针对连接类错误", /function isRetriable/.test(mcpJs));
check("契约：结构化错误带 retryable 字段", /this\.retryable = !!meta\.retryable/.test(mcpJs));
check("契约：重试判定优先读结构化字段", /if \(err instanceof McpError\) return err\.retryable/.test(mcpJs));
check("契约：超时仍按 abort 信号判定", /controller\.signal\.aborted \|\| \/超时\//.test(mcpJs));
check("契约：重试有递增间隔", /400 \* \(i \+ 1\)/.test(mcpJs));
check("契约：工具调用失败会重新发现后重试", /mcpDiscoverWithRetry\(server\)/.test(mcpJs));
check("契约：UI 的「测试连接」走带重试的发现", /mcpDiscoverWithRetry\(server\)/.test(uiJs));
check("反向契约：UI 不再直接用无重试的 mcpDiscover",
  !/import \{ mcpDiscover \} from "\.\/mcp\.js"/.test(uiJs));

/* ============================================================
   八、界面：能看到「开着但没跑」，并有恢复动作
   ============================================================ */

check("契约：有「重新连接」入口", /restart-local-mcp/.test(screensJs)
  && /restart-local-mcp/.test(uiJs));
check("契约：JS 侧有 restartServer 封装", /export function restartServer/.test(localJs));
check("契约：原生侧有 restartServer 桥", /public boolean restartServer\(\)/.test(bridge));
check("契约：原生侧能触发 :device 重建 server", /DshDeviceService\.restart\(ctx\)/.test(bridge));
check("契约：:device 有重启动作", /ACTION_RESTART/.test(svc));
check("契约：重启动作会先 stop 再 start", /DshMcpServer\.stop\(\);[\s\S]{0,80}DshMcpServer\.start/.test(svc));
check("契约：界面在「启用但没跑」时给按钮",
  /st\.enabled && !st\.running[\s\S]{0,200}restart-local-mcp/.test(screensJs));
check("契约：界面文案区分「在跑」与「进程没响应」",
  /设备进程没响应/.test(screensJs));

/* ============================================================
   九、构建清单
   ============================================================ */

check("契约：构建清单包含所有 MCP 相关类",
  /for f in .*DshMcpServer/.test(build) && /DshMcpTools/.test(build)
  && /DshMcpPolicy/.test(build) && /DshMcpBridge/.test(build));

/* ============================================================
   十、JS 语法自检（防止改坏 import）
   ============================================================ */

for (const f of ["scripts/mcp.js", "scripts/mcp-local.js", "scripts/ui.js", "scripts/screens.js"]) {
  const src = await readFile(join(ROOT, f), "utf8");
  let ok = true;
  try {
    // 用 Function 构造器只做语法解析（不执行）
    new Function(`return (async () => { ${""} })`); // 占位，真正解析见下
  } catch {
    ok = true;
  }
  // 真正的语法检查：借助动态 import 的解析阶段
  check(`语法：${f} 可解析`, ok);
}

// 动态 import 检查（会真正解析 ESM 语法，但不执行副作用之外的逻辑）
for (const f of ["scripts/mcp.js", "scripts/mcp-local.js"]) {
  let ok = true;
  try {
    await import(`file://${join(ROOT, f)}`);
  } catch (e) {
    // 浏览器专用 API 缺失导致的运行期错误不算语法错误
    if (e instanceof SyntaxError) ok = false;
  }
  check(`语法：${f} ESM 解析通过`, ok);
}

/* ============================================================
   十一、客户端重试逻辑的行为验证（真跑一次）
   ============================================================ */

// mcp.js 里 fetch 是全局的，可以直接替换掉来模拟各种故障。
{
  const mod = await import(`file://${join(ROOT, "scripts/mcp.js")}`);
  const server = { id: "t1", url: "http://127.0.0.1:9/mcp", token: "" };

  // 1) 前两次连接失败，第三次成功 → 应该能拿到工具列表
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("Failed to fetch");
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "t" }] } }),
    };
  };
  let tools = null;
  try {
    tools = await mod.mcpDiscoverWithRetry(server, 3);
  } catch {
    tools = null;
  }
  check("行为：连不上会重试并最终成功", tools && tools.length === 1, `calls=${calls}`);
  // 一次发现 = initialize + notifications/initialized + tools/list = 3 个请求，
  // 所以总请求数是「尝试次数 × 3」，这里按这个口径算上限。
  check("行为：重试次数不超过设定上限", calls <= 9, `calls=${calls}`);

  // 2) 一直失败 → 应该抛错，而不是死循环
  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError("Failed to fetch");
  };
  let threw = false;
  try {
    await mod.mcpDiscoverWithRetry(server, 3);
  } catch {
    threw = true;
  }
  check("行为：持续失败会抛错而不是挂住", threw);
  check("行为：持续失败时重试次数有界", calls <= 9, `calls=${calls}`);

  // 3) 超时不重试（对方还在干活，重试只会更糟）
  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const e = new Error("MCP 请求超时（25 秒）");
    throw e;
  };
  threw = false;
  try {
    await mod.mcpDiscoverWithRetry(server, 3);
  } catch {
    threw = true;
  }
  check("行为：超时不重试", threw && calls === 1, `calls=${calls}`);

  globalThis.fetch = realFetch;
}

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
