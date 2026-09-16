import { describe, expect, it } from 'vitest'

import {
  cell,
  displayWidth,
  fieldOrder,
  formatNumber,
  keyValueTable,
  pad,
  floatString,
  formatInstant,
  renderResultSet,
  renderTable,
  rowsToTable,
  truncate,
} from '../server/output/table'

describe('displayWidth：CJK 与组合字符', () => {
  it('ASCII 每字符一列', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('')).toBe(0)
  })

  it('中日韩宽字符算两列', () => {
    expect(displayWidth('中文')).toBe(4)
    expect(displayWidth('a中')).toBe(3)
  })

  it('组合字符不占列宽', () => {
    // e + U+0301（combining acute）视觉上仍是 1 列
    expect(displayWidth('e\u0301')).toBe(1)
  })
})

describe('pad / truncate', () => {
  it('pad 在显示宽度内左对齐', () => {
    expect(pad('ab', 4)).toBe('ab  ')
    expect(pad('中文', 4)).toBe('中文')
    expect(pad('中文', 5)).toBe('中文 ')
    expect(pad('toolong', 3)).toBe('toolong') // 不截断，只补空格
  })

  it('truncate 在超宽时以 … 结尾并留一列', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef')
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abcdef', 0)).toBe('')
    expect(displayWidth(truncate('abcdef', 4))).toBe(4)
  })

  it('truncate 对宽字符按列宽计算', () => {
    expect(truncate('中文字', 5)).toBe('中文…')
  })
})

describe('cell：值渲染', () => {
  it.each([
    [null, ''],
    [undefined, ''],
    [true, 'true'],
    [false, 'false'],
    ['x', 'x'],
    [3, '3'],
    [3.5, '3.5'],
    [3.0, '3'],
  ])('cell(%s) === %s', (value, expected) => {
    expect(cell(value)).toBe(expected)
  })

  it('数组用逗号连接，对象展开成 k=v', () => {
    expect(cell(['a', 'b'])).toBe('a, b')
    expect(cell({ a: 1, b: 'x' })).toBe('a=1, b=x')
    expect(cell([{ a: 1 }])).toBe('a=1')
  })
})

describe('renderTable', () => {
  it('无列头 / 无数据时给出明确反馈', () => {
    expect(renderTable([], [])).toBe('(no columns)')
    expect(renderTable(['a'], [])).toBe('(no results)')
  })

  it('列宽取列头与单元格的最大显示宽度，行尾空白被去掉', () => {
    const table = renderTable(['name', 'n'], [['ab', '1'], ['c', '22']])
    expect(table).toBe(['name  n', 'ab    1', 'c     22'].join('\n'))
  })

  it('多行值被折叠成单行，避免破坏对齐', () => {
    const table = renderTable(['v'], [['a\nb   c']])
    expect(table).toBe(['v', 'a b c'].join('\n'))
  })

  it('超过 maxCellWidth 的单元格被截断', () => {
    const table = renderTable(['v'], [['x'.repeat(20)]], { maxCellWidth: 5 })
    expect(table.split('\n')[1]).toBe('xxxx…')
  })

  it('过短的行以空串补齐', () => {
    const table = renderTable(['a', 'b'], [['1']])
    expect(table.split('\n')[1]).toBe('1')
  })
})

describe('fieldOrder / rowsToTable', () => {
  it('fieldOrder：preferred 在前，其余按首次出现顺序', () => {
    const rows = [{ b: 1, a: 2 }, { c: 3, a: 4 }]
    expect(fieldOrder(rows)).toEqual(['b', 'a', 'c'])
    expect(fieldOrder(rows, ['a', 'c'])).toEqual(['a', 'c', 'b'])
    expect(fieldOrder(rows, ['missing'])).toEqual(['b', 'a', 'c'])
  })

  it('rowsToTable 默认按 fieldOrder，可显式指定列', () => {
    const rows = [{ b: 1, a: 2 }]
    expect(rowsToTable(rows)).toBe(['b  a', '1  2'].join('\n'))
    expect(rowsToTable(rows, { fields: ['a'] })).toBe(['a', '2'].join('\n'))
    expect(rowsToTable([])).toBe('(no results)')
  })
})

