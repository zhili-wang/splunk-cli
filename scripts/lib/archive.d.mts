/**
 * `scripts/lib/archive.mjs` 的类型声明。
 *
 * 归档写入器刻意写成 `.mjs`（构建工具，不是要发布的服务端代码），因此不在
 * `tsconfig.json` 的 `include` 里。但它的输出格式值得被测试直接断言，
 * 所以这里补一份手写声明，让 `test/package.test.ts` 能在 strict 模式下 import 它。
 *
 * 声明与实现必须同步：实现里新增导出时，这里也要加，否则测试用不到新能力。
 */

/** 一个待归档的条目。 */
export interface ArchiveEntry {
  /** 归档内路径；目录条目以 `/` 结尾。始终使用 `/`，即使是 Windows。 */
  path: string
  type: 'file' | 'directory'
  /** 文件内容；目录条目忽略。 */
  data?: Buffer
  /** Unix 秒。固定值才能产出可复现的归档。 */
  mtime: number
  /** Unix 权限位；省略时文件为 0o644、目录为 0o755。 */
  mode?: number
}

/** ZIP 的 DOS 时间戳能表达的最早时刻（1980-01-01T00:00:00Z）。 */
export declare const ZIP_EPOCH_SECONDS: number

/** 计算 CRC-32（IEEE 802.3）。 */
export declare function crc32(buffer: Buffer): number

/** 生成未压缩的 tar 归档。 */
export declare function createTar(entries: ArchiveEntry[]): Buffer

/** 生成 tar.gz。 */
export declare function createTarGz(
  entries: ArchiveEntry[],
  options?: { level?: number },
): Buffer

/** 生成 zip 归档。 */
export declare function createZip(entries: ArchiveEntry[]): Buffer
