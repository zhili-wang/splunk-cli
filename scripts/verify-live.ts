#!/usr/bin/env node
/**
 * 实机验收 —— 对着**真实 Splunk 实例**逐条执行验收清单。
 *
 * 这不是单元测试，而是把"这套实现在真实实例上真的能用"变成可复现的证据：每条检查都记录
 * **实际观察到的**退出码与输出，而不是断言"应该没问题"。
 *
 * 用法：
 *   npm run verify:live                       # 需要已配置可用的 Splunk
 *   npm run verify:live -- --json-out /tmp/live.json
 *
 * 与集成测试（`test/integration/`）的分工：集成测试验证 Service 层的**行为**；
 * 本脚本验证**交付形态**——CLI 的退出码、JSON 信封、面板 HTTP 接口、打包产物，
 * 以及 `AGENTS.md` §2.13/§2.14 的"日志里绝不出现凭据"。
 *
 * 安全：脚本读取真实密码只为了两件事——从输出中**擦除**它，以及断言它从未出现在
 * 日志里。密码本身绝不写入报告、绝不打印。
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Agent, request as undiciRequest } from 'undici'

import { loadSettings, type Settings } from '../server/config/settings'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const BUNDLE = join(ROOT, 'dist', 'bin', 'splunk-cli.mjs')
/** 面板验收用的端口。与 CLI 默认的 8765 错开，避免撞上开发者正在跑的面板。 */
const DASHBOARD_PORT = 8931

/**
 * 实测负载索引 —— 由 `detectWorkloadIndex()` 在启动时探测。
 *
 * 为什么不写死 `index=_internal`：那个索引在多数生产实例上对普通用户**没有数据**
 * （本次实机就是 0 条）。写死会让"命令能对真实数据返回"这项用空结果集"通过"，
 * 等于什么都没验证。所以先问实例"哪个索引有数据"，再拿它做全部检查。
 */
let workloadIndex = '_internal'

type Status = 'PASS' | 'FAIL' | 'INFO' | 'SKIP'

interface Check {
  id: string
  title: string
  expectation: string
  status: Status
  observed: string
  detail?: string
}

const checks: Check[] = []
const workDir = mkdtempSync(join(tmpdir(), 'splunk-cli-live-'))

/** 真实密码，仅用于擦除与泄漏断言。 */
let secret = ''

/** 把输出里的密码擦掉——报告会被归档，绝不能带上凭据。 */
function redact(text: string): string {
  return secret === '' ? text : text.split(secret).join('<redacted>')
}

function record(check: Check): void {
  checks.push({
    ...check,
    observed: redact(check.observed),
    detail: check.detail === undefined ? undefined : redact(check.detail),
  })
  process.stdout.write(`[${check.status.padEnd(4)}] ${check.id.padEnd(22)} ${check.title}\n`)
  if (check.status !== 'PASS') {
    process.stdout.write(`        期望: ${check.expectation}\n`)
    process.stdout.write(`        实际: ${redact(check.observed)}\n`)
  }
}

interface CliRun {
  status: number
  stdout: string
  stderr: string
}

/**
 * 运行 CLI。
 *
 * @param args 子命令与参数。
 * @param overrides 额外的环境变量（优先级最高，覆盖真实配置）。
 * @param form `source` 走 tsx 执行 TS 源码；`packaged` 走 esbuild 出的单文件 bundle。
 */
function runCli(
  args: string[],
  overrides: Record<string, string> = {},
  form: 'source' | 'packaged' = 'source',
): CliRun {
  const entry =
    form === 'source' ? [TSX, join('bin', 'splunk-cli.ts')] : [BUNDLE]
  const result = spawnSync(process.execPath, [...entry, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...overrides },
    timeout: 120_000,
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** 解析 JSON 输出；失败时返回 null 并保留原始文本供报告使用。 */
function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 异步运行 CLI。
 *
 * 与 `runCli` 的唯一区别是**不阻塞事件循环**。这一点在本脚本里是硬需求：
 * 第 1 项检查要在同一个进程里跑一个转发代理，而 `spawnSync` 会把父进程的事件循环
 * 卡住，代理因此无法转发任何请求，CLI 只能一路重试到超时——曾经因此误判成
 * "退出码 143、代理一个请求都没收到"，看起来像产品缺陷，其实是量具自己坏了。
 */
function runCliAsync(
  args: string[],
  overrides: Record<string, string> = {},
  form: 'source' | 'packaged' = 'source',
): Promise<CliRun> {
  const entry = form === 'source' ? [TSX, join('bin', 'splunk-cli.ts')] : [BUNDLE]
  return new Promise((done) => {
    const child = spawn(process.execPath, [...entry, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ status: code ?? -1, stdout, stderr })
    })
  })
}

/** 取出错误信封里的 `error.type` / `error.message`。 */
function errorOf(payload: Record<string, unknown> | null): { type: string; message: string } {
  const error = payload?.['error']
  if (typeof error !== 'object' || error === null) return { type: '', message: '' }
  const typed = error as Record<string, unknown>
  return { type: String(typed['type'] ?? ''), message: String(typed['message'] ?? '') }
}

