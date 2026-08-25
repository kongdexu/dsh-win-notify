/**
 * dsh-win-notify — pure, testable core.
 *
 * Everything here is free of `ctx`, `node:*` imports and Windows APIs so the
 * vitest suite can regression-test it on any platform (CI included). The
 * plugin entry (`src/index.ts`) wires these into DSH host events.
 */

/** Minimum gap between two "任务完成" toasts of the same agent (ms). */
export const FINISH_COOLDOWN_MS = 10_000

/**
 * True only on Windows. The WinRT Toast helper (`.dsh-notify/DshToast.exe`)
 * is a Windows-only binary; declaring `"os": ["win32"]` in package.json is the
 * install-time gate and this guard is the runtime gate (apply() no-ops).
 */
export function isSupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}

/** Clip a string to `max` chars, adding a single ellipsis when truncated. */
export function truncate(text: string, max: number): string {
  if (text.length === 0) return text
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** The minimal session-header shape isRootAgent inspects. */
export interface AgentLike {
  session?: {
    header?: {
      /** Set to 'subagent' by the subagent machinery for in-process children. */
      origin?: string
      /** Present (> 0) on delegated/subagent runs. */
      delegationDepth?: number
    }
  }
}

/**
 * True only for user-facing root agents. Subagents — plain `subagent` runs,
 * AgentTeams members and workflow workers all being in-process children — are
 * marked `origin: "subagent"` (+ `delegationDepth`) in their session header by
 * the subagent machinery. Their running→idle churn must never raise toasts.
 * Forked sessions (`parentSession` without `origin`) stay user-facing.
 */
export function isRootAgent(agent: unknown): boolean {
  try {
    const header = agent && typeof agent === 'object'
      ? (agent as AgentLike).session?.header
      : undefined
    if (!header || typeof header !== 'object') return true // unknown shape: be permissive
    if (header.origin === 'subagent') return false
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
    return true
  } catch {
    return true
  }
}

/** The session-title service face this plugin relies on (duck-typed). */
export interface SessionTitleService {
  get(session: unknown): { title?: string } | undefined
}

/** Subprocess service surfaces used by the plugin (duck-typed, structural). */
export interface SubprocessHandle {
  done?: Promise<unknown>
}

export interface SubprocessService {
  spawn(opts: { argv: string[]; cwd?: string; stdio?: unknown; graceMs?: number }): SubprocessHandle
}

/**
 * The minimal DSH host context this plugin consumes. Structural typing keeps
 * the plugin (and its published types) free of runtime dependencies: the real
 * DSH `Context` satisfies this shape, and tests can hand in a plain mock.
 */
export interface NotifyContext {
  get<T = unknown>(name: string): T
  on(event: string, listener: (...args: any[]) => unknown): unknown
  subprocess: SubprocessService
}

/**
 * Human title of the session this agent is running, when one exists.
 * Resolved directly from `agent.session` (a WeakMap-keyed service lookup that
 * often missed on web sessions) — falls back to undefined on any failure.
 */
export function resolveSessionTitle(agent: unknown, sessionTitle: SessionTitleService | undefined): string | undefined {
  try {
    if (!sessionTitle || typeof agent !== 'object' || agent === null) return undefined
    const session = (agent as AgentLike).session
    if (!session) return undefined
    const snapshot = sessionTitle.get(session)
    if (snapshot && typeof snapshot.title === 'string' && snapshot.title.length > 0) return snapshot.title
  } catch {
    // Any extraction failure falls back to a generic message.
  }
  return undefined
}

/**
 * One-line label for an ask_user_question tool execution. Reads the first
 * question's text (or header) and appends a count when several questions are
 * asked at once.
 */
export function resolveQuestionText(exec: unknown): string | undefined {
  try {
    const e = exec as { arguments?: { questions?: unknown[] }, args?: { questions?: unknown[] }, input?: { questions?: unknown[] } }
    const args = e.arguments || e.args || e.input
    const questions = args && args.questions
    if (!Array.isArray(questions) || questions.length === 0) return undefined
    const first = questions[0] as { question?: string, header?: string } | undefined
    const text = first && (first.question || first.header)
    if (typeof text !== 'string' || text.length === 0) return undefined
    const label = '问题：' + truncate(text, 80)
    return questions.length > 1 ? label + '（共 ' + questions.length + ' 个问题）' : label
  } catch {
    return undefined
  }
}

/**
 * One-line label for a pending approval request: tool name + reason. Either
 * may be absent; returns undefined only when nothing usable is present.
 */
export function resolveApprovalText(req: unknown): string | undefined {
  try {
    const r = req as {
      reason?: string, description?: string, toolName?: string,
      tool?: { name?: string } | string,
    }
    const reason = r.reason || r.description
    const toolObj = r.tool
    const toolName = r.toolName || (toolObj && typeof toolObj === 'object' && toolObj.name) || (typeof toolObj === 'string' ? toolObj : undefined)
    const parts: string[] = []
    if (typeof toolName === 'string' && toolName.length > 0) parts.push('操作：' + truncate(toolName, 40))
    if (typeof reason === 'string' && reason.length > 0) parts.push('原因：' + truncate(reason, 80))
    return parts.length > 0 ? parts.join('；') : undefined
  } catch {
    return undefined
  }
}