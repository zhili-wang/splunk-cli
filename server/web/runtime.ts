/**
 * 面板背后的长生命周期容器。
 *
 * CLI 的上下文是"每次调用一份、命令结束就关"；Web 服务恰好相反：一个进程、
 * 许多并发请求，所以它有自己的容器，而不是在 CLI 的容器上加个开关。
 */

import type { Settings } from '../config/settings'
import { SplunkClient } from '../client/splunk'
import type { BaseService } from '../services/base'

/** 一个共享的 Splunk 客户端 + 每类服务各一份缓存实例。 */
export class WebRuntime {
  /** 生效中的配置。**绝不序列化进响应。** */
  readonly settings: Settings

  readonly #client: SplunkClient
  readonly #ownsClient: boolean
  readonly #services = new Map<unknown, unknown>()

  /**
   * @param settings 启动时加载一次的连接配置。凭据留在本进程内存里，绝不下发到页面。
   * @param options.client 预构造的客户端（测试注入）；注入的客户端由调用方负责关闭。
   */
  constructor(settings: Settings, options: { client?: SplunkClient } = {}) {
    this.settings = settings
    this.#client = options.client ?? new SplunkClient(settings)
    this.#ownsClient = options.client === undefined
  }

  /** 共享的只读客户端。 */
  get client(): SplunkClient {
    return this.#client
  }

  /** 返回缓存的服务实例，最多构造一次。 */
  service<T>(serviceType: new (client: SplunkClient) => T): T {
    const existing = this.#services.get(serviceType)
    if (existing !== undefined) return existing as T
    const created = new serviceType(this.#client)
    this.#services.set(serviceType, created)
    return created
  }

  /** 释放连接池——仅当客户端是本容器构造的。 */
  async close(): Promise<void> {
    if (this.#ownsClient) await this.#client.close()
  }
}

/** 服务类型必须是 `BaseService` 的子类（编译期约束，与运行时无关）。 */
export type ServiceClass<T> = new (client: SplunkClient) => T & BaseService

/** 运行时在 `app.locals` 上的键。 */
export const RUNTIME_KEY = 'runtime'

/**
 * 取出挂在本应用上的运行时。
 *
 * @param request 传入请求。
 */
export function runtimeOf(request: {
  app: { locals: Record<string, unknown> }
}): WebRuntime {
  const runtime = request.app.locals[RUNTIME_KEY]
  if (!(runtime instanceof WebRuntime)) {
    throw new Error('WebRuntime is not attached to this application')
  }
  return runtime
}
