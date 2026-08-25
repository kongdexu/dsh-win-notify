import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/index'

// The helper EXE ships inside lib/.dsh-notify (built output), so it is not
// present next to the src/ entry the tests execute. Pretend the toast EXE
// exists so the tests can drive the spawn path; everything else (the csc
// compile-fallback probe, README assets, …) uses the real filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (p: string) =>
      String(p).toLowerCase().endsWith('dshtoast.exe') ? true : actual.existsSync(p),
  }
})

/**
 * Behavior tests for the plugin wiring. The `ctx` is fully mocked; no real
 * subprocess is ever spawned and no Windows API is touched. Platform
 * independence: on non-Windows hosts the guard must make `apply()` a no-op,
 * which the last `describe` asserts on every OS; on Windows the same block
 * additionally drives real event → spawn(argv) behavior.
 */

interface Listener {
  event: string
  cb: (...args: any[]) => unknown
}

interface SpawnCall {
  argv: string[]
  cwd: string
}

function makeRootAgent(sessionId = 'root-1', header: Record<string, unknown> = {}) {
  // A stable object identity per agent being essential (WeakMap state),
  // each call builds a fresh agent.
  return { id: sessionId, session: { header, _sessionId: sessionId } as any }
}

function makeCtx() {
  const listeners: Listener[] = []
  const spawns: SpawnCall[] = []
  const ctx = {
    get: vi.fn((svc: string): any => (svc === 'sessionTitle' ? new Map() : undefined)),
    on: vi.fn((event: string, cb: (...args: any[]) => unknown) => {
      listeners.push({ event, cb })
    }),
    subprocess: {
      spawn: vi.fn((opts: { argv: string[]; cwd: string }) => {
        spawns.push({ argv: opts.argv, cwd: opts.cwd })
        return { done: Promise.resolve(0) }
      }),
    },
  }
  return { ctx, listeners, spawns }
}

function fire(ctx: ReturnType<typeof makeCtx>['ctx'], event: string, ...args: unknown[]) {
  const rec = ctx.on.mock.calls.find(([e]) => e === event)
  if (!rec) throw new Error('listener not registered: ' + event)
  return rec[1](...args)
}

const isWin = process.platform === 'win32'

describe('plugin shape', () => {
  it('exports the cordis plugin contract', () => {
    expect(name).toBe('dsh-win-notify')
    expect(inject).toContain('subprocess')
    expect(typeof apply).toBe('function')
  })
})

describe.skipIf(!isWin)('apply() wiring (Windows)', () => {
  let ctx: ReturnType<typeof makeCtx>['ctx']
  let spawns: SpawnCall[]

  beforeEach(() => {
    const made = makeCtx()
    ctx = made.ctx
    spawns = made.spawns
    apply(ctx)
  })

  function helperSpawns() {
    return spawns.filter((s) => s.argv[0].toLowerCase().endsWith('dshtoast.exe'))
  }

  it('registers the three host event listeners', () => {
    const events = ctx.on.mock.calls.map(([e]) => e)
    expect(events).toContain('agent/status')
    expect(events).toContain('tools/execute')
    expect(events).toContain('approval/request')
  })

  it('raises 任务完成 on root agent running -> idle', () => {
    const agent = makeRootAgent('r1')
    fire(ctx, 'agent/status', { agent, status: 'running' })
    fire(ctx, 'agent/status', { agent, status: 'idle' })
    const calls = helperSpawns()
    expect(calls).toHaveLength(1)
    expect(calls[0].argv[1]).toBe('任务完成')
  })

  it('never raises for subagent completion churn', () => {
    const sub = makeRootAgent('sub-1', { origin: 'subagent' })
    fire(ctx, 'agent/status', { agent: sub, status: 'running' })
    fire(ctx, 'agent/status', { agent: sub, status: 'idle' })
    expect(helperSpawns()).toHaveLength(0)
  })

  it('enforces the per-agent completion cooldown', () => {
    vi.useFakeTimers()
    try {
      const agent = makeRootAgent('r2')
      fire(ctx, 'agent/status', { agent, status: 'running' })
      fire(ctx, 'agent/status', { agent, status: 'idle' })
      fire(ctx, 'agent/status', { agent, status: 'running' })
      fire(ctx, 'agent/status', { agent, status: 'idle' })
      expect(helperSpawns()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('raises 需要您的输入 on ask_user_question for a root agent and returns next()', () => {
    let nextCalled = 0
    const ret = fire(ctx, 'tools/execute', { name: 'ask_user_question', arguments: { questions: [{ question: '继续？' }] }, agent: makeRootAgent('q1') }, () => { nextCalled += 1 })
    expect(ret === undefined || typeof ret === 'function').toBe(true)
    // waterfall must always be released
    expect(nextCalled).toBe(1)
    const calls = helperSpawns()
    expect(calls).toHaveLength(1)
    expect(calls[0].argv[1]).toBe('需要您的输入')
    expect(calls[0].argv[2]).toContain('继续？')
  })

  it('does not ping on subagent questions but still releases the waterfall', () => {
    let nextCalled = 0
    fire(ctx, 'tools/execute', { name: 'ask_user_question', arguments: { questions: [{ question: 'x' }] }, agent: makeRootAgent('q2', { origin: 'subagent' }) }, () => { nextCalled += 1 })
    expect(nextCalled).toBe(1)
    expect(helperSpawns()).toHaveLength(0)
  })

  it('ignores non-question tool executions', () => {
    fire(ctx, 'tools/execute', { name: 'read', arguments: {} }, () => {})
    expect(helperSpawns()).toHaveLength(0)
  })

  it('raises 需要您的审批 for root-agent approval requests and releases the waterfall', () => {
    let nextCalled = 0
    fire(ctx, 'approval/request', { tool: { name: 'pwsh' }, reason: '执行命令', agent: makeRootAgent('a1') }, () => { nextCalled += 1 })
    expect(nextCalled).toBe(1)
    const calls = helperSpawns()
    expect(calls).toHaveLength(1)
    expect(calls[0].argv[1]).toBe('需要您的审批')
    expect(calls[0].argv[2]).toContain('执行命令')
  })

  it('uses the session title in the completion body when available', () => {
    const session = {}
    const sessionTitle = new Map([[session, { title: '发布插件' }]])
    const made = makeCtx()
    made.ctx.get.mockImplementation((svc: string) => (svc === 'sessionTitle' ? sessionTitle : undefined))
    apply(made.ctx)
    const agent = { session }
    fire(made.ctx, 'agent/status', { agent, status: 'running' })
    fire(made.ctx, 'agent/status', { agent, status: 'idle' })
    const calls = made.spawns.filter((s) => s.argv[0].toLowerCase().endsWith('dshtoast.exe'))
    expect(calls).toHaveLength(1)
    expect(calls[0].argv[2]).toContain('发布插件')
  })
})

describe.skipIf(isWin)('apply() platform guard (non-Windows)', () => {
  it('registers nothing and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const made = makeCtx()
      apply(made.ctx)
      expect(made.ctx.on).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Windows-only'))
    } finally {
      warn.mockRestore()
    }
  })
})