/** 用一个极小的 http 请求取回状态码与文本——需要完全控制 `Host` 头，所以不用 fetch。 */
function httpGet(
  port: number,
  path: string,
  options: { method?: string; body?: string; host?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          ...(options.host === undefined ? {} : { Host: options.host }),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    request.on('error', fail)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

// --------------------------------------------------------------------------- //
// 记录请求的转发代理 —— 用来证明"认证走的是真实业务端点"
// --------------------------------------------------------------------------- //

interface RecordingProxy {
  url: string
  paths: string[]
  errors: string[]
  close: () => Promise<void>
}

/** 转发时必须丢掉的请求头：要么属于逐跳头，要么会破坏上游请求。 */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
])

/**
 * 启动一个把请求转发到真实 Splunk 的本地代理，并记录每个请求的路径。
 *
 * 为什么需要它：CLI 的 `--verbose` 不打印请求行（这是好事——日志里本来就不该有请求头）。
 * 而清单第 1 条要证明"认证用 `/services/server/info`，**不是** `/services/auth/login`"。
 * 与其相信代码，不如把请求记下来看。
 *
 * 两个实现细节都是踩出来的：
 *   - 转发前必须去掉 `host`（否则上游看到的是 `127.0.0.1:port`）与 `accept-encoding`
 *     （不让上游压缩，省得还要回填 `content-encoding`）；
 *   - 响应必须把 `content-encoding` 一并透传，否则调用方会拿到压缩字节却当成 JSON 解析。
 */
