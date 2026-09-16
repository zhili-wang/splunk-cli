#!/usr/bin/env node
/**
 * 构建脚本。
 *
 * 做什么：
 *   - `bin/splunk-cli.ts` → `dist/bin/splunk-cli.mjs`（单文件，内联我们自己的代码）；
 *   - `minify: true` + **不产出 source map**：压缩单文件解包后无法还原可读源码，
 *     起到源码保护作用（"只发编译产物、不发可读源码"）。
 *
 * 运行时依赖标记为 external，由目标机 `npm install` 按平台解析——"产物只带本项目代码，
 * 第三方依赖交给目标机安装"。
 *
 * 本脚本自身保留 `.mjs`（构建工具，不是业务代码），用 node 直接执行。
 */

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')

/** 运行时外部依赖，不打进 bundle（由目标机 npm install 解析）。 */
const EXTERNAL = ['express', 'compression', 'undici']

const ESBUILD_OPTS = {
  bundle: true,
  minify: true,
  // 不生成 source map：避免 .map 随包分发，否则解包者能拿到"压缩前"对照表。
  sourcemap: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: EXTERNAL,
  legalComments: 'none',
  banner: {
    // shebang 必须是文件第一行；createRequire 让内联进来的 CJS 依赖仍能 require。
    js:
      '#!/usr/bin/env node\n' +
      "import { createRequire as __splunkCliRequire } from 'module';\n" +
      'const require = __splunkCliRequire(import.meta.url);',
  },
}

async function bundleCli() {
  await build({
    ...ESBUILD_OPTS,
    entryPoints: [join(ROOT, 'bin', 'splunk-cli.ts')],
    outfile: join(DIST, 'bin', 'splunk-cli.mjs'),
  })
}

/**
 * 构建前端。
 *
 * 依赖统一装在仓库根（单一 `package.json`），前端没有自己的包清单，因此直接调用
 * 根 `node_modules` 下的 `tsc` 与 `vite`，而不是 `npm run`。先类型检查再构建，
 * 保持与过去 `cd web && npm run build` 相同的严格度。
 */
function buildFrontend() {
  const webDir = join(ROOT, 'web')
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(vite)) {
    console.log('[build] 跳过前端：未安装 vite（先执行 `npm install`）')
    return
  }
  console.log('[build] 类型检查前端...')
  execFileSync(process.execPath, [tsc, '-p', join('web', 'tsconfig.json'), '--noEmit'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  execFileSync(process.execPath, [tsc, '-p', join('web', 'tsconfig.node.json'), '--noEmit'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  console.log('[build] 构建前端...')
  execFileSync(process.execPath, [vite, 'build'], { cwd: webDir, stdio: 'inherit' })
  console.log('[build] 前端构建完成: dist/web')
}

async function main() {
  console.log('[build] 开始构建...')
  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true })
  mkdirSync(join(DIST, 'bin'), { recursive: true })

  await bundleCli()
  console.log('[build] CLI 打包完成: dist/bin/splunk-cli.mjs')

  // 顺序关键：Vite 必须在清空 dist/ 之后、且不自己清空目录（见 web/vite.config.ts）。
  buildFrontend()
}

main().catch((error) => {
  console.error(`[build] 构建失败: ${error.message}`)
  process.exit(1)
})
