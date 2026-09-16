#!/usr/bin/env node
/**
 * 打包脚本。
 *
 * 流程：
 *   1. 调用 `scripts/build.mjs`：esbuild 把 `bin/splunk-cli.ts` 连同我们自己的全部
 *      代码打成**单个压缩文件** `dist/bin/splunk-cli.mjs`，Vite 把前端构建到 `dist/web`；
 *   2. 把构建产物 + `package.json` + `README.md` 组装到 staging 目录 `pack/splunk-cli/`；
 *   3. 生成 tgz（`npm install -g` 直接安装）并把 tgz 放进分发目录 `splunk-cli/`，
 *      再把分发目录整体压成版本化 zip 放到 `releases/`。
 *
 * 分发安全：
 *   - staging 只从 `dist/` 取产物，**从不复制 `server/`、`bin/` 的 `.ts` 源码**
 *     ——源码已被内联压缩进单文件 bundle，解包后无法还原可读实现；
 *   - `sanitizePackageJson()` 删掉 `scripts` 与 `devDependencies`，
 *     安装包不携带构建链（也就不会把 `esbuild` / `vitest` 带给用户）；
 *   - `assertArchiveClean()` 在归档前逐条检查，源码 / source map / 凭据一旦混入
 *     就直接让打包失败，而不是"相信复制逻辑"。
 *
 * 可复现构建：归档由 `scripts/lib/archive.mjs` 在进程内写出，条目顺序按路径排序、
 * 所有 mtime 固定为常量、gzip 头不带时间戳，因此同样的 `dist/` 必然产出同样的字节。
 * 用 `--verify-reproducible` 自证：**完整打包两次**（含重新构建）并比对 sha256。
 *
 * 用法：
 *   node scripts/package.mjs                        # 常规打包
 *   node scripts/package.mjs --skip-build           # 复用已有 dist/（仅调试）
 *   node scripts/package.mjs --verify-reproducible  # 打包两次比对哈希（CI 门禁）
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ZIP_EPOCH_SECONDS, createTarGz, createZip } from './lib/archive.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')
/** staging 目录：归档内容就是它下面的 `splunk-cli/`。 */
const PACK_DIR = join(ROOT, 'pack')
const STAGING = join(PACK_DIR, 'splunk-cli')
/** 本地分发目录：指南文档在此维护并提交 Git，安装包是构建产物（不提交）。 */
const DIST_DIR = join(ROOT, 'splunk-cli')
/** 历史版本 zip 的归档目录（每次打包一个，全部保留，不提交）。 */
const RELEASES_DIR = join(ROOT, 'releases')

/** 从 `dist/` 复制的构建产物。 */
const DIST_ITEMS = ['bin', 'web']
/** 从仓库根复制的静态资源。 */
const STATIC_ITEMS = ['package.json', 'README.md']

/** 归档内 tgz 的固定文件名（不带版本号，方便脚本与文档引用）。 */
const TARBALL_NAME = 'splunk-cli.tgz'

/**
 * 归档内所有条目的固定 mtime —— 取常量而非"当前时间"，否则每次打包哈希都不同。
 * 默认 1980-01-01T00:00:00Z：ZIP 的 DOS 时间戳能表达的最早时刻，也是 zip 工具的惯例。
 * 可用 `SOURCE_DATE_EPOCH`（可复现构建的通用约定）覆盖。
 */
const FIXED_MTIME = process.env.SOURCE_DATE_EPOCH
  ? Number(process.env.SOURCE_DATE_EPOCH)
  : ZIP_EPOCH_SECONDS

const args = new Set(process.argv.slice(2))
const SKIP_BUILD = args.has('--skip-build')
const VERIFY_REPRODUCIBLE = args.has('--verify-reproducible')
if (SKIP_BUILD && VERIFY_REPRODUCIBLE) {
  throw new Error('--skip-build 与 --verify-reproducible 互斥：复现性验证必须重新构建')
}

/** 按路径排序地递归收集目录树，产出归档条目（目录 + 文件，前序）。 */
function collectEntries(baseDir, { mtime = FIXED_MTIME } = {}) {
  const entries = []
  const walk = (dir) => {
    const children = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
    for (const child of children) {
      const full = join(dir, child.name)
      // 归档内路径一律用 `/`，Windows 上生成的包也必须可跨平台解压。
      const path = relative(baseDir, full).split(sep).join('/')
      if (child.isDirectory()) {
        entries.push({ path: `${path}/`, type: 'directory', mtime })
        walk(full)
      } else {
        entries.push({ path, type: 'file', data: readFileSync(full), mtime })
      }
    }
  }
  walk(baseDir)
  return entries
}

