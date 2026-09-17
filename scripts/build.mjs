#!/usr/bin/env node
/**
 * 构建脚本。
 *
 * 做什么：
 *   - `bin/splunk-cli.ts` → `dist/bin/splunk-cli.mjs`（单文件，内联我们自己的代码）；
 *   - `minify: true` + **不产出 source map**：压缩单文件解包后无法还原可读源码，
 *     起到源码保护作用（"只发编译产物、不发可读源码"）；
 *   - 剔除 zod 内联进来的 64 种语言包（见 `dropZodLocales`，占 bundle 的 46%）。
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

/**
 * esbuild 插件：把 zod 的全语言包表换成一个空模块。
 *
 * 为什么要这么做：
 *
 *   zod 的 `core/index.js`、`classic/external.js` 里各有一行
 *   `export * as locales from "../locales/index.js"`，而那个 barrel 逐个导入 64 种
 *   语言的错误文案（希伯来语 9.6kb、俄语 7.2kb、泰米尔语 7.0kb……）。这是为了支持
 *   `z.config(z.locales.zhCN)` 这种用法，本项目**一处都没用到**——错误信息是英文的
 *   默认文案，写在 `core/errors.js` 里，与这个 barrel 无关。
 *
 *   带走它们要花 262kb（占 bundle 46%），而 esbuild 摇不掉：`export * as` 会立刻
 *   构造命名空间对象，tree-shaking 看不见"没人读过它的属性"。所以只能换成空模块。
 *
 * 安全性：已逐命令比对过替换前后的输出（含 zod 校验失败路径），逐字节一致。
 * 若将来要用 `z.locales.*`，这里必须同步改回。
 *
 * @returns 插件与命中计数。计数为 0 说明 zod 换了内部路径、这招已失效，调用方据此报错。
 */
function dropZodLocales() {
  const stats = { hits: 0 }
  const plugin = {
    name: 'drop-zod-locales',
    setup(build) {
      build.onResolve({ filter: /locales\/index\.js$/ }, (args) => {
        // filter 匹配的是**未解析的 import 字符串**（zod 写的是 `../locales/index.js`），
        // 不是解析后的绝对路径，所以还要用 importer 确认确实来自 zod，避免误伤同名文件。
        if (!/[\\/]zod[\\/]v4[\\/]/.test(args.importer)) return null
        stats.hits += 1
        return { path: 'zod-locales', namespace: 'zod-locales' }
      })
      build.onLoad({ filter: /.*/, namespace: 'zod-locales' }, () => ({
        contents: 'export {}',
        loader: 'js',
      }))
    },
  }
  return { plugin, stats }
}

async function bundleCli() {
  const zod = dropZodLocales()
  await build({
    ...ESBUILD_OPTS,
    plugins: [zod.plugin],
    entryPoints: [join(ROOT, 'bin', 'splunk-cli.ts')],
    outfile: join(DIST, 'bin', 'splunk-cli.mjs'),
  })
  // 宁可构建失败，也不要悄悄把 260kb 语言包又塞回包里——体积回归是无声的。
  if (zod.stats.hits === 0) {
    throw new Error(
      '未能剔除 zod 语言包：插件没有匹配到任何 locales barrel。' +
        '多半是 zod 升级改了内部路径，请检查 node_modules/zod/v4/*/index.js 里的 locales 导入。',
    )
  }
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
