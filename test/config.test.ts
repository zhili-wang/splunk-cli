import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigurationError } from '../server/errors'
import { parseEnvFile, parseDuration, loadSettings } from '../server/config/settings'
import { configDirPath, resolveConfigDir, writableConfigFile } from '../server/config/paths'
import { CONFIG_TEMPLATE } from '../server/config/template'

/**
 * 隔离约定（AGENTS.md §4）：测试必须用 `SPLUNK_CONFIG_DIR` 指向临时目录，
 * **绝不能读写真实的 `~/.splunk-cli`**。这里所有用例都通过显式 env 对象达成隔离，
 * 不依赖 `process.env`。
 */
let dir: string
let configDir: string
let cwd: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'splunk-cli-config-'))
  configDir = join(dir, 'config')
  cwd = join(dir, 'work')
  // cwd 用临时目录：确保不会读到仓库根真实的 ./.env
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function envWith(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { SPLUNK_CONFIG_DIR: configDir, ...extra }
}

function writeGlobalConfig(text: string): void {
  writeFileSync(join(configDir, 'config.env'), text)
}

function writeLocalEnv(text: string): void {
  writeFileSync(join(cwd, '.env'), text)
}

describe('parseDuration', () => {
  it.each([
    ['30s', 30],
    ['5m', 300],
    ['1h', 3600],
    ['7d', 604_800],
    ['2w', 1_209_600],
    ['1.5h', 5400],
    ['-30d', 2_592_000],
    ['+1h', 3600],
  ])('解析 %s → %s 秒', (input, expected) => {
    expect(parseDuration(input)).toBe(expected)
  })

  it.each(['now', '@d', '-1h@h', '', 'abc', '5', 'h'])('%s 不是固定时长 → null', (input) => {
    expect(parseDuration(input)).toBeNull()
  })
})

describe('parseEnvFile（`.env` 常用子集）', () => {
  it('忽略空行与注释，支持 export 前缀、引号与内联注释', () => {
    const parsed = parseEnvFile(
      [
        '# 注释',
        '',
        'SPLUNK_HOST=203.0.113.10',
        'export SPLUNK_PORT=8089',
        'SPLUNK_USERNAME="quoted user"',
        "SPLUNK_PASSWORD='single'",
        'SPLUNK_URL=https://h:8089   # 内联注释',
      ].join('\n'),
    )
    expect(parsed).toEqual({
      SPLUNK_HOST: '203.0.113.10',
      SPLUNK_PORT: '8089',
      SPLUNK_USERNAME: 'quoted user',
      SPLUNK_PASSWORD: 'single',
      SPLUNK_URL: 'https://h:8089',
    })
  })
})

describe('配置分层（env > 全局 config.env > ./.env > 默认值）', () => {
  it('无任何来源时使用内置默认值', () => {
    const settings = loadSettings({}, envWith(), cwd)
    expect(settings.port).toBe(8089)
    expect(settings.timeout).toBe(30)
    expect(settings.max_results).toBe(5000)
    expect(settings.max_time_range).toBe('7d')
    expect(settings.poll_interval).toBe(1)
    expect(settings.search_timeout).toBe(60)
    expect(settings.max_retries).toBe(3)
    expect(settings.retry_backoff).toBe(0.5)
    // 内置默认**开启**校验，`init` 写出的模板同样是 `true`——两者一致，见文件末尾的用例。
    expect(settings.verify_ssl).toBe(true)
    expect(settings.trust_env).toBe(false)
    expect(settings.insecure).toBe(false)
  })

  it('全局 config.env 覆盖 ./.env', () => {
    writeLocalEnv('SPLUNK_HOST=from-local\nSPLUNK_PORT=1111\n')
    writeGlobalConfig('SPLUNK_HOST=from-global\n')
    const settings = loadSettings({}, envWith(), cwd)
    expect(settings.host).toBe('from-global')
    // 全局文件没设 port，于是 ./.env 的值保留下来——这正是"逐字段合并"的意义。
    expect(settings.port).toBe(1111)
  })

  it('环境变量覆盖两个文件', () => {
    writeLocalEnv('SPLUNK_HOST=from-local\n')
    writeGlobalConfig('SPLUNK_HOST=from-global\n')
    const settings = loadSettings({}, envWith({ SPLUNK_HOST: 'from-env' }), cwd)
    expect(settings.host).toBe('from-env')
  })

  it('显式 overrides 覆盖一切', () => {
    const settings = loadSettings({ host: 'from-override' }, envWith({ SPLUNK_HOST: 'env' }), cwd)
    expect(settings.host).toBe('from-override')
  })

  it('布尔值解析：字符串 "false" 必须是 false（不能用 Boolean(raw)）', () => {
    expect(loadSettings({}, envWith({ SPLUNK_VERIFY_SSL: 'false' }), cwd).verify_ssl).toBe(false)
    expect(loadSettings({}, envWith({ SPLUNK_VERIFY_SSL: 'TRUE' }), cwd).verify_ssl).toBe(true)
    expect(loadSettings({}, envWith({ SPLUNK_TRUST_ENV: '1' }), cwd).trust_env).toBe(true)
    expect(loadSettings({}, envWith({ SPLUNK_INSECURE: 'on' }), cwd).insecure).toBe(true)
    expect(() => loadSettings({}, envWith({ SPLUNK_VERIFY_SSL: 'maybe' }), cwd)).toThrowError(
      ConfigurationError,
    )
  })
})