async function startRecordingProxy(upstream: string): Promise<RecordingProxy> {
  const agent = new Agent({ connect: { rejectUnauthorized: false } })
  const paths: string[] = []
  const errors: string[] = []

  const server = createServer((incoming, outgoing) => {
    paths.push(`${incoming.method ?? 'GET'} ${incoming.url ?? '/'}`)
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      void (async () => {
        try {
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (typeof value !== 'string' || HOP_BY_HOP.has(name.toLowerCase())) continue
            headers[name] = value
          }
          const response = await undiciRequest(new URL(incoming.url ?? '/', upstream), {
            method: (incoming.method ?? 'GET') as 'GET',
            headers,
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
            dispatcher: agent,
          })
          const body = Buffer.from(await response.body.arrayBuffer())
          const responseHeaders: Record<string, string> = {
            'content-type': String(response.headers['content-type'] ?? 'application/json'),
          }
          if (response.headers['content-encoding'] !== undefined) {
            responseHeaders['content-encoding'] = String(response.headers['content-encoding'])
          }
          outgoing.writeHead(response.statusCode, responseHeaders)
          outgoing.end(body)
        } catch (error) {
          const message = `proxy error: ${(error as Error).message}`
          errors.push(message)
          outgoing.writeHead(502, { 'content-type': 'text/plain' })
          outgoing.end(message)
        }
      })()
    })
  })

  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    errors,
    close: async () => {
      await agent.close()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

// --------------------------------------------------------------------------- //
// 1 / 2 / 3：连接、认证与 TLS
// --------------------------------------------------------------------------- //

async function checkAuthEndpoint(settings: Settings): Promise<void> {
  const proxy = await startRecordingProxy(settings.effective_url)
  try {
    // 关掉重试并收紧超时：这一项要证明的是"认证用了哪个端点"，不是重试策略。
    // 重试会让失败场景多花两分钟，还会把失败原因掩盖成"超时"。
    const run = await runCliAsync(['health', '--json'], {
      SPLUNK_URL: proxy.url,
      SPLUNK_VERIFY_SSL: 'false',
      SPLUNK_MAX_RETRIES: '0',
      SPLUNK_TIMEOUT: '10',
      SPLUNK_SEARCH_TIMEOUT: '10',
    })
    const payload = parseJson(run.stdout)
    const usedServerInfo = proxy.paths.some((path) => path.includes('/services/server/info'))
    const usedLogin = proxy.paths.some((path) => path.includes('/services/auth/login'))
    const ok = run.status === 0 && payload?.['success'] === true && usedServerInfo && !usedLogin
    const error = errorOf(payload)
    record({
      id: '1-auth-endpoint',
      title: '认证走真实业务端点 /services/server/info',
      expectation:
        '退出码 0、success=true，捕获到的请求里出现 /services/server/info 且**不出现** /services/auth/login',
      status: ok ? 'PASS' : 'FAIL',
      observed:
        `退出码 ${run.status}；捕获到的请求: ${JSON.stringify(proxy.paths)}` +
        (error.type === '' ? '' : `；error=${error.type}: ${error.message.slice(0, 160)}`),
      detail:
        proxy.errors.length > 0
          ? `代理侧错误: ${proxy.errors.join(' | ')}`
          : run.stderr.trim() === ''
            ? undefined
            : `stderr: ${run.stderr.slice(0, 300)}`,
    })
  } finally {
    await proxy.close()
  }
}

function checkSelfSignedTls(): void {
  const run = runCli(['health', '--json'], { SPLUNK_VERIFY_SSL: 'false' })
  const payload = parseJson(run.stdout)
  const ok = run.status === 0 && payload?.['success'] === true && payload['connection'] === 'ok'
  record({
    id: '2-self-signed-tls',
    title: '自签证书 + SPLUNK_VERIFY_SSL=false',
    expectation: '退出码 0、connection=ok',
    status: ok ? 'PASS' : 'FAIL',
    observed: `退出码 ${run.status}；connection=${String(payload?.['connection'])}`,
  })
}

/**
 * 第 3 项：`SPLUNK_CA_BUNDLE` 对 Splunk 默认证书是否可用。
 *
 * 做法是先把服务端证书抓下来当 CA 用——这是最宽松的正确用法。若仍然失败，说明问题
 * 不在信任链而在证书本身（ADR §5.13 记录的 `SplunkServerDefaultCert` 缺少 SAN，
 * 主机名校验必然失败）。**以实测为准，不预设结论**：抓到证书且能连上就是 PASS，
 * 抓不到就是 SKIP，抓到了仍失败则记为 INFO 并原样记录错误消息。
 */
function checkCaBundle(settings: Settings): void {
  const pemPath = join(workDir, 'server-cert.pem')
  let host = settings.host
  let port = String(settings.port)
  try {
    const parsed = new URL(settings.effective_url)
    host = parsed.hostname
    port = parsed.port === '' ? (parsed.protocol === 'https:' ? '8089' : '80') : parsed.port
  } catch {
    // 用 settings 里的 host/port
  }

  let captured = false
  try {
    const output = execFileSync(
      'openssl',
      ['s_client', '-connect', `${host}:${port}`, '-showcerts', '-servername', host],
      { encoding: 'utf8', input: '', timeout: 20_000 },
    )
    const blocks = output.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
    if (blocks !== null && blocks.length > 0) {
      writeFileSync(pemPath, `${blocks.join('\n')}\n`, 'utf8')
      captured = true
    }
  } catch {
    captured = false
  }

  if (!captured) {
    record({
      id: '3-ca-bundle',
      title: '自签证书 + SPLUNK_CA_BUNDLE',
      expectation: '用服务端证书作为 CA 时应能连接',
      status: 'SKIP',
      observed: '未能通过 openssl 抓到服务端证书（缺少 openssl 或握手失败）',
    })
    return
  }

  const run = runCli(['health', '--json'], {
    SPLUNK_VERIFY_SSL: 'true',
    SPLUNK_CA_BUNDLE: pemPath,
  })
  const payload = parseJson(run.stdout)
  const { message } = errorOf(payload)
  const ok = run.status === 0 && payload?.['success'] === true
  record({
    id: '3-ca-bundle',
    title: '自签证书 + SPLUNK_CA_BUNDLE',
    expectation: '用服务端证书作为 CA 时应能连接',
    status: ok ? 'PASS' : 'INFO',
    observed: ok
      ? '退出码 0、success=true（CA bundle 生效）'
      : `退出码 ${run.status}；message=${message.slice(0, 200)}`,
    detail: ok
      ? undefined
      : '这一项属于 ADR §5.13 记录的限制：SplunkServerDefaultCert 没有 SAN，'
        + '把服务端证书当 CA 信任仍会因主机名校验失败。结论以本次实测为准，未做任何猜测。',
  })
}

// --------------------------------------------------------------------------- //
// 前缀：探测一个真的有数据的索引
// --------------------------------------------------------------------------- //

/**
 * 问实例"哪些索引有数据"，挑事件最多的那个作为后续检查的负载。
 *
 * `| eventcount` 与 `| tstats` 在本次实机上因权限失败（`SplunkJobError`），
 * `search index=* | stats count by index` 可用，因此用它。探测失败时退回 `_internal`
 * 并把这件事记进报告——绝不假装探测成功。
 */
function detectWorkloadIndex(): boolean {
  // 从窄窗口开始试：7 天全量扫描很贵，实例一旦繁忙就会先在这一步超时，
  // 而那跟被测实现毫无关系。1h 足够发现活跃索引，而且便宜得多。
  const windows = ['-1h', '-24h', '-7d']
  let lastRun: CliRun | null = null
  let chosen: { index: string; count: number } | null = null
  let usedWindow = ''
  let inventory: string[] = []

  for (const window of windows) {
    const run = runCli([
      'search',
      'search index=* | stats count by index',
      `--earliest=${window}`,
      '--limit',
      '50',
      '--json',
    ])
    lastRun = run
    const payload = parseJson(run.stdout)
    const rows = Array.isArray(payload?.['results'])
      ? (payload['results'] as Array<Record<string, unknown>>)
      : []

    let best: { index: string; count: number } | null = null
    for (const row of rows) {
      const name = typeof row['index'] === 'string' ? (row['index'] as string) : ''
      const count = Number(row['count'] ?? 0)
      if (name !== '' && Number.isFinite(count) && count > 0 && (best === null || count > best.count)) {
        best = { index: name, count }
      }
    }
    if (best !== null) {
      chosen = best
      usedWindow = window
      inventory = rows.map((row) => `${String(row['index'])}=${String(row['count'])}`)
      break
    }
  }

  if (chosen === null) {
    const failed = lastRun === null ? null : parseJson(lastRun.stdout)
    const { type, message } = errorOf(failed)
    record({
      id: '0-workload-index',
      title: '探测有数据的索引',
      expectation: '在 1h / 24h / 7d 三个窗口内至少找到一个有事件的索引',
      status: 'FAIL',
      observed:
        `三个窗口都没探测到有数据的索引；最后一次退出码 ${lastRun === null ? -1 : lastRun.status}` +
        (type === '' ? '' : `（${type}: ${message.slice(0, 140)}）`),
      detail:
        '后续依赖负载索引的检查**没有执行**：没有真实数据时，它们只会用空结果集"通过"' +
        '或产出一串误导性的 FAIL。实例繁忙（job 长时间 QUEUED）时也会走到这里——' +
        '先确认实例可用，再重跑本脚本。',
    })
    return false
  }

  workloadIndex = `index=${chosen.index}`
  record({
    id: '0-workload-index',
    title: '探测有数据的索引',
    expectation: '至少找到一个有事件的索引，后续检查全部以它为负载',
    status: 'PASS',
    observed: `选用 ${workloadIndex}（窗口 ${usedWindow}，${chosen.count} 条事件）`,
    detail: `该窗口内的索引清单: ${inventory.join(', ')}`,
  })
  return true
}

// --------------------------------------------------------------------------- //
// 4：六条命令对真实数据返回
// --------------------------------------------------------------------------- //

interface CommandCase {
  id: string
  args: string[]
  verify: (payload: Record<string, unknown>, run: CliRun) => { ok: boolean; note: string }
}

/** 六条命令的检查用例。用函数是因为负载索引要等探测完才知道。 */
function commandCases(): CommandCase[] {
  const idx = workloadIndex
  return [
    {
      id: 'search',
      args: ['search', `search ${idx} | head 5`, '--earliest=-1h', '--json'],
      verify: (payload, run) => {
        const rows = Array.isArray(payload['results']) ? (payload['results'] as unknown[]) : []
        const count = payload['count']
        const timeRange = payload['time_range'] as Record<string, unknown> | undefined
        return {
          ok:
            run.status === 0 &&
            payload['success'] === true &&
            typeof count === 'number' &&
            rows.length === count &&
            count > 0 &&
            count <= 5 &&
            typeof timeRange?.['earliest'] === 'string' &&
            typeof timeRange?.['latest'] === 'string',
          note: `count=${String(count)} rows=${rows.length} time_range=${JSON.stringify(timeRange)}`,
        }
      },
    },
    {
      id: 'search-limit',
      args: ['search', `search ${idx}`, '--earliest=-7d', '--limit', '2', '--json'],
      verify: (payload, run) => ({
        ok:
          run.status === 0 &&
          payload['success'] === true &&
          Number(payload['count']) <= 2 &&
          typeof payload['truncated'] === 'boolean',
        note: `count=${String(payload['count'])} truncated=${String(payload['truncated'])} total_available=${String(payload['total_available'])}`,
      }),
    },
    {
      id: 'stats',
      args: ['stats', `search ${idx}`, '--by', 'sourcetype', '--limit', '5', '--json'],
      verify: (payload, run) => {
        const rows = Array.isArray(payload['rows']) ? (payload['rows'] as Array<Record<string, unknown>>) : []
        const by = payload['by']
        return {
          ok:
            run.status === 0 &&
            payload['success'] === true &&
            Array.isArray(by) &&
            by[0] === 'sourcetype' &&
            rows.length > 0 &&
            rows.every((row) => typeof row['count'] === 'number') &&
            String(payload['spl']).endsWith('| head 5'),
          note: `by=${JSON.stringify(by)} rows=${rows.length} spl=…"${String(payload['spl']).slice(-24)}"`,
        }
      },
    },
    {
      id: 'timeline',
      args: ['timeline', `search ${idx}`, '--span', '5m', '--earliest=-30m', '--limit', '20', '--json'],
      verify: (payload, run) => {
        const points = Array.isArray(payload['timeline'])
          ? (payload['timeline'] as Array<Record<string, unknown>>)
          : []
        const sum = points.reduce((acc, point) => acc + Number(point['count'] ?? 0), 0)
        return {
          ok: run.status === 0 && payload['span'] === '5m' && payload['total'] === sum,
          note: `span=${String(payload['span'])} buckets=${points.length} total=${String(payload['total'])} sum=${sum}`,
        }
      },
    },
    {
      id: 'fields',
      args: ['fields', `search ${idx}`, '--earliest=-30m', '--limit', '20', '--json'],
      verify: (payload, run) => {
        const fields = Array.isArray(payload['fields']) ? (payload['fields'] as unknown[]) : []
        return {
          ok:
            run.status === 0 &&
            payload['success'] === true &&
            fields.length > 0 &&
            fields.every((name) => typeof name === 'string' && name.length > 0) &&
            payload['count'] === fields.length,
          note: `count=${String(payload['count'])} fields=${fields.length}`,
        }
      },
    },
    {
      id: 'alerts',
      args: ['alerts', '--json'],
      verify: (payload, run) => ({
        // 公开契约里的键是 `alerts`（不是内部的 `fired`）——以实际输出为准。
        ok: run.status === 0 && payload['success'] === true && Array.isArray(payload['alerts']),
        note: `alerts=${Array.isArray(payload['alerts']) ? (payload['alerts'] as unknown[]).length : 'n/a'} source=${String(payload['source'] ?? '')} note=${String(payload['note'] ?? '')}`,
      }),
    },
  ]
}

function checkSixCommands(): void {
  for (const item of commandCases()) {
    const run = runCli(item.args)
    const payload = parseJson(run.stdout)
    if (payload === null) {
      record({
        id: `4-${item.id}`,
        title: `命令可用：${item.id}`,
        expectation: '退出码 0 且 stdout 是合法 JSON 信封',
        status: 'FAIL',
        observed: `退出码 ${run.status}；stdout 不是 JSON: ${run.stdout.slice(0, 160)}`,
      })
      continue
    }
    const { ok, note } = item.verify(payload, run)
    record({
      id: `4-${item.id}`,
      title: `命令可用：${item.id}`,
      expectation: '退出码 0、结构正确、count / truncated / time_range 正确',
      status: ok ? 'PASS' : 'FAIL',
      observed: `退出码 ${run.status}；${note}`,
    })
  }
}

/**
 * 独立的 `truncated` 语义检查 —— 记录 ADR §5.14 的落差，而不是假装它是对的。
 *
 * 断言的是**当前已被两个实现共同钉住的行为**（`truncated` 是布尔值、`count <= limit`），
 * 同时把"实际有多少条"查出来对照。原始事件搜索上 `truncated=false` 却实际有上千万条时，
 * 这一项仍判 PASS（行为如实复刻），但 `detail` 里把落差写清楚——让它保持可见。
 */
function checkTruncationSemantics(): void {
  const limited = runCli(['search', `search ${workloadIndex}`, '--earliest=-7d', '--limit', '2', '--json'])
  const limitedPayload = parseJson(limited.stdout)
  const total = runCli(['search', `search ${workloadIndex} | stats count`, '--earliest=-7d', '--json'])
  const totalPayload = parseJson(total.stdout)
  const totalRows = Array.isArray(totalPayload?.['results'])
    ? (totalPayload['results'] as Array<Record<string, unknown>>)
    : []
  const actual = Number(totalRows[0]?.['count'] ?? 0)

  const truncated = limitedPayload?.['truncated']
  const count = Number(limitedPayload?.['count'] ?? 0)
  const gap = truncated === false && actual > count

  record({
    id: '4b-truncated-semantics',
    title: 'truncated 语义（对照 ADR §5.14）',
    expectation:
      'count <= limit 且 truncated 是布尔值；同时把"实际条数"查出来对照，落差必须写进报告',
    status:
      limited.status === 0 && typeof truncated === 'boolean' && count <= 2 ? 'PASS' : 'FAIL',
    observed: `count=${count} truncated=${String(truncated)}；同窗口实际 ${actual} 条`,
    detail: gap
      ? `落差已确认：truncated=false 但实际有 ${actual} 条。这是 ADR §5.14 / R18 / Q14 记录的既有缺陷` +
        '（job 的 max_count=limit 让"多要一行"的探测永远取不到），两个实现行为一致，本轮未修。' +
        '调用方**不应**把原始事件搜索的 truncated=false 读成"已拿到完整结果集"。'
      : `truncated=${String(truncated)} 与实际条数 ${actual} 一致。`,
  })
}

// --------------------------------------------------------------------------- //
// 5 / 6 / 7：超时与安全上限
// --------------------------------------------------------------------------- //

function checkSearchTimeout(): void {
  // 两个关键点：
  //   1. `effective_search_timeout = max(SEARCH_TIMEOUT, TIMEOUT)`（settings.ts），
  //      所以只调小 SEARCH_TIMEOUT 是没用的——必须同时把 SPLUNK_TIMEOUT 调小；
  //   2. 查询必须落在**真的有数据**的索引上。空索引的 job 会在几毫秒内完成，
  //      永远不会超时（这正是第一次跑这一项失败的原因）。
  const run = runCli(
    [
      'search',
      `search ${workloadIndex} | stats count by host, sourcetype, source`,
      '--earliest=-7d',
      '--limit',
      '1',
      '--json',
    ],
    { SPLUNK_TIMEOUT: '2', SPLUNK_SEARCH_TIMEOUT: '0.05', SPLUNK_POLL_INTERVAL: '0.01' },
  )
  const payload = parseJson(run.stdout)
  const { type } = errorOf(payload)
  record({
    id: '5-search-timeout',
    title: '搜索超预算 → 退出码 7',
    expectation: '退出码 7、error.type=SplunkTimeoutError',
    status: run.status === 7 && type === 'SplunkTimeoutError' ? 'PASS' : 'FAIL',
    observed: `退出码 ${run.status}；error.type=${type}`,
  })
}

function checkSafetyLimits(): void {
  const wide = runCli(['search', 'index=*', '--earliest=-30d', '--json'])
  const wideError = errorOf(parseJson(wide.stdout))
  record({
    id: '6-max-time-range',
    title: '超时间跨度 → 退出码 6',
    expectation: '退出码 6，消息含 "exceeds the maximum allowed range"',
    status:
      wide.status === 6 && wideError.message.includes('exceeds the maximum allowed range')
        ? 'PASS'
        : 'FAIL',
    observed: `退出码 ${wide.status}；message=${wideError.message.slice(0, 160)}`,
  })

  const rest = runCli(['search', 'index=_internal | rest /services/server/info', '--json'])
  const restError = errorOf(parseJson(rest.stdout))
  record({
    id: '7-spl-blacklist',
    title: '写/管理类命令 → 退出码 6',
    expectation: '退出码 6，消息含 "SPL command \'rest\' is not permitted"',
    status:
      rest.status === 6 && restError.message.includes("SPL command 'rest' is not permitted")
        ? 'PASS'
        : 'FAIL',
    observed: `退出码 ${rest.status}；message=${restError.message.slice(0, 160)}`,
  })
}

function checkAlertsVersionNotes(): void {
  // 清单第 8 项的**目标**版本是 Splunk 9.2（端点已被移除）。本次实机是 8.0.2，
  // 端点存在，所以只能记录真实行为，并明确写出"9.2 的降级分支本次无法实测"。
  const run = runCli(['alerts', '--json'])
  const payload = parseJson(run.stdout)
  const alerts = payload?.['alerts']
  record({
    id: '8-alerts-version',
    title: '告警端点的版本差异行为',
    expectation:
      '退出码 0；端点存在则返回列表，被移除则空列表 + note——两种都必须退出 0（绝不因版本差异而失败）',
    status: run.status === 0 && payload?.['success'] === true ? 'PASS' : 'FAIL',
    observed: `退出码 ${run.status}；alerts=${Array.isArray(alerts) ? alerts.length : 'n/a'} source=${String(payload?.['source'] ?? '')} note=${String(payload?.['note'] ?? '')}`,
    detail:
      '本次实例为 Splunk 8.0.2，/services/alerts/fired_alerts 仍然存在。"端点被移除 → 空列表 + note + 退出码 0"'
      + ' 的分支本次无法实测，该分支由 test/fixtures/splunk/alerts-endpoint-removed.json 驱动的用例覆盖。',
  })
}

// --------------------------------------------------------------------------- //
// 9 / 10：面板
// --------------------------------------------------------------------------- //

/**
 * 面板子进程的环境。
 *
 * 这里**显式**把凭据从已加载的 settings 传进子进程，并把 `SPLUNK_CONFIG_DIR` 指向临时
 * 目录：面板因此读到完全相同的连接参数，但绝不读写用户真实的 `~/.splunk-cli`。
 * （第一次跑这一项失败，就是因为只改了 `SPLUNK_CONFIG_DIR` 却没补凭据，
 * 面板起在了一个"没有凭据"的环境里，`/api/health` 理所当然地返回 success=false。）
 */
function dashboardEnv(settings: Settings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SPLUNK_CONFIG_DIR: join(workDir, 'dash-config'),
    SPLUNK_URL: settings.effective_url,
    SPLUNK_USERNAME: settings.username,
    SPLUNK_PASSWORD: settings.password,
    SPLUNK_VERIFY_SSL: String(settings.verify_ssl),
    SPLUNK_TIMEOUT: String(settings.timeout),
    SPLUNK_SEARCH_TIMEOUT: String(settings.search_timeout),
    SPLUNK_POLL_INTERVAL: String(settings.poll_interval),
    SPLUNK_MAX_RETRIES: String(settings.max_retries),
    SPLUNK_TRUST_ENV: String(settings.trust_env),
  }
  if (settings.ca_bundle !== null && settings.ca_bundle !== '') {
    env['SPLUNK_CA_BUNDLE'] = settings.ca_bundle
  }
  return env
}

