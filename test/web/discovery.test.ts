/**
 * 发现要停止的服务。
 *
 * 本套测试的重点全在一个问题上：**凭什么认定某个 pid 是我们的服务？**
 * pid 会被系统回收，端口会被别的程序接管，名册会因为崩溃而变得过时。
 * 因此这里大量构造"名册说有这么个服务，但事实上不是"的场景。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registryFilePath } from '../../server/config/paths'
import { discoverServers, parseProcessList, type VersionProbe } from '../../server/web/discovery'
import type { ServerEntry } from '../../server/web/registry'

let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'splunk-cli-discovery-'))
  env = { SPLUNK_CONFIG_DIR: join(root, 'cfg') }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 写一个名册。pid 用真实存活的值没有意义——本模块根本不看存活性。 */
function name(entries: ServerEntry[]): void {
  const path = registryFilePath(env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, servers: entries }), 'utf8')
}

function entry(pid: number, port: number): ServerEntry {
  return { pid, port, startedAt: '2026-09-20T11:00:00.000Z' }
}

/** 探针：只有列出的端口认识。其余一律否认。 */
function probeKnows(...ports: number[]): VersionProbe {
  return vi.fn(async (port: number): Promise<boolean> => ports.includes(port))
}

/** 进程表：给几行 `ps -eo pid=,args=` 风格的输出。 */
function processes(...lines: string[]): () => string {
  return () => lines.join('\n')
}

const NO_PROCESSES = processes()

describe('名册线索', () => {
  it('报出通过端口确认的服务', async () => {
    name([entry(4242, 8765)])

    const found = await discoverServers({
      env,
      probe: probeKnows(8765),
      readProcessList: NO_PROCESSES,
    })

    expect(found).toEqual([{ pid: 4242, port: 8765, source: 'registry' }])
  })

  it('端口上不是我们的服务时不报——这是 pid 复用唯一的防线', async () => {
    // 名册记的 pid 还活着，但那个 pid 早就被系统回收给了别的程序，
    // 端口也被别的程序占了。照着名册发信号，杀的是用户毫不相干的进程。
    name([entry(4242, 8765)])

    const found = await discoverServers({
      env,
      probe: probeKnows(),
      readProcessList: NO_PROCESSES,
    })

    expect(found).toEqual([])
  })

  it('端口连不上时不报', async () => {
    // 进程崩了但没清名册（kill -9 之后没有机会执行退出清理）。
    name([entry(4242, 8765)])

    const found = await discoverServers({
      env,
      probe: probeKnows(),
      readProcessList: NO_PROCESSES,
    })

    expect(found).toEqual([])
  })

  it('一条坏记录不影响其余条目的处理', async () => {
    name([entry(1111, 8765), entry(4242, 8846)])

    const found = await discoverServers({
      env,
      probe: probeKnows(8846),
      readProcessList: NO_PROCESSES,
    })

    expect(found).toEqual([{ pid: 4242, port: 8846, source: 'registry' }])
  })

  it('名册不存在时返回空列表，而不是抛错', async () => {
    const found = await discoverServers({
      env,
      probe: probeKnows(),
      readProcessList: NO_PROCESSES,
    })

    expect(found).toEqual([])
  })
})

