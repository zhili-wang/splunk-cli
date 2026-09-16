import { afterEach, describe, expect, it } from 'vitest'

import { debug, error, info, serializeData, setLogLevel, setLoggerOutput, warn } from '../server/logger'

/**
 * 日志格式是被测试锁定的契约：它决定排查时能不能稳定 grep。
 * 更重要的两条不变式：
 *   - **全部写 stderr**，stdout 只留机器载荷；
 *   - 任何级别都不打印凭据。
 */
const captured: string[] = []

afterEach(() => {
  captured.length = 0
  setLoggerOutput(null)
  setLogLevel(null)
})

describe('日志格式与级别', () => {
  it('格式为 ISO时间 [LEVEL] [mod ] msg {json}，模块名定宽 4 字符', () => {
    setLoggerOutput((line) => captured.push(line))
    setLogLevel('info')
    info('server', '服务已启动', { port: 8765 })
    expect(captured[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO \] \[serv\] 服务已启动 \{"port":8765\}$/,
    )
  })

  it('模块名短于 4 字符时补空格、长于 4 字符时截断', () => {
    setLoggerOutput((line) => captured.push(line))
    setLogLevel('info')
    info('io', 'x')
    info('verylongmodule', 'y')
    expect(captured[0]).toContain('[io  ]')
    expect(captured[1]).toContain('[very]')
  })

  it('低于当前级别的日志被丢弃', () => {
    setLoggerOutput((line) => captured.push(line))
    setLogLevel('warn')
    debug('test', 'd')
    info('test', 'i')
    warn('test', 'w')
    error('test', 'e')
    expect(captured).toHaveLength(2)
    expect(captured[0]).toContain('[WARN ]')
    expect(captured[1]).toContain('[ERROR]')
  })

  it('无附加数据时不输出尾随 JSON', () => {
    setLoggerOutput((line) => captured.push(line))
    setLogLevel('info')
    info('test', 'plain')
    expect(captured[0]?.endsWith('plain')).toBe(true)
  })

  it('默认 sink 写 stderr 而不是 stdout（stdout 留给机器载荷）', () => {
    const originals = { out: process.stdout.write, err: process.stderr.write }
    const toStdout: string[] = []
    const toStderr: string[] = []
    process.stdout.write = ((chunk: string) => {
      toStdout.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string) => {
      toStderr.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      setLogLevel('info')
      info('test', 'hello')
    } finally {
      process.stdout.write = originals.out
      process.stderr.write = originals.err
    }
    expect(toStdout).toHaveLength(0)
    expect(toStderr.join('')).toContain('hello')
  })
})

describe('serializeData', () => {
  it('undefined 不产生输出', () => {
    expect(serializeData(undefined)).toBe('')
  })

  it('Error 转成 {name, message, stack}', () => {
    const text = serializeData({ err: new Error('boom') })
    expect(text).toContain('"name":"Error"')
    expect(text).toContain('"message":"boom"')
    expect(text).toContain('"stack"')
  })

  it('Date 转 ISO 字符串', () => {
    expect(serializeData({ at: new Date('2026-09-15T00:00:00.000Z') })).toBe(
      ' {"at":"2026-09-15T00:00:00.000Z"}',
    )
  })

  it('循环引用降级而不是抛错', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node['self'] = node
    expect(serializeData(node)).toContain('circular')
  })
})