describe('取值约束（超限即拒绝，不静默改写）', () => {
  it.each([
    ['SPLUNK_PORT', '0'],
    ['SPLUNK_PORT', '65536'],
    ['SPLUNK_TIMEOUT', '0'],
    ['SPLUNK_TIMEOUT', '601'],
    ['SPLUNK_MAX_RESULTS', '0'],
    ['SPLUNK_MAX_RESULTS', '1000001'],
    ['SPLUNK_POLL_INTERVAL', '0'],
    ['SPLUNK_POLL_INTERVAL', '61'],
    ['SPLUNK_SEARCH_TIMEOUT', '3601'],
    ['SPLUNK_MAX_QUERY_LENGTH', '0'],
    ['SPLUNK_MAX_RETRIES', '11'],
    ['SPLUNK_RETRY_BACKOFF', '31'],
  ])('%s=%s 被拒绝', (key, value) => {
    expect(() => loadSettings({}, envWith({ [key]: value }), cwd)).toThrowError(ConfigurationError)
  })

  it('非整数/非数字被拒绝', () => {
    expect(() => loadSettings({}, envWith({ SPLUNK_PORT: 'abc' }), cwd)).toThrowError(/must be an integer/)
    expect(() => loadSettings({}, envWith({ SPLUNK_TIMEOUT: 'abc' }), cwd)).toThrowError(/must be a number/)
    expect(() => loadSettings({}, envWith({ SPLUNK_PORT: '80.5' }), cwd)).toThrowError(/must be an integer/)
  })

  it('SPLUNK_MAX_TIME_RANGE 必须是固定时长', () => {
    expect(loadSettings({}, envWith({ SPLUNK_MAX_TIME_RANGE: '24h' }), cwd).max_time_range_seconds).toBe(
      86_400,
    )
    expect(() => loadSettings({}, envWith({ SPLUNK_MAX_TIME_RANGE: 'now' }), cwd)).toThrowError(
      /must be a fixed duration/,
    )
  })
})

describe('host / url 校验', () => {
  it('host 不接受 scheme、端口或路径', () => {
    expect(() => loadSettings({}, envWith({ SPLUNK_HOST: 'https://h' }), cwd)).toThrowError(
      /must be a bare host or IP/,
    )
    expect(() => loadSettings({}, envWith({ SPLUNK_HOST: 'h:8089' }), cwd)).toThrowError(
      /must not include a port/,
    )
    expect(() => loadSettings({}, envWith({ SPLUNK_HOST: 'h/path' }), cwd)).toThrowError(
      /must not include a path/,
    )
  })

  it('IPv6 字面量不被误判为端口', () => {
    expect(loadSettings({}, envWith({ SPLUNK_HOST: '::1' }), cwd).effective_url).toBe('https://[::1]:8089')
    expect(loadSettings({}, envWith({ SPLUNK_HOST: '[::1]' }), cwd).effective_url).toBe('https://[::1]:8089')
  })

  it('host 去掉尾斜杠', () => {
    expect(loadSettings({}, envWith({ SPLUNK_HOST: 'h/' }), cwd).host).toBe('h')
  })

  it('url 必须是 http(s) 且带主机名，并去掉尾斜杠', () => {
    expect(loadSettings({}, envWith({ SPLUNK_URL: 'https://h:8089/' }), cwd).effective_url).toBe(
      'https://h:8089',
    )
    expect(() => loadSettings({}, envWith({ SPLUNK_URL: 'ftp://h' }), cwd)).toThrowError(
      /must use http:\/\/ or https:\/\//,
    )
    expect(() => loadSettings({}, envWith({ SPLUNK_URL: 'https://' }), cwd)).toThrowError(
      ConfigurationError,
    )
  })
})

