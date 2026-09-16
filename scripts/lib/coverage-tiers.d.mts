/**
 * `scripts/lib/coverage-tiers.mjs` 的类型声明。
 *
 * 与归档写入器同样的理由：判定逻辑写成 `.mjs`（构建工具），但它的行为必须被测到，
 * 所以补一份手写声明让 strict 模式下的测试文件能 import。
 */

/** coverage-summary 里单个文件的条目。 */
export interface CoverageEntry {
  statements?: { pct?: number }
}

/** 归一化后的报告：仓库相对路径（或 `__total__`）→ 条目。 */
export type NormalisedSummary = Map<string, CoverageEntry>

/** 一个分档门槛。 */
export interface CoverageTier {
  label: string
  /** 相对仓库根的覆盖率报告路径。 */
  summary: string
  /** 匹配仓库相对路径；`null` 表示取整份报告的 total。 */
  pattern: RegExp | null
  min: number
}

/** 判定结果的一行。 */
export interface CoverageRow extends CoverageTier {
  status: 'PASS' | 'FAIL' | 'MISSING'
  pct: number | null
  files: number
}

/** 代表"整份报告"的特殊键。 */
export declare const TOTAL_KEY: string

/** Q10 的分档门槛。 */
export declare const TIERS: CoverageTier[]

/** 把一份覆盖率报告归一成 `Map<仓库相对路径, 条目>`。 */
export declare function normaliseSummary(
  summary: Record<string, CoverageEntry | unknown>,
  toRelativeRepoPath: (absolutePath: string) => string,
): NormalisedSummary

/** 逐档判定。 */
export declare function evaluateTiers(
  loadSummary: (relativePath: string) => NormalisedSummary | null,
  tiers?: CoverageTier[],
): { rows: CoverageRow[]; failed: number }
