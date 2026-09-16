/**
 * 把错误体系翻译成 HTTP。
 *
 * 响应体始终是 CLI 写进 stdout 的那个信封（`errorPayload()` 构造），
 * 所以已经会解析 `splunk-cli --json` 失败的调用方不需要第二套代码路径。
 *
 * 这条对"没有 Splunk 语义"的失败同样成立：意外异常也走同一个信封，
 * 而不是以框架默认的 HTML 500 逃逸出去。
 */

import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'

import { SplunkError, errorPayload, sanitizeMessage } from '../errors'
import { debug as logDebug, error as logError } from '../logger'

/**
 * 稳定错误类型 → HTTP 状态码。表里没有的类型属于编程错误，500 是诚实的答案。
 */
export const HTTP_STATUS_BY_ERROR_TYPE: Readonly<Record<string, number>> = {
  ConfigurationError: 500,
  SplunkAuthenticationError: 502,
  SplunkConnectionError: 502,
  SplunkQueryError: 400,
  SplunkJobError: 502,
  SplunkResultError: 502,
  SafetyLimitError: 422,
  SplunkTimeoutError: 504,
  ForbiddenOrigin: 403,
  FrontendNotBuilt: 503,
}

/** 非 `SplunkError` 异常的状态码。 */
export const HTTP_INTERNAL_ERROR = 500

/** 请求体校验失败的状态码。 */
export const HTTP_UNPROCESSABLE = 422

/** 请求体校验失败时报出的错误类型（刻意不是任一 Splunk 错误类型）。 */
export const VALIDATION_ERROR_TYPE = 'ValidationError'

/** 无法更好归类时报出的错误类型。 */
export const INTERNAL_ERROR_TYPE = 'InternalError'

/**
 * 这类失败的消息。**刻意写死**：意外异常可能带文件路径、取值或上游响应体，
 * 而这个载荷是要发给浏览器的——永远不是 `str(exc)`。
 */
export const INTERNAL_ERROR_MESSAGE = 'internal error'

/** 没有 Splunk 语义的失败。 */
class InternalError extends SplunkError {
  override readonly errorType: string = INTERNAL_ERROR_TYPE

  constructor(message: string) {
    super(message)
    this.name = 'InternalError'
  }
}

/** 在接触 Splunk 之前就被拒绝的请求体。 */
class ValidationError extends SplunkError {
  override readonly errorType: string = VALIDATION_ERROR_TYPE

  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** 把异常映射成 HTTP 状态码。 */
export function statusFor(error: unknown): number {
  if (error instanceof SplunkError) {
    return HTTP_STATUS_BY_ERROR_TYPE[error.errorType] ?? HTTP_INTERNAL_ERROR
  }
  return HTTP_INTERNAL_ERROR
}

/** 把 zod 的校验错误汇总成 `[{field, issue}]`。 */
function summarizeIssues(error: ZodError): Array<{ field: string; issue: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.map((part) => String(part)).join('.'),
    issue: issue.message,
  }))
}

/**
 * 统一错误中间件（express 要求四个参数，缺一不可）。
 *
 * 一个出口覆盖三类失败：
 *   - `SplunkError` → 按 `HTTP_STATUS_BY_ERROR_TYPE` 映射；
 *   - zod 校验失败 → 422 + `ValidationError`（而不是让框架吐出 `{"detail": ...}`，
 *     那会给调用方制造第二套契约）；
 *   - 其它意外 → 500 + `InternalError`，消息固定为 `internal error`。
 */
export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  if (response.headersSent) return

  // body 解析失败：`express.json()` 抛出的是带 `status: 400` 的 SyntaxError。
  // 归类为**请求体非法**（422 + ValidationError），而不是"服务器内部错误"——
  // 请求确实有问题，而服务器没有任何问题。
  const parserStatus = (error as { status?: unknown } | null)?.status
  if (error instanceof SyntaxError && parserStatus === 400) {
    response
      .status(HTTP_UNPROCESSABLE)
      .json(
        errorPayload(
          new ValidationError(`invalid request body: ${JSON.stringify([{ field: '', issue: 'malformed JSON' }])}`),
        ),
      )
    return
  }

  if (error instanceof ZodError) {
    const summarized = summarizeIssues(error)
    response
      .status(HTTP_UNPROCESSABLE)
      .json(
        errorPayload(
          new ValidationError(
            `invalid request body: ${JSON.stringify(summarized)}`,
          ),
        ),
      )
    return
  }

  if (error instanceof SplunkError) {
    response.status(statusFor(error)).json(errorPayload(error))
    return
  }

  // 意外异常的文本绝不外泄：它可能带路径、取值或上游内容。
  // 但**必须留在服务端日志里**——否则 500 只剩一句 `internal error`，连排查的起点都没有。
  logUnexpected(error)
  response
    .status(HTTP_INTERNAL_ERROR)
    .json(errorPayload(new InternalError(INTERNAL_ERROR_MESSAGE)))
}

/**
 * 把意外异常写进服务端日志（stderr）。
 *
 * 响应体刻意只给 `internal error`，所以日志是**唯一**的诊断入口：不打这一行，
 * 用户和我们都只能看到一个没有任何信息的 500。
 *
 * 消息过一遍 `sanitizeMessage`；堆栈只在 `debug` 级别输出，避免默认日志被噪声淹没。
 */
function logUnexpected(error: unknown): void {
  const name = error instanceof Error ? error.name : 'NonError'
  const message = error instanceof Error ? error.message : String(error)
  logError('web', `unhandled ${name}: ${sanitizeMessage(message)}`)
  if (error instanceof Error && error.stack !== undefined) {
    logDebug('web', sanitizeMessage(error.stack))
  }
}
