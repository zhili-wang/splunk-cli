import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { FetchLike, HttpResponseLike } from '../server/client/http'
import { SplunkClient } from '../server/client/splunk'
import { loadSettings, type Settings } from '../server/config/settings'
import { SafetyLimitError } from '../server/safety/limits'
import {
  BaseService,
  canonicalise,
  computeDuration,
  expandTimeRange,
  normaliseTimeLiteral,
  timeRangeNames,
} from '../server/services/base'

function makeSettings(): Settings {
  return loadSettings(
    { host: 'splunk.example', username: 'u', password: 'p', max_retries: '0', retry_backoff: '0' },
    { SPLUNK_CONFIG_DIR: join(tmpdir(), 'splunk-cli-base-tests-no-such-dir') },
    join(tmpdir(), 'splunk-cli-base-tests-no-such-cwd'),
  )
}

function jsonResponse(status: number, body: unknown): HttpResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => text,
  }
}

/** resolveTimeRange 不发请求，所以传输层只要存在即可。 */
function service(settings: Settings = makeSettings()): BaseService {
  const fetchImpl: FetchLike = async () => jsonResponse(200, {})
  return new BaseService(
    new SplunkClient(settings, { fetch: fetchImpl, dispatcher: { close: async () => {} } }),
  )
}

describe('normaliseTimeLiteral：常见拼写', () => {
  it.each([
    ['now', 'now'],
    ['NOW', 'now'],
    ['today', '@d'],
    ['Today', '@d'],
    ['yesterday', '-1d@d'],
    // 与面板「本周 / 本月 / 今年」一致：都是**周期起点**，不是"滚动 7/30 天"。
    ['week', '@w'],
    ['this-week', '@w'],
    ['month', '@mon'],
    ['this-month', '@mon'],
    ['year', '@y'],
    ['this-year', '@y'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseTimeLiteral(input, 'earliest')).toBe(expected)
  })
})

describe('expandTimeRange：一个名字给出整个窗口', () => {
  it('展开每个具名窗口，与面板的日历预设一一对应', () => {
    expect(expandTimeRange('today')).toEqual({ earliest: '@d', latest: 'now' })
    expect(expandTimeRange('yesterday')).toEqual({ earliest: '-1d@d', latest: '@d' })
    expect(expandTimeRange('this-week')).toEqual({ earliest: '@w', latest: 'now' })
    expect(expandTimeRange('last-week')).toEqual({ earliest: '-7d@w0', latest: '@w0' })
    expect(expandTimeRange('this-month')).toEqual({ earliest: '@mon', latest: 'now' })
    expect(expandTimeRange('last-month')).toEqual({ earliest: '-1mon@mon', latest: '@mon' })
    expect(expandTimeRange('this-year')).toEqual({ earliest: '@y', latest: 'now' })
    expect(expandTimeRange('last-year')).toEqual({ earliest: '-1y@y', latest: '@y' })
  })

  it('接受下划线与大小写的写法', () => {
    expect(expandTimeRange('  LAST_MONTH ')).toEqual(expandTimeRange('last-month'))
    expect(expandTimeRange('This-Week')).toEqual(expandTimeRange('this-week'))
  })

  it('把固定时长当成"最近 N"', () => {
    expect(expandTimeRange('7d')).toEqual({ earliest: '-7d', latest: 'now' })
    expect(expandTimeRange('-30m')).toEqual({ earliest: '-30m', latest: 'now' })
  })

  it('认不出来时拒绝，并列出可用写法', () => {
    // 猜一个近似窗口，或静默退回默认的 -1h，都会交出一份"看起来正常"的错误数据。
    let error: SafetyLimitError | null = null
    try {
      expandTimeRange('this-fortnight')
    } catch (err) {
      error = err as SafetyLimitError
    }
    expect(error).toBeInstanceOf(SafetyLimitError)
    expect(error?.message).toContain('unknown range')
    expect(error?.message).toContain('last-month')
    expect(error?.details).toMatchObject({ range: 'this-fortnight' })
  })

  it('列出的名字就是能展开的名字', () => {
    for (const name of timeRangeNames()) {
      expect(() => expandTimeRange(name)).not.toThrow()
    }
  })
})

describe('normaliseTimeLiteral：裸对齐点', () => {
  // "这个周期的开始"本身就是合法字面量，Splunk 8.0.2 实测接受。
  it.each(['@d', '@h', '@m', '@s', '@w', '@w0', '@w6', '@mon', '@y', '@q'])(
    '%s 原样透传',
    (input) => {
      expect(normaliseTimeLiteral(input, 'earliest')).toBe(input)
    },
  )

  it('越界的星期与未知对齐点被拒绝', () => {
    for (const input of ['@w7', '@w-1', '@z', '@mon@d', '@']) {
      expect(() => normaliseTimeLiteral(input, 'earliest')).toThrowError(SafetyLimitError)
    }
  })
})