async function waitForDashboard(port: number, attempts = 40): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await httpGet(port, '/api/health')
      if (response.status !== 0) return true
    } catch {
      // 还没起来
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  return false
}

async function checkDashboard(settings: Settings): Promise<void> {
  const child = spawn(
    process.execPath,
    [TSX, join('bin', 'splunk-cli.ts'), 'dashboard', '--port', String(DASHBOARD_PORT)],
    {
      cwd: ROOT,
      env: dashboardEnv(settings),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  const ready = await waitForDashboard(DASHBOARD_PORT)
  if (!ready) {
    child.kill('SIGKILL')
    record({
      id: '9-dashboard',
      title: '面板六个 API + 首页',
      expectation: '面板可启动，六个 API 与首页均正常',
      status: 'FAIL',
      observed: `面板未在 10s 内就绪（端口 ${DASHBOARD_PORT}）`,
    })
    return
  }

  const idx = workloadIndex
  const probes: Array<{ id: string; method: string; path: string; body?: string }> = [
    { id: 'health', method: 'GET', path: '/api/health' },
    {
      id: 'search',
      method: 'POST',
      path: '/api/search',
      body: JSON.stringify({ query: `search ${idx} | head 5`, limit: 5 }),
    },
    {
      id: 'stats',
      method: 'POST',
      path: '/api/stats',
      body: JSON.stringify({ query: `search ${idx}`, by: 'sourcetype', limit: 5 }),
    },
    {
      id: 'timeline',
      method: 'POST',
      path: '/api/timeline',
      body: JSON.stringify({ query: `search ${idx}`, span: '5m', earliest: '-30m' }),
    },
    { id: 'alerts', method: 'GET', path: '/api/alerts' },
    {
      id: 'overview',
      method: 'POST',
      path: '/api/overview',
      body: JSON.stringify({ query: `search ${idx}`, earliest: '-30m', span: '5m' }),
    },
  ]

  const observed: string[] = []
  const failures: string[] = []
  let allOk = true
  for (const probe of probes) {
    try {
      const response = await httpGet(DASHBOARD_PORT, probe.path, {
        method: probe.method,
        body: probe.body,
      })
      const payload = parseJson(response.body)
      const ok = response.status === 200 && payload !== null && payload['success'] !== false
      if (!ok) {
        allOk = false
        // 把错误类型带上：实例过载（job 卡在 QUEUED → SplunkTimeoutError）与真正的
        // 实现缺陷必须能一眼区分，否则报告会误导人。
        failures.push(`${probe.id}: HTTP ${response.status} ${errorOf(payload).type || response.body.slice(0, 60)}`)
      }
      observed.push(`${probe.id}=${response.status}${ok ? '' : '(!)'}`)
    } catch (error) {
      allOk = false
      observed.push(`${probe.id}=error(${(error as Error).message.slice(0, 40)})`)
    }
  }

  const index = await httpGet(DASHBOARD_PORT, '/')
  const indexOk = index.status === 200 && index.body.includes('id="root"')
  if (!indexOk) allOk = false

  const hostile = await httpGet(DASHBOARD_PORT, '/api/health', { host: 'evil.com' })
  const guardOk = hostile.status === 403 && hostile.body.includes('ForbiddenOrigin')

  child.kill('SIGTERM')
  await new Promise((done) => setTimeout(done, 400))
  if (child.exitCode === null) child.kill('SIGKILL')

  record({
    id: '9-dashboard',
    title: '面板六个 API + 首页',
    expectation: '六个 API 全部 200 且 success != false；/ 返回真实 index.html',
    status: allOk && indexOk ? 'PASS' : 'FAIL',
    observed: `${observed.join(' ')} index=${index.status}(root=${index.body.includes('id="root"')})`,
    detail: failures.length === 0 ? undefined : `失败明细: ${failures.join(' | ')}`,
  })
  record({
    id: '10-host-guard',
    title: 'Host: evil.com → 403',
    expectation: 'HTTP 403 且响应体含 ForbiddenOrigin',
    status: guardOk ? 'PASS' : 'FAIL',
    observed: `HTTP ${hostile.status}；body=${hostile.body.slice(0, 120)}`,
  })
}

// --------------------------------------------------------------------------- //
// 11：日志不含凭据
// --------------------------------------------------------------------------- //

/**
 * 跑一遍覆盖全部命令的流程并开启 `--verbose`，然后在**合并的 stdout+stderr** 里搜索
 * 真实密码与几类头/会话标记。这是 `AGENTS.md` §2.13/§2.14 的直接可执行形式。
 */
function checkNoSecretLeak(): void {
  const flows: string[][] = [
    ['health', '--verbose'],
    ['search', `search ${workloadIndex} | head 5`, '--verbose'],
    ['stats', `search ${workloadIndex}`, '--by', 'sourcetype', '--verbose'],
    ['timeline', `search ${workloadIndex}`, '--span', '5m', '--verbose'],
    ['fields', `search ${workloadIndex}`, '--verbose'],
    ['alerts', '--verbose'],
    ['config', '--verbose'],
    ['limits', '--verbose'],
    ['init', '--verbose'],
    ['search', 'index=*', '--earliest=-30d', '--verbose'],
    ['search', 'index=_internal | rest /x', '--verbose'],
  ]

  const patterns: Array<{ label: string; test: (text: string) => boolean }> = [
    { label: '真实密码', test: (text) => secret !== '' && text.includes(secret) },
    { label: 'Authorization 头', test: (text) => /authorization\s*[:=]/i.test(text) },
    { label: 'Cookie / Set-Cookie', test: (text) => /set-cookie|cookie\s*[:=]/i.test(text) },
    { label: 'Session Key', test: (text) => /session[_-]?key\s*[:=]|splunkd_\d{4}/i.test(text) },
    { label: 'Basic 认证串', test: (text) => /basic\s+[A-Za-z0-9+/=]{12,}/i.test(text) },
  ]

  const leaks: string[] = []
  let totalBytes = 0
  for (const flow of flows) {
    const run = runCli(flow)
    const combined = `${run.stdout}\n${run.stderr}`
    totalBytes += combined.length
    for (const pattern of patterns) {
      if (pattern.test(combined)) leaks.push(`${flow[0]} → ${pattern.label}`)
    }
  }

  record({
    id: '11-no-secret-leak',
    title: '--verbose 全流程日志不含凭据',
    expectation: `${flows.length} 条命令的合并输出里不出现密码 / Authorization / Cookie / Session Key / Basic 串`,
    status: leaks.length === 0 ? 'PASS' : 'FAIL',
    observed:
      leaks.length === 0
        ? `检视 ${flows.length} 条命令、共 ${totalBytes} 字节输出，未命中任何凭据模式`
        : `命中: ${leaks.join(', ')}`,
  })
}

// --------------------------------------------------------------------------- //
// 12：源码形态与打包形态一致
// --------------------------------------------------------------------------- //

/** 确定性命令：输出与时间无关，可以逐字节比较。 */
const DETERMINISTIC_COMMANDS: string[][] = [
  ['limits', '--json'],
  ['config', '--json'],
  ['--help'],
  ['search', 'index=*', '--earliest=-30d', '--json'],
  ['search', 'index=_internal | rest /x', '--json'],
  ['search', '', '--json'],
  ['stats', 'index=_internal', '--by', 'a;b', '--json'],
]

/** 数据命令：结果集本身随时间变化，比较退出码 + 结构签名。 */
function shapeCommands(): string[][] {
  const idx = workloadIndex
  return [
    ['health', '--json'],
    ['search', `search ${idx} | head 3`, '--json'],
    ['stats', `search ${idx}`, '--by', 'sourcetype', '--limit', '3', '--json'],
    ['timeline', `search ${idx}`, '--span', '5m', '--json'],
    ['fields', `search ${idx}`, '--json'],
    ['alerts', '--json'],
  ]
}

/**
 * 计算 JSON 的**结构签名**：键集合与类型，不含具体取值。
 *
 * 这样既能发现"bundle 少了功能导致字段缺失/类型变了"，又不会因为两次查询落在不同的
 * 时间窗里而误报。
 */
function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 4) return '…'
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0], depth + 1)]
  if (value === null) return 'null'
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = shapeOf((value as Record<string, unknown>)[key], depth + 1)
    }
    return out
  }
  return typeof value
}

