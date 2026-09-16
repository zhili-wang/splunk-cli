// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { BarPanel } from './BarPanel'

afterEach(cleanup)

function bars(container: HTMLElement): (string | undefined)[] {
  return [...container.querySelectorAll('li')].map(
    (item) => (item.querySelector('span[aria-hidden]') as HTMLElement | null)?.style.width,
  )
}

describe('BarPanel', () => {
  it('names the empty state instead of rendering an empty list', () => {
    render(<BarPanel title="服务排行" rows={[]} emptyLabel="暂无服务维度拆解数据。" />)

    expect(screen.getByText('服务排行')).toBeDefined()
    expect(screen.getByText('暂无服务维度拆解数据。')).toBeDefined()
    expect(screen.getByText('0 组')).toBeDefined()
  })

  it('renders the grouping key and its count for each row', () => {
    render(
      <BarPanel
        title="服务排行"
        emptyLabel="none"
        rows={[
          { key: 'payment', count: 120 },
          { key: ['api', 'api-01'], count: 40 },
        ]}
      />,
    )

    expect(screen.getByText('payment')).toBeDefined()
    expect(screen.getByText('120')).toBeDefined()
    expect(screen.getByText('api · api-01')).toBeDefined()
    expect(screen.getByText('40')).toBeDefined()
    // The header counts every group, not just the ranked slice.
    expect(screen.getByText('2 组')).toBeDefined()
  })

  it('caps the list at twelve rows but still reports the full count', () => {
    const rows = Array.from({ length: 20 }, (_unused, index) => ({
      key: `service-${String(index).padStart(2, '0')}`,
      count: 20 - index,
    }))

    const { container } = render(
      <BarPanel title="服务排行" emptyLabel="none" rows={rows} />,
    )

    expect(container.querySelectorAll('li')).toHaveLength(12)
    expect(screen.getByText('20 组')).toBeDefined()
    expect(screen.queryByText('service-12')).toBeNull()
  })

  it('scales each bar against the peak row', () => {
    const { container } = render(
      <BarPanel
        title="服务排行"
        emptyLabel="none"
        rows={[
          { key: 'top', count: 10 },
          { key: 'half', count: 5 },
        ]}
      />,
    )

    const widths = bars(container)
    expect(widths[0]).toBe('100%')
    expect(parseFloat(String(widths[1]))).toBeCloseTo(50)
  })

  it('does not divide by a zero peak', () => {
    // Every group reported zero (or a malformed row). The bar must be 0%, not
    // NaN%, which would make the whole row unrenderable.
    const { container } = render(
      <BarPanel
        title="服务排行"
        emptyLabel="none"
        rows={[
          { key: 'a', count: 0 },
          { key: 'b', count: 0 },
        ]}
      />,
    )

    expect(bars(container)).toEqual(['0%', '0%'])
  })

  it('names a blank grouping key rather than showing nothing', () => {
    render(<BarPanel title="主机排行" emptyLabel="none" rows={[{ key: '', count: 1 }]} />)

    expect(screen.getByText('(无)')).toBeDefined()
  })
})