describe('keyValueTable：str() 语义', () => {
  it('布尔渲染成 True/False，null 渲染成 -', () => {
    expect(keyValueTable([['a', true], ['b', false], ['c', null]])).toBe(
      ['a  True', 'b  False', 'c  -'].join('\n'),
    )
  })

  it('标签按显示宽度对齐', () => {
    expect(keyValueTable([['short', '1'], ['much_longer', '2']])).toBe(
      ['short        1', 'much_longer  2'].join('\n'),
    )
  })

  it('空输入返回 (no data)', () => {
    expect(keyValueTable([])).toBe('(no data)')
  })

  it('数字不加多余的零（浮点语义由 floatString 显式控制）', () => {
    expect(keyValueTable([['n', 604800]])).toBe('n  604800')
    expect(keyValueTable([['n', floatString(604800)]])).toBe('n  604800.0')
  })
})

describe('formatNumber：数值显示格式化', () => {
  // 期望值全部来自实测（先保留 3 位小数，再去掉尾随零与小数点），
  // 不是"按直觉的舍入"——2.1235 两边都是 '2.123'，因为它对应的二进制值略小于 2.1235。
  it.each([
    [null, '-'],
    [undefined, '-'],
    [5, '5'],
    [5.0, '5'],
    [2.5, '2.5'],
    [2.0004, '2'],
    [2.1235, '2.123'],
    [2.1245, '2.124'],
    [0.1 + 0.2, '0.3'],
    [0, '0'],
  ])('formatNumber(%s) === %s', (value, expected) => {
    expect(formatNumber(value)).toBe(expected)
  })
})

describe('floatString', () => {
  it('整数值补 .0，非整数原样', () => {
    expect(floatString(604800)).toBe('604800.0')
    expect(floatString(5.8)).toBe('5.8')
    expect(floatString(0)).toBe('0.0')
  })
})

describe('renderResultSet', () => {
  it('空结果给出 (no results)', () => {
    expect(renderResultSet({ results: [], count: 0, truncated: false, total_available: 0 })).toBe(
      '(no results)',
    )
  })

  it('preferred 列优先，摘要含条数；truncated 时带可用总数', () => {
    const text = renderResultSet({
      results: [{ host: 'h', _time: 'T' }],
      count: 1,
      truncated: false,
      total_available: 1,
    })
    expect(text).toBe(['_time  host', 'T      h', '', '1 result(s)'].join('\n'))

    const truncated = renderResultSet({
      results: [{ _time: 'T' }],
      count: 1,
      truncated: true,
      total_available: 42,
    })
    expect(truncated).toContain('1 result(s) (truncated at limit; 42 available)')
  })

  it('摘要里带上 Job 实际执行的时间窗，给人看的形态是带时区的 ISO-8601', () => {
    // 时间范围是以表达式给出的（`@mon`、`--range last-month`），只有服务端知道它落到
    // 了哪两个瞬间——读结果之前得先能确认这一点。
    const text = renderResultSet({
      results: [{ _time: 'T' }],
      count: 1,
      truncated: false,
      total_available: 1,
      job: {
        search_earliest_time: 1785513600,
        search_latest_time: 1788192000,
        run_duration: 0.05,
        sample_ratio: '1',
      },
    })

    expect(text).toMatch(
      /1 result\(s\) · 实际时间窗 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} → \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} · 耗时 0\.05s/,
    )
  })

  it('没有命中时也报窗口——"真的没有"要靠它才能成立', () => {
    const text = renderResultSet({
      results: [],
      count: 0,
      truncated: false,
      total_available: 0,
      job: {
        search_earliest_time: 1785513600,
        search_latest_time: 1788192000,
        run_duration: null,
        sample_ratio: '',
      },
    })

    expect(text).toContain('(no results)')
    expect(text).toContain('实际时间窗')
    expect(text).not.toContain('耗时')
  })

  it('采样不是 1:1 时摘要里点名，计数不能当成精确值读', () => {
    const text = renderResultSet({
      results: [{ _time: 'T' }],
      count: 1,
      truncated: false,
      total_available: 1,
      job: {
        search_earliest_time: null,
        search_latest_time: null,
        run_duration: null,
        sample_ratio: '100',
      },
    })

    expect(text).toContain('采样 1:100（近似值）')
  })

  it('没有 Job 元数据时摘要保持原样（离线构造的结果集）', () => {
    const text = renderResultSet({
      results: [{ _time: 'T' }],
      count: 1,
      truncated: false,
      total_available: 1,
      job: null,
    })

    expect(text.endsWith('1 result(s)')).toBe(true)
  })
})

describe('formatInstant', () => {
  it('带本地时区偏移，因此和 Splunk 界面上的那一行对得上', () => {
    expect(formatInstant(1785513600)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })
})
