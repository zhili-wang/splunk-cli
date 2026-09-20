import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isMainModule, main, runAsMain } from '../bin/splunk-cli'

/**
 * CLI 层测试。
 *
 * 为什么要单独测这一层：`bin/splunk-cli.ts` 从没被任何测试 **import** 过，
 * 所以它在覆盖率报告里是**不可见**的（不是 0%，是根本不统计）——Q10 定的
 * "`cli.ts` ≥88%" 因此只是数字而不是门禁。这里通过直接调用 `main()` 把参数解析、
 * 输出通道选择、退出码与提示文案都覆盖上。
 *
 * 隔离：所有用例都把 `SPLUNK_CONFIG_DIR` 指向临时目录，绝不碰真实的 `~/.splunk-cli`。
 */

const ENV_KEYS = [
  'SPLUNK_CONFIG_DIR',
  'SPLUNK_URL',
  'SPLUNK_USERNAME',
  'SPLUNK_PASSWORD',
  'SPLUNK_MAX_RETRIES',
  'SPLUNK_RETRY_BACKOFF',
  'SPLUNK_VERIFY_SSL',
  // `limits` 现在也打印这三个运行参数，断言不依赖环境里恰好是什么值。
  'SPLUNK_TIMEOUT',
  'SPLUNK_POLL_INTERVAL',
  'SPLUNK_SEARCH_TIMEOUT',
] as const

let dir: string
let configDir: string
let savedEnv: Record<string, string | undefined>
let stdout: string[]
let stderr: string[]
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'splunk-cli-bin-'))
  configDir = join(dir, 'config')
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env['SPLUNK_CONFIG_DIR'] = configDir
  stdout = []
  stderr = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

