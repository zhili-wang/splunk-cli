/**
 * 由 API 自己的 origin 提供已构建的前端。
 *
 * 同源正是浏览器能直接调用 `/api/...` 的原因：不需要 CORS 规则，页面里也不放凭据
 * ——本来就没有东西可发。
 */

import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import express, { type Express, type NextFunction, type Request, type Response } from 'express'

import { SplunkError, errorPayload } from '../errors'

/** 前端构建产物的候选目录（两种运行形态各一个）。 */
export function webDirCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    // 源码形态：server/web/ → <root>/dist/web
    join(here, '..', '..', 'dist', 'web'),
    // 打包形态：<包根>/bin/splunk-cli.mjs（单文件 bundle）→ <包根>/web
    join(here, '..', 'web'),
  ]
}

/** 找到含 `index.html` 的构建目录；都没有则返回 `null`（= 前端未构建）。 */
export function resolveWebDir(candidates: string[] = webDirCandidates()): string | null {
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return resolve(candidate)
  }
  return null
}

/** 索引文档名。 */
export const INDEX_FILE = 'index.html'

/** API 独占的命名空间。SPA fallback 绝不能占用它。 */
export const API_PREFIX = 'api'

/** 没有前端构建时的状态码。 */
export const HTTP_SERVICE_UNAVAILABLE = 503

/** API 命名空间下未知路径的状态码。 */
export const HTTP_NOT_FOUND = 404

/** 路径存在但方法不对时的状态码。 */
export const HTTP_METHOD_NOT_ALLOWED = 405

/** 尚无前端构建。 */
class FrontendNotBuiltError extends SplunkError {
  override readonly errorType: string = 'FrontendNotBuilt'

  constructor(message: string) {
    super(message)
    this.name = 'FrontendNotBuiltError'
  }
}

/** 说明前端尚未构建，并给出可行做法。 */
function notBuilt(response: Response): void {
  response.status(HTTP_SERVICE_UNAVAILABLE).json(
    errorPayload(
      new FrontendNotBuiltError(
        'the dashboard frontend is not built. From the repo root, run ' +
          '`npm install` once and then `npm run build` to produce dist/web, or ' +
          '`npm run dev:web` for a dev server on http://localhost:5173 ' +
          '(it proxies /api to this server); or use the API directly under /api.',
      ),
    ),
  )
}

/** 路径是否落在 API 命名空间内。 */
export function ownsApiPath(path: string): boolean {
  return path === `/${API_PREFIX}` || path.startsWith(`/${API_PREFIX}/`)
}

/** 已注册的 API 路由（路径 → 允许的方法），用于区分 404 与 405。 */
export const API_ROUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['/api/health', new Set(['GET'])],
  ['/api/search', new Set(['POST'])],
  ['/api/stats', new Set(['POST'])],
  ['/api/timeline', new Set(['POST'])],
  ['/api/alerts', new Set(['GET'])],
  ['/api/overview', new Set(['POST'])],
  ['/api/version', new Set(['GET'])],
  // 不是 Splunk 端点：关的是这个进程自己（见 routes/shutdown.routes.ts）。
  ['/api/shutdown', new Set(['POST'])],
])

/**
 * 挂载 SPA。
 *
 * 必须在所有 API 路由之后注册，这样兜底处理只会看到 API 没有认领的请求。
 *
 * @param app 目标应用。
 * @param webDir 前端构建目录；省略时自动探测（测试可显式注入 `null` 来模拟"未构建"）。
 */
export function installStaticRoutes(app: Express, webDir: string | null = resolveWebDir()): void {
  if (webDir !== null) {
    app.use(
      express.static(webDir, {
        index: false,
        setHeaders: (response, filePath) => {
          // 只对 index.html 关缓存：它引用带哈希的资源，缓存住旧 index 会让页面
          // 一直加载已经删掉的资源。
          if (filePath.endsWith(INDEX_FILE)) {
            response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
            response.setHeader('Pragma', 'no-cache')
            response.setHeader('Expires', '0')
          }
        },
      }),
    )
  }

  app.use((request: Request, response: Response, next: NextFunction) => {
    const path = request.path

    if (ownsApiPath(path)) {
      const allowed = API_ROUTES.get(path)
      if (allowed !== undefined && !allowed.has(request.method)) {
        response.status(HTTP_METHOD_NOT_ALLOWED).json({ detail: 'Method Not Allowed' })
        return
      }
      response.status(HTTP_NOT_FOUND).json({ detail: 'Not Found' })
      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.status(HTTP_METHOD_NOT_ALLOWED).json({ detail: 'Method Not Allowed' })
      return
    }

    if (webDir === null) {
      notBuilt(response)
      return
    }

    // 目录穿越防护：解析后的路径必须仍在构建目录内。
    const candidate = resolve(join(webDir, path))
    const withinBuild = candidate === webDir || candidate.startsWith(webDir + sep)
    if (path !== '/' && withinBuild && existsSync(candidate) && statSync(candidate).isFile()) {
      sendFromWebDir(response, path, webDir)
      return
    }

    const index = join(webDir, INDEX_FILE)
    if (existsSync(index)) {
      response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      sendFromWebDir(response, INDEX_FILE, webDir)
      return
    }

    next()
  })
}

/**
 * 从构建目录发送一个文件。
 *
 * **必须传 `root` 并给相对路径。** 只传绝对路径时，`send` 的 dotfile 检查作用于
 * **整条绝对路径**：只要安装路径里任何一段以 `.` 开头，`/` 就会 404，再被错误中间件
 * 变成 500 `internal error`。`~/.nvm`、`~/.local`、`~/.pnpm`、隐藏的 HOME 全都命中——
 * 也就是说用 nvm 装出来的包，面板首页根本打不开（`/index.html` 反而是好的，因为它走
 * `express.static`，那里 `root` 是传了的）。
 *
 * 传了 `root` 之后，dotfile 检查只看相对路径（`index.html` / `assets/…`），
 * 而目录穿越仍由 `send` 自身与上面的 `withinBuild` 双重拦住。
 */
function sendFromWebDir(response: Response, relativePath: string, webDir: string): void {
  const relative = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath
  response.sendFile(relative, { root: webDir })
}
