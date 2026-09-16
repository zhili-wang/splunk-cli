// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { resetFieldSelection } from '../hooks/useFieldSelection'
import { LogTable } from './LogTable'

// The field selection is stored now, so every test starts from the default rule
// rather than whatever the test before it happened to choose.
beforeEach(() => {
  localStorage.clear()
  resetFieldSelection()
})

afterEach(cleanup)

function headers(): string[] {
  return screen.getAllByRole('columnheader').map((cell) => cell.textContent ?? '')
}

/** The data cells of one event row, found through its expand button. */
function rowCells(number: number): string[] {
  const button = screen.getByRole('button', { name: `展开第 ${number} 行` })
  const row = button.closest('tr')
  if (row === null) throw new Error(`no row ${number}`)
  return [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '')
}

function chip(name: string): HTMLElement {
  return screen.getByRole('button', { name: `字段 ${name}` })
}

const ROW = {
  _time: '2024-01-02T03:04:05',
  _raw: 'api-01 ERROR boom',
  _serial: '999',
  _bkt: 'main~1',
  host: 'api-01',
  level: 'ERROR',
  count: 12.5,
}

describe('LogTable', () => {
  it('says so when nothing matched instead of drawing an empty shell', () => {
    render(<LogTable rows={[]} />)

    expect(screen.getByText('没有匹配到事件。')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('leads with a row number, the time and the event text', () => {
    render(<LogTable rows={[ROW]} />)

    // `_time` then `_raw` is what an operator scans; the rest follow.
    expect(headers()).toEqual(['#', '_time', '_raw', 'host', 'level', 'count'])
  })

  it('keeps the bookkeeping fields out of the way by default', () => {
    render(<LogTable rows={[ROW]} />)

    expect(headers()).not.toContain('_serial')
    expect(headers()).not.toContain('_bkt')
    // …but they are still offered as chips, carrying their value counts.
    expect(chip('_serial').textContent).toContain('1')
  })

  it('formats the time column and stringifies the others', () => {
    render(<LogTable rows={[ROW]} />)

    const cells = rowCells(1)
    expect(cells[0]).toBe('1')
    expect(cells[1]).toBe('2024/1/2 03:04:05')
    expect(cells).toContain('12.5')
  })

  it('shows a severity badge for the level field', () => {
    const { container } = render(<LogTable rows={[ROW]} />)

    const badge = container.querySelector('td span.rounded')
    expect(badge?.textContent).toBe('ERROR')
    expect(badge?.className).toContain('signal-bad')
  })

  it('tones the badge by severity, and stays neutral when it does not know', () => {
    const { container } = render(
      <LogTable rows={[{ level: 'WARN' }, { level: 'INFO' }, { level: 'DEBUG' }]} />,
    )

    const tones = [...container.querySelectorAll('td span.rounded')].map((node) => node.className)
    expect(tones[0]).toContain('signal-warn')
    expect(tones[1]).toContain('signal-info')
    // An unrecognised severity is not painted as if it mattered.
    expect(tones[2]).toContain('signal-muted')
  })

  it('falls back to the severity field when the event calls it something else', () => {
    render(<LogTable rows={[{ severity: 'ERROR' }]} />)

    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toContain('severity')
    expect(document.querySelector('td span.rounded')?.textContent).toBe('ERROR')
  })

  it('opens a detail view even for an event with no raw text', () => {
    render(<LogTable rows={[{ host: 'api-01' }]} />)

    fireEvent.click(screen.getByRole('button', { name: '展开第 1 行' }))

    // No `_raw`, so no `pre` block — but the field list still opens.
    expect(document.querySelector('pre')).toBeNull()
    expect(document.querySelector('td[colspan]')?.textContent).toContain('host')
  })

  it('leaves a cell empty for a field the event does not carry', () => {
    render(<LogTable rows={[{ _time: 'n/a', host: 'api-01' }, { level: null }]} />)

    expect(headers()).toEqual(['#', '_time', 'host', 'level'])
    expect(rowCells(1)).toEqual(['1', 'n/a', 'api-01', ''])
    // The second event has no `_time`, and `formatTimestamp` reports that
    // explicitly instead of drawing a blank that reads like empty data.
    expect(rowCells(2)).toEqual(['2', '—', '', ''])
  })

  it('keeps falsy but real values visible', () => {
    // `0` and `false` are data; only `null`/`undefined` mean "absent".
    render(<LogTable rows={[{ service: 0, extra: false }]} />)

    expect(rowCells(1)).toEqual(['1', '0', 'false'])
  })

  it('reveals a hidden field when its chip is turned on, and hides it again', () => {
    render(<LogTable rows={[ROW]} />)

    fireEvent.click(chip('_serial'))
    expect(headers()).toContain('_serial')
    expect(rowCells(1)).toContain('999')

    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(headers()).not.toContain('_serial')
  })

  it('shows every field at once', () => {
    render(<LogTable rows={[ROW]} />)

    fireEvent.click(screen.getByRole('button', { name: '全部字段' }))

    expect(headers()).toContain('_serial')
    expect(headers()).toContain('_bkt')
  })

  it('remembers a field turned on across a reload', () => {
    render(<LogTable rows={[ROW]} />)
    fireEvent.click(chip('_serial'))
    expect(headers()).toContain('_serial')

    cleanup() // a page refresh, as far as the component is concerned

    render(<LogTable rows={[ROW]} />)
    expect(headers()).toContain('_serial')
  })

  it('remembers a field turned off across a reload', () => {
    render(<LogTable rows={[ROW]} />)
    fireEvent.click(chip('host'))
    expect(headers()).not.toContain('host')

    cleanup()

    render(<LogTable rows={[ROW]} />)
    expect(headers()).not.toContain('host')
  })

  it('applies a stored choice to a query that returns different fields', () => {
    // Only the deviations are stored, so a name that is not there keeps
    // following the rule instead of inheriting an unrelated column list.
    render(<LogTable rows={[{ host: 'h', level: 'ERROR' }]} />)
    fireEvent.click(chip('level'))
    cleanup()

    render(<LogTable rows={[{ host: 'h', message: 'boom', level: 'ERROR' }]} />)

    expect(headers()).toEqual(['#', 'host', 'message'])
  })

  it('forgets the choice when the default is restored', () => {
    render(<LogTable rows={[ROW]} />)
    fireEvent.click(chip('host'))
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))

    cleanup()

    render(<LogTable rows={[ROW]} />)
    expect(headers()).toContain('host')
    expect(headers()).not.toContain('_serial')
  })

  it('lets the operator turn every field off, and says how to get back', () => {
    render(<LogTable rows={[{ host: 'api-01' }]} />)

    fireEvent.click(chip('host'))

    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText(/未选择任何字段/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(headers()).toEqual(['#', 'host'])
  })

  it('opens the whole event when a row is clicked', () => {
    render(<LogTable rows={[ROW]} />)

    // `_serial` is a hidden column, but the detail is where it belongs.
    expect(screen.queryByText('999')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '展开第 1 行' }))

    expect(screen.getByRole('button', { name: '收起第 1 行' }).getAttribute('aria-expanded')).toBe(
      'true',
    )
    // Scoped to the detail cell: `_bkt` also exists as a chip, and the point is
    // that the hidden-by-default fields are shown here, in full.
    const detail = screen.getByText('999').closest('td')
    expect(detail?.textContent).toContain('_serial')
    expect(detail?.textContent).toContain('_bkt')
    // The raw event gets a block of its own (it is also a column, so scope to
    // the `pre` rather than matching the text anywhere in the table).
    expect(document.querySelector('pre')?.textContent).toContain('api-01 ERROR boom')
  })

  it('closes the detail again on a second click', () => {
    render(<LogTable rows={[ROW]} />)

    fireEvent.click(screen.getByRole('button', { name: '展开第 1 行' }))
    fireEvent.click(screen.getByRole('button', { name: '收起第 1 行' }))

    expect(screen.getByRole('button', { name: '展开第 1 行' })).toBeDefined()
    expect(screen.queryByText('999')).toBeNull()
  })

  it('marks the terms the operator searched for', () => {
    const { container } = render(<LogTable rows={[ROW]} query="index=app level=ERROR" />)

    const marks = [...container.querySelectorAll('mark')].map((node) => node.textContent)
    expect(marks).toContain('ERROR')
    expect(container.querySelector('mark')?.className).toContain('bg-accent')
  })

  it('highlights the raw event inside the expanded row too', () => {
    const { container } = render(<LogTable rows={[ROW]} query="index=app level=ERROR" />)

    fireEvent.click(screen.getByRole('button', { name: '展开第 1 行' }))

    const inDetail = [...container.querySelectorAll('pre mark')].map((node) => node.textContent)
    expect(inDetail).toContain('ERROR')
  })

  it('does not mark anything when the query carries no usable term', () => {
    const { container } = render(<LogTable rows={[ROW]} query="" />)

    expect(container.querySelectorAll('mark')).toHaveLength(0)
  })

  it('renders one row per event', () => {
    render(<LogTable rows={[{ host: 'a' }, { host: 'b' }, { host: 'c' }]} />)

    expect(screen.getByRole('button', { name: '展开第 3 行' })).toBeDefined()
    expect(rowCells(3)).toEqual(['3', 'c'])
  })
})

function manyRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({ host: `h${index + 1}` }))
}

describe('LogTable paging', () => {
  it('puts the pager above the list, not below it', () => {
    render(<LogTable rows={manyRows(120)} />)

    const pager = screen.getByRole('button', { name: '下一页' })
    const table = screen.getByRole('table')

    // Below 5000 rows the control would sit at the end of a long scroll.
    expect(
      pager.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('mounts only the first page of a large result set', () => {
    render(<LogTable rows={manyRows(120)} />)

    // A default search returns thousands of events; mounting them all is what
    // made the table stutter on every later interaction.
    expect(screen.getAllByRole('button', { name: /^展开第/ })).toHaveLength(50)
  })

  it('keeps the row numbers absolute across pages', () => {
    render(<LogTable rows={manyRows(120)} />)

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))

    expect(screen.getByRole('button', { name: '展开第 51 行' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '展开第 1 行' })).toBeNull()
    expect(screen.getByText('51–100 / 120')).toBeDefined()
  })

  it('disables the arrows at both ends', () => {
    render(<LogTable rows={manyRows(120)} />)

    expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))

    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('101–120 / 120')).toBeDefined()
  })

  it('returns to the first page when the page size changes', () => {
    render(<LogTable rows={manyRows(120)} />)

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('button', { name: '100' }))

    expect(screen.getByText('1–100 / 120')).toBeDefined()
    expect(screen.getAllByRole('button', { name: /^展开第/ })).toHaveLength(100)
  })

  it('hides the pager when everything fits on one page', () => {
    render(<LogTable rows={manyRows(10)} />)

    expect(screen.queryByRole('button', { name: '下一页' })).toBeNull()
    expect(screen.queryByText(/每页/)).toBeNull()
  })

  it('offers the page numbers and jumps straight to one', () => {
    render(<LogTable rows={manyRows(120)} />)

    expect(screen.getByRole('button', { name: '第 1 页' })).toBeDefined()
    expect(screen.getByRole('button', { name: '第 3 页' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '第 3 页' }))

    expect(screen.getByText('101–120 / 120')).toBeDefined()
    // The page in view is the one marked as current, not merely styled.
    expect(screen.getByRole('button', { name: '第 3 页' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: '第 1 页' }).getAttribute('aria-current')).toBeNull()
  })

  it('collapses the middle pages into a gap when there are many', () => {
    render(<LogTable rows={manyRows(1000)} />)

    // 20 pages: the ends and the neighbours, with the rest elided.
    expect(screen.getByRole('button', { name: '第 1 页' })).toBeDefined()
    expect(screen.getByRole('button', { name: '第 20 页' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '第 10 页' })).toBeNull()
    expect(screen.getAllByText('…').length).toBeGreaterThan(0)
  })

  it('jumps to a page the operator types', () => {
    render(<LogTable rows={manyRows(120)} />)

    fireEvent.change(screen.getByLabelText('跳至页码'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '跳转' }))

    expect(screen.getByText('51–100 / 120')).toBeDefined()
  })

  it('jumps on Enter in the page box too', () => {
    render(<LogTable rows={manyRows(120)} />)

    const input = screen.getByLabelText('跳至页码')
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByText('101–120 / 120')).toBeDefined()
  })

  it('refuses a page number that is out of range instead of clamping', () => {
    render(<LogTable rows={manyRows(120)} />)

    const input = screen.getByLabelText('跳至页码')
    for (const value of ['0', '4', 'abc']) {
      fireEvent.change(input, { target: { value } })
      expect(
        (screen.getByRole('button', { name: '跳转' }) as HTMLButtonElement).disabled,
        value,
      ).toBe(true)
    }

    // The known-good page still works, and the view never moved on its own.
    fireEvent.change(input, { target: { value: '2' } })
    expect((screen.getByRole('button', { name: '跳转' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('1–50 / 120')).toBeDefined()
  })

  it('forgets a typed page number when the result set changes', () => {
    const { rerender } = render(<LogTable rows={manyRows(120)} />)

    fireEvent.change(screen.getByLabelText('跳至页码'), { target: { value: '3' } })
    rerender(<LogTable rows={manyRows(80)} />)

    // The old number has nothing left to point at.
    expect((screen.getByLabelText('跳至页码') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('1–50 / 80')).toBeDefined()
  })
})