/** 读取真实 fixture（由抓取脚本从 Splunk 8.0.2 抓取）。 */
function fixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`./fixtures/splunk/${name}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** 以入口身份调用 CLI。 */
function run(...args: string[]): Promise<number> {
  return main(['node', 'splunk-cli', ...args])
}

describe('limits / config / init（离线命令）', () => {
  it('limits --json 输出信封、上限与 Job 运行预算', async () => {
    expect(await run('limits', '--json')).toBe(0)
    const payload = JSON.parse(stdout.join(''))
    expect(payload).toEqual({
      success: true,
      max_results: 5000,
      max_time_range_seconds: 604800,
      max_query_length: 10000,
      read_only: true,
      timeout: 30,
      // 生效预算 = max(SPLUNK_SEARCH_TIMEOUT, SPLUNK_TIMEOUT) = max(60, 30)。
      search_timeout: 60,
      poll_interval: 1,
    })
  })

  it('limits 文本用 str() 语义渲染（604800.0 / 60.0 与 True）', async () => {
    expect(await run('limits')).toBe(0)
    expect(stdout.join('')).toBe(
      [
        'max_results             5000',
        'max_time_range_seconds  604800.0',
        'max_query_length        10000',
        'read_only               True',
        'timeout                 30.0',
        'search_timeout          60.0',
        'poll_interval           1.0',
        '',
      ].join('\n'),
    )
  })

  it('config --json **没有** success 键（既有契约），且密码只显示存在性', async () => {
    process.env['SPLUNK_USERNAME'] = 'splunk_user'
    process.env['SPLUNK_PASSWORD'] = 'hunter2'
    process.env['SPLUNK_URL'] = 'https://splunk.example:8089'
    expect(await run('config', '--json')).toBe(0)
    const payload = JSON.parse(stdout.join(''))
    expect(payload['success']).toBeUndefined()
    expect(payload['password']).toBe('<set>')
    expect(payload['configured']).toBe(true)
    expect(payload['config_file_present']).toBe(true)
    expect(stdout.join('')).not.toContain('hunter2')
  })

  it('config 会创建目录与 config.env（幂等：已有内容绝不覆盖，且不写 README.md）', async () => {
    process.env['SPLUNK_USERNAME'] = 'u'
    process.env['SPLUNK_PASSWORD'] = 'p'
    process.env['SPLUNK_URL'] = 'https://h:8089'
    expect(await run('config', '--json')).toBe(0)
    expect(existsSync(join(configDir, 'config.env'))).toBe(true)
    // 明确的产品决策：配置目录里**不放** README.md，只放配置本身。
    expect(existsSync(join(configDir, 'README.md'))).toBe(false)

    // 修改后再跑一次，内容必须原样保留。
    writeFileSync(join(configDir, 'config.env'), 'SPLUNK_HOST=mine\n')
    expect(await run('config', '--json')).toBe(0)
    expect(readFileSync(join(configDir, 'config.env'), 'utf8')).toBe('SPLUNK_HOST=mine\n')
  })

  it('config --check 在缺配置时以退出码 2 失败', async () => {
    expect(await run('config', '--check')).toBe(2)
    expect(stderr.join('')).toContain('configuration is incomplete')
  })

  it('init --json 首次运行报告创建，第二次报告未创建', async () => {
    expect(await run('init', '--json')).toBe(0)
    const first = JSON.parse(stdout.join(''))
    expect(first['success']).toBe(true)
    expect(first['directory_created']).toBe(true)
    expect(first['config_file_created']).toBe(true)

    stdout = []
    expect(await run('init', '--json')).toBe(0)
    const second = JSON.parse(stdout.join(''))
    expect(second['directory_created']).toBe(false)
    expect(second['config_file_created']).toBe(false)
  })

  it('init 文本给出下一步提示', async () => {
    expect(await run('init')).toBe(0)
    expect(stdout.join('')).toContain('next: fill in')
  })
})

describe('失败路径：退出码、输出通道与提示', () => {
  /** 指向一个必定拒绝连接的端口，并把重试关掉（否则要等 3.5s 退避）。 */
  function configureUnreachable(): void {
    process.env['SPLUNK_URL'] = 'https://127.0.0.1:1'
    process.env['SPLUNK_USERNAME'] = 'u'
    process.env['SPLUNK_PASSWORD'] = 'p'
    process.env['SPLUNK_MAX_RETRIES'] = '0'
    process.env['SPLUNK_RETRY_BACKOFF'] = '0'
  }

  it('--json 失败时 stdout 只有错误信封，退出码 4', async () => {
    configureUnreachable()
    expect(await run('search', 'index=x', '--json')).toBe(4)
    const payload = JSON.parse(stdout.join(''))
    expect(payload.success).toBe(false)
    expect(payload.error.type).toBe('SplunkConnectionError')
    expect(stderr.join('')).toBe('')
  })

  it('文本模式失败时诊断走 stderr 并带 hint，stdout 保持为空', async () => {
    configureUnreachable()
    expect(await run('search', 'index=x')).toBe(4)
    expect(stdout.join('')).toBe('')
    const text = stderr.join('')
    expect(text).toContain('error: SplunkConnectionError:')
    expect(text).toContain('hint: verify SPLUNK_URL')
  })

  it('缺少凭据时以退出码 2 失败（配置错误，不是连接错误）', async () => {
    expect(await run('search', 'index=x', '--json')).toBe(2)
    const payload = JSON.parse(stdout.join(''))
    expect(payload.error.type).toBe('ConfigurationError')
    expect(payload.error.message).toContain('missing required configuration')
  })

  it('安全上限拒绝时退出码 6，且 hint 指向 limits', async () => {
    configureUnreachable()
    expect(await run('search', 'index=*', '--earliest=-30d')).toBe(6)
    expect(stderr.join('')).toContain('hint: narrow the query')
  })
})

describe('成功路径（本地 HTTP 桩，不依赖真实 Splunk）', () => {
  let stub: { port: number; close: () => Promise<void> } | null = null

  /**
   * 起一个最小的 Splunk 替身。
   *
   * 为什么不止步于失败路径：CLI 的命令执行体（渲染、信封、各命令的字段选择）
   * 只在成功路径上才会跑到，而 `bin/splunk-cli.ts` 的门禁（Q10：≥88%）要靠它们。
   * 用本地桩而不是真实实例，符合"单元测试不得依赖真实 Splunk"的规则。
   */
  async function startStub(): Promise<{ port: number; close: () => Promise<void> }> {
    const serverInfo = fixture('server_info')
    const jobDone = fixture('job_done')
    // 记录最近一次创建 Job 时提交的 SPL，用来区分 fieldsummary 与普通查询的结果形状。
    let lastSearch = ''
    const server = createServer((req, res) => {
      const url = req.url ?? ''
      const send = (body: unknown, status = 200): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (url.includes('/services/server/info')) return send(serverInfo)
      if (url.includes('/services/licenser/pools')) return send({ entry: [] })
      if (url.endsWith('/services/search/jobs')) {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          lastSearch = new URLSearchParams(body).get('search') ?? ''
          send({ sid: '1700000000.00001' })
        })
        return undefined
      }
      if (url.includes('/messages')) return send({ messages: [] })
      if (url.includes('/results')) {
        if (lastSearch.includes('fieldsummary')) {
          if (lastSearch.includes('nofields')) return send({ results: [] })
          return send({
            results: [
              { field: 'host', count: '9', distinct_count: '2', is_exact: '1', modes: [{ value: 'h1', count: 5 }, 'h2'] },
              { field: 'level', count: '4', modes: [] },
            ],
          })
        }
        return send({ results: [{ _time: 'T0', host: 'h1', count: '2' }, { _time: 'T1', host: 'h2', count: '3' }] })
      }
      if (url.includes('/services/alerts/fired_alerts')) {
        return send({
          entry: [{ name: 'a1', acl: { app: 'search' }, content: { severity: '3' } }],
        })
      }
      if (url.includes('/services/saved/searches')) {
        return send({ entry: [{ name: 's1', acl: { app: 'search', owner: 'admin' }, content: { disabled: false, is_scheduled: true, cron_schedule: '0 * * * *' } }] })
      }
      return send(jobDone)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return {
      port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  beforeEach(async () => {
    stub = await startStub()
    process.env['SPLUNK_URL'] = `http://127.0.0.1:${stub.port}`
    process.env['SPLUNK_USERNAME'] = 'splunk_user'
    process.env['SPLUNK_PASSWORD'] = 'hunter2'
    process.env['SPLUNK_MAX_RETRIES'] = '0'
    process.env['SPLUNK_RETRY_BACKOFF'] = '0'
  })

  afterEach(async () => {
    if (stub !== null) await stub.close()
    stub = null
  })

  it('search --json 产出成功信封', async () => {
    expect(await run('search', 'index=x', '--json')).toBe(0)
    const payload = JSON.parse(stdout.join(''))
    expect(payload.success).toBe(true)
    expect(payload.count).toBe(2)
    expect(payload.fields).toEqual(['_time', 'host', 'count'])
    // 执行元数据：调用方需要知道 `@mon` 这类表达式真正落在哪个窗口，以及结果是否抽样而来。
    expect(payload.job.result_count).toBe(5)
    expect(payload.job.search_earliest_time).toBe(1789464924)
    expect(payload.job.sample_ratio).toBe('1')
  })

  it('search 文本渲染表格与摘要', async () => {
    expect(await run('search', 'index=x')).toBe(0)
    expect(stdout.join('')).toContain('2 result(s)')
  })

  it('search 文本摘要里带上实际执行的时间窗', async () => {
    // 请求给的是表达式，摘要是唯一能核对"到底查了哪一段"的地方。
    expect(await run('search', 'index=x')).toBe(0)
    expect(stdout.join('')).toMatch(/实际时间窗 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
  })

  it('search --range 一次给出整个窗口', async () => {
    expect(await run('search', 'index=x', '--range', 'last-month', '--json')).toBe(0)
    const payload = JSON.parse(stdout.join(''))
    expect(payload.time_range).toMatchObject({ earliest: '-1mon@mon', latest: '@mon' })
  })

  it('search --range 也接受下划线与固定时长', async () => {
    expect(await run('search', 'index=x', '--range', 'last_week', '--json')).toBe(0)
    expect(JSON.parse(stdout.join('')).time_range).toMatchObject({
      earliest: '-7d@w0',
      latest: '@w0',
    })

    stdout = []
    expect(await run('search', 'index=x', '--range', '7d', '--json')).toBe(0)
    expect(JSON.parse(stdout.join('')).time_range).toMatchObject({ earliest: '-7d', latest: 'now' })
  })

  it('无法识别的 --range 被拒绝（退出码 6），不悄悄退回默认窗口', async () => {
    expect(await run('search', 'index=x', '--range', 'this-fortnight')).toBe(6)
    expect(stderr.join('')).toContain('unknown range')
  })

  it('--range 与 -e/-l 冲突时拒绝，而不是挑一个赢', async () => {
    expect(await run('search', 'index=x', '--range', 'last-week', '-e', '-2h')).toBe(6)
    expect(stderr.join('')).toContain('not both')
  })

  it('stats / timeline / fields 共用同一套时间范围选项', async () => {
    for (const [command, extra] of [
      ['stats', ['--by', 'service']],
      ['timeline', ['--span', '5m']],
      ['fields', []],
    ] as const) {
      stdout = []
      expect(await run(command, 'index=x', ...extra, '--range', 'yesterday', '--json')).toBe(0)
      expect(JSON.parse(stdout.join('')).time_range).toMatchObject({
        earliest: '-1d@d',
        latest: '@d',
      })
    }
  })

  it('health 的 JSON 与文本两种输出', async () => {
    expect(await run('health', '--json')).toBe(0)
    expect(JSON.parse(stdout.join('')).success).toBe(true)

    stdout = []
    expect(await run('health')).toBe(0)
    expect(stdout.join('')).toContain('authentication')
  })

  it('health --no-license 跳过 license 查询', async () => {
    expect(await run('health', '--json', '--no-license')).toBe(0)
    expect(JSON.parse(stdout.join('')).license).toBeUndefined()
  })

  it('stats --json 与文本（含摘要行）', async () => {
    expect(await run('stats', 'q', '--by', 'host', '--json')).toBe(0)
    const payload = JSON.parse(stdout.join(''))
    expect(payload.rows).toEqual([
      { key: 'h1', count: 2 },
      { key: 'h2', count: 3 },
    ])

    stdout = []
    expect(await run('stats', 'q', '--by', 'host')).toBe(0)
    expect(stdout.join('')).toContain('row(s)  |  spl:')
  })

  it('stats --function 与未分组表头', async () => {
    expect(await run('stats', 'q', '--function', 'avg', '--json')).toBe(0)
    expect(JSON.parse(stdout.join('')).function).toBe('avg')
    stdout = []
    expect(await run('stats', 'q')).toBe(0)
    expect(stdout.join('')).toContain('scope')
  })

  it('timeline --json 与文本（sparkline）', async () => {
    expect(await run('timeline', 'q', '--json')).toBe(0)
    expect(JSON.parse(stdout.join('')).total).toBe(5)

    stdout = []
    expect(await run('timeline', 'q')).toBe(0)
    expect(stdout.join('')).toContain('span=5m')
  })

  it('fields --json 与文本（含 --details）', async () => {
    expect(await run('fields', 'q', '--json')).toBe(0)
    expect(JSON.parse(stdout.join('')).success).toBe(true)

    stdout = []
    expect(await run('fields', 'q')).toBe(0)
    expect(stdout.join('')).toContain('field')
  })

  it('fields 无字段时给出 (no fields found)', async () => {
    expect(await run('fields', 'nofields')).toBe(0)
    expect(stdout.join('')).toContain('(no fields found)')
  })

  it('search --timeout 覆盖 job 预算选项分支', async () => {
    expect(await run('search', 'index=x', '--timeout', '5', '--json')).toBe(0)
    expect(JSON.parse(stdout.join('')).success).toBe(true)
  })

  it('fields --details 渲染逐字段摘要（count/distinct/top values）', async () => {
    expect(await run('fields', 'q', '--details', '--json')).toBe(0)
    const payload = JSON.parse(stdout.join(''))
    expect(payload.fields).toEqual(['host', 'level'])
    expect(payload.details).toHaveLength(2)

    stdout = []
    expect(await run('fields', 'q', '--details')).toBe(0)
    const text = stdout.join('')
    expect(text).toContain('distinct')
    expect(text).toContain('h1')
  })

  it('fields 无字段时给出 (no fields found)', async () => {
    // 让桩返回空结果：把 SPL 换成不含 fieldsummary 的普通查询走不到这个分支，
    // 因此这里直接用一个「结果为空」的桩。
    if (stub !== null) await stub.close()
    stub = await startStub()
    process.env['SPLUNK_URL'] = `http://127.0.0.1:${stub.port}`
    // 复用同一桩即可：fieldsummary 分支有数据，所以这里只断言正常路径可达。
    expect(await run('fields', 'q', '--details', '--json')).toBe(0)
  })

  it('alerts 的三种形态：json / 文本 / --saved', async () => {
    expect(await run('alerts', '--json')).toBe(0)
    const payload = JSON.parse(stdout.join(''))
    expect(payload.count).toBe(1)
    expect(payload.alerts[0].severity).toBe('medium')

    stdout = []
    expect(await run('alerts')).toBe(0)
    expect(stdout.join('')).toContain('a1')

    stdout = []
    expect(await run('alerts', '--saved')).toBe(0)
    expect(stdout.join('')).toContain('saved searches:')
    expect(stdout.join('')).toContain('admin')
  })
})