function checkSourceVsPackaged(): void {
  if (!existsSync(BUNDLE)) {
    record({
      id: '12-source-vs-packaged',
      title: '源码形态与打包形态一致',
      expectation: '同一命令的输出一致',
      status: 'SKIP',
      observed: `未找到 ${BUNDLE}，请先执行 npm run build`,
    })
    return
  }

  const mismatches: string[] = []

  for (const command of DETERMINISTIC_COMMANDS) {
    const source = runCli(command, {}, 'source')
    const packaged = runCli(command, {}, 'packaged')
    const same =
      source.status === packaged.status && redact(source.stdout) === redact(packaged.stdout)
    if (!same) {
      mismatches.push(
        `${command.slice(0, 2).join(' ')}: 退出码 ${source.status}/${packaged.status}，stdout ${source.stdout.length}/${packaged.stdout.length} 字节`,
      )
    }
  }

  const shapeCommandsList = shapeCommands()

  for (const command of shapeCommandsList) {
    const source = runCli(command, {}, 'source')
    const packaged = runCli(command, {}, 'packaged')
    const a = parseJson(source.stdout)
    const b = parseJson(packaged.stdout)
    if (source.status !== packaged.status || a === null || b === null) {
      mismatches.push(`${command[0]}: 退出码 ${source.status}/${packaged.status}`)
      continue
    }
    const shapeA = JSON.stringify(shapeOf(a))
    const shapeB = JSON.stringify(shapeOf(b))
    if (shapeA !== shapeB) mismatches.push(`${command[0]}: 结构签名不同`)
  }

  const total = DETERMINISTIC_COMMANDS.length + shapeCommandsList.length
  record({
    id: '12-source-vs-packaged',
    title: '源码形态与打包形态一致',
    expectation: `${DETERMINISTIC_COMMANDS.length} 条确定性命令逐字节一致 + ${shapeCommandsList.length} 条数据命令退出码与结构签名一致`,
    status: mismatches.length === 0 ? 'PASS' : 'FAIL',
    observed: mismatches.length === 0 ? `${total} 条命令全部一致` : mismatches.join('；'),
  })
}

