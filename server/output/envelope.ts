/**
 * 稳定的 JSON 输出。
 *
 * 成功：`{"success": true, ...命令特有键...}`
 * 失败：`{"success": false, "error": {"type": "...", "message": "..."}}`
 *
 * 信封是**公开契约**：调用方依赖 `success` 与 `error.type`。
 *
 * 一条硬要求：输出结束后**不调用 `process.exit()`**，而是设置 `process.exitCode`。
 * stdout 写入对管道是异步的，立即 exit 会截断 JSON。
 */

/** 默认缩进：2 个空格。 */
const DEFAULT_INDENT = 2

/**
 * 序列化为 JSON 文本（不带尾随换行）。
 *
 * @param payload 任意可序列化值。
 * @param indent 缩进；`null` 表示紧凑单行。
 */
export function dumps(payload: unknown, indent: number | null = DEFAULT_INDENT): string {
  const text = indent === null ? JSON.stringify(payload) : JSON.stringify(payload, null, indent)
  return text ?? 'null'
}

/**
 * 把 JSON 载荷写入流并换行。
 *
 * @param payload 任意可序列化值。
 * @param stream 目标流；默认 `process.stdout`。
 */
export function emitJson(payload: unknown, stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(dumps(payload))
  stream.write('\n')
}

/**
 * 写入纯文本输出（文本模式）。
 *
 * @param text 文本内容（自动补尾随换行）。
 * @param stream 目标流；默认 `process.stdout`。
 */
export function emitText(text: string, stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(`${text}\n`)
}

/**
 * 写入诊断信息（错误提示、hint）。
 *
 * stdout 只放机器载荷，诊断一律走 stderr。
 */
export function emitDiagnostic(text: string, stream: NodeJS.WritableStream = process.stderr): void {
  stream.write(`${text}\n`)
}
