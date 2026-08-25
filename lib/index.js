// src/index.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/core.ts
var FINISH_COOLDOWN_MS = 1e4;
function isSupportedPlatform(platform) {
  return platform === "win32";
}
function truncate(text, max) {
  if (text.length === 0) return text;
  return text.length > max ? text.slice(0, max) + "\u2026" : text;
}
function isRootAgent(agent) {
  try {
    const header = agent && typeof agent === "object" ? agent.session?.header : void 0;
    if (!header || typeof header !== "object") return true;
    if (header.origin === "subagent") return false;
    if (typeof header.delegationDepth === "number" && header.delegationDepth > 0) return false;
    return true;
  } catch {
    return true;
  }
}
function resolveSessionTitle(agent, sessionTitle) {
  try {
    if (!sessionTitle || typeof agent !== "object" || agent === null) return void 0;
    const session = agent.session;
    if (!session) return void 0;
    const snapshot = sessionTitle.get(session);
    if (snapshot && typeof snapshot.title === "string" && snapshot.title.length > 0) return snapshot.title;
  } catch {
  }
  return void 0;
}
function resolveQuestionText(exec) {
  try {
    const e = exec;
    const args = e.arguments || e.args || e.input;
    const questions = args && args.questions;
    if (!Array.isArray(questions) || questions.length === 0) return void 0;
    const first = questions[0];
    const text = first && (first.question || first.header);
    if (typeof text !== "string" || text.length === 0) return void 0;
    const label = "\u95EE\u9898\uFF1A" + truncate(text, 80);
    return questions.length > 1 ? label + "\uFF08\u5171 " + questions.length + " \u4E2A\u95EE\u9898\uFF09" : label;
  } catch {
    return void 0;
  }
}
function resolveApprovalText(req) {
  try {
    const r = req;
    const reason = r.reason || r.description;
    const toolObj = r.tool;
    const toolName = r.toolName || toolObj && typeof toolObj === "object" && toolObj.name || (typeof toolObj === "string" ? toolObj : void 0);
    const parts = [];
    if (typeof toolName === "string" && toolName.length > 0) parts.push("\u64CD\u4F5C\uFF1A" + truncate(toolName, 40));
    if (typeof reason === "string" && reason.length > 0) parts.push("\u539F\u56E0\uFF1A" + truncate(reason, 80));
    return parts.length > 0 ? parts.join("\uFF1B") : void 0;
  } catch {
    return void 0;
  }
}

// src/index.ts
var name = "dsh-win-notify";
var inject = ["subprocess"];
var __dirname = dirname(fileURLToPath(import.meta.url));
var HELPER_DIR = join(__dirname, ".dsh-notify");
var HELPER_EXE = join(HELPER_DIR, "DshToast.exe");
var HELPER_CS = join(HELPER_DIR, "DshToast.cs");
var NOTIFY_ICO = join(HELPER_DIR, "notify.ico");
var CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
var NET4 = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319";
var WINMD = "C:\\Windows\\System32\\WinMetadata";
function ensureHelper(ctx) {
  if (existsSync(HELPER_EXE)) return;
  try {
    const refs = [
      join(NET4, "System.Runtime.dll"),
      join(NET4, "System.Runtime.InteropServices.WindowsRuntime.dll"),
      join(WINMD, "Windows.Foundation.winmd"),
      join(WINMD, "Windows.Data.winmd"),
      join(WINMD, "Windows.UI.winmd")
    ];
    const argv = ["/nologo", "/target:winexe", "/platform:anycpu", "/win32icon:" + NOTIFY_ICO];
    for (const r of refs) argv.push("/reference:" + r);
    argv.push("/out:" + HELPER_EXE, HELPER_CS);
    const handle = ctx.subprocess.spawn({
      argv: [CSC, ...argv],
      cwd: HELPER_DIR,
      stdio: { stdin: "ignore", stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 15e3
    });
    if (handle && handle.done && typeof handle.done.then === "function") {
      handle.done.then(() => {
      }, (err) => console.warn("[dsh-win-notify] helper compile failed:", String(err)));
    }
  } catch (error) {
    console.warn("[dsh-win-notify] helper compile threw:", String(error));
  }
}
function apply(ctx) {
  if (!isSupportedPlatform(process.platform)) {
    console.warn("[dsh-win-notify] Windows-only plugin: refusing to start on " + process.platform);
    return;
  }
  const agentState = /* @__PURE__ */ new WeakMap();
  const lastFinishedAt = /* @__PURE__ */ new WeakMap();
  const sessionTitle = ctx.get("sessionTitle");
  ensureHelper(ctx);
  function notify(title, body) {
    if (!existsSync(HELPER_EXE)) return;
    try {
      const handle = ctx.subprocess.spawn({
        argv: [HELPER_EXE, title, body],
        cwd: HELPER_DIR,
        stdio: { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
        graceMs: 5e3
      });
      if (handle && handle.done && typeof handle.done.catch === "function") {
        handle.done.catch(() => {
        });
      }
    } catch (error) {
      console.warn("[dsh-win-notify] failed to raise notification:", String(error));
    }
  }
  function notifyFinished(agent) {
    if (!isRootAgent(agent)) return;
    const key = agent;
    const now = Date.now();
    const last = lastFinishedAt.get(key);
    if (last !== void 0 && now - last < FINISH_COOLDOWN_MS) return;
    lastFinishedAt.set(key, now);
    const title = resolveSessionTitle(agent, sessionTitle);
    notify("\u4EFB\u52A1\u5B8C\u6210", title ? "\u5DF2\u5B8C\u6210\uFF1A\u300C" + truncate(title, 40) + "\u300D" : "\u5F53\u524D\u4EFB\u52A1\u5DF2\u5B8C\u6210");
  }
  ctx.on("agent/status", (payload) => {
    const p = payload;
    const agent = p && p.agent;
    const status = p && p.status;
    if (typeof agent !== "object" || agent === null) return;
    const key = agent;
    if (status === "idle" && agentState.get(key) === "running") notifyFinished(agent);
    if (status === "running" || status === "idle") agentState.set(key, status);
  });
  ctx.on("tools/execute", (exec, next) => {
    try {
      const toolName = exec && typeof exec === "object" ? exec.name : void 0;
      if (toolName === "ask_user_question") {
        const agent = exec && typeof exec === "object" ? exec.agent : void 0;
        if (agent && !isRootAgent(agent)) return next();
        const text = resolveQuestionText(exec);
        notify("\u9700\u8981\u60A8\u7684\u8F93\u5165", text || "\u8BF7\u63D0\u4F9B\u4FE1\u606F\u6216\u505A\u51FA\u9009\u62E9");
      }
    } catch (error) {
      console.warn("[dsh-win-notify] tools/execute observer failed:", String(error));
    }
    return next();
  });
  ctx.on("approval/request", (req, next) => {
    const agent = req && typeof req === "object" ? req.agent : void 0;
    if (agent && !isRootAgent(agent)) return next();
    const text = resolveApprovalText(req);
    notify("\u9700\u8981\u60A8\u7684\u5BA1\u6279", text || "Agent \u8BF7\u6C42\u4E00\u9879\u64CD\u4F5C\u5BA1\u6279");
    return next();
  });
}
export {
  HELPER_DIR,
  apply,
  inject,
  name
};
