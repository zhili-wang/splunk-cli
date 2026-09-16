/**
 * 错误体系。
 *
 * 这个模块**零依赖**，位于依赖图最底层：配置、安全、输出、服务、客户端都抛同一套错误，
 * 不会形成循环导入。
 *
 * 两条不可协商的约束：
 *   1. `errorType` 是**公开契约**——它出现在 JSON 的 `error.type` 里，调用方据此分支。
 *      它必须逐字等于既定的契约字符串，**不能**用 TS 的类名（ADR §5.3）；
 *   2. 消息绝不携带密码、`Authorization` 头、session key 或 Cookie。
 *      `sanitizeMessage()` 是所有外部字符串进入错误信息的唯一入口。
 */

/** 会把凭据泄漏进错误消息的模式。 */
const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Splunk session key：字面量 "Splunk " 后跟一个含数字的长 token。
  // 要求含数字是为了不误伤 "Splunk HTTP 502" 这类普通叙述。
  [/\bSplunk\s+(?=[A-Za-z0-9+/=_-]*[0-9])[A-Za-z0-9+/=_-]{12,}/gi, 'Splunk <redacted>'],
  // 通用 bearer / basic 凭据。
  [/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{4,}/gi, '$1 <redacted>'],
  // key=value 形式的密钥。
  [
    /\b(password|passwd|pwd|token|session_?key|authorization|cookie)\b\s*[=:]\s*\S+/gi,
    '$1=<redacted>',
  ],
  // JSON 形式的 "password": "..." 键值对。
  [
    /"(password|passwd|token|sessionKey|authorization|cookie)"\s*:\s*"[^"]*"/gi,
    '"$1":"<redacted>"',
  ],
]

/**
 * 去掉凭据形状的子串并把长度截断。
 *
 * @param text 不可信文本，通常是远端响应体或异常消息。
 * @param limit 返回字符串的最大长度。
 * @returns 单行、已脱敏、已截断的字符串。
 */
export function sanitizeMessage(text: string, limit = 2000): string {
  // 折叠所有空白并去掉首尾。
  let cleaned = text
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ')
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement)
  }
  if (cleaned.length > limit) {
    cleaned = `${cleaned.slice(0, limit - 3)}...`
  }
  return cleaned
}

/** 构造错误时的可选参数。 */
export interface SplunkErrorOptions {
  /** 结构化上下文。绝不包含凭据。 */
  details?: Record<string, unknown>
}

/**
 * 所有失败的基类。
 *
 * 注意 `errorType` 在子类里用 `override` 收窄为字面量类型：这样 `errorType` 既是运行时
 * 的契约字符串，也是编译期的字面量，双层保护。
 */
export class SplunkError extends Error {
  /** 稳定的、机器可读的错误类型（JSON `error.type`）。 */
  readonly errorType: string = 'SplunkError'

  readonly details: Record<string, unknown>

  constructor(message: string, options: SplunkErrorOptions = {}) {
    const safe = sanitizeMessage(message)
    super(safe)
    this.name = 'SplunkError'
    this.message = safe
    this.details = { ...(options.details ?? {}) }
  }

  /** 稳定的 JSON 表示。`details` 为空时整个键省略。 */
  toDict(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      type: this.errorType,
      message: this.message,
    }
    if (Object.keys(this.details).length > 0) {
      payload.details = this.details
    }
    return payload
  }
}

/** 配置缺失、非法或自相矛盾。退出码 2。 */
export class ConfigurationError extends SplunkError {
  override readonly errorType: string = 'ConfigurationError'

  constructor(message: string, options: SplunkErrorOptions = {}) {
    super(message, options)
    this.name = 'ConfigurationError'
  }
}

/** 连不上 Splunk（DNS / TCP / TLS / 连接重置）。退出码 4。 */
export class SplunkConnectionError extends SplunkError {
  override readonly errorType: string = 'SplunkConnectionError'

  constructor(message: string, options: SplunkErrorOptions = {}) {
    super(message, options)
    this.name = 'SplunkConnectionError'
  }
}

/** Splunk 拒绝了凭据（HTTP 401/403）。退出码 3。 */
export class SplunkAuthenticationError extends SplunkError {
  override readonly errorType: string = 'SplunkAuthenticationError'

  constructor(message: string, options: SplunkErrorOptions = {}) {
    super(message, options)
    this.name = 'SplunkAuthenticationError'
  }
}

/** HTTP 请求或搜索 Job 超出时间预算。退出码 7。 */
export class SplunkTimeoutError extends SplunkError {
  override readonly errorType: string = 'SplunkTimeoutError'

  constructor(message: string, options: SplunkErrorOptions = {}) {
    super(message, options)
    this.name = 'SplunkTimeoutError'
  }
}

/** Splunk 拒绝了查询或返回非 2xx。退出码 5。 */
export class SplunkQueryError extends SplunkError {
  override readonly errorType: string = 'SplunkQueryError'

  constructor(message: string, options: SplunkErrorOptions = {}) {
    super(message, options)
    this.name = 'SplunkQueryError'
  }
}

/** 搜索 Job 失败、被取消或状态不一致。退出码 5。 */
export class SplunkJobError extends SplunkError {
  override readonly errorType: string = 'SplunkJobError'

  constructor(message: string, options: SplunkErrorOptions = {}) {
    super(message, options)
    this.name = 'SplunkJobError'
  }
}

/** 搜索结果无法解析成预期结构。退出码 5。 */
export class SplunkResultError extends SplunkError {
  override readonly errorType: string = 'SplunkResultError'

  constructor(message: string, options: SplunkErrorOptions = {}) {
    super(message, options)
    this.name = 'SplunkResultError'
  }
}

/**
 * 错误类型 → 退出码。**这是公开契约**。
 *
 * `SafetyLimitError` 定义在 `safety/limits.ts`，但同样登记在这里，
 * 因为退出码映射属于错误体系。
 */
export const EXIT_CODES: Readonly<Record<string, number>> = {
  SplunkError: 1,
  ConfigurationError: 2,
  SplunkAuthenticationError: 3,
  SplunkConnectionError: 4,
  SplunkQueryError: 5,
  SafetyLimitError: 6,
  SplunkTimeoutError: 7,
  SplunkJobError: 5,
  SplunkResultError: 5,
}

/** 非 `SplunkError` 的意外失败的退出码。 */
export const EXIT_UNEXPECTED = 1

/** 成功退出码。 */
export const EXIT_SUCCESS = 0

/**
 * 把异常映射为稳定的进程退出码。
 *
 * @param error 终止命令的异常。
 * @returns README 中记录的退出码。
 */
export function exitCodeFor(error: unknown): number {
  if (error instanceof SplunkError) {
    return EXIT_CODES[error.errorType] ?? 1
  }
  return EXIT_UNEXPECTED
}

/**
 * 构造稳定的失败信封。
 *
 * @param error 终止命令的异常。
 * @returns `{success: false, error: {type, message, details?}}`。
 */
export function errorPayload(error: unknown): { success: false; error: Record<string, unknown> } {
  if (error instanceof SplunkError) {
    return { success: false, error: error.toDict() }
  }
  // 非 taxonomy 错误：类型名取构造器的 `name`，
  // 消息取 `.message`，两者先后经过脱敏。
  const type = error instanceof Error ? error.constructor.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  return { success: false, error: { type, message: sanitizeMessage(message) } }
}
