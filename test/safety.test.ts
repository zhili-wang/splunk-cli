import { describe, expect, it } from 'vitest'

import { SafetyLimitError, SafetyPolicy, limitsReport } from '../server/safety/limits'
import { formatG } from '../server/format'
import {
  buildProbeSpl,
  buildStatsSpl,
  buildTimelineSpl,
  checkProhibitedCommands,
  validateByFields,
  validateFieldNames,
  validateSpl,
  validateStatsFunction,
} from '../server/safety/validator'

const policy = new SafetyPolicy()

describe('权威消息逐字稳定（调用方按这些字符串做分支判断）', () => {
  it('时间跨度超限：数字用 %g 格式化', () => {
    const error = (() => {
      try {
        policy.check_time_range(2_592_000, { earliest: '-30d', latest: 'now' })
        return null
      } catch (err) {
        return err as SafetyLimitError
      }
    })()
    expect(error?.message).toBe(
      'requested time range of 2.592e+06s exceeds the maximum allowed range of 604800s ' +
        '(earliest=-30d, latest=now)',
    )
    expect(error?.toDict()).toEqual({
      type: 'SafetyLimitError',
      message:
        'requested time range of 2.592e+06s exceeds the maximum allowed range of 604800s ' +
        '(earliest=-30d, latest=now)',
      details: {
        earliest: '-30d',
        latest: 'now',
        requested_seconds: 2_592_000,
        max_time_range_seconds: 604_800,
      },
    })
  })

  it('结果数超限', () => {
    expect(() => policy.check_limit(999_999)).toThrowError(
      'requested limit 999999 exceeds the maximum allowed 5000 results; ' +
        'narrow the query or raise SPLUNK_MAX_RESULTS',
    )
  })

  it('前导管道命令被黑名单拒绝，position 为 0', () => {
    let error: SafetyLimitError | null = null
    try {
      validateSpl('| rest /services/server/info')
    } catch (err) {
      error = err as SafetyLimitError
    }
    expect(error?.message).toBe(
      "SPL command 'rest' is not permitted: it calls arbitrary REST endpoints, " +
        'including write APIs. Splunk CLI is read-only.',
    )
    expect(error?.details).toEqual({
      command: 'rest',
      reason: 'calls arbitrary REST endpoints, including write APIs',
      position: 0,
    })
  })

  it('空查询：只有 message，没有 details', () => {
    let error: SafetyLimitError | null = null
    try {
      validateSpl('   ')
    } catch (err) {
      error = err as SafetyLimitError
    }
    expect(error?.toDict()).toEqual({ type: 'SafetyLimitError', message: 'search query is empty' })
  })
})

describe('formatG 按 %g 语义', () => {
  it.each([
    [2_592_000, '2.592e+06'],
    [604_800, '604800'],
    [0, '0'],
    [3600, '3600'],
    [1.5, '1.5'],
    [-2_592_000, '-2.592e+06'],
    [0.00001, '1e-05'],
    [1234567, '1.23457e+06'],
  ])('formatG(%s) === %s', (value, expected) => {
    expect(formatG(value)).toBe(expected)
  })
})

describe('SafetyPolicy', () => {
  it('check_limit 对 null 返回策略默认值，对非正值拒绝', () => {
    expect(policy.check_limit(null)).toBe(5000)
    expect(policy.check_limit(undefined)).toBe(5000)
    expect(policy.check_limit(10)).toBe(10)
    expect(() => policy.check_limit(0)).toThrowError('limit must be a positive integer (got 0)')
  })

  it('check_time_range：无法静态判定时放行（交给服务端）', () => {
    expect(() => policy.check_time_range(null, { earliest: '-1d@d', latest: 'now' })).not.toThrow()
  })

  it('check_time_range：earliest 晚于 latest 时拒绝', () => {
    expect(() => policy.check_time_range(-1, { earliest: 'now', latest: '-1h' })).toThrowError(
      'earliest (now) is later than latest (-1h)',
    )
  })

  it('check_span：拒绝带符号或非固定时长', () => {
    expect(policy.check_span('5m')).toBe('5m')
    expect(() => policy.check_span('-5m')).toThrowError(/invalid span '-5m'/)
    expect(() => policy.check_span('@d')).toThrowError(/invalid span '@d'/)
  })

  it('check_read_only：白名单放行、禁止方法与越权路径一律拒绝', () => {
    expect(() => policy.check_read_only('GET', '/services/server/info')).not.toThrow()
    expect(() => policy.check_read_only('GET', '/services/search/jobs/123.45')).not.toThrow()
    expect(() => policy.check_read_only('GET', '/services/search/jobs/123.45/results')).not.toThrow()
    expect(() => policy.check_read_only('DELETE', '/services/search/jobs/123.45')).toThrowError(
      /strictly read-only/,
    )
    expect(() => policy.check_read_only('POST', '/services/admin/foo')).toThrowError(
      /strictly read-only/,
    )
    expect(() => policy.check_read_only('GET', '/services/search/jobs/export')).toThrowError(
      /strictly read-only/,
    )
    expect(() => policy.check_read_only('GET', '/services/nope')).toThrowError(
      'endpoint /services/nope is not on the read-only allow-list',
    )
  })

  it('check_read_only 忽略查询串并按尾斜杠归一化', () => {
    expect(() => policy.check_read_only('GET', '/services/server/info?output_mode=json')).not.toThrow()
    expect(() => policy.check_read_only('GET', '/services/server/info/')).not.toThrow()
  })

  it('toPublicDict 的键名是公开输出的一部分', () => {
    expect(policy.toPublicDict()).toEqual({
      max_results: 5000,
      max_time_range_seconds: 604_800,
      max_query_length: 10_000,
      read_only: true,
    })
  })

  it('limitsReport 在安全上限之后追加 Job 运行预算', () => {
    expect(
      limitsReport({
        timeout: 30,
        // 生效值由 Settings 算好（max(search_timeout, timeout)），这里原样透传。
        effective_search_timeout: 60,
        poll_interval: 2.5,
        max_results: 123,
        max_time_range_seconds: 3600,
        max_query_length: 500,
      }),
    ).toEqual({
      max_results: 123,
      max_time_range_seconds: 3600,
      max_query_length: 500,
      read_only: true,
      timeout: 30,
      search_timeout: 60,
      poll_interval: 2.5,
    })
  })
})