describe('normaliseTimeLiteral：偏移与对齐组合', () => {
  it.each([
    ['1h', '-1h'],
    ['30s', '-30s'],
    ['-1h', '-1h'],
    ['-7d', '-7d'],
    ['1mon', '-1mon'],
    ['1y', '-1y'],
    ['1q', '-1q'],
    ['-1d@d', '-1d@d'],
    ['-7d@w0', '-7d@w0'],
    ['-1mon@mon', '-1mon@mon'],
    ['-1y@y', '-1y@y'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseTimeLiteral(input, 'earliest')).toBe(expected)
  })

  it('正号偏移不被反向：+1d 仍指向未来', () => {
    // 丢掉 `+` 会把它悄悄变成"一天前"——两个方向相反的时间窗。
    expect(normaliseTimeLiteral('+1d', 'latest')).toBe('+1d')
    expect(normaliseTimeLiteral('+1d@d', 'latest')).toBe('+1d@d')
  })

  it('now / 0 保持原样，不补方向', () => {
    expect(normaliseTimeLiteral('now', 'latest')).toBe('now')
    expect(normaliseTimeLiteral('0', 'earliest')).toBe('0')
    expect(normaliseTimeLiteral('0@d', 'earliest')).toBe('0@d')
    expect(normaliseTimeLiteral('now@d', 'latest')).toBe('now@d')
  })
})

describe('normaliseTimeLiteral：绝对时间与拒绝路径', () => {
  it.each([
    '2024-01-02T03:04:05Z',
    '2024-01-02T03:04:05+08:00',
    '2024-01-02 03:04:05',
    '2024-01-02',
    '1704164645',
    '1704164645.5',
  ])('%s 原样接受', (input) => {
    expect(normaliseTimeLiteral(input, 'latest')).toBe(input)
  })

  it.each(['', '   ', 'abc', '5', 'h', '-1', '1x', '-1h@', 'tomorrow'])(
    '%s 被拒绝，并说明期望的形状',
    (input) => {
      let error: SafetyLimitError | null = null
      try {
        normaliseTimeLiteral(input, 'earliest')
      } catch (err) {
        error = err as SafetyLimitError
      }
      expect(error).toBeInstanceOf(SafetyLimitError)
      expect(error?.message).toContain('invalid earliest value')
      expect(error?.details).toEqual({ field: 'earliest', value: input })
    },
  )
})

describe('canonicalise', () => {
  it('无法解析时原样返回，不制造新字面量', () => {
    expect(canonicalise('2024-01-02')).toBe('2024-01-02')
  })
})

describe('computeDuration', () => {
  it('两端都可静态求值时给出宽度', () => {
    expect(computeDuration('-1h', 'now')).toBe(3600)
    expect(computeDuration('-1d', 'now')).toBe(86400)
    expect(computeDuration('-4h', '-1h')).toBe(10800)
  })

  it('需要服务端求值时返回 null', () => {
    expect(computeDuration('@d', 'now')).toBeNull()
    expect(computeDuration('-1d@d', 'now')).toBeNull()
    expect(computeDuration('-1mon@mon', '@mon')).toBeNull()
  })

  it('绝对时间与 epoch 返回 null', () => {
    expect(computeDuration('2024-01-02T03:04:05Z', 'now')).toBeNull()
    expect(computeDuration('-1h', '2024-01-02T03:04:05Z')).toBeNull()
    expect(computeDuration('1704164645', 'now')).toBeNull()
  })

  it('earliest 无法解析时返回 null', () => {
    expect(computeDuration('now', 'now')).toBeNull()
    expect(computeDuration('-1mon', 'now')).toBeNull()
  })

  it('latest 是相对偏移时取两者之差', () => {
    expect(computeDuration('-7d', '-1d')).toBe(6 * 86400)
  })
})

describe('resolveTimeRange', () => {
  it('缺省时回落到有界默认值', () => {
    const range = service().resolveTimeRange()
    expect(range.earliest).toBe('-1h')
    expect(range.latest).toBe('now')
    expect(range.duration_seconds).toBe(3600)
  })

  it('空白字符串等同于缺省，不会变成"全部时间"', () => {
    const range = service().resolveTimeRange('   ', '')
    expect(range.earliest).toBe('-1h')
    expect(range.latest).toBe('now')
  })

  it('具名窗口字面量走同一条路（week = 本周起点）', () => {
    const range = service().resolveTimeRange('week', 'now')
    expect(range.earliest).toBe('@w')
    expect(range.duration_seconds).toBeNull()
  })

  it('日历窗口透传，宽度交给服务端', () => {
    const range = service().resolveTimeRange('@mon', 'now')
    expect(range.earliest).toBe('@mon')
    expect(range.latest).toBe('now')
    expect(range.duration_seconds).toBeNull()
  })

  it('超过上限的相对窗口被拒绝，且信息里带原始参数', () => {
    let error: SafetyLimitError | null = null
    try {
      service().resolveTimeRange('-30d', 'now')
    } catch (err) {
      error = err as SafetyLimitError
    }
    expect(error).toBeInstanceOf(SafetyLimitError)
    expect(error?.details).toMatchObject({ earliest: '-30d', latest: 'now' })
  })

  it('earliest 晚于 latest 时拒绝', () => {
    expect(() => service().resolveTimeRange('-1h', '-4h')).toThrowError(
      'earliest (-1h) is later than latest (-4h)',
    )
  })

  it('非法字面量在触及网络之前就被拒绝', () => {
    expect(() => service().resolveTimeRange('tomorrow', 'now')).toThrowError(SafetyLimitError)
  })
})
