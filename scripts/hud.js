/* ============================================================
   HUD — 悬浮状态窗
   APK：DshHud 原生桥 → 系统悬浮窗服务（SYSTEM_ALERT_WINDOW）
   浏览器 / PWA：应用内可拖动、可伸缩的浮条（降级实现）
   数据快照由 ui.js 的 hudSnapshot() 收集，hudSync() 每约 1.2s 推送。
   浮条头部有一颗 DSH 小球（dsh-ball.js 移植自 Agent HUD 的 Bots 动画），
   按 look 摆姿态、按一次性事件做动作。
   ============================================================ */

import { DshBall } from "./dsh-ball.js";

let inAppEl = null;
let inAppBall = null;
let inAppOpen = false;

export function nativeHudAvailable() {
  return typeof window !== "undefined" && typeof window.DshHud?.push === "function";
}

export function hudPermissionGranted() {
  if (!nativeHudAvailable()) return true; // 应用内浮条不需要系统权限
  try {
    return !!window.DshHud.canDrawOverlays();
  } catch {
    return false;
  }
}

/** 推送快照：APK 走原生悬浮窗；浏览器渲染应用内浮条。 */
export function hudRender(snapshot, enabled) {
  if (nativeHudAvailable()) {
    try {
      if (enabled) {
        window.DshHud.push(JSON.stringify(snapshot));
        window.DshHud.enable();
      } else {
        window.DshHud.disable();
      }
    } catch {
      /* 原生侧不可用时忽略 */
    }
    removeInApp();
    return;
  }
  if (enabled) renderInApp(snapshot);
  else removeInApp();
}

/* ---------------- 应用内浮条 ---------------- */

const CSS = `
/* 宽度：250 → 300，和原生悬浮窗对齐。
   max() 兜住小屏：320px 的屏幕上 300 + 两侧 padding 会溢出，
   所以再用 calc(100vw - 24px) 压一道。 */
#dsh-hud-inapp{position:fixed;z-index:900;top:86px;right:10px;
  max-width:min(300px,calc(100vw - 24px));
  background:rgba(20,24,33,.68);border:1px solid rgba(120,140,180,.35);border-radius:14px;
  padding:7px 11px;color:#e9edf5;font:500 11.5px/1.5 "Noto Sans SC",sans-serif;
  box-shadow:0 8px 26px rgba(0,0,0,.4);cursor:grab;user-select:none;touch-action:none;backdrop-filter:blur(8px)}
#dsh-hud-inapp .hud-cap{display:flex;align-items:center;gap:3px;font-weight:600;min-width:0}
#dsh-hud-inapp .hud-cap-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#dsh-hud-inapp .hud-ball{flex:none;width:48px;height:48px;margin:-10px -9px -10px -11px;
  touch-action:none;cursor:pointer}
#dsh-hud-inapp[data-status="idle"] .hud-cap-text{color:#e9edf5}
#dsh-hud-inapp[data-status="thinking"] .hud-cap-text{color:#c9a6f8}
#dsh-hud-inapp[data-status="tool"] .hud-cap-text{color:#f0c073}
#dsh-hud-inapp[data-status="done"] .hud-cap-text{color:#7ee2a8}
#dsh-hud-inapp[data-status="waiting"] .hud-cap-text{color:#f0b35a}
#dsh-hud-inapp .hud-body{display:none;margin-top:5px;font-size:10.5px;line-height:1.6;color:#c8d2e4}
#dsh-hud-inapp[data-open="true"]{width:min(300px,calc(100vw - 24px))}
#dsh-hud-inapp[data-open="true"] .hud-body{display:block}
  #dsh-hud-inapp .hud-sec{border-top:1px solid rgba(120,140,180,.25);margin-top:5px;padding-top:4px}
  #dsh-hud-inapp .hud-eyebrow{font-size:8.5px;letter-spacing:.08em;color:#7b8497;font-weight:700}
  #dsh-hud-inapp .hud-row{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #dsh-hud-inapp .hud-hint{font-size:9px;color:#7b8497;margin-top:4px}
  #dsh-hud-inapp .hud-msg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #dsh-hud-inapp .hud-msg b{color:#9fb4d8;font-weight:600}
  #dsh-hud-inapp .hud-act{display:none;gap:5px;margin-top:6px;align-items:center}
  #dsh-hud-inapp[data-open="true"] .hud-act{display:flex}
  #dsh-hud-inapp .hud-act input{flex:1;min-width:0;background:rgba(120,140,180,.12);
  border:1px solid rgba(120,140,180,.3);border-radius:9px;color:#e9edf5;padding:4px 7px;
  font:500 11px "Noto Sans SC",sans-serif;outline:none}
  #dsh-hud-inapp .hud-act input::placeholder{color:#6c7789}
  #dsh-hud-inapp .hud-act button{flex:none;border:0;border-radius:9px;padding:5px 9px;
  font:700 10px "Noto Sans SC",sans-serif;cursor:pointer;background:#3a7bd5;color:#fff}
  #dsh-hud-inapp .hud-act button.hud-stop{background:#8c3a3a}
  #dsh-hud-inapp .hud-act button:disabled{opacity:.4;cursor:default}`;