describe('SPL 校验', () => {
  it('只检查管道位置的命令，字段名恰好叫 delete 不影响', () => {
    expect(() => checkProhibitedCommands('index=app | stats count by delete')).not.toThrow()
    expect(() => checkProhibitedCommands('index=app delete=1')).not.toThrow()
  })

  it.each([
    'delete',
    'collect',
    'outputlookup',
    'outputcsv',
    'script',
    'sendalert',
    'map',
    'mcollect',
    'tscollect',
    'dbinspect',
    'meventcollect',
    'runshellscript',
    'outputtext',
  ])('拒绝 %s', (command) => {
    expect(() => checkProhibitedCommands(`index=app | ${command} x`)).toThrowError(SafetyLimitError)
  })

  it('大小写不敏感', () => {
    expect(() => checkProhibitedCommands('index=app | REST /x')).toThrowError(/REST/i)
  })

  it('超长查询被拒绝并给出 details', () => {
    const long = 'a'.repeat(20)
    let error: SafetyLimitError | null = null
    try {
      validateSpl(long, { maxLength: 10 })
    } catch (err) {
      error = err as SafetyLimitError
    }
    expect(error?.message).toBe('query length 20 exceeds the maximum allowed 10 characters')
    expect(error?.details).toEqual({ length: 20, max_query_length: 10 })
  })

  it('字段名校验', () => {
    expect(validateFieldNames('service')).toBe('service')
    expect(validateFieldNames('request.status')).toBe('request.status')
    expect(() => validateFieldNames('')).toThrowError('field name must not be empty')
    expect(() => validateFieldNames('bad name')).toThrowError(/invalid field name/)
  })

  it('by 字段列表：逗号或空白分隔，最多 4 个', () => {
    expect(validateByFields('service,host')).toEqual(['service', 'host'])
    expect(validateByFields('service host')).toEqual(['service', 'host'])
    expect(validateByFields(undefined)).toEqual([])
    expect(validateByFields('  ')).toEqual([])
    expect(() => validateByFields('a,b,c,d,e')).toThrowError(
      /at most 4 grouping fields are supported \(got 5\)/,
    )
  })

  it('stats 函数白名单', () => {
    expect(validateStatsFunction('COUNT')).toBe('count')
    expect(() => validateStatsFunction('nope')).toThrowError(
      "unsupported stats function 'nope': choose one of avg, count, dc, max, min, sum",
    )
  })
})

describe('SPL 构造（只插值已校验的标识符）', () => {
  it('buildStatsSpl', () => {
    expect(buildStatsSpl('index=app', { fn: 'count', by: ['service'], limit: 50 })).toBe(
      'index=app | stats count by service | sort - count | head 50',
    )
    expect(buildStatsSpl('index=app', { fn: 'avg', by: [], limit: 10 })).toBe(
      'index=app | stats avg(*) | sort - avg | head 10',
    )
  })

  it('buildTimelineSpl / buildProbeSpl', () => {
    expect(buildTimelineSpl('index=app', { span: '5m', limit: 200 })).toBe(
      'index=app | timechart span=5m count | head 200',
    )
    expect(buildProbeSpl()).toBe('| makeresults count=1')
  })
})