describe('扫描线索', () => {
  it('发现名册之外、仍在监听的 dashboard', async () => {
    // 名册丢了（用户手工删了配置目录、或换了 SPLUNK_CONFIG_DIR），
    // 但进程还开着——扫描是这时唯一能救场的线索。
    const found = await discoverServers({
      env,
      probe: probeKnows(8846),
      readProcessList: processes('  9001 /usr/bin/node /opt/splunk-cli/bin/splunk-cli.mjs dashboard --port 8846'),
    })

    expect(found).toEqual([{ pid: 9001, port: 8846, source: 'scan' }])
  })

  it('只认 dashboard 子命令，不碰别的命令', async () => {
    const probe = probeKnows(8765)

    const found = await discoverServers({
      env,
      probe,
      readProcessList: processes(
        '  9001 /usr/bin/node /opt/splunk-cli/bin/splunk-cli.mjs search index=app',
        '  9002 /usr/bin/node /opt/splunk-cli/bin/splunk-cli.mjs stop-web',
      ),
    })

    expect(found).toEqual([])
    // 连探都不该探：探一个不该停的端口本身就是多余的。
    expect(probe).not.toHaveBeenCalled()
  })

  it('命令行里没有 --port 时按默认端口推断', async () => {
    const found = await discoverServers({
      env,
      probe: probeKnows(8765),
      readProcessList: processes('  9001 node /opt/bin/splunk-cli.mjs dashboard'),
    })

    expect(found).toEqual([{ pid: 9001, port: 8765, source: 'scan' }])
  })

  it('扫描到的候选同样要过端口确认', async () => {
    // 命令行看着像，但那个端口上不是我们的服务（端口已经换主了）。
    const found = await discoverServers({
      env,
      probe: probeKnows(),
      readProcessList: processes('  9001 node /opt/bin/splunk-cli.mjs dashboard --port 8846'),
    })

    expect(found).toEqual([])
  })

  it('名册与扫描指向同一个 pid 时只报一次，采用名册的端口', async () => {
    // 两个端口都"认识"，这样断言才有区分度：若去重失效，pid 9001 会以两条记录
    // 出现（8846 来自扫描推断、8765 来自名册）。名册里的端口是进程自己写的，
    // 可信度高于从命令行推断出来的，所以留下的必须是 8765。
    name([entry(9001, 8765)])

    const found = await discoverServers({
      env,
      probe: probeKnows(8765, 8846),
      readProcessList: processes('  9001 node /opt/bin/splunk-cli.mjs dashboard --port 8846'),
    })

    expect(found).toEqual([{ pid: 9001, port: 8765, source: 'registry' }])
  })

  it('绝不把 stop-web 自己算进候选', async () => {
    // 它自己的命令行也含 `splunk-cli`；把自己停掉会让命令在打印结果前就死掉。
    const found = await discoverServers({
      env,
      probe: probeKnows(8765),
      readProcessList: processes(`  ${process.pid} node /opt/bin/splunk-cli.mjs dashboard`),
    })

    expect(found).toEqual([])
  })

  it('ps 不可用时静默退化到名册线索', async () => {
    name([entry(4242, 8765)])

    const found = await discoverServers({
      env,
      probe: probeKnows(8765),
      readProcessList: () => {
        throw new Error('ps: command not found')
      },
    })

    expect(found).toEqual([{ pid: 4242, port: 8765, source: 'registry' }])
  })

  it('Windows 上不扫描进程，但名册线索照常工作', async () => {
    // 那边没有 `ps -eo pid=,args=`。跳过而不是失败——用户不该因为平台差异
    // 收到一条错误，而名册在 Windows 上完全可用。
    name([entry(4242, 8765)])
    const reader = vi.fn(() => {
      throw new Error('不该被调用')
    })

    const found = await discoverServers({
      env,
      probe: probeKnows(8765),
      readProcessList: reader,
      platform: 'win32',
    })

    expect(found).toEqual([{ pid: 4242, port: 8765, source: 'registry' }])
    expect(reader).not.toHaveBeenCalled()
  })
})

describe('parseProcessList', () => {
  it('解析 pid、端口，并跳过空行与表头', async () => {
    expect(
      parseProcessList(
        [
          '  PID ARGS',
          '',
          '  9001 node /opt/bin/splunk-cli.mjs dashboard --port 8846',
          '  9002 node /opt/bin/splunk-cli.mjs dashboard -p 9000',
          '  9003 node /opt/bin/splunk-cli.mjs dashboard --port=9100',
          '  9004 vim notes.txt',
          '  不是数字 nope',
        ].join('\n'),
      ),
    ).toEqual([
      { pid: 9001, port: 8846 },
      { pid: 9002, port: 9000 },
      { pid: 9003, port: 9100 },
    ])
  })

  it('--port 0 回落到默认端口，不会推断出端口 0', async () => {
    // `--port 0` 是让系统随便挑一个，真实端口不在命令行里。
    // 这种实例靠名册定位；推断成 0 只会去连一个不存在的端口。
    expect(parseProcessList('  9001 node /opt/bin/splunk-cli.mjs dashboard --port 0')).toEqual([
      { pid: 9001, port: 8765 },
    ])
  })
})
