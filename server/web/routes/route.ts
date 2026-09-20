/**
 * 路由处理器的异常包装。
 *
 * Express **不会**自动接住 async 处理器里 reject 的 Promise：没有这层包装，一个失败的
 * `await` 会变成未处理的 rejection，而那个请求就永远挂在那里，直到客户端超时。
 * 包一层之后，异常统一交给 `errorHandler`。
 *
 * 抽成独立文件而不是留在 `thin.routes.ts`：它已经不是某一个路由文件的私有工具了。
 * `shutdown.routes.ts` 也要用它，而"路由文件 import 另一个路由文件"是种说不清的耦合
 * —— 别人看 `shutdown.routes.ts` 的 import 会以为它依赖了那五条薄透传路由。
 */

import type { NextFunction, Request, Response } from 'express'

/** 把处理函数包成"异常一定交给统一错误中间件"的形式。 */
export function route(
  handler: (request: Request, response: Response) => Promise<void> | void,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    try {
      const result = handler(request, response)
      if (result instanceof Promise) result.catch(next)
    } catch (error) {
      next(error)
    }
  }
}