function ensureStyle() {
  if (document.getElementById("dsh-hud-style")) return;
  const st = document.createElement("style");
  st.id = "dsh-hud-style";
  st.textContent = CSS;
  document.head.appendChild(st);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInApp(snapshot) {
  ensureStyle();
  if (!inAppEl) {
    inAppEl = document.createElement("div");
    inAppEl.id = "dsh-hud-inapp";
    // 骨架只建一次：小球画布常驻，动画由自己的 rAF 循环驱动
    inAppEl.innerHTML = `
      <div class="hud-cap"><canvas class="hud-ball"></canvas><span class="hud-cap-text"></span></div>
      <div class="hud-body"></div>
      <div class="hud-act">
        <input class="hud-input" type="text" placeholder="回消息…" enterkeyhint="send">
        <button class="hud-send" type="button">发送</button>
        <button class="hud-stop" type="button">停止</button>
      </div>`;
    document.body.appendChild(inAppEl);

    const canvas = inAppEl.querySelector(".hud-ball");
    inAppBall = new DshBall(canvas, { side: 30 });
    inAppBall.start();

    // 拖动 + 点按伸缩
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
    // 事件来自可交互子控件（输入框 / 按钮）时，浮条自己不处理。
    //
    // ============ 为什么必须判 ============
    //
    // 监听器挂在浮条容器上，而点击按钮同样会冒泡上来。
    // 不判的话：点「发送」→ 冒泡到 pointerup → 判定为「点按浮条」→ 浮条收起。
    // 用户发完一条消息，整个浮条就没了。
    const fromControl = (e) =>
      e.target && e.target.closest && e.target.closest(".hud-act");
    inAppEl.addEventListener("pointerdown", (e) => {
      if (fromControl(e)) return;
      sx = e.clientX; sy = e.clientY;
      const rect = inAppEl.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      moved = false;
      try {
        inAppEl.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件没有真实 pointerId，忽略即可 */
      }
    });
    inAppEl.addEventListener("pointermove", (e) => {
      if (e.buttons === 0 || fromControl(e)) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 8) return;
      moved = true;
      const rect = inAppEl.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      // 拖动全程夹在屏幕内，出界后松手才能可靠贴边
      inAppEl.style.left =
        Math.max(4, Math.min(ox + dx, vw - rect.width - 4)) + "px";
      inAppEl.style.top =
        Math.max(4, Math.min(oy + dy, vh - rect.height - 4)) + "px";
      inAppEl.style.right = "auto";
    });
    inAppEl.addEventListener("pointerup", (e) => {
      if (fromControl(e)) return;
      if (!moved) {
        inAppOpen = !inAppOpen;
        inAppEl.dataset.open = String(inAppOpen);
      } else {
        snapInApp();
      }
    });

    /* 快捷操作：发消息 / 停止会话
     *
     * 走的是与原生悬浮窗**同一套**协议（window.__dshHudCommand），
     * 所以浏览器降级版和 APK 版的行为完全一致 —— 不需要两套逻辑。
     */
    const inputEl = inAppEl.querySelector(".hud-input");
    const sendEl = inAppEl.querySelector(".hud-send");
    const stopEl = inAppEl.querySelector(".hud-stop");
    const doSend = () => {
      const text = String(inputEl.value || "").trim();
      if (!text) return;
      inputEl.value = "";
      window.__dshHudCommand?.("send", { text });
    };
    sendEl.addEventListener("click", doSend);
    stopEl.addEventListener("click", () => window.__dshHudCommand?.("stop", null));
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSend();
      }
      // 关键：输入框里按下的字符不能被当成拖动
      e.stopPropagation();
    });
    // 指针事件也要拦：不然输入框里点一下可能被当成拖动浮条
    inputEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    inputEl.addEventListener("pointerup", (e) => e.stopPropagation());
  }

  /* 贴边：松手后吸附最近的屏幕左右边，并夹紧上下边界 */
  function snapInApp() {
    const rect = inAppEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 4;
    const centerX = rect.left + rect.width / 2;
    inAppEl.style.right = "auto";
    inAppEl.style.left =
      (centerX <= vw / 2 ? margin : vw - rect.width - margin) + "px";
    inAppEl.style.top =
      Math.max(margin, Math.min(rect.top, vh - rect.height - margin)) + "px";
  }

  const open = inAppOpen;
  const sessions = snapshot.sessions || [];
  const tasks = snapshot.tasks || [];
  const messages = snapshot.messages || [];
  inAppEl.dataset.status = snapshot.status || "idle";
  inAppEl.dataset.open = String(open);
  inAppEl.querySelector(".hud-cap-text").textContent = snapshot.statusText || "空闲中";
  inAppEl.querySelector(".hud-body").innerHTML = `
      ${snapshot.step ? `<div class="hud-row">${escapeHtml(snapshot.step)}</div>` : ""}
      ${
        sessions.length
          ? `<div class="hud-sec"><div class="hud-eyebrow">会话</div>${sessions
              .map((s) => `<div class="hud-row">· ${escapeHtml(s.title)} — ${escapeHtml(s.state)}</div>`)
              .join("")}</div>`
          : ""
      }
      ${
        tasks.length
          ? `<div class="hud-sec"><div class="hud-eyebrow">任务</div>${tasks
              .map((t) => `<div class="hud-row">▸ ${escapeHtml(t.title)}${t.progress ? ` · ${t.progress}%` : ""}</div>`)
              .join("")}</div>`
          : ""
      }
      ${
        messages.length
          ? `<div class="hud-sec"><div class="hud-eyebrow">消息</div>${messages
              .map(
                (m) =>
                  `<div class="hud-msg"><b>${m.role === "user" ? "你" : "DSH"}</b>：${escapeHtml(m.text)}</div>`
              )
              .join("")}</div>`
          : ""
      }
      ${open ? `<div class="hud-hint">拖动移动 · 点按伸缩 · 设置中可关闭</div>` : ""}`;

  // 「停止」只在真的有运行中的会话时可点
  const stopEl = inAppEl.querySelector(".hud-stop");
  if (stopEl) {
    stopEl.disabled = !snapshot.running;
  }

  // 驱动小球：状态姿态 + 一次性事件 + 头顶徽标
  if (inAppBall) {
    inAppBall.setLook(snapshot.look);
    inAppBall.play(snapshot.event);
    inAppBall.setBadge(snapshot.badge);
  }
}

function removeInApp() {
  inAppBall?.stop();
  inAppBall = null;
  inAppEl?.remove();
  inAppEl = null;
}
