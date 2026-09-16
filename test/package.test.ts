/**
 * 归档写入器的测试。
 *
 * 这里刻意**不**断言"输出的字节长得像我以为的样子"，而是交给系统 `tar` / `unzip`
 * 解回来比对内容 —— 自己写的归档格式，只有被独立实现读通才算真的对。同时验证
 * 两次生成的字节完全一致，这是"可复现构建"这条承诺的底层依据。
 *
 * 系统工具缺失时相关用例跳过（而不是假装通过）：`unzip` 不保证每台机器都有。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  ZIP_EPOCH_SECONDS,
  type ArchiveEntry,
  createTar,
  createTarGz,
  createZip,
  crc32,
} from '../scripts/lib/archive.mjs'

/** 固定 mtime：所有用例都用它，确保归档可复现。 */
const MTIME = ZIP_EPOCH_SECONDS

const workDir = mkdtempSync(join(tmpdir(), 'splunk-cli-archive-'))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** 判断某个可执行文件是否存在。 */
function hasCommand(command: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HAS_TAR = hasCommand('tar')
const HAS_UNZIP = hasCommand('unzip')

/** 一组代表性条目：目录、文件、空文件、以及一个超过 100 字节的深路径。 */
function sampleEntries(): ArchiveEntry[] {
  const longPath =
    'splunk-cli/web/assets/very/deeply/nested/directory/structure/for/testing/the/ustar/prefix/field/index-4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f.js'
  return [
    { path: 'splunk-cli/', type: 'directory', mtime: MTIME },
    { path: 'splunk-cli/package.json', type: 'file', data: Buffer.from('{"a":1}\n'), mtime: MTIME },
    { path: 'splunk-cli/empty.txt', type: 'file', data: Buffer.from(''), mtime: MTIME },
    { path: 'splunk-cli/bin/', type: 'directory', mtime: MTIME },
    {
      path: 'splunk-cli/bin/splunk-cli.mjs',
      type: 'file',
      data: Buffer.from('#!/usr/bin/env node\nconsole.log("hi")\n'),
      mtime: MTIME,
    },
    { path: longPath, type: 'file', data: Buffer.from('long\n'), mtime: MTIME },
  ]
}

describe('crc32', () => {
  it('匹配 IEEE 802.3 的标准测试向量', () => {
    // "123456789" → 0xCBF43926 是 CRC-32 最通用的公开测试向量。
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  it('空输入为 0', () => {
    expect(crc32(Buffer.from(''))).toBe(0)
  })

  it('对同样的输入稳定，对不同输入敏感', () => {
    expect(crc32(Buffer.from('splunk-cli'))).toBe(crc32(Buffer.from('splunk-cli')))
    expect(crc32(Buffer.from('splunk-cli'))).not.toBe(crc32(Buffer.from('splunk-cli ')))
  })
})

describe('createTarGz', () => {
  it('两次生成字节完全一致（可复现）', () => {
    const a = createTarGz(sampleEntries())
    const b = createTarGz(sampleEntries())
    expect(a.equals(b)).toBe(true)
  })

  it('gzip 头里不写时间戳与原始文件名', () => {
    const gz = createTarGz(sampleEntries())
    // gzip 头固定 10 字节：magic(2) method(1) flags(1) mtime(4) xfl(1) os(1)。
    expect(gz[0]).toBe(0x1f)
    expect(gz[1]).toBe(0x8b)
    expect(gz[2]).toBe(0x08) // deflate
    expect((gz[3] ?? 0) & 0x08).toBe(0) // FNAME 未置位
    expect(gz.readUInt32LE(4)).toBe(0) // MTIME = 0
  })

  it.skipIf(!HAS_TAR)('能被系统 tar 读出全部条目', () => {
    const path = join(workDir, 'sample.tar.gz')
    writeFileSync(path, createTarGz(sampleEntries()))

    const listing = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
      .trim()
      .split('\n')

    expect(listing).toContain('splunk-cli/package.json')
    expect(listing).toContain('splunk-cli/bin/splunk-cli.mjs')
    expect(listing).toContain('splunk-cli/empty.txt')
    // 深路径必须靠 ustar prefix 字段还原成完整路径。
    expect(listing.some((name) => name.endsWith('index-4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f.js'))).toBe(
      true,
    )
  })

  it.skipIf(!HAS_TAR)('解包后内容逐字节一致', () => {
    const path = join(workDir, 'roundtrip.tar.gz')
    const outDir = mkdtempSync(join(workDir, 'tar-out-'))
    writeFileSync(path, createTarGz(sampleEntries()))
    execFileSync('tar', ['-xzf', path, '-C', outDir])

    expect(readFileSync(join(outDir, 'splunk-cli/package.json'), 'utf8')).toBe('{"a":1}\n')
    expect(readFileSync(join(outDir, 'splunk-cli/bin/splunk-cli.mjs'), 'utf8')).toBe(
      '#!/usr/bin/env node\nconsole.log("hi")\n',
    )
    expect(readFileSync(join(outDir, 'splunk-cli/empty.txt'), 'utf8')).toBe('')
  })

  it('归档内所有条目的 mtime 都是固定值', () => {
    // 直接读 tar 头，而不是解析 `tar -tv` 的文字输出：后者各平台列布局不一样
    // （bsdtar 与 GNU tar 的 owner/group 排法就不同），会让测试变成"测 tar 的格式"。
    const tar = createTar(sampleEntries())
    const mtimies: number[] = []
    for (let offset = 0; offset + 512 <= tar.length; ) {
      const header = tar.subarray(offset, offset + 512)
      if (header.every((byte) => byte === 0)) break // 结束块
      const sizeText = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim()
      const timeText = header.toString('ascii', 136, 148).replace(/\0.*$/, '').trim()
      const size = Number.parseInt(sizeText || '0', 8)
      mtimies.push(Number.parseInt(timeText || '0', 8))
      const dataBlocks = Math.ceil(size / 512)
      offset += 512 + dataBlocks * 512
    }
    expect(mtimies.length).toBeGreaterThan(0)
    expect(new Set(mtimies)).toEqual(new Set([MTIME]))
  })

  it('路径过长且无法用 prefix/name 表达时直接报错，而不是截断', () => {
    const absurd = `${'x'.repeat(120)}/${'y'.repeat(120)}/${'z'.repeat(120)}`
    expect(() => createTar([{ path: absurd, type: 'file', data: Buffer.from('x'), mtime: MTIME }])).toThrow(
      /路径过长/,
    )
  })

  it('空条目列表产出只有结束块的合法归档', () => {
    const tar = createTar([])
    expect(tar.length).toBe(1024)
    expect(tar.equals(Buffer.alloc(1024))).toBe(true)
  })
})

describe('createZip', () => {
  it('两次生成字节完全一致（可复现）', () => {
    const a = createZip(sampleEntries())
    const b = createZip(sampleEntries())
    expect(a.equals(b)).toBe(true)
  })

  it('以 EOCD 结束且条目数正确', () => {
    const entries = sampleEntries()
    const zip = createZip(entries)
    const eocdOffset = zip.length - 22
    expect(zip.readUInt32LE(eocdOffset)).toBe(0x06054b50)
    expect(zip.readUInt16LE(eocdOffset + 8)).toBe(entries.length)
    expect(zip.readUInt16LE(eocdOffset + 10)).toBe(entries.length)
  })

  it.skipIf(!HAS_UNZIP)('能通过 unzip 的完整性校验', () => {
    const path = join(workDir, 'sample.zip')
    writeFileSync(path, createZip(sampleEntries()))
    const output = execFileSync('unzip', ['-t', path], { encoding: 'utf8' })
    expect(output).toContain('No errors detected')
  })

  it.skipIf(!HAS_UNZIP)('解包后内容与目录结构一致', () => {
    const path = join(workDir, 'roundtrip.zip')
    const outDir = mkdtempSync(join(workDir, 'zip-out-'))
    writeFileSync(path, createZip(sampleEntries()))
    execFileSync('unzip', ['-q', path, '-d', outDir])

    expect(readFileSync(join(outDir, 'splunk-cli/package.json'), 'utf8')).toBe('{"a":1}\n')
    expect(readFileSync(join(outDir, 'splunk-cli/empty.txt'), 'utf8')).toBe('')
    expect(readFileSync(join(outDir, 'splunk-cli/bin/splunk-cli.mjs'), 'utf8')).toContain('hi')
  })

  it.skipIf(!HAS_UNZIP)('保留空目录（Windows 资源管理器解压后结构完整）', () => {
    const path = join(workDir, 'dirs.zip')
    const outDir = mkdtempSync(join(workDir, 'zip-dirs-'))
    writeFileSync(
      path,
      createZip([
        { path: 'splunk-cli/', type: 'directory', mtime: MTIME },
        { path: 'splunk-cli/only-dir/', type: 'directory', mtime: MTIME },
      ]),
    )
    execFileSync('unzip', ['-q', path, '-d', outDir])
    const listing = execFileSync('sh', ['-c', `cd ${outDir} && find . -type d | sort`], {
      encoding: 'utf8',
    })
    expect(listing).toContain('./splunk-cli/only-dir')
  })

  it('mtime 早于 1980 时钳到 ZIP 纪元，不会写出非法 DOS 时间', () => {
    // DOS 时间戳无法表达 1980 之前；实现必须钳位而不是溢出成垃圾日期。
    const zip = createZip([{ path: 'a.txt', type: 'file', data: Buffer.from('a'), mtime: 0 }])
    const dosTime = zip.readUInt16LE(10)
    const dosDay = zip.readUInt16LE(12)
    expect(dosDay).toBe((1980 - 1980) << 9 | (1 << 5) | 1)
    expect(dosTime).toBe(0)
  })

  it('空文件走 store 且 CRC 为 0', () => {
    const zip = createZip([{ path: 'empty', type: 'file', data: Buffer.from(''), mtime: MTIME }])
    expect(zip.readUInt16LE(8)).toBe(0) // method = store
    expect(zip.readUInt32LE(14)).toBe(0) // crc
    expect(zip.readUInt32LE(18)).toBe(0) // compressed size
  })
})
