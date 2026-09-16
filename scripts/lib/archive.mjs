/**
 * 零依赖归档写入器 —— tar.gz 与 zip。
 *
 * 为什么不调用系统 `tar` / `gzip` / `zip`：
 *
 *   1. **可移植性**：macOS 自带的是 bsdtar，不认识 `--sort=name`；GNU tar 的
 *      `--mtime` / `--owner=0` 也不在 bsdtar 的稳定子集里。要写出"同一份输入、
 *      任何机器上哈希都一样"的包，就得依赖一堆平台各异的命令行开关。
 *   2. **可复现**：`tar -z` 会把"当前时间"和原始文件名塞进 gzip 头，哈希每次都变；
 *      必须额外记得 `gzip -n`。Node 的 `zlib.gzipSync` 自带头里 mtime 恒为 0，
 *      没有这个坑。
 *   3. **本仓库的既有取向**：`server/logger.ts` 与 `server/errors.ts` 都是零依赖实现，
 *      归档写入器遵循同一取向。
 *
 * 输出格式的兼容性由测试保证（`test/package.test.ts` 会用系统 tar/unzip 解回来比对），
 * 而不是靠"看起来对"。
 */

import { deflateRawSync, gzipSync } from 'node:zlib'

const BLOCK = 512

/** zip 中央目录条目的固定元数据。 */
const ZIP_VERSION_NEEDED = 20
const ZIP_VERSION_MADE_BY = 0x0314 // 高字节 3 = Unix，低字节 20 = 2.0
const ZIP_FLAG_UTF8 = 0x0800

/** DOS 时间戳的合法范围下限（1980-01-01），也是 ZIP 能表达的最早时刻。 */
export const ZIP_EPOCH_SECONDS = 315532800

/** CRC-32（IEEE 802.3）查表。zip 要求它，Node 20 的 `zlib.crc32` 还不可用。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

/** 计算一段字节的 CRC-32。 */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 把八进制数值写进 tar 头的定长字段（尾部 NUL）。 */
function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0')
  if (text.length > length - 1) {
    throw new Error(`tar 字段溢出: ${value} 放不进 ${length - 1} 位八进制`)
  }
  buffer.write(text, offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

/**
 * 把路径拆成 ustar 的 `prefix` / `name` 两段（各 155 / 100 字节）。
 *
 * 只按 `/` 边界切分，且绝不切断任何一段路径：切不出合法组合就直接报错，
 * 而不是悄悄截断（截断会产出解包后路径错误的归档）。
 */
function splitUstarPath(path) {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { prefix: '', name: path }
  const parts = path.split('/')
  for (let split = parts.length - 1; split > 0; split -= 1) {
    const prefix = parts.slice(0, split).join('/')
    const name = parts.slice(split).join('/')
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { prefix, name }
    }
  }
  throw new Error(`路径过长，ustar 无法表达: ${path}`)
}

