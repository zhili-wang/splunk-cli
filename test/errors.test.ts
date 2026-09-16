import { describe, expect, it } from 'vitest'

import {
  ConfigurationError,
  EXIT_CODES,
  SplunkAuthenticationError,
  SplunkConnectionError,
  SplunkError,
  SplunkJobError,
  SplunkQueryError,
  SplunkResultError,
  SplunkTimeoutError,
  errorPayload,
  exitCodeFor,
  sanitizeMessage,
} from '../server/errors'

describe('sanitizeMessage', () => {
  it('折叠空白并去掉首尾空白', () => {
    expect(sanitizeMessage('  a \n b\t\tc  ')).toBe('a b c')
  })

  it('抹掉 Splunk session key，但保留普通的 "Splunk HTTP 502" 叙述', () => {
    expect(sanitizeMessage('key Splunk ABCDEFGHIJKLMNOP1234567890 end')).toBe(
      'key Splunk <redacted> end',
    )
    expect(sanitizeMessage('Splunk HTTP 502')).toBe('Splunk HTTP 502')
  })

  it('抹掉 Basic / Bearer 凭据', () => {
    // 注意这里的双重脱敏是**刻意保留的行为**，不是 bug：
    // 先用 (Basic|Bearer) 规则把密码换成 <redacted>，随后 key=value 规则又匹配到
    // "Authorization: Basic" 并再替换一次。实测输出完全相同。
    expect(sanitizeMessage('Authorization: Basic dXNlcjpwYXNz')).toBe(
      'Authorization=<redacted> <redacted>',
    )
    expect(sanitizeMessage('Bearer abcdefghijklmnop')).toBe('Bearer <redacted>')
  })

  it('抹掉 key=value 形式的密钥', () => {
    expect(sanitizeMessage('password=hunter2 and more')).toBe('password=<redacted> and more')
    expect(sanitizeMessage('token: abc123')).toBe('token=<redacted>')
  })

  it('抹掉 JSON 形式的密钥键值对', () => {
    expect(sanitizeMessage('{"password": "hunter2"}')).toBe('{"password":"<redacted>"}')
  })

  it('按 limit 截断并加省略号', () => {
    const out = sanitizeMessage('x'.repeat(50), 10)
    expect(out).toBe(`${'x'.repeat(7)}...`)
    expect(out.length).toBe(10)
  })
})

describe('错误类型与退出码（AGENTS.md §5 的公开契约）', () => {
  const cases: Array<[SplunkError, string, number]> = [
    [new SplunkError('boom'), 'SplunkError', 1],
    [new ConfigurationError('boom'), 'ConfigurationError', 2],
    [new SplunkAuthenticationError('boom'), 'SplunkAuthenticationError', 3],
    [new SplunkConnectionError('boom'), 'SplunkConnectionError', 4],
    [new SplunkQueryError('boom'), 'SplunkQueryError', 5],
    [new SplunkJobError('boom'), 'SplunkJobError', 5],
    [new SplunkResultError('boom'), 'SplunkResultError', 5],
    [new SplunkTimeoutError('boom'), 'SplunkTimeoutError', 7],
  ]

  for (const [error, type, code] of cases) {
    it(`${type} → error.type=${type}、退出码 ${code}`, () => {
      expect(error.errorType).toBe(type)
      expect(exitCodeFor(error)).toBe(code)
      expect(errorPayload(error)).toEqual({ success: false, error: { type, message: 'boom' } })
    })
  }

  it('退出码表是公开契约', () => {
    expect(EXIT_CODES).toEqual({
      SplunkError: 1,
      ConfigurationError: 2,
      SplunkAuthenticationError: 3,
      SplunkConnectionError: 4,
      SplunkQueryError: 5,
      SafetyLimitError: 6,
      SplunkTimeoutError: 7,
      SplunkJobError: 5,
      SplunkResultError: 5,
    })
  })

  it('details 为空时整个键省略', () => {
    expect(new SplunkError('m').toDict()).toEqual({ type: 'SplunkError', message: 'm' })
    expect(new SplunkError('m', { details: { a: 1 } }).toDict()).toEqual({
      type: 'SplunkError',
      message: 'm',
      details: { a: 1 },
    })
  })

  it('非 taxonomy 错误归到退出码 1，并给出脱敏后的消息', () => {
    expect(exitCodeFor(new Error('boom'))).toBe(1)
    expect(exitCodeFor('not-an-error')).toBe(1)
    const payload = errorPayload(new TypeError('bad token=abc123'))
    expect(payload.success).toBe(false)
    expect(payload.error['type']).toBe('TypeError')
    expect(payload.error['message']).toBe('bad token=<redacted>')
  })

  it('构造时就脱敏：凭据不会存活在 message 里', () => {
    const error = new SplunkError('failed with password=hunter2')
    expect(error.message).toBe('failed with password=<redacted>')
    expect(JSON.stringify(error.toDict())).not.toContain('hunter2')
  })

  it('instanceof 关系让调用方可以按基类捕获', () => {
    expect(new ConfigurationError('m')).toBeInstanceOf(SplunkError)
    expect(new SplunkTimeoutError('m')).toBeInstanceOf(SplunkError)
  })
})
