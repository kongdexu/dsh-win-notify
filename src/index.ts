/**
 * dsh-win-notify — OS-level system notification for dsh on Windows.
 *
 * Raises true Windows toasts that persist in the notification center (通知中心),
 * grouped under the source name "DeepSeek Harness" with the DeepSeek black
 * whale icon (black circular background + white whale).
 *
 * How it works
 * ------------
 * The heavy lifting is done by a self-compiled .NET Framework helper EXE
 * (`lib/.dsh-notify/DshToast.exe`), which calls the WinRT ToastNotification API
 * directly. We compile our own EXE because:
 *   - PowerShell 7 (pwsh) cannot load the WinRT ToastNotification projection,
 *     and its balloon tip neither persists nor can be branded.
 *   - Windows PowerShell 5.1 can, but the agent sandbox blocks launching
 *     powershell.exe, and its toasts cannot be re-branded or re-iconed.
 * A self-owned EXE owns its AUMID, its display name and its embedded icon, so
 * the toast shows exactly "DeepSeek Harness" + the black whale icon.
 *
 * `.dsh-notify/` (copied to `lib/.dsh-notify/` at build) holds DshToast.exe
 * (pre-built), DshToast.cs (source), notify.ico (the whale icon embedded into
 * the EXE) and whale-black-bg.png. If DshToast.exe is ever missing (e.g. after
 * a cleanup), the plugin rebuilds it on the fly using the system csc.exe
 * (ships with .NET Framework 4 on every Windows 10/11 install — no extra
 * dependencies).
 *
 * Events watched (all existing DSH host events):
 *   agent/status     running -> idle   => 任务完成 (with session title)
 *   tools/execute    ask_user_question => 需要您的输入 (question extracted)
 *   approval/request pending decision  => 需要您的审批 (reason/tool)
 *
 * Timing note (2026-08-24): "需要您的输入" fires on `tools/execute`, NOT
 * `tools/result`. The DSH tool pipeline is pre-execute → execute → post-execute
 * → result; for ask_user_question the question modal is presented while the
 * `tools/execute` body runs and blocks for the human, while `tools/result` is
 * only observed after the tool completed — i.e. after the user already
 * answered. Hooking `tools/result` made every input toast arrive late.
 *
 * Noise control (2026-08-21):
 *   - `agent/status` fires for EVERY agent (root agent, subagents, AgentTeams
 *     members, workflow workers…). Only **user-facing root agents** raise a
 *     completion toast: subagent sessions are marked `origin: "subagent"` in
 *     their session header and are skipped, otherwise every background worker
 *     finishing would spam "任务完成".
 *   - Status transitions are tracked **per agent** (WeakMap), so interleaved
 *     events from several agents cannot corrupt each other's state machine
 *     (the old single global flag fired spurious toasts and could even miss
 *     the real completion).
 *   - A short per-agent cooldown (FINISH_COOLDOWN_MS) suppresses completion
 *     chatter from rapid consecutive turns / goal continuation rounds.
 *   - Toast text prefers the real session title (`sessionTitle.get(agent.session)`,
 *     resolved directly from the agent session instead of a session-store
 *     lookup that often missed); subagent 输入/审批 requests never ping the user.
 *
 * Platform gate: this package declares `"os": ["win32"]` and the plugin
 * additionally no-ops at runtime on non-Windows hosts, so installing it on
 * Linux/macOS is harmless.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FINISH_COOLDOWN_MS,
  isRootAgent,
  isSupportedPlatform,
  resolveApprovalText,
  resolveQuestionText,
  resolveSessionTitle,
  truncate,
  type NotifyContext,
  type SessionTitleService,
} from './core'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-win-notify'

/** The subprocess service must exist before this plugin can spawn helpers. */
export const inject: readonly string[] = ['subprocess']

const __dirname = dirname(fileURLToPath(import.meta.url))
export const HELPER_DIR = join(__dirname, '.dsh-notify')
const HELPER_EXE = join(HELPER_DIR, 'DshToast.exe')
const HELPER_CS = join(HELPER_DIR, 'DshToast.cs')
const NOTIFY_ICO = join(HELPER_DIR, 'notify.ico')

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
const NET4 = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319'
const WINMD = 'C:\\Windows\\System32\\WinMetadata'

/**
 * Rebuild DshToast.exe from DshToast.cs if the EXE is missing. Fire-and-forget:
 * compilation is asynchronous; the notification for this round is simply
 * skipped and the next one uses the freshly built EXE.
 */
