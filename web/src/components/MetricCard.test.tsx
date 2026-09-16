// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { MetricCard } from './MetricCard'

afterEach(cleanup)

describe('MetricCard', () => {
  it('renders a known value with its hint', () => {
    render(<MetricCard label="事件" value={23521} hint="选定范围内" />)

    expect(screen.getByText('事件')).toBeDefined()
    expect(screen.getByText('23,521')).toBeDefined()
    expect(screen.getByText('选定范围内')).toBeDefined()
  })

  it('renders an unknown value as an em dash and says so', () => {
    // `null` means the sub-query failed. Rendering 0 would turn "we do not
    // know" into "there is nothing".
    render(<MetricCard label="主机" value={null} hint="去重计数" />)

    expect(screen.getByText('—')).toBeDefined()
    expect(screen.getByText('不可用')).toBeDefined()
    expect(screen.queryByText('去重计数')).toBeNull()
  })

  it('keeps a genuine zero distinct from an unknown value', () => {
    render(<MetricCard label="服务" value={0} hint="去重计数" />)

    expect(screen.getByText('0')).toBeDefined()
    expect(screen.getByText('去重计数')).toBeDefined()
    expect(screen.queryByText('不可用')).toBeNull()
  })

  it('renders without a hint row when no hint was given', () => {
    const { container } = render(<MetricCard label="时间桶" value={4} />)

    expect(screen.getByText('4')).toBeDefined()
    // label + value are the only two direct children.
    expect(container.firstElementChild?.children).toHaveLength(2)
  })
})
