/**
 * 面板的请求守卫。
 *
 * 绑定 `127.0.0.1` 能让服务不出网卡，但**拦不住用户访问的网页**：DNS rebinding 会让
 * `evil.com` 解析到 `127.0.0.1`，浏览器随后就替攻击者发起查询。
 *
 * 防线是 `Host` 头：rebinding 无法伪造它（浏览器只会发送用户实际访问的名字），
 * 所以 `Host: evil.com:8765` 直接拒绝。`Origin` 作为纵深防御一并校验。
 */

import type { NextFunction, Request, Response } from 'express'

import { SplunkError, errorPayload } from '../errors'

/** 面板唯一应答的主机名。 */
export const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1'])

/** 守卫拒绝请求时返回的状态码。 */
export const HTTP_FORBIDDEN = 403

/** 守卫拒绝请求时报出的错误类型。 */
export const FORBIDDEN_ORIGIN_ERROR_TYPE = 'ForbiddenOrigin'

/** 请求的 `Host` 或 `Origin` 没有指向回环地址。 */
export class ForbiddenOriginError extends SplunkError {
  override readonly errorType: string = FORBIDDEN_ORIGIN_ERROR_TYPE

  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenOriginError'
  }
}

/**
 * 去掉 `Host` 头的端口部分。
 *
 * @param hostHeader 如 `127.0.0.1:8765`、`localhost` 或 `[::1]:8765`。
 * @returns 小写的裸主机名；带方括号的 IPv6 会去掉方括号。
 */
export function bareHostname(hostHeader: string): string {
  const value = hostHeader.trim()
  if (value.startsWith('[')) {
    // [::1]:8765 -> ::1
    return (value.slice(1).split(']')[0] ?? '').toLowerCase()
  }
  if (value.includes(':')) {
    return (value.slice(0, value.lastIndexOf(':')) ?? '').toLowerCase()
  }
  return value.toLowerCase()
}

/**
 * 判断 `Host` 头是否被允许。
 *
 * @param hostHeader 原始头值，缺失时为 `undefined`。
 */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader === '') return false
  return ALLOWED_HOSTNAMES.has(bareHostname(hostHeader))
}

/**
 * 判断 `Origin` 头是否被允许。
 *
 * @param origin 原始头值，缺失时为 `undefined`。
 * @returns 头缺失时返回 `true`（非浏览器客户端不带该头），否则要求指向回环地址。
 */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true
  let hostname: string
  try {
    // 覆盖 "null"、空串与任何无法解析的值：它们都会抛错或得到空主机名。
    hostname = new URL(origin).hostname
  } catch {
    return false
  }
  if (hostname === '') return false
  return ALLOWED_HOSTNAMES.has(hostname.toLowerCase())
}

/** 构造拒绝响应：403 + 项目统一的标准错误信封。 */
function forbidden(response: Response, reason: string): void {
  response.status(HTTP_FORBIDDEN).json(errorPayload(new ForbiddenOriginError(reason)))
}

/**
 * Host / Origin 守卫中间件。
 *
 * 必须注册在**最前面**（早于 body 解析），这样敌意的 `Host` 在进入任何业务逻辑之前
 * 就被拒绝。
 */
export function originGuard(request: Request, response: Response, next: NextFunction): void {
  if (!hostAllowed(request.headers.host)) {
    forbidden(response, 'the Host header does not name a loopback address')
    return
  }
  if (!originAllowed(request.headers.origin)) {
    forbidden(response, 'the Origin header does not name a loopback address')
    return
  }
  next()
}