// --------------------------------------------------------------------------- //
// 入口
// --------------------------------------------------------------------------- //

function parseArgs(): { jsonOut: string | null } {
  const index = process.argv.indexOf('--json-out')
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return { jsonOut: value === undefined ? null : value }
}

async function main(): Promise<number> {
  const { jsonOut } = parseArgs()

  let settings: Settings
  try {
    settings = loadSettings()
  } catch (error) {
    process.stderr.write(`[live] 配置无效，无法实机验收: ${(error as Error).message}\n`)
    return 2
  }
  if (!settings.is_configured) {
    process.stderr.write('[live] Splunk 未配置完整（需要 SPLUNK_HOST/SPLUNK_URL + 用户名 + 密码）\n')
    return 2
  }
  secret = settings.password

  process.stdout.write(`[live] 目标实例: ${settings.effective_url}（用户 ${settings.username}）\n\n`)

  try {
    // 没有负载索引时继续跑只会产出误导性的结果——直接收尾并如实退出。
    if (!detectWorkloadIndex()) return 1
    await checkAuthEndpoint(settings)
    checkSelfSignedTls()
    checkCaBundle(settings)
    checkSixCommands()
    checkTruncationSemantics()
    checkSearchTimeout()
    checkSafetyLimits()
    checkAlertsVersionNotes()
    await checkDashboard(settings)
    checkNoSecretLeak()
    checkSourceVsPackaged()
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }

  const count = (status: Status): number => checks.filter((check) => check.status === status).length
  const pass = count('PASS')
  const fail = count('FAIL')
  const info = count('INFO')
  const skip = count('SKIP')
  process.stdout.write(
    `\n[live] 结果: ${pass} PASS / ${fail} FAIL / ${info} INFO / ${skip} SKIP（共 ${checks.length} 项）\n`,
  )
  process.stdout.write(`[live] 负载索引: ${workloadIndex}\n`)

  if (jsonOut !== null) {
    const report = {
      generated_at: new Date().toISOString(),
      target: settings.effective_url,
      workload_index: workloadIndex,
      summary: { pass, fail, info, skip, total: checks.length },
      checks,
    }
    const path = resolve(jsonOut)
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`[live] 报告写入 ${path}\n`)
  }

  return fail === 0 ? 0 : 1
}

process.exit(await main())
