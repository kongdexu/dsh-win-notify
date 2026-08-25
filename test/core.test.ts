import { describe, expect, it } from 'vitest'
import {
  FINISH_COOLDOWN_MS,
  isRootAgent,
  isSupportedPlatform,
  resolveApprovalText,
  resolveQuestionText,
  resolveSessionTitle,
  truncate,
  type SessionTitleService,
} from '../src/core'

describe('truncate', () => {
  it('returns empty string unchanged', () => {
    expect(truncate('', 10)).toBe('')
  })

  it('keeps short strings intact', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })

  it('clips long strings with a single ellipsis', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde…')
    expect(truncate('abcdefghij', 5).length).toBe(6)
  })

  it('handles CJK strings by code units', () => {
    expect(truncate('任务完成通知测试', 4)).toBe('任务完成…')
  })
})

describe('isSupportedPlatform', () => {
  it('accepts only win32', () => {
    expect(isSupportedPlatform('win32')).toBe(true)
    expect(isSupportedPlatform('linux')).toBe(false)
    expect(isSupportedPlatform('darwin')).toBe(false)
    expect(isSupportedPlatform('freebsd')).toBe(false)
  })
})

describe('isRootAgent', () => {
  it('is permissive for unknown shapes', () => {
    expect(isRootAgent(undefined)).toBe(true)
    expect(isRootAgent(null)).toBe(true)
    expect(isRootAgent({})).toBe(true)
  })

  it('treats a plain session without header as root', () => {
    expect(isRootAgent({ session: {} })).toBe(true)
  })

  it('skips subagent-origin sessions', () => {
    expect(isRootAgent({ session: { header: { origin: 'subagent' } } })).toBe(false)
  })

  it('skips delegated sessions (delegationDepth > 0)', () => {
    expect(isRootAgent({ session: { header: { delegationDepth: 1 } } })).toBe(false)
    expect(isRootAgent({ session: { header: { delegationDepth: 3 } } })).toBe(false)
  })

  it('keeps forked sessions (parentSession without origin) user-facing', () => {
    expect(isRootAgent({ session: { header: { parentSession: 'abc' } } })).toBe(true)
  })

  it('tolerates malformed session shapes', () => {
    expect(isRootAgent('not-an-object')).toBe(true)
    expect(isRootAgent(42)).toBe(true)
  })
})

describe('resolveSessionTitle', () => {
  const service: SessionTitleService = new Map([['s1', { title: '会话标题' }]]) as unknown as SessionTitleService

  it('returns the title when present', () => {
    expect(resolveSessionTitle({ session: 's1' }, service)).toBe('会话标题')
  })

  it('returns undefined when the session is unknown', () => {
    expect(resolveSessionTitle({ session: 's2' }, service)).toBeUndefined()
  })

  it('returns undefined without a service or session', () => {
    expect(resolveSessionTitle({ session: 's1' }, undefined)).toBeUndefined()
    expect(resolveSessionTitle({}, service)).toBeUndefined()
    expect(resolveSessionTitle(null, service)).toBeUndefined()
  })

  it('returns undefined for empty titles', () => {
    const empty: SessionTitleService = new Map([['s1', { title: '' }]]) as unknown as SessionTitleService
    expect(resolveSessionTitle({ session: 's1' }, empty)).toBeUndefined()
  })
})

describe('resolveQuestionText', () => {
  it('extracts the first question with a count suffix', () => {
    const text = resolveQuestionText({
      name: 'ask_user_question',
      arguments: { questions: [{ question: 'A' }, { header: 'B' }] },
    })
    expect(text).toBe('问题：A（共 2 个问题）')
  })

  it('reads args/input aliases and header fallback', () => {
    expect(resolveQuestionText({ args: { questions: [{ header: 'H' }] } })).toBe('问题：H')
    expect(resolveQuestionText({ input: { questions: [{ question: 'Q' }] } })).toBe('问题：Q')
  })

  it('truncates long questions', () => {
    const long = 'x'.repeat(100)
    const text = resolveQuestionText({ arguments: { questions: [{ question: long }] } })
    expect(text).toBe('问题：' + 'x'.repeat(80) + '…')
  })

  it('returns undefined for empty/missing question lists', () => {
    expect(resolveQuestionText({ arguments: {} })).toBeUndefined()
    expect(resolveQuestionText({ arguments: { questions: [] } })).toBeUndefined()
    expect(resolveQuestionText({ arguments: { questions: [{ foo: 1 }] } })).toBeUndefined()
    expect(resolveQuestionText(null)).toBeUndefined()
    expect(resolveQuestionText('nope')).toBeUndefined()
  })
})

describe('resolveApprovalText', () => {
  it('combines tool name and reason', () => {
    expect(resolveApprovalText({ toolName: 'write', reason: '创建文件' })).toBe('操作：write；原因：创建文件')
  })

  it('supports tool object forms and description fallback', () => {
    expect(resolveApprovalText({ tool: { name: 'edit' }, description: '修改配置' })).toBe('操作：edit；原因：修改配置')
    expect(resolveApprovalText({ tool: 'pwsh', reason: '执行命令' })).toBe('操作：pwsh；原因：执行命令')
  })

  it('tolerates partial information', () => {
    expect(resolveApprovalText({ toolName: 'write' })).toBe('操作：write')
    expect(resolveApprovalText({ reason: 'x' })).toBe('原因：x')
  })

  it('returns undefined when nothing usable is present', () => {
    expect(resolveApprovalText({})).toBeUndefined()
    expect(resolveApprovalText(null)).toBeUndefined()
    expect(resolveApprovalText(undefined)).toBeUndefined()
  })
})

describe('constants', () => {
  it('exposes the completion cooldown', () => {
    expect(FINISH_COOLDOWN_MS).toBe(10_000)
  })
})