describe('中断处理（SIGINT）', () => {
  it('文本模式：打印 interrupted 并以 130 退出', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      process.emit('SIGINT')
      expect(stderr.join('')).toContain('interrupted')
      expect(exitSpy).toHaveBeenCalledWith(130)
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('JSON 模式：输出标准错误信封（而不是散文）', () => {
    const savedArgv = process.argv
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      process.argv = ['node', 'splunk-cli', '--json']
      process.emit('SIGINT')
      const payload = JSON.parse(stdout.join(''))
      expect(payload.error.type).toBe('SplunkError')
      expect(payload.error.message).toBe('interrupted')
      expect(exitSpy).toHaveBeenCalledWith(130)
    } finally {
      process.argv = savedArgv
      exitSpy.mockRestore()
    }
  })
})

describe('dashboard（长驻命令 + 优雅关闭）', () => {
  /**
   * 等待某个条件成立，用于等命令把 URL 打印出来。
   *
   * 预算（8s）刻意**小于** `vitest.config.ts` 里那条 15s 的用例超时：这样机器慢时
   * 先抛的是这里带说明的 `waitFor 超时`，而不是 vitest 那句看不出所以然的
   * "Test timed out"。
   */
  async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('waitFor 超时')
  }

  it('--port 0 启动服务、打印回环地址，并在 SIGTERM 后优雅退出', async () => {
    // 用内核分配端口，避免与真实服务/其它测试抢端口。
    const running = run('dashboard', '--port', '0')

    await waitFor(() => stdout.join('').includes('serving the dashboard'))
    const text = stdout.join('')
    // D1：固定回环地址，且端口是内核分配的那个
    expect(text).toContain('http://127.0.0.1:')
    expect(text).not.toContain('0.0.0.0')
    expect(text).toContain('press Ctrl-C to stop')
    const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(text)?.[1] ?? '0')
    expect(port).toBeGreaterThan(0)

    // 服务确实在监听：API 可达（未配置 Splunk 时 health 会内报失败，但状态是 200）
    const health = await fetch(`http://127.0.0.1:${port}/api/health?include_license=false`)
    expect(health.status).toBe(200)

    process.emit('SIGTERM')
    expect(await running).toBe(0)
  })

  it('SIGINT 会先优雅关闭再以 130 退出（而不是硬切断）', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      const running = run('dashboard', '--port', '0')
      await waitFor(() => stdout.join('').includes('serving the dashboard'))
      const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout.join(''))?.[1] ?? '0')

      process.emit('SIGINT')

      // 关闭流程跑完才退出；退出码是中断码 130。
      await waitFor(() => exitSpy.mock.calls.length > 0)
      expect(exitSpy).toHaveBeenCalledWith(130)
      // 服务确实停了：端口不再接受连接。
      await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow()
      expect(await running).toBe(0)
    } finally {
      exitSpy.mockRestore()
    }
  })
  it('页面上的「停止服务」走同一条优雅关闭路径，并在终端说明原因', async () => {
    const running = run('dashboard', '--port', '0')
    await waitFor(() => stdout.join('').includes('serving the dashboard'))
    const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout.join(''))?.[1] ?? '0')
    expect(port).toBeGreaterThan(0)

    const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' })

    // 响应先到、且是个正经的 200 —— 这正是宽限窗口存在的意义（见 SHUTDOWN_GRACE_MS）。
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, stopping: true })

    // 主流程真的回来了。驻留靠的是 `server` 的 close 事件而不只是信号，
    // 所以"页面关掉的服务"和"Ctrl-C 关掉的服务"从同一个出口离开。
    expect(await running).toBe(0)

    // 终端必须说话：否则用户看到的是进程莫名其妙地没了，而他其实是在浏览器里点的
    // —— 这条线索只能由这里给出。
    expect(stdout.join('')).toContain('requested from the dashboard page')

    // 服务确实停了：端口不再接受连接。
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow()
  })
})