describe('派生属性', () => {
  it('effective_url：默认 https，insecure 时为 http，显式 url 优先', () => {
    expect(loadSettings({}, envWith({ SPLUNK_HOST: 'h' }), cwd).effective_url).toBe('https://h:8089')
    expect(loadSettings({}, envWith({ SPLUNK_HOST: 'h', SPLUNK_INSECURE: 'true' }), cwd).effective_url).toBe(
      'http://h:8089',
    )
    expect(
      loadSettings({}, envWith({ SPLUNK_HOST: 'h', SPLUNK_URL: 'https://proxy/api' }), cwd).effective_url,
    ).toBe('https://proxy/api')
  })

  it('base_path / is_url_explicit / is_configured', () => {
    const settings = loadSettings(
      {},
      envWith({ SPLUNK_HOST: 'h', SPLUNK_USERNAME: 'u', SPLUNK_PASSWORD: 'p' }),
      cwd,
    )
    expect(settings.base_path).toBe('https://h:8089/services')
    expect(settings.is_url_explicit).toBe(false)
    expect(settings.is_configured).toBe(true)
    expect(loadSettings({}, envWith({ SPLUNK_HOST: 'h' }), cwd).is_configured).toBe(false)
    expect(loadSettings({}, envWith(), cwd).effective_url).toBe('')
    expect(loadSettings({}, envWith(), cwd).base_path).toBe('')
  })

  it('effective_search_timeout = max(search_timeout, timeout)', () => {
    expect(loadSettings({}, envWith({ SPLUNK_SEARCH_TIMEOUT: '2', SPLUNK_TIMEOUT: '30' }), cwd).effective_search_timeout).toBe(30)
    expect(loadSettings({}, envWith({ SPLUNK_SEARCH_TIMEOUT: '90', SPLUNK_TIMEOUT: '30' }), cwd).effective_search_timeout).toBe(90)
  })
})

describe('redacted()：唯一允许渲染配置的出口', () => {
  it('密码只以存在性标记出现，绝不回显', () => {
    const settings = loadSettings(
      {},
      envWith({ SPLUNK_HOST: 'h', SPLUNK_USERNAME: 'u', SPLUNK_PASSWORD: 'hunter2' }),
      cwd,
    )
    const view = settings.redacted()
    expect(view['password']).toBe('<set>')
    expect(JSON.stringify(view)).not.toContain('hunter2')
  })

  it('未设置密码时为 <unset>', () => {
    expect(loadSettings({}, envWith(), cwd).redacted()['password']).toBe('<unset>')
  })

  it('键名与顺序是公开输出的一部分', () => {
    const view = loadSettings({}, envWith({ SPLUNK_HOST: 'h' }), cwd).redacted()
    expect(Object.keys(view)).toEqual([
      'host',
      'port',
      'url',
      'url_source',
      'username',
      'password',
      'verify_ssl',
      'ca_bundle',
      'trust_env',
      'timeout',
      'max_results',
      'max_time_range',
      'poll_interval',
      'search_timeout',
      'max_query_length',
      'max_retries',
      'retry_backoff',
    ])
  })

  it('url_source 区分显式 URL 与 host/port 推导', () => {
    expect(loadSettings({}, envWith({ SPLUNK_HOST: 'h' }), cwd).redacted()['url_source']).toBe(
      'SPLUNK_HOST/SPLUNK_PORT',
    )
    expect(
      loadSettings({}, envWith({ SPLUNK_URL: 'https://h:8089' }), cwd).redacted()['url_source'],
    ).toBe('SPLUNK_URL')
  })

  it('ca_bundle 空串归一为 null', () => {
    expect(loadSettings({}, envWith({ SPLUNK_CA_BUNDLE: '' }), cwd).ca_bundle).toBeNull()
    expect(loadSettings({}, envWith({ SPLUNK_CA_BUNDLE: '/tmp/ca.pem' }), cwd).ca_bundle).toBe(
      '/tmp/ca.pem',
    )
  })
})

