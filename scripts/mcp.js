/* ============================================================
   MCP — 最小 Streamable HTTP 客户端
   只实现 JSON-RPC over HTTP 的 initialize / tools/list / tools/call。
   不支持 stdio、SSE 服务器的主动推送与 OAuth。
   ============================================================ */

import { state, APP_VERSION } from "./store.js";

const sessions = new Map();
let seq = 0;

function headersFor(server) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2024-11-05",
  };
  if (server.token) headers.Authorization = `Bearer ${server.token}`;
  const sid = sessions.get(server.id);
  if (sid) headers["Mcp-Session-Id"] = sid;
  return headers;
}

function parseSse(text) {
  const lines = String(text).split(/\r?\n/);
  const payloads = [];
  let data = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trim());
    } else if (line === "" && data.length) {
      payloads.push(data.join("\n"));
      data = [];
    }
  }
  if (data.length) payloads.push(data.join("\n"));
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(payloads[i]);
    } catch {
      /* 继续找 */
    }
  }
  throw new Error("MCP 返回了无法解析的 SSE 数据");
}

async function rpc(server, method, params, notify = false) {
  const payload = { jsonrpc: "2.0", method, params: params || {} };
  if (!notify) {
    seq += 1;
    payload.id = seq;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(server.url, {
      method: "POST",
      headers: headersFor(server),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`无法连接 MCP 服务器：${err.message}（检查 URL、网络或 CORS）`);
  } finally {
    clearTimeout(timer);
  }

  const sid = res.headers.get("Mcp-Session-Id");
  if (sid) sessions.set(server.id, sid);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MCP HTTP ${res.status}${body ? ` · ${body.slice(0, 120)}` : ""}`);
  }
  if (notify) return null;

  const text = await res.text();
  if (!text.trim()) return null;
  const type = res.headers.get("content-type") || "";
  const data = type.includes("text/event-stream") ? parseSse(text) : JSON.parse(text);
  if (data.error) throw new Error(data.error.message || "MCP 返回错误");
  return data.result;
}

/** 建立会话并列出工具；返回 MCP 原始工具数组。 */
export async function mcpDiscover(server) {
  sessions.delete(server.id);
  await rpc(server, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dsh-mobile", version: APP_VERSION },
  });
  await rpc(server, "notifications/initialized", {}, true);
  const result = await rpc(server, "tools/list", {});
  return Array.isArray(result?.tools) ? result.tools : [];
}

/** 调用一个 MCP 工具，返回纯文本结果。 */
export async function mcpCall(server, toolName, args) {
  const run = async () => {
    const result = await rpc(server, "tools/call", { name: toolName, arguments: args || {} });
    const text = (result?.content || [])
      .map((part) => (part?.type === "text" ? part.text : `[${part?.type || "content"}]`))
      .join("\n");
    return { text: text || "（MCP 工具没有返回文本）", isError: !!result?.isError };
  };

  try {
    return await run();
  } catch (err) {
    // 会话过期时重连一次
    if (/session|initialized|404|400/i.test(err.message)) {
      await mcpDiscover(server);
      return run();
    }
    throw err;
  }
}

/** 工具名里只留字母数字下划线，避免把 MCP 的名字直接塞进 function name。 */
export function mcpToolName(serverId, toolName) {
  const clean = String(toolName).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
  return `mcp__${String(serverId).replace(/[^a-zA-Z0-9_]/g, "_")}__${clean}`;
}

/** 给模型看的工具 schema（只包含已发现且启用的服务器）。 */
export function mcpToolSchemas() {
  const out = [];
  for (const server of state.settings.mcpServers || []) {
    if (!server.enabled || !Array.isArray(server.tools)) continue;
    for (const tool of server.tools) {
      if (!tool?.name) continue;
      out.push({
        type: "function",
        function: {
          name: mcpToolName(server.id, tool.name),
          description: `[MCP · ${server.name}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
      });
    }
  }
  return out;
}

/** 反查一个 function name 对应的服务器与原始工具名。 */
export function findMcpTool(functionName) {
  for (const server of state.settings.mcpServers || []) {
    if (!server.enabled) continue;
    for (const tool of server.tools || []) {
      if (mcpToolName(server.id, tool.name) === functionName) {
        return { server, tool };
      }
    }
  }
  return null;
}
