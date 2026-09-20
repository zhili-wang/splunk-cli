/**
 * CLI 入口 —— 解析参数、渲染输出、决定退出码。
 *
 * 两条硬要求：
 *   1. **用 `process.exitCode`，不调用 `process.exit()`**——stdout 对管道是异步的，
 *      立即退出会截断 JSON；
 *   2. **stdout 只放机器载荷**，诊断与提示一律走 stderr。
 *
 * commander 直接产出**类型化的 options 对象**，不引入 `buildLegacyArgs` / `parseArgs(argv)`
 * 那套 argv 数组解析。
 */

import { Command, CommanderError } from 'commander'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { SplunkClient } from '../server/client/splunk'
import { loadSettings, type Settings } from '../server/config/settings'
import { ensureConfigDir, writableConfigFile } from '../server/config/paths'
import {
  ConfigurationError,
  SplunkError,
  errorPayload,
  exitCodeFor,
  sanitizeMessage,
} from '../server/errors'
import { setLogLevel } from '../server/logger'
import { emitDiagnostic, emitJson, emitText } from '../server/output/envelope'
import { discoverServers } from '../server/web/discovery'
import { registerServer, unregisterServer } from '../server/web/registry'
import { stopServers, type StopReason } from '../server/web/stopper'
import {
  formatNumber,
  keyValueTable,
  floatString,
  renderResultSet,
  renderTable,
  sparkline,
  statKey,
} from '../server/output/table'
import { SafetyLimitError, limitsReport } from '../server/safety/limits'
import { AlertsService } from '../server/services/alerts'
import {
  DEFAULT_EARLIEST,
  DEFAULT_LATEST,
  expandTimeRange,
  timeRangeNames,
} from '../server/services/base'
import { FieldsService } from '../server/services/fields'
import { HealthService } from '../server/services/health'
import { SearchService } from '../server/services/search'
import { StatsService } from '../server/services/stats'
import { TimelineService } from '../server/services/timeline'
import { VERSION } from '../server/version'

/**
 * 携带自定义退出码的信号。
 *
 * 有些失败**已经**产出了结构化报告（如 `health` 的探针失败），此时不应再按错误类型
 * 打印一遍，只需带着报告自己算出的退出码退出。
 */
class ExitSignal extends Error {
  readonly code: number

  constructor(code: number) {
    super(`exit ${code}`)
    this.name = 'ExitSignal'
    this.code = code
  }
}

/** 每条命令都有的公共选项。 */
interface CommonOptions {
  json?: boolean
  verbose?: boolean
}

/** 应用日志级别与 JSON 开关。 */
function applyCommon(options: CommonOptions): void {
  setLogLevel(options.verbose === true ? 'debug' : null)
}

/** 构造配置（所有命令共用）。 */
function settingsFor(): Settings {
  return loadSettings()
}

/** 已知错误类型的可执行提示。 */
function hintsFor(errorType: string): string {
  const hints: Record<string, string> = {
    ConfigurationError:
      'hint: check the SPLUNK_* settings and ' +
      `${writableConfigFile()} — missing credentials, an unreadable path ` +
      '(e.g. SPLUNK_CA_BUNDLE) and invalid values all land here; ' +
      '`splunk-cli config` shows the effective settings.',
    SplunkAuthenticationError:
      'hint: verify SPLUNK_USERNAME/SPLUNK_PASSWORD; authentication is checked ' +
      'against /services/server/info.',
    SplunkConnectionError:
      'hint: verify SPLUNK_URL (default REST port 8089) and network reachability; ' +
      'for a self-signed certificate set SPLUNK_VERIFY_SSL=false, or point ' +
      'SPLUNK_CA_BUNDLE at the CA that signed it.',
    SafetyLimitError:
      'hint: narrow the query, the time range or the limit; ' +
      '`splunk-cli limits` shows the active ceilings.',
    SplunkTimeoutError:
      'hint: narrow the time range, add a terminating command such as `| head 100`, ' +
      'or raise SPLUNK_TIMEOUT.',
  }
  return hints[errorType] ?? ''
}

