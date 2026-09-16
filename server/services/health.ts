/**
 * 健康检查服务。
 *
 * 对应未来的 `splunk_health` 工具。这通常是 agent 的**第一个调用**：在做任何搜索之前
 * 先证明凭据可用。
 *
 * 一条关键设计：连接/认证失败**在报告内呈现**（`connection="failed"`）而不是抛出，
 * 这样监控脚本拿到的是一个结构化的答案；退出码由 `HealthReport.failureExitCode()` 决定。
 */

import { SplunkAuthenticationError, SplunkError } from '../errors'
import { HealthReport, LicenseInfo } from '../models/health'
import { BaseService } from './base'

/** 不跑搜索地探测一个 Splunk 实例。 */
export class HealthService extends BaseService {
  /**
   * 检查连通性、认证、版本与 license 状态。
   *
   * @param options.includeLicense 是否同时查询 license pool。
   */
  async health(options: { includeLicense?: boolean } = {}): Promise<HealthReport> {
    const includeLicense = options.includeLicense ?? true
    const started = Date.now()
    let info
    try {
      info = await this.client.serverInfo()
    } catch (error) {
      if (error instanceof SplunkError) {
        return failureReport(error, started)
      }
      throw error
    }

    const latencyMs = Math.round((Date.now() - started) * 10) / 10

    let license: LicenseInfo | null = null
    if (includeLicense) {
      license = LicenseInfo.fromApi(await this.client.licenseInfo())
    }

    return new HealthReport({
      success: true,
      splunk: info,
      connection: 'ok',
      authentication: 'ok',
      health: info.health,
      license,
      latency_ms: latencyMs,
    })
  }
}

/** 构造一次失败探针的报告。 */
function failureReport(error: SplunkError, started: number): HealthReport {
  const latencyMs = Math.round((Date.now() - started) * 10) / 10
  const isAuth = error instanceof SplunkAuthenticationError
  return new HealthReport({
    success: false,
    splunk: null,
    // 认证失败说明**连接是通的**——这是字段设计上刻意区分的两个维度（README §10）。
    connection: isAuth ? 'ok' : 'failed',
    authentication: isAuth ? 'failed' : 'unknown',
    health: 'unknown',
    license: null,
    latency_ms: latencyMs,
    error: error.message,
  })
}
