/**
 * 零依赖 logger。
 *
 * 设计取舍：
 *   - 不引第三方依赖（pino / winston 都是 100+ KB 且要在 esbuild 里外部化处理）；
 *   - **全部写 stderr**：stdout 留给机器载荷（README §13「日志输出到 stderr」），
 *     这是对拍与 agent 解析的前提；
 *   - 模块名定宽 4 字符，便于 `grep` 时列对齐；
 *   - sink 可注入，测试不会污染自己的输出；
 *   - 任何级别都不打印请求头、Cookie、Session Key 或密码（AGENTS.md §4）。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const LEVEL_ENV = 'LOG_LEVEL'

let currentLevel: LogLevel = readLevelFromEnv()
let explicitlySetLevel: LogLevel | null = null

function readLevelFromEnv(): LogLevel {
  const raw = (process.env[LEVEL_ENV] ?? '').toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  return 'info'
}

/** 单条日志的写入目标（默认 stderr —— 不污染 stdout）。 */
export type LogSink = (line: string) => void

let sink: LogSink = (line) => {
  process.stderr.write(`${line}\n`)
}

/**
 * 覆盖日志级别（`--verbose` 用）。
 *
 * @param level 目标级别，或 `null` 恢复为环境变量/默认值。
 */
export function setLogLevel(level: LogLevel | null): void {
  explicitlySetLevel = level
  currentLevel = level ?? readLevelFromEnv()
}

/**
 * 注入自定义 sink（测试用）。
 *
 * @param custom 写入函数，或 `null` 恢复 stderr。
 */
export function setLoggerOutput(custom: LogSink | null): void {
  sink = custom ?? ((line) => process.stderr.write(`${line}\n`))
}

/** 当前生效的级别（测试与诊断用）。 */
export function getLogLevel(): LogLevel {
  return explicitlySetLevel ?? readLevelFromEnv()
}

/**
 * 把附加数据序列化成一行 JSON。
 *
 * `Error` → `{name, message, stack}`；循环引用退化为可读标记而不是抛错——
 * 日志绝不该因为序列化失败而中断命令。
 */
export function serializeData(data: unknown): string {
  if (data === undefined) return ''
  const seen = new WeakSet<object>()
  try {
    const text = JSON.stringify(data, (_key, value: unknown) => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack }
      }
      if (value instanceof Date) return value.toISOString()
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circular]'
        seen.add(value)
      }
      return value
    })
    return text === undefined ? '' : ` ${text}`
  } catch (error) {
    return ` [unserializable: ${error instanceof Error ? error.message : String(error)}]`
  }
}

function emit(level: LogLevel, module: string, message: string, data?: unknown): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[getLogLevel()]) return
  const mod = module.length >= 4 ? module.slice(0, 4) : module.padEnd(4)
  const line = `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] [${mod}] ${message}${serializeData(data)}`
  sink(line)
}

/** 记录 debug 日志。 */
export function debug(module: string, message: string, data?: unknown): void {
  emit('debug', module, message, data)
}

/** 记录 info 日志。 */
export function info(module: string, message: string, data?: unknown): void {
  emit('info', module, message, data)
}

/** 记录 warn 日志。 */
export function warn(module: string, message: string, data?: unknown): void {
  emit('warn', module, message, data)
}

/** 记录 error 日志。 */
export function error(module: string, message: string, data?: unknown): void {
  emit('error', module, message, data)
}