/** 调用 build.mjs。打包永远从干净构建开始，避免复用陈旧产物。 */
function runBuild() {
  console.log('[pack] 1/3 执行 esbuild + Vite 构建...')
  execFileSync(process.execPath, [join('scripts', 'build.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
}

/** 清理并重建 staging 目录。 */
function cleanStaging() {
  rmSync(STAGING, { recursive: true, force: true })
  mkdirSync(STAGING, { recursive: true })
}

/** 把构建产物与静态资源复制到 staging。 */
function copyToStaging() {
  for (const name of DIST_ITEMS) {
    const source = join(DIST, name)
    if (!existsSync(source)) {
      throw new Error(`构建产物缺失: ${source}，请先执行 build`)
    }
    cpSync(source, join(STAGING, name), { recursive: true })
  }
  for (const name of STATIC_ITEMS) {
    const source = join(ROOT, name)
    if (!existsSync(source)) {
      throw new Error(`分发资源缺失: ${source}`)
    }
    cpSync(source, join(STAGING, name), { recursive: true })
  }
}

/**
 * 精简 staging 里的 `package.json`：只保留运行必需字段。
 *
 * `bin` 必须保留（`npm install -g` 靠它注册可执行命令），`dependencies` 必须保留
 * （bundle 把 express / compression / undici 标为 external，由目标机 npm 解析）。
 *
 * 三个字段要特别处理：
 *   - `private` 删掉：它在仓库根的作用是**禁止误发**（根目录直接 `npm publish`
 *     会把 `.ts` 源码一起发出去），但安装包本身不该自称 private；
 *   - `scripts` / `devDependencies` 删掉：安装包不携带构建链；
 *   - `files` 改写成 staging 的真实布局：它只影响"再次打包"，照抄根目录那份
 *     （含 `server/`、`dist/`）会让产物自相矛盾。
 */
function sanitizePackageJson() {
  const path = join(STAGING, 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  delete pkg.scripts
  delete pkg.devDependencies
  delete pkg.private
  pkg.files = ['bin/', 'web/', 'README.md']
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`[pack] package.json 已精简为: ${Object.keys(pkg).join(', ')}`)
}

/**
 * 归档里绝不能出现的东西 —— 出现即打包失败。
 *
 * 这里刻意只列**结构性**禁项。它是一条兜底断言，不是审查替代品：
 * staging 只从 `dist/` 取产物，所以真正的保证来自"不复制源码"这个动作本身。
 */
const FORBIDDEN_IN_ARCHIVE = [
  { label: '可读源码', test: (name) => /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) },
  { label: 'source map', test: (name) => /\.map$/.test(name) },
  { label: '凭据 / 本地配置', test: (name) => /(^|\/)(\.env|config\.env|\.env\.\w+)$/.test(name) },
  { label: '测试夹具', test: (name) => /(^|\/)(fixtures|__tests__)(\/|$)/.test(name) },
  { label: '构建缓存', test: (name) => /(^|\/)(node_modules|\.cache|coverage)(\/|$)/.test(name) },
]

/** 校验 staging 内容：分发物里不允许有源码、map、凭据、夹具。 */
function assertArchiveClean() {
  const pkg = JSON.parse(readFileSync(join(STAGING, 'package.json'), 'utf8'))
  if (pkg.scripts !== undefined || pkg.devDependencies !== undefined) {
    throw new Error('package.json 精简失败：scripts / devDependencies 仍在')
  }
  if (pkg.private !== undefined) {
    throw new Error('package.json 精简失败：private 仍在（安装包不该自称 private）')
  }
  if (pkg.version === undefined || pkg.bin === undefined) {
    throw new Error('package.json 精简过头：version 或 bin 缺失，安装后无法注册命令')
  }
  if (
    !Array.isArray(pkg.files) ||
    pkg.files.length !== 3 ||
    !pkg.files.includes('bin/') ||
    !pkg.files.includes('web/')
  ) {
    throw new Error(`package.json 的 files 未改写成 staging 布局: ${JSON.stringify(pkg.files)}`)
  }

  const offenders = []
  for (const entry of collectEntries(STAGING)) {
    for (const rule of FORBIDDEN_IN_ARCHIVE) {
      if (rule.test(entry.path)) offenders.push(`${entry.path}（${rule.label}）`)
    }
  }
  if (offenders.length > 0) {
    throw new Error(`分发物含不应分发的文件:\n  - ${offenders.join('\n  - ')}`)
  }
  console.log('[pack] 分发物检查通过：无源码、无 source map、无凭据、无夹具')
}

/**
 * 生成 tgz。
 *
 * 归档内路径带 `splunk-cli/` 前缀，解包后就是一个可直接 `npm install -g` 的包目录。
 */
function createTarball(outPath) {
  mkdirSync(dirname(outPath), { recursive: true })
  const entries = collectEntries(STAGING).map((entry) => ({
    ...entry,
    path: `splunk-cli/${entry.path}`,
  }))
  writeFileSync(outPath, createTarGz(entries))
  return outPath
}

/** 把 tgz 放进分发目录，并清掉旧版安装包（分发目录只保留最新一个）。 */
function copyToDistDir(tarball) {
  mkdirSync(DIST_DIR, { recursive: true })
  for (const entry of readdirSync(DIST_DIR)) {
    if (/\.tgz$/.test(entry) && entry !== TARBALL_NAME) rmSync(join(DIST_DIR, entry), { force: true })
  }
  const target = join(DIST_DIR, TARBALL_NAME)
  cpSync(tarball, target, { force: true })
  return target
}

/**
 * 把分发目录整体压成版本化 zip。
 *
 * 目录条目一并写入，解压后得到完整的 `splunk-cli/` 目录（含指南文档与安装包）。
 */
function createZipArchive(version) {
  mkdirSync(RELEASES_DIR, { recursive: true })
  const zipPath = join(RELEASES_DIR, `splunk-cli-v${version}.zip`)
  const entries = collectEntries(DIST_DIR).map((entry) => ({
    ...entry,
    path: `splunk-cli/${entry.path}`,
  }))
  writeFileSync(zipPath, createZip(entries))
  return zipPath
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 完整打包一次，返回产物路径与哈希。 */
function packOnce() {
  if (!SKIP_BUILD) runBuild()

  console.log('[pack] 2/3 组装分发目录...')
  cleanStaging()
  copyToStaging()
  sanitizePackageJson()
  assertArchiveClean()

  console.log('[pack] 3/3 生成分发包...')
  const tarball = createTarball(join(PACK_DIR, TARBALL_NAME))
  const published = copyToDistDir(tarball)
  const { version } = JSON.parse(readFileSync(join(STAGING, 'package.json'), 'utf8'))
  const zip = createZipArchive(version)

  return {
    tarball,
    published,
    zip,
    version,
    hashes: { tgz: sha256(tarball), zip: sha256(zip) },
  }
}

/**
 * 自证可复现：完整跑两次（各自重新构建）并比对 sha256。
 *
 * 因为第二次是从干净 `dist/` 重建的，这一条同时验证了两件事：esbuild / Vite 的内容
 * 确定性，以及归档元数据的确定性。只比对最终产物，避免"比了中间态"的假阳性。
 */
function verifyReproducible() {
  console.log('[pack] 复现性验证：第 1 次打包...')
  const first = packOnce()

  console.log('\n[pack] 复现性验证：第 2 次打包（含重新构建）...')
  const second = packOnce()

  console.log('\n[pack] 复现性比对:')
  let mismatch = 0
  for (const label of ['tgz', 'zip']) {
    const a = first.hashes[label]
    const b = second.hashes[label]
    const ok = a === b
    if (!ok) mismatch += 1
    console.log(`  [${ok ? 'OK  ' : 'DIFF'}] ${label}  ${a.slice(0, 16)}…  ${b.slice(0, 16)}…`)
  }
  if (mismatch > 0) {
    throw new Error(`可复现性验证失败：${mismatch} 个产物两次哈希不同`)
  }
  console.log('[pack] 可复现性验证通过：两次打包字节一致')
  return second
}

function report({ tarball, published, zip, version, hashes }) {
  console.log('\n[pack] 打包完成:')
  console.log(`  - 安装包: ${relative(ROOT, tarball)}`)
  console.log(`  - 已复制到分发目录: ${relative(ROOT, published)}`)
  console.log(`  - 分发包 zip: ${relative(ROOT, zip)}`)
  console.log(`  - 版本: ${version}`)
  console.log(`  - sha256(tgz): ${hashes.tgz}`)
  console.log(`  - sha256(zip): ${hashes.zip}`)
  console.log('\n[pack] 已排除: server/**/*.ts、bin/*.ts、source map、.env、node_modules、测试夹具')
  console.log('[pack] 源码已压缩内联进单文件 bundle，解包后无法还原可读实现。')
  console.log('\n安装方式:')
  console.log(`  npm install -g ./splunk-cli/${TARBALL_NAME}`)
}

try {
  report(VERIFY_REPRODUCIBLE ? verifyReproducible() : packOnce())
} catch (error) {
  console.error(`[pack] 打包失败: ${error.message}`)
  process.exit(1)
}