/** 把失败写到 stdout（JSON）或 stderr（人类可读）。 */
function reportError(error: unknown, jsonOutput: boolean): void {
  if (jsonOutput) {
    emitJson(errorPayload(error))
    return
  }
  if (error instanceof SplunkError) {
    emitDiagnostic(`error: ${error.errorType}: ${error.message}`)
    const hint = hintsFor(error.errorType)
    if (hint !== '') emitDiagnostic(hint)
    return
  }
  const type = error instanceof Error ? error.constructor.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  emitDiagnostic(`error: unexpected ${type}: ${sanitizeMessage(message)}`)
  emitDiagnostic(`hint: re-run with --verbose for details (splunk-cli ${VERSION})`)
}

/** 把停止失败的原因翻成人话；失败就要说清失败在哪，而不是抛个裸码。 */
function reasonText(reason: StopReason): string {
  switch (reason) {
    case 'still-running':
      return 'still running after the stop request'
    case 'permission-denied':
      return 'permission denied sending the stop signal'
    case 'signal-failed':
      return 'failed to send the stop signal'
  }
}

/** 注册公共选项。 */
function withCommon(command: Command): Command {
  return command
    .option('-j, --json', 'Emit a stable JSON envelope instead of a table.')
    .option('-v, --verbose', 'Enable debug logging on stderr.')
}

/**
 * `-e` / `-l` / `-r`：四个查询命令共用同一套时间范围选项。
 *
 * 默认值故意留在帮助文本里而不是 `.option()` 的 default 上：`--range` 给的是**整个**
 * 窗口，只有"这个边界到底有没有被显式给出"才能判断它是否与 `--range` 冲突，而带 default
 * 的选项分不清"没给"和"给了默认值"。
 */
function withTimeRange(command: Command): Command {
  return command
    .option(
      '-e, --earliest <time>',
      'Lower bound (default: -1h): -30m, -1d@d, @mon, ISO-8601, epoch',
    )
    .option('-l, --latest <time>', 'Upper bound (default: now): now, @d, ISO-8601, epoch')
    .option(
      '-r, --range <name>',
      `A whole window at once (${timeRangeNames().join(', ')}) or a duration such as 7d`,
    )
}

/** 时间范围选项的取值。 */
interface TimeOptions {
  earliest?: string
  latest?: string
  range?: string
}

/**
 * 把 `--range` 与 `-e`/`-l` 合成一对边界。
 *
 * 两者同时出现时**拒绝**而不是挑一个赢：`--range last-week --earliest=-2h` 里的两个意图，
 * 任何一方被静默忽略都会给出一个"看起来正常"的错误窗口，而这正是排查时最难发现的那种错。
 */
function timeBounds(options: TimeOptions): { earliest: string; latest: string } {
  const hasBound = options.earliest !== undefined || options.latest !== undefined
  if (options.range !== undefined && hasBound) {
    throw new SafetyLimitError(
      '--range already names both ends of the window: use --range or --earliest/--latest, not both',
      { details: { range: options.range, earliest: options.earliest, latest: options.latest } },
    )
  }
  if (options.range !== undefined) return { ...expandTimeRange(options.range) }
  return {
    earliest: options.earliest ?? DEFAULT_EARLIEST,
    latest: options.latest ?? DEFAULT_LATEST,
  }
}

