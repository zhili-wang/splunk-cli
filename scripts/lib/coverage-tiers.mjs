/**
 * 覆盖率分档门禁的判定逻辑。
 *
 * 与 `check-coverage.mjs` 分开的理由：判定逻辑需要被测试。脚本本身在 import 时就会
 * `process.exit()`，没法直接喂给它构造好的覆盖率报告；把纯逻辑抽到这里之后，
 * "报告缺失要不要判失败""路径怎么归一""平均还是总量"这些容易出错的地方都能被断言。
 *
 * 这里刻意不碰文件系统：调用方传入一个 `loadSummary(relativePath)` 函数。
 */

/**
 * Q10 决策的分档门槛。`summary` 是相对仓库根的覆盖率报告路径。
 *
 * ⚠ 模式匹配的是**仓库相对路径**（`bin/splunk-cli.ts`、`web/src/App.tsx`），不是
 * coverage-summary 里的绝对路径。踩过的坑：用绝对路径匹配 `web/**` 时，因为仓库位于
 * `~/Desktop/web/UData/splunk-cli/`，路径里本来就含 `/web/`，于是"前端档"把**全部
 * 后端文件**都算了进去——门槛看着达标，测的却是另一批文件。
 */
export const TIERS = [
  { label: '后端总体', summary: 'coverage/coverage-summary.json', pattern: null, min: 88 },
  {
    label: 'bin/splunk-cli.ts',
    summary: 'coverage/coverage-summary.json',
    pattern: /^bin\/splunk-cli\.ts$/,
    min: 88,
  },
  {
    label: 'server/client/http.ts',
    summary: 'coverage/coverage-summary.json',
    pattern: /^server\/client\/http\.ts$/,
    min: 90,
  },
  {
    label: 'web/src/**（前端）',
    summary: 'web/coverage/coverage-summary.json',
    pattern: /^web\/src\/.*\.tsx?$/,
    min: 95,
  },
]

/** 报告里代表"整份报告"的特殊键（不是真实文件）。 */
export const TOTAL_KEY = '__total__'

/**
 * 把一份覆盖率报告归一成 `Map<仓库相对路径, 条目>`，并把 `total` 放进 `__total__`。
 *
 * @param {Record<string, {statements?: {pct?: number}}>} summary 解析后的 json-summary。
 * @param {(absolutePath: string) => string} toRelativeRepoPath 绝对路径 → 仓库相对路径（POSIX 分隔符）。
 * @returns {Map<string, {statements?: {pct?: number}}>}
 */
export function normaliseSummary(summary, toRelativeRepoPath) {
  const entries = new Map()
  for (const [key, data] of Object.entries(summary)) {
    if (key === 'total') continue
    entries.set(toRelativeRepoPath(key), data)
  }
  entries.set(TOTAL_KEY, summary.total ?? {})
  return entries
}

/**
 * 逐档判定。
 *
 * 规则：
 *   - 报告缺失 → 该档 `MISSING` 并计为失败。**故意不设"可选档"**：曾经前端档标了
 *     optional，结果是"只跑了后端测试"也能全绿，门禁等于形同虚设。
 *   - 报告存在但没有文件匹配该档 → `MISSING` 并失败。这通常意味着路径归一写错了，
 *     让它静默通过就等于把门禁关掉。
 *   - 多文件档取各文件 statements 百分比的**算术平均**，与"总体"档取报告自带的
 *     total 不同：平均能防止一个超小文件的高覆盖掩盖一个大文件的低覆盖。
 *
 * @param {(relativePath: string) => Map<string, {statements?: {pct?: number}}> | null} loadSummary
 * @returns {{rows: Array<Record<string, unknown>>, failed: number}}
 */
export function evaluateTiers(loadSummary, tiers = TIERS) {
  const cache = new Map()
  const rows = []
  let failed = 0

  for (const tier of tiers) {
    if (!cache.has(tier.summary)) cache.set(tier.summary, loadSummary(tier.summary))
    const summary = cache.get(tier.summary)

    if (summary === null || summary === undefined) {
      rows.push({ ...tier, status: 'MISSING', pct: null, files: 0 })
      failed += 1
      continue
    }

    let pct
    let files
    if (tier.pattern === null) {
      pct = summary.get(TOTAL_KEY)?.statements?.pct ?? 0
      files = summary.size - 1
    } else {
      const matched = [...summary.entries()].filter(
        ([file]) => file !== TOTAL_KEY && tier.pattern.test(file),
      )
      files = matched.length
      if (files === 0) {
        rows.push({ ...tier, status: 'MISSING', pct: null, files: 0 })
        failed += 1
        continue
      }
      pct =
        matched.reduce((sum, [, data]) => sum + (data.statements?.pct ?? 0), 0) / matched.length
    }

    const ok = pct >= tier.min
    if (!ok) failed += 1
    rows.push({ ...tier, status: ok ? 'PASS' : 'FAIL', pct, files })
  }

  return { rows, failed }
}