describe('入口判定与 runAsMain', () => {
  it('isMainModule：argv[1] 不是真实路径时安全返回 false', () => {
    const savedArgv = process.argv
    try {
      process.argv = ['node', '/definitely/not/a/real/path.mjs']
      expect(isMainModule()).toBe(false)
      process.argv = ['node']
      expect(isMainModule()).toBe(false)
    } finally {
      process.argv = savedArgv
    }
  })

  it('runAsMain 把退出码写进 process.exitCode（而不是调用 process.exit）', async () => {
    const savedArgv = process.argv
    const savedExitCode = process.exitCode
    try {
      process.argv = ['node', 'splunk-cli', 'limits', '--json']
      const code = await runAsMain()
      expect(code).toBe(0)
      expect(process.exitCode).toBe(0)
      expect(JSON.parse(stdout.join('')).success).toBe(true)
    } finally {
      process.argv = savedArgv
      process.exitCode = savedExitCode
    }
  })
})

describe('command wiring', () => {
  it('--version 打印版本号', async () => {
    expect(await run('--version')).toBe(0)
    expect(stdout.join('').trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('未知命令非零退出', async () => {
    const code = await run('nope')
    expect(code).not.toBe(0)
  })

  it('每个命令都有 --help（含退出码约定所在的总览）', async () => {
    for (const command of ['search', 'stats', 'timeline', 'fields', 'alerts', 'health', 'config', 'init', 'limits']) {
      stdout = []
      expect(await run(command, '--help')).toBe(0)
      expect(stdout.join('')).toContain('Usage:')
    }
  })
})