/** 构建命令树。 */
export function buildProgram(): Command {
  const program = new Command()
  // 接管 commander 的退出行为：默认它会直接 process.exit()，那样就绕过了
  // "设置 exitCode 而不是 process.exit" 的约定，也让 CLI 无法被测试驱动。
  //
  // ⚠ 必须在**创建任何子命令之前**调用：子命令只在创建时继承该设置，
  // 放在后面的话子命令（如 `stats --help`）仍会走到 process.exit。
  program.exitOverride()
  program
    .name('splunk-cli')
    .description('Read-only, agent-friendly CLI for Splunk logs')
    .version(VERSION, '-V, --version', 'show version number')
    .helpOption('-h, --help', 'show help')

  withTimeRange(
    withCommon(
      program
        .command('search')
        .description('Run a read-only SPL search')
        .argument('<query>', "SPL query, e.g. 'index=app level=ERROR'")
        .option(
          '-n, --limit <number>',
          'Maximum number of results',
          (value: string) => Number.parseInt(value, 10),
        )
        .option('--timeout <seconds>', 'Search job budget in seconds', (value: string) =>
          Number.parseFloat(value),
        ),
    ),
  ).action(
    async (
      query: string,
      options: CommonOptions &
        TimeOptions & {
          limit?: number
          timeout?: number
        },
    ) => {
      applyCommon(options)
      const { earliest, latest } = timeBounds(options)
      const settings = settingsFor()
      settings.require_credentials()
      const client = new SplunkClient(settings)
      try {
        const service = new SearchService(client, {
          searchTimeout: options.timeout ?? null,
        })
        const result = await service.search(query, {
          earliest,
          latest,
          limit: options.limit ?? null,
        })
        if (options.json === true) {
          emitJson(result.toPublicDict())
        } else {
          emitText(renderResultSet(result))
        }
      } finally {
        await client.close()
      }
    },
  )

  withCommon(
    program
      .command('config')
      .description('Show the effective configuration with secrets redacted')
      .option('--check', 'Exit non-zero when required settings are missing.'),
  ).action((options: CommonOptions & { check?: boolean }) => {
    applyCommon(options)
    // 默认会创建目录与模板（幂等，绝不覆盖）。
    const directory = ensureConfigDir()
    const settings = settingsFor()
    const payload = settings.redacted()
    payload['configured'] = settings.is_configured
    payload['config_dir'] = directory.dir
    payload['config_file'] = directory.configFile
    payload['config_file_present'] = directory.isPopulated

    if (options.json === true) {
      // 注意：`config --json` **没有** `success` 键（与其它命令不同），
      // 这是既有契约，照实保留而不是"顺手补齐"。
      emitJson(payload)
    } else {
      // 这些字段是 float → str() 语义带 `.0`（如 `timeout: 30.0`）。
      const floatFields = new Set(['timeout', 'poll_interval', 'search_timeout', 'retry_backoff'])
      emitText(
        keyValueTable(
          Object.entries(payload).map(([key, value]) => [
            key,
            floatFields.has(key) && typeof value === 'number' ? floatString(value) : value,
          ]),
        ),
      )
    }

    if (options.check === true && !settings.is_configured) {
      throw new ConfigurationError(
        'configuration is incomplete: set SPLUNK_URL, SPLUNK_USERNAME ' +
          `and SPLUNK_PASSWORD in ${directory.configFile}`,
      )
    }
  })

  withCommon(
    program
      .command('init')
      .description(
        'Create the configuration directory and template if they do not exist',
      ),
  ).action((options: CommonOptions) => {
    applyCommon(options)
    const directory = ensureConfigDir()
    const settings = settingsFor()
    const payload: Record<string, unknown> = {
      success: true,
      config_dir: directory.dir,
      config_file: directory.configFile,
      directory_created: directory.created === true,
      config_file_created: directory.configCreated === true,
      configured: settings.is_configured,
    }

    if (options.json === true) {
      emitJson(payload)
      return
    }
    emitText(keyValueTable(Object.entries(payload)))
    emitText('')
    if (settings.is_configured) {
      emitText('configuration looks complete; run `splunk-cli health` to verify')
    } else {
      emitText(`next: fill in ${directory.configFile}, then run \`splunk-cli health\``)
    }
  })

  withCommon(
    program
      .command('dashboard')
      .description('Open the local investigation dashboard on 127.0.0.1')
      .option('-p, --port <number>', 'Port to bind on 127.0.0.1', (value: string) =>
        Number.parseInt(value, 10),
      ),
  ).action(async (options: CommonOptions & { port?: number }) => {
    applyCommon(options)
    // 懒加载：只有真正要用面板时才加载 web 层与其依赖。
    let serverModule: typeof import('../server/server')
    try {
      serverModule = await import('../server/server')
    } catch (error) {
      throw new ConfigurationError(
        'the dashboard requires its web dependencies (express, compression). ' +
          `Reinstall the package and try again. (${error instanceof Error ? error.message : String(error)})`,
      )
    }

    const handle = await serverModule.startServer({
      port: options.port ?? serverModule.DEFAULT_PORT,
      // 页面上的「停止服务」会走到这里。终端必须说话：否则用户看到的是进程
      // 莫名其妙地没了，而他其实是在浏览器里点的 —— 这条线索只能由这里给出。
      // 与上面两行一样走 stdout，沿用既有的输出约定，不另立一套。
      onShutdownRequested: () => {
        emitText('stopping: requested from the dashboard page')
      },
    })
    gracefulShutdown = handle.close
    emitText(`serving the dashboard on http://127.0.0.1:${handle.port}`)
    emitText('read-only; press Ctrl-C to stop')

    // 登记进名册：stop-web 靠它定位正在跑的面板。注册失败（权限、磁盘满）不致命——
    // 进程扫描仍能兜底——所以刻意不在这里抛错。
    registerServer({ pid: process.pid, port: handle.port, startedAt: new Date().toISOString() })

    // 前台驻留，直到收到中断信号。
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        void handle.close().finally(() => resolve())
      }
      process.once('SIGTERM', stop)
      process.once('SIGHUP', stop)
      handle.server.once('close', () => resolve())
    })
    // 优雅关闭后注销：SIGTERM、页面「停止服务」、Ctrl-C 都汇聚到同一个 resolve，
    // 所以注销只写一次。注销失败同样不致命——stop-web 的探针会丢弃陈旧条目。
    unregisterServer(process.pid)
  })

  withCommon(
    program
      .command('stop-web')
      .description('Stop every dashboard started by this CLI')
      // 默认连进程表一起扫；关掉它就只认名册里登记过的服务。
      .option('--no-scan', 'Only stop servers recorded in the registry'),
  ).action(async (options: CommonOptions & { scan?: boolean }) => {
    applyCommon(options)
    // 刻意不读 Splunk 配置、不建连接：用户想停掉面板，往往正是因为 Splunk 连不上，
    // 这时候去加载凭据只会让这条命令在最需要它的时候失败。
    const servers = await discoverServers({ scan: options.scan !== false })
    const results = await stopServers(servers)

    const stopped = results.filter((r) => r.outcome === 'stopped').length
    const failed = results.length - stopped

    if (options.json === true) {
      // stopServers 按传入顺序逐个处理，结果与发现到的服务一一对应。
      emitJson({
        success: failed === 0,
        found: servers.length,
        stopped,
        failed,
        servers: results.map((result, index) => {
          const server = servers[index]
          const base = {
            pid: result.pid,
            port: result.port,
            source: server === undefined ? 'registry' : server.source,
            outcome: result.outcome,
          }
          return result.outcome === 'failed' ? { ...base, reason: result.reason } : base
        }),
      })
    } else if (results.length === 0) {
      emitText('no running dashboard')
    } else {
      for (const result of results) {
        if (result.outcome === 'stopped') {
          emitText(`stopped: pid ${result.pid} (port ${result.port})`)
        } else {
          emitText(`failed: pid ${result.pid} (port ${result.port}): ${reasonText(result.reason)}`)
        }
      }
    }

    // 与 health 同一约定：报告已经说完，带着自己的退出码离开。
    if (failed > 0) throw new ExitSignal(1)
  })

  withCommon(
    program
      .command('limits')
      .description('Show the active safety limits and search-job budget'),
  ).action((options: CommonOptions) => {
    applyCommon(options)
    const settings = settingsFor()
    // 安全上限 + 运行预算（超时、轮询节奏）合成一张"当前生效的护栏"表。
    const payload = limitsReport(settings)
    if (options.json === true) {
      emitJson({ success: true, ...payload })
    } else {
      // 这些字段是 float → 文本按 `str()` 语义带 `.0`（如 `604800.0`、`60.0`）。
      const floatFields = new Set([
        'max_time_range_seconds',
        'timeout',
        'search_timeout',
        'poll_interval',
      ])
      emitText(
        keyValueTable(
          Object.entries(payload).map(([key, value]) => [
            key,
            floatFields.has(key) && typeof value === 'number' ? floatString(value) : value,
          ]),
        ),
      )
    }
  })

  return program
}