describe('require_credentials', () => {
  it('按缺失项列出，且消息不含密码值', () => {
    let error: ConfigurationError | null = null
    try {
      loadSettings({}, envWith(), cwd).require_credentials()
    } catch (err) {
      error = err as ConfigurationError
    }
    expect(error?.message).toContain('missing required configuration: SPLUNK_HOST, SPLUNK_USERNAME, SPLUNK_PASSWORD')
    expect(error?.errorType).toBe('ConfigurationError')
  })

  it('仅缺密码时只列出密码', () => {
    expect(() =>
      loadSettings({}, envWith({ SPLUNK_HOST: 'h', SPLUNK_USERNAME: 'u' }), cwd).require_credentials(),
    ).toThrowError(/missing required configuration: SPLUNK_PASSWORD/)
  })

  it('配置齐全时不抛错', () => {
    expect(() =>
      loadSettings(
        {},
        envWith({ SPLUNK_HOST: 'h', SPLUNK_USERNAME: 'u', SPLUNK_PASSWORD: 'p' }),
        cwd,
      ).require_credentials(),
    ).not.toThrow()
  })
})

describe('paths：目录解析与注入', () => {
  it('SPLUNK_CONFIG_DIR 覆盖默认目录（测试隔离的基础）', () => {
    expect(configDirPath({ SPLUNK_CONFIG_DIR: '/tmp/x' })).toBe('/tmp/x')
    expect(configDirPath({ SPLUNK_CONFIG_DIR: '/tmp/x' })).not.toContain('.splunk-cli')
  })

  it('未设置时回落到 ~/.splunk-cli', () => {
    expect(configDirPath({})).toContain('.splunk-cli')
  })

  it('resolveConfigDir / writableConfigFile 反映目录与文件状态', () => {
    expect(resolveConfigDir(envWith()).exists).toBe(true)
    expect(resolveConfigDir(envWith()).isPopulated).toBe(false)
    expect(writableConfigFile(envWith())).toBe(join(configDir, 'config.env'))
    writeGlobalConfig('SPLUNK_HOST=h\n')
    expect(resolveConfigDir(envWith()).isPopulated).toBe(true)
  })
})

/**
 * `init` 模板与**内置**默认值必须一致地**开启**校验（AGENTS.md §4：绝不默认关闭校验）。
 * 同时模板要把"对接 Splunk 默认自签证书该怎么办"写在用户看得见的地方——默认安装上
 * 校验一定失败，只写个 `true` 而不给办法等于把问题丢给用户。
 */
describe('init 模板默认开启 TLS 校验', () => {
  it('模板里 SPLUNK_VERIFY_SSL 是 true，且没有任何地方把它设成 false', () => {
    expect(CONFIG_TEMPLATE).toContain('SPLUNK_VERIFY_SSL=true')
    expect(CONFIG_TEMPLATE).not.toContain('SPLUNK_VERIFY_SSL=false')
  })

  it('模板写清了 CA 路径，以及"只放叶子无效"和 SAN 前提', () => {
    expect(CONFIG_TEMPLATE).toContain('SPLUNK_CA_BUNDLE=/path/to/splunk-ca.pem')
    // 叶子证书放进 CA 包**不能**建立信任，这一点必须写出来。
    expect(CONFIG_TEMPLATE).toMatch(/leaf/i)
    // 默认证书没有 SAN：按 IP 连接时配 CA 也过不去。
    expect(CONFIG_TEMPLATE).toMatch(/SAN/)
  })

  it('把模板写进 config.env 后，生效值确实是 true（开发环境仍可显式关闭）', () => {
    expect(parseEnvFile(CONFIG_TEMPLATE)['SPLUNK_VERIFY_SSL']).toBe('true')
    writeGlobalConfig(CONFIG_TEMPLATE)
    expect(loadSettings({}, envWith(), cwd).verify_ssl).toBe(true)
    // 模板给的是默认值，不是硬编码：环境变量优先级更高。
    expect(loadSettings({}, envWith({ SPLUNK_VERIFY_SSL: 'false' }), cwd).verify_ssl).toBe(false)
  })
})