/** 构造一个 tar 条目头（512 字节，已填好校验和）。 */
function tarHeader(entry) {
  const isDir = entry.type === 'directory'
  const path = isDir && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path
  const { prefix, name } = splitUstarPath(path)

  const header = Buffer.alloc(BLOCK)
  header.write(name, 0, 100, 'utf8')
  writeOctal(header, 100, 8, isDir ? 0o755 : 0o644)
  writeOctal(header, 108, 8, 0) // uid
  writeOctal(header, 116, 8, 0) // gid
  writeOctal(header, 124, 12, isDir ? 0 : entry.data.length)
  writeOctal(header, 136, 12, entry.mtime)
  // 校验和字段先按"8 个空格"参与计算，算完再写回。
  header.fill(0x20, 148, 156)
  header.write(isDir ? '5' : '0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write('root', 265, 32, 'ascii')
  header.write('root', 297, 32, 'ascii')
  header.write(prefix, 345, 155, 'utf8')

  let sum = 0
  for (const byte of header) sum += byte
  const checksum = sum.toString(8).padStart(6, '0')
  header.write(checksum, 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

/** 把 512 字节对齐所需的补零算出。 */
function padding(size) {
  const remainder = size % BLOCK
  return remainder === 0 ? 0 : BLOCK - remainder
}

/**
 * 生成 tar 归档（未压缩）。
 *
 * @param {Array<{path: string, type: 'file'|'directory', data?: Buffer, mtime: number}>} entries
 *   条目顺序即归档顺序 —— 调用方负责排序，本函数不重排，便于测试固定顺序。
 * @returns {Buffer}
 */
export function createTar(entries) {
  const chunks = []
  for (const entry of entries) {
    const data = entry.type === 'directory' ? Buffer.alloc(0) : (entry.data ?? Buffer.alloc(0))
    chunks.push(tarHeader({ ...entry, data }))
    if (data.length > 0) {
      chunks.push(data)
      const pad = padding(data.length)
      if (pad > 0) chunks.push(Buffer.alloc(pad))
    }
  }
  // 归档以两个全零块结束。
  chunks.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(chunks)
}

/**
 * 生成 tar.gz。
 *
 * `zlib.gzipSync` 的 gzip 头里 mtime 恒为 0、不写原始文件名，因此只要 tar 部分确定，
 * 输出就确定。（这正是不用 `tar -z` 的原因。）
 */
export function createTarGz(entries, { level = 9 } = {}) {
  return gzipSync(createTar(entries), { level })
}

/** 把 Unix 秒转换成 zip 的 DOS 时间 / 日期对（按 UTC，避免时区影响哈希）。 */
function dosDateTime(unixSeconds) {
  const date = new Date(Math.max(unixSeconds, ZIP_EPOCH_SECONDS) * 1000)
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1)
  const day =
    ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  return { time, day }
}

/**
 * 生成 zip 归档。
 *
 * 目录条目也写进去（外部属性标记成 `drwxr-xr-x` + 目录位），这样用 Windows 资源管理器
 * 解压时目录结构完整 —— 只写文件条目虽然 unzip 能还原，但部分图形工具会拍平。
 *
 * @param {Array<{path: string, type: 'file'|'directory', data?: Buffer, mtime: number, mode?: number}>} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const localChunks = []
  const centralChunks = []
  let offset = 0

  for (const entry of entries) {
    const isDir = entry.type === 'directory'
    const raw = isDir ? Buffer.alloc(0) : (entry.data ?? Buffer.alloc(0))
    const nameBytes = Buffer.from(entry.path, 'utf8')
    const { time, day } = dosDateTime(entry.mtime)
    // 目录压缩没有意义，直接 store；文件一律 deflate。
    const method = isDir || raw.length === 0 ? 0 : 8
    const compressed = method === 8 ? deflateRawSync(raw, { level: 9 }) : raw
    const checksum = isDir || raw.length === 0 ? 0 : crc32(raw)
    // 0o100644 普通文件 / 0o040755 目录，左移到高 16 位是 Unix 外部属性约定。
    const unixMode = entry.mode ?? (isDir ? 0o040755 : 0o100644)
    const externalAttributes = ((unixMode << 16) | (isDir ? 0x10 : 0)) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(ZIP_VERSION_NEEDED, 4)
    local.writeUInt16LE(ZIP_FLAG_UTF8, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra length

    localChunks.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(ZIP_VERSION_MADE_BY, 4)
    central.writeUInt16LE(ZIP_VERSION_NEEDED, 6)
    central.writeUInt16LE(ZIP_FLAG_UTF8, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(externalAttributes, 38)
    central.writeUInt32LE(offset, 42)

    centralChunks.push(central, nameBytes)
    offset += local.length + nameBytes.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralChunks)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // this disk
  end.writeUInt16LE(0, 6) // disk with central directory
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localChunks, centralDirectory, end])
}
