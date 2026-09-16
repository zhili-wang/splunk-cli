/**
 * 版本号的单一来源 —— 从 `package.json` 读取，读不到时降级为 `0.0.0`。
 *
 * 为什么不硬编码：把版本号写死会变成陈旧常量——`--version` 与 User-Agent 一旦
 * 和包版本脱节，排查时就分不清对方装的到底是哪一版。
 * 这里从包元数据读取，并在两个运行形态下都能命中：
 *   - 源码形态：`server/version.ts` → `../package.json`
 *   - 打包形态：`dist/bin/splunk-cli.mjs` → `../../package.json`
 * 读取失败不抛错：版本号不该让命令失败。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]
    for (const candidate of candidates) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'))
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof (parsed as { version?: unknown }).version === 'string' &&
          (parsed as { version: string }).version !== ''
        ) {
          return (parsed as { version: string }).version
        }
      } catch {
        // 试下一个候选路径
      }
    }
  } catch {
    // 落入下面的兜底
  }
  return '0.0.0'
}

/** 当前包版本。 */
export const VERSION: string = readPackageVersion()

/** 发往 Splunk 的 User-Agent。 */
export const USER_AGENT = `splunk-cli/${VERSION} (+read-only)`