/** 运行一个需要客户端的命令，并负责关闭连接池。 */
async function withClient<T>(fn: (client: SplunkClient) => Promise<T>): Promise<T> {
  const settings = settingsFor()
  settings.require_credentials()
  const client = new SplunkClient(settings)
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

/** 注册 `health` 与 `alerts`（Phase 2 补齐的命令）。 */
function registerPhase2Commands(program: Command): void {
  withCommon(
    program
      .command('health')
      .description('Check connectivity, authentication, version and licence state')
      .option('--no-license', 'Skip the licence pool lookup.'),
  ).action(async (options: CommonOptions & { license?: boolean }) => {
    applyCommon(options)
    const report = await withClient((client) =>
      new HealthService(client).health({ includeLicense: options.license !== false }),
    )

    if (!report.success) {
      // 探针已经产出了结构化报告（含标准错误信封），只发一次再按报告算出的退出码退出。
      if (options.json !== true && report.error !== null) {
        emitDiagnostic(`error: ${report.error}`)
      }
      emitJson(report.toPublicDict())
      throw new ExitSignal(report.failureExitCode())
    }

    if (options.json === true) {
      emitJson(report.toPublicDict())
      return
    }
    const info = report.splunk
    if (info !== null) {
      emitText(
        keyValueTable([
          ['connection', report.connection],
          ['authentication', report.authentication],
          ['health', report.health],
          ['version', info.version],
          ['server_name', info.server_name],
          ['build', info.build],
          ['license_state', info.license_state],
          ['license_pools', report.license === null ? '-' : report.license.pools.length],
          ['latency_ms', report.latency_ms === null ? null : floatString(report.latency_ms)],
        ]),
      )
      return
    }
    emitText(
      keyValueTable([
        ['connection', report.connection],
        ['authentication', report.authentication],
        ['health', report.health],
        ['latency_ms', report.latency_ms === null ? null : floatString(report.latency_ms)],
      ]),
    )
  })

  withCommon(
    program
      .command('alerts')
      .description('List triggered alerts (read-only; never modifies alerts)')
      .option('-n, --count <number>', 'Maximum number of alerts', (value: string) =>
        Number.parseInt(value, 10),
      )
      .option('--saved', 'Also list saved searches / alert definitions.'),
  ).action(async (options: CommonOptions & { count?: number; saved?: boolean }) => {
    applyCommon(options)
    const includeSaved = options.saved === true
    const result = await withClient((client) =>
      new AlertsService(client).alerts({
        count: options.count ?? null,
        includeSaved,
      }),
    )

    if (options.json === true) {
      emitJson(result.toPublicDict())
      return
    }

    if (result.note !== null) {
      emitText(`note: ${result.note}`)
    }
    if (result.fired.length > 0) {
      emitText(
        renderTable(
          ['name', 'severity', 'triggered', 'trigger_time', 'app'],
          result.fired.map((alert) => [
            alert.name,
            alert.severity,
            formatNumber(alert.triggered_alerts),
            alert.trigger_time,
            alert.app,
          ]),
        ),
      )
    } else {
      emitText('(no triggered alerts)')
    }

    if (includeSaved) {
      emitText('')
      if (result.saved.length > 0) {
        emitText('saved searches:')
        emitText(
          renderTable(
            ['name', 'app', 'owner', 'scheduled', 'schedule', 'disabled'],
            result.saved.map((saved) => [
              saved.name,
              saved.app,
              saved.owner,
              saved.is_scheduled,
              saved.cron_schedule,
              saved.disabled,
            ]),
          ),
        )
      } else {
        emitText('(no saved searches)')
      }
    }
  })
}

/** 注册 `stats` / `timeline` / `fields`（Phase 2 的聚合类命令）。 */
function registerQueryCommands(program: Command): void {
  withTimeRange(
    withCommon(
      program
        .command('stats')
        .description('Aggregate events, e.g. error counts grouped by service')
        .argument('<query>', "Base SPL query, e.g. 'index=app level=ERROR'")
        .option('--by <fields>', "Grouping field(s), e.g. 'service' or 'service,host'.")
        .option('-f, --function <name>', 'Aggregate: count, dc, sum, avg, min, max.', 'count')
        .option('-n, --limit <number>', 'Maximum grouped rows.', (value: string) =>
          Number.parseInt(value, 10),
        ),
    ),
  ).action(
    async (
      query: string,
      options: CommonOptions &
        TimeOptions & {
          by?: string
          function: string
          limit?: number
        },
    ) => {
      applyCommon(options)
      const { earliest, latest } = timeBounds(options)
      const result = await withClient((client) =>
        new StatsService(client).stats(query, {
          by: options.by ?? null,
          function: options.function,
          earliest,
          latest,
          limit: options.limit ?? null,
        }),
      )

      if (options.json === true) {
        emitJson(result.toPublicDict())
        return
      }
      const label = result.by.length > 0 ? 'key' : 'scope'
      emitText(
        renderTable(
          [label, result.function],
          result.rows.map((row) => [statKey(row.key), formatNumber(row.count)]),
        ),
      )
      let summary = `${result.rows.length} row(s)  |  spl: ${result.spl}`
      if (result.truncated) summary += '  (truncated)'
      emitText(`\n${summary}`)
    },
  )

  withTimeRange(
    withCommon(
      program
        .command('timeline')
        .description('Show event volume over time for a query')
        .argument('<query>', "Base SPL query, e.g. 'index=app level=ERROR'")
        .option('-s, --span <span>', 'Bucket size, e.g. 30s, 5m, 1h.', '5m')
        .option('-n, --limit <number>', 'Maximum number of buckets.', (value: string) =>
          Number.parseInt(value, 10),
        ),
    ),
  ).action(
    async (
      query: string,
      options: CommonOptions &
        TimeOptions & {
          span: string
          limit?: number
        },
    ) => {
      applyCommon(options)
      const { earliest, latest } = timeBounds(options)
      const result = await withClient((client) =>
        new TimelineService(client).timeline(query, {
          span: options.span,
          earliest,
          latest,
          limit: options.limit ?? null,
        }),
      )

      if (options.json === true) {
        emitJson(result.toPublicDict())
        return
      }
      if (result.timeline.length === 0) {
        emitText('(no data)')
        return
      }
      emitText(`span=${result.span}  total=${formatNumber(result.total)}`)
      emitText(sparkline(result.timeline.map((point) => point.count)))
      emitText('')
      emitText(
        renderTable(
          ['time', 'count'],
          result.timeline.map((point) => [point.time, formatNumber(point.count)]),
        ),
      )
    },
  )

  withTimeRange(
    withCommon(
      program
        .command('fields')
        .description('List the fields available for a query (useful for schema discovery)')
        .argument('<query>', "Base SPL query, e.g. 'index=app'")
        .option('-n, --limit <number>', 'Maximum number of fields.', (value: string) =>
          Number.parseInt(value, 10),
        )
        .option('--details', 'Show per-field counts and common values.'),
    ),
  ).action(
    async (
      query: string,
      options: CommonOptions &
        TimeOptions & {
          limit?: number
          details?: boolean
        },
    ) => {
      applyCommon(options)
      const { earliest, latest } = timeBounds(options)
      const showDetails = options.details === true
      const result = await withClient((client) =>
        new FieldsService(client).fields(query, {
          earliest,
          latest,
          limit: options.limit ?? null,
          includeDetails: showDetails,
        }),
      )

      if (options.json === true) {
        emitJson(result.toPublicDict())
        return
      }
      if (result.fields.length === 0) {
        emitText('(no fields found)')
        return
      }
      if (showDetails && result.details.length > 0) {
        emitText(
          renderTable(
            ['field', 'count', 'distinct', 'top values'],
            result.details.map((detail) => [
              detail.name,
              formatNumber(detail.count),
              formatNumber(detail.distinct_count),
              detail.modes
                .slice(0, 3)
                .map((mode) => String(mode['value'] ?? ''))
                .join(', '),
            ]),
            { maxCellWidth: 40 },
          ),
        )
        return
      }
      emitText(renderTable(['field'], result.fields.map((name) => [name])))
    },
  )
}

/** 解析过程是否请求了 JSON（用于在解析失败时也能选对输出通道）。 */
function jsonRequested(argv: readonly string[]): boolean {
  return argv.includes('--json') || argv.includes('-j')
}

/** 运行 CLI，返回退出码。 */
export async function main(argv: string[] = process.argv): Promise<number> {
  try {
    const program = buildProgram()
    registerPhase2Commands(program)
    registerQueryCommands(program)
    await program.parseAsync(argv)
    return 0
  } catch (error) {
    // 已产出结构化报告的失败：直接采用它算出的退出码，不再重复打印。
    if (error instanceof ExitSignal) return error.code
    if (error instanceof CommanderError) {
      // `--help` / `--version` 是**正常输出**，不是错误；commander 已经把它们写到了
      // stdout。未知命令等真正的解析错误由 commander 写到 stderr 并给出非零码。
      return error.exitCode === 0 ? 0 : 1
    }
    reportError(error, jsonRequested(argv))
    return exitCodeFor(error)
  }
}

/**
 * 长驻命令（`dashboard`）注册的优雅关闭钩子。
 *
 * 没有它，下面的 SIGINT 处理会直接 `process.exit(130)`，把 HTTP 服务与连接池
 * 硬切断；有了它，关闭流程先跑完再退出。
 */
let gracefulShutdown: (() => Promise<void>) | null = null

// 中断处理：与命令行惯例一致，退出码 130。
process.on('SIGINT', () => {
  if (gracefulShutdown !== null) {
    const shutdown = gracefulShutdown
    gracefulShutdown = null
    void shutdown().finally(() => process.exit(130))
    return
  }
  if (jsonRequested(process.argv)) {
    emitJson(errorPayload(new SplunkError('interrupted')))
  } else {
    emitDiagnostic('interrupted')
  }
  // 中断路径不追求"冲刷完毕"：用户已经要求停下，等待写盘反而更糟。
  process.exit(130)
})

/**
 * 只在被当作入口执行时运行，被 import 时不运行。
 *
 * 没有这个守卫，任何 `import { main } from '../bin/splunk-cli'` 都会**立刻执行一遍 CLI**
 * 并把 exitCode 设成它的结果——测试根本没法用。
 */
export function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return false
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url)
  } catch {
    // argv[1] 不是一条真实路径（例如被测试改写）——当作"不是入口"。
    return false
  }
}

/**
 * 以进程入口身份运行：把退出码写进 `process.exitCode`。
 *
 * **不调用 `process.exit()`**：stdout 对管道是异步的，立即退出会截断 JSON。
 * 抽成函数是为了让它可被测试直接驱动（否则这段只在 import 时执行，无法覆盖）。
 */
export async function runAsMain(): Promise<number> {
  const code = await main()
  process.exitCode = code
  return code
}

if (isMainModule()) {
  await runAsMain()
}
