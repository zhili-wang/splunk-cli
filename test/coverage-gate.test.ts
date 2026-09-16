/**
 * 覆盖率分档门禁的判定逻辑测试。
 *
 * 这个门禁是 Definition of Done 的一部分，所以它自己出错的代价很高：曾经因为
 * "前端档标成 optional"，只跑后端测试也能全绿；也曾因为用绝对路径匹配 `web/**`
 * 而把全部后端文件算进了前端档。下面把这两类失效都钉死。
 */

import { describe, expect, it } from 'vitest'

import {
  TOTAL_KEY,
  normaliseSummary,
  evaluateTiers,
  type CoverageEntry,
  type CoverageTier,
} from '../scripts/lib/coverage-tiers.mjs'

/** 构造一份 `Map<路径, {statements:{pct}}>`。 */
function report(entries: Record<string, number>, total: number): Map<string, CoverageEntry> {
  const map = new Map<string, CoverageEntry>()
  for (const [path, pct] of Object.entries(entries)) map.set(path, { statements: { pct } })
  map.set(TOTAL_KEY, { statements: { pct: total } })
  return map
}

/** 一个只认固定几份报告的 loader。 */
function loader(reports: Record<string, Map<string, CoverageEntry> | null>) {
  return (path: string): Map<string, CoverageEntry> | null => reports[path] ?? null
}

const BACKEND = 'coverage/coverage-summary.json'
const FRONTEND = 'web/coverage/coverage-summary.json'

const TIERS: CoverageTier[] = [
  { label: '总', summary: BACKEND, pattern: null, min: 88 },
  { label: 'bin', summary: BACKEND, pattern: /^bin\/splunk-cli\.ts$/, min: 88 },
  { label: 'http', summary: BACKEND, pattern: /^server\/client\/http\.ts$/, min: 90 },
  { label: 'web', summary: FRONTEND, pattern: /^web\/src\/.*\.tsx?$/, min: 95 },
]

describe('normaliseSummary', () => {
  it('把 total 放进特殊键，其余键交给归一函数', () => {
    const map = normaliseSummary(
      {
        '/abs/root/bin/splunk-cli.ts': { statements: { pct: 90 } },
        total: { statements: { pct: 91 } },
      },
      (absolute) => absolute.replace('/abs/root/', ''),
    )
    expect(map.get('bin/splunk-cli.ts')).toEqual({ statements: { pct: 90 } })
    expect(map.get(TOTAL_KEY)).toEqual({ statements: { pct: 91 } })
    expect(map.has('total')).toBe(false)
  })

  it('报告缺 total 时兜底成空对象而不是崩', () => {
    const map = normaliseSummary({}, (absolute) => absolute)
    expect(map.get(TOTAL_KEY)).toEqual({})
  })
})

describe('evaluateTiers', () => {
  it('全部达标时零失败', () => {
    const { rows, failed } = evaluateTiers(
      loader({
        [BACKEND]: report(
          { 'bin/splunk-cli.ts': 90, 'server/client/http.ts': 95 },
          92,
        ),
        [FRONTEND]: report({ 'web/src/App.tsx': 99 }, 99),
      }),
      TIERS,
    )
    expect(failed).toBe(0)
    expect(rows.map((row) => row.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS'])
  })

  it('报告缺失即失败 —— 前端档不允许"没跑就算过"', () => {
    const { rows, failed } = evaluateTiers(
      loader({
        [BACKEND]: report({ 'bin/splunk-cli.ts': 90, 'server/client/http.ts': 95 }, 92),
      }),
      TIERS,
    )
    expect(failed).toBe(1)
    const web = rows.find((row) => row.label === 'web')
    expect(web?.status).toBe('MISSING')
    expect(web?.pct).toBeNull()
  })

  it('报告存在但没有任何文件匹配该档时也判失败（路径归一写错不能静默通过）', () => {
    const { rows, failed } = evaluateTiers(
      loader({
        [BACKEND]: report({ 'bin/splunk-cli.ts': 90, 'server/client/http.ts': 95 }, 92),
        // 前端报告里的键仍然是绝对路径 —— 归一函数有 bug 时的症状。
        [FRONTEND]: report({ '/abs/web/src/App.tsx': 99 }, 99),
      }),
      TIERS,
    )
    expect(failed).toBe(1)
    expect(rows.find((row) => row.label === 'web')?.status).toBe('MISSING')
  })

  it('低于门槛判 FAIL，并如实报出百分数', () => {
    const { rows, failed } = evaluateTiers(
      loader({
        [BACKEND]: report({ 'bin/splunk-cli.ts': 87, 'server/client/http.ts': 95 }, 92),
        [FRONTEND]: report({ 'web/src/App.tsx': 99 }, 99),
      }),
      TIERS,
    )
    expect(failed).toBe(1)
    const bin = rows.find((row) => row.label === 'bin')
    expect(bin?.status).toBe('FAIL')
    expect(bin?.pct).toBe(87)
  })

  it('多文件档取算术平均，而不是让一个小文件的高覆盖掩盖大文件的低覆盖', () => {
    const { rows } = evaluateTiers(
      loader({
        [BACKEND]: report({ 'bin/splunk-cli.ts': 90, 'server/client/http.ts': 95 }, 92),
        [FRONTEND]: report(
          { 'web/src/huge.tsx': 10, 'web/src/tiny.tsx': 100, 'web/src/mid.tsx': 100 },
          70,
        ),
      }),
      TIERS,
    )
    const web = rows.find((row) => row.label === 'web')
    // (10 + 100 + 100) / 3 = 70 —— 若改成按行加权或取最大值，这里就会静默变绿。
    expect(web?.pct).toBeCloseTo(70, 6)
    expect(web?.status).toBe('FAIL')
    expect(web?.files).toBe(3)
  })

  it('同一份报告被多档引用时只读一次', () => {
    let reads = 0
    const load = (path: string) => {
      reads += 1
      return path === BACKEND
        ? report({ 'bin/splunk-cli.ts': 90, 'server/client/http.ts': 95 }, 92)
        : report({ 'web/src/App.tsx': 99 }, 99)
    }
    evaluateTiers(load, TIERS)
    expect(reads).toBe(2)
  })

  it('总体档取报告自带的 total，不是各文件平均', () => {
    const { rows } = evaluateTiers(
      loader({
        // 两个文件平均 60，但 total 是 92（按行加权）。总体档必须用 92。
        [BACKEND]: report({ 'bin/splunk-cli.ts': 20, 'server/client/http.ts': 100 }, 92),
        [FRONTEND]: report({ 'web/src/App.tsx': 99 }, 99),
      }),
      TIERS,
    )
    const total = rows.find((row) => row.label === '总')
    expect(total?.pct).toBe(92)
    expect(total?.status).toBe('PASS')
    expect(total?.files).toBe(2)
  })
})
