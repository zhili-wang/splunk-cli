#!/usr/bin/env node
/**
 * 覆盖率门禁（Q10 已决策的分档门槛）。
 *
 * 为什么要有这个脚本，而不是把阈值写进 vitest 配置：
 *   - 阈值写进 vitest 会让**任何**单文件未达标时整个测试套件失败，错误信息也只说
 *     "coverage threshold not met"，看不清是哪一档、差多少；
 *   - 门槛是**分档**的（后端总体 / CLI / HTTP / 前端），需要逐档报告。
 *     这些判定逻辑值得显式、可读、可单独运行。
 *
 * 两份报告：后端由根 vitest 产出 `coverage/coverage-summary.json`，前端由在 `web/`
 * 目录下运行的 vitest 产出 `web/coverage/coverage-summary.json`（依赖统一装在仓库根，
 * 前端没有自己的 package.json）。缺任何一份都判 MISSING
 * 并失败——避免"只跑了后端测试就以为门禁通过"。
 *
 * 判定逻辑在 `scripts/lib/coverage-tiers.mjs`（可单独测试）；本文件只负责读文件与打印。
 *
 * 用法（一条命令跑完两份报告再做判定）：
 *   npm run test:coverage
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normaliseSummary, evaluateTiers } from './lib/coverage-tiers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * 读取一份覆盖率报告并归一化路径。
 *
 * @param {string} relativePath 相对仓库根的报告路径。
 * @returns {Map<string, {statements?: {pct?: number}}> | null} 报告不存在时为 null。
 */
function loadSummary(relativePath) {
  const path = join(ROOT, relativePath)
  if (!existsSync(path)) return null
  return normaliseSummary(JSON.parse(readFileSync(path, 'utf8')), (absolute) =>
    relative(ROOT, absolute).split(sep).join('/'),
  )
}

function main() {
  const { rows, failed } = evaluateTiers(loadSummary)

  process.stdout.write('[coverage] Q10 分档门禁（statements）\n')
  for (const row of rows) {
    const pct = row.pct === null ? '  —  ' : `${row.pct.toFixed(2)}%`
    const detail = row.files > 0 ? `  (${row.files} 个文件)` : ''
    process.stdout.write(
      `  [${row.status.padEnd(7)}] ${row.label.padEnd(24)} ${pct.padStart(7)} / 门槛 ${String(row.min).padStart(3)}%${detail}\n`,
    )
    if (row.status === 'MISSING') {
      process.stdout.write(`            缺少报告: ${row.summary}\n`)
    }
  }

  if (failed > 0) {
    process.stdout.write(`\n[coverage] ${failed} 档未达标（或报告缺失）。完整跑法: npm run test:coverage\n`)
    return 1
  }
  process.stdout.write('\n[coverage] 全部档位达标\n')
  return 0
}

process.exit(main())