function ensureHelper(ctx: NotifyContext): void {
  if (existsSync(HELPER_EXE)) return
  try {
    const refs = [
      join(NET4, 'System.Runtime.dll'),
      join(NET4, 'System.Runtime.InteropServices.WindowsRuntime.dll'),
      join(WINMD, 'Windows.Foundation.winmd'),
      join(WINMD, 'Windows.Data.winmd'),
      join(WINMD, 'Windows.UI.winmd'),
    ]
    const argv = ['/nologo', '/target:winexe', '/platform:anycpu', '/win32icon:' + NOTIFY_ICO]
    for (const r of refs) argv.push('/reference:' + r)
    argv.push('/out:' + HELPER_EXE, HELPER_CS)
    const handle = ctx.subprocess.spawn({
      argv: [CSC, ...argv],
      cwd: HELPER_DIR,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 15000,
    })
    if (handle && handle.done && typeof handle.done.then === 'function') {
      handle.done.then(() => {}, (err: unknown) => console.warn('[dsh-win-notify] helper compile failed:', String(err)))
    }
  } catch (error) {
    console.warn('[dsh-win-notify] helper compile threw:', String(error))
  }
}

/** @param {NotifyContext} ctx — the DSH host context (structural). */
export function apply(ctx: NotifyContext): void {
  if (!isSupportedPlatform(process.platform)) {
    console.warn('[dsh-win-notify] Windows-only plugin: refusing to start on ' + process.platform)
    return
  }

  // Per-agent transition state: interleaved events from concurrent agents
  // must not corrupt each other's running→idle detection.
  const agentState = new WeakMap<object, string>()
  const lastFinishedAt = new WeakMap<object, number>()
  const sessionTitle = ctx.get<SessionTitleService | undefined>('sessionTitle')

  // The helper EXE is pre-built and shipped; rebuild only if it vanished.
  ensureHelper(ctx)

  function notify(title: string, body: string): void {
    if (!existsSync(HELPER_EXE)) return // helper still compiling; skip this round
    try {
      const handle = ctx.subprocess.spawn({
        argv: [HELPER_EXE, title, body],
        cwd: HELPER_DIR,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: 5000,
      })
      if (handle && handle.done && typeof handle.done.catch === 'function') {
        handle.done.catch(() => {})
      }
    } catch (error) {
      console.warn('[dsh-win-notify] failed to raise notification:', String(error))
    }
  }

  function notifyFinished(agent: unknown): void {
    if (!isRootAgent(agent)) return
    const key = agent as object
    const now = Date.now()
    const last = lastFinishedAt.get(key)
    if (last !== undefined && now - last < FINISH_COOLDOWN_MS) return
    lastFinishedAt.set(key, now)
    const title = resolveSessionTitle(agent, sessionTitle)
    notify('任务完成', title ? '已完成：「' + truncate(title, 40) + '」' : '当前任务已完成')
  }

  // Task finished: a user-facing root agent drained, running -> idle.
  ctx.on('agent/status', (payload: unknown) => {
    const p = payload as { agent?: unknown, status?: string } | null
    const agent = p && p.agent
    const status = p && p.status
    if (typeof agent !== 'object' || agent === null) return
    const key = agent as object
    if (status === 'idle' && agentState.get(key) === 'running') notifyFinished(agent)
    if (status === 'running' || status === 'idle') agentState.set(key, status)
  })

  // User input / choice needed: fire when the question is actually presented.
  // The ask_user_question body runs during `tools/execute` — the modal is shown
  // to the user right then and the call blocks until the human answers, so this
  // is the correct moment. (`tools/result` would fire only after the user
  // answered.) `tools/execute` is a pipeline waterfall: this observer must
  // always `return next()` so the execution keeps flowing; the toast itself is
  // fire-and-forget and never short-circuits the tool.
  ctx.on('tools/execute', (exec: unknown, next: () => void) => {
    try {
      const toolName = exec && typeof exec === 'object' ? (exec as { name?: string }).name : undefined
      if (toolName === 'ask_user_question') {
        const agent = exec && typeof exec === 'object' ? (exec as { agent?: unknown }).agent : undefined
        if (agent && !isRootAgent(agent)) return next() // background worker question: no ping
        const text = resolveQuestionText(exec)
        notify('需要您的输入', text || '请提供信息或做出选择')
      }
    } catch (error) {
      console.warn('[dsh-win-notify] tools/execute observer failed:', String(error))
    }
    return next()
  })

  // Approval pending: compose the waterfall and forward; do not block it.
  ctx.on('approval/request', (req: unknown, next: () => void) => {
    const agent = req && typeof req === 'object' ? (req as { agent?: unknown }).agent : undefined
    if (agent && !isRootAgent(agent)) return next() // subagent approvals are auto-rejected
    const text = resolveApprovalText(req)
    notify('需要您的审批', text || 'Agent 请求一项操作审批')
    return next()
  })
}