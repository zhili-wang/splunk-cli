/**
 * SPL 基础安全校验。
 *
 * 这**不是**完整的 SPL 解析器，而是针对管理类/破坏类命令的保守词法黑名单。
 * 原则（AGENTS.md §4）：**拿不准就拒绝**。误拒可接受，误放不可接受。
 *
 * 只检查以管道分隔的**命令位置**，因此 `| stats count by delete` 里名为 delete 的字段
 * 依然可用。
 */

import { SafetyLimitError } from './limits'

/** 会改动数据、配置、用户、应用或集群的 SPL 命令。 */
export const PROHIBITED_COMMANDS: Readonly<Record<string, string>> = {
  // 搜索 Job / 数据改写
  delete: 'deletes indexed data',
  collect: 'writes results into an index',
  meventcollect: 'writes results into a summary index',
  dbinspect: 'mutates index bucket metadata',
  // 配置、应用与集群管理
  sendalert: 'triggers alert actions with side effects',
  script: 'executes arbitrary server-side scripts',
  runshellscript: 'executes shell scripts on the search head',
  rest: 'calls arbitrary REST endpoints, including write APIs',
  outputlookup: 'writes lookup files',
  outputcsv: 'writes CSV output to the search head',
  outputtext: 'writes output files',
  mcollect: 'writes to an index',
  tscollect: 'writes to a summary index',
  // 远端/外部执行
  map: 'executes a subsearch per result and can amplify load',
}

/** 只允许普通字段标识符（可带点）。 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/** `by` 子句的分隔符：逗号或空白。 */
const BY_SPLIT_RE = /[,\s]+/

/** 管道位置的命令 token。 */
const PIPE_COMMAND_RE = /(?:^|\|)\s*([A-Za-z][A-Za-z0-9_]*)/g

/**
 * 校验用户提供的 SPL 查询是否只读安全。
 *
 * @param query 原始输入，可带或不带前导 `search`。
 * @param options.maxLength 允许的最大长度。
 * @returns 通过校验后去掉首尾空白的查询。
 */
export function validateSpl(query: string, options: { maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? 10_000
  const text = query.trim()
  if (text === '') {
    throw new SafetyLimitError('search query is empty')
  }
  if (text.length > maxLength) {
    throw new SafetyLimitError(
      `query length ${text.length} exceeds the maximum allowed ${maxLength} characters`,
      { details: { length: text.length, max_query_length: maxLength } },
    )
  }
  checkProhibitedCommands(text)
  return text
}

/**
 * 拒绝包含管理类/改写类命令的查询。
 *
 * @param query SPL 文本。
 */
export function checkProhibitedCommands(query: string): void {
  for (const match of query.matchAll(PIPE_COMMAND_RE)) {
    const command = (match[1] ?? '').toLowerCase()
    const reason = PROHIBITED_COMMANDS[command]
    if (reason !== undefined) {
      throw new SafetyLimitError(
        `SPL command '${command}' is not permitted: it ${reason}. Splunk CLI is read-only.`,
        { details: { command, reason, position: match.index } },
      )
    }
  }
}

/** 校验用于构造 SPL 的字段名（`stats ... by <field>`）。 */
export function validateFieldNames(field: string): string {
  const name = field.trim()
  if (name === '') {
    throw new SafetyLimitError('field name must not be empty')
  }
  if (!IDENTIFIER_RE.test(name)) {
    throw new SafetyLimitError(
      `invalid field name '${name}': expected an identifier such as ` +
        "'service' or 'request.status'",
      { details: { field } },
    )
  }
  return name
}

/** 解析并校验逗号/空白分隔的 `by` 字段列表。 */
export function validateByFields(by: string | null | undefined): string[] {
  if (by === null || by === undefined) return []
  const text = by.trim()
  if (text === '') return []
  const parts = text.split(BY_SPLIT_RE).filter((part) => part !== '')
  if (parts.length === 0) return []
  if (parts.length > 4) {
    throw new SafetyLimitError(
      `at most 4 grouping fields are supported (got ${parts.length}): ` +
        'narrow the grouping to keep results interpretable',
      { details: { by: text, fields: parts.length } },
    )
  }
  return parts.map((part) => validateFieldNames(part))
}

/** 校验 `stats` 使用的聚合函数。 */
export function validateStatsFunction(fn: string): string {
  // 白名单按字母序输出，消息与 details 都据此生成。
  const allowed = ['count', 'dc', 'sum', 'avg', 'min', 'max'].sort()
  const name = fn.trim().toLowerCase()
  if (!allowed.includes(name)) {
    throw new SafetyLimitError(
      `unsupported stats function '${fn}': choose one of ${allowed.join(', ')}`,
      { details: { function: fn, allowed } },
    )
  }
  return name
}

/** 构造 `stats` 的完整 SPL。只插值**已校验**的标识符。 */
export function buildStatsSpl(query: string, options: { fn: string; by: string[]; limit: number }): string {
  const aggregate = options.fn === 'count' ? 'count' : `${options.fn}(*)`
  let pipeline = `| stats ${aggregate}`
  if (options.by.length > 0) {
    pipeline = `${pipeline} by ${options.by.join(', ')}`
  }
  pipeline = `${pipeline} | sort - ${aggregate.split('(')[0]}`
  return `${query} ${pipeline} | head ${options.limit}`
}

/** 构造 `timeline` 的完整 SPL。 */
export function buildTimelineSpl(query: string, options: { span: string; limit: number }): string {
  return `${query} | timechart span=${options.span} count | head ${options.limit}`
}

/** 构造 `fields` 的完整 SPL。 */
export function buildFieldsummarySpl(query: string, options: { limit: number }): string {
  return `${query} | fieldsummary | head ${options.limit}`
}

/** `health` 使用的最小 SPL：不触碰任何索引。 */
export function buildProbeSpl(): string {
  return '| makeresults count=1'
}
