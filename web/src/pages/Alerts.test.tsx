// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { fetchAlerts } from '../api/endpoints'
import { ApiError } from '../api/client'
import type { AlertList } from '../types/api'
import { Alerts } from './Alerts'

vi.mock('../api/endpoints', () => ({ fetchAlerts: vi.fn() }))

const fetchAlertsMock = vi.mocked(fetchAlerts)

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

function alertList(overrides: Partial<AlertList> = {}): AlertList {
  return {
    success: true,
    source: 'splunk',
    count: 1,
    alerts: [{ name: 'High error rate' }],
    truncated: false,
    ...overrides,
  }
}

describe('Alerts', () => {
  it('shows progress while the fired alerts load', () => {
    fetchAlertsMock.mockReturnValue(new Promise(() => {}))

    render(<Alerts />)

    expect(screen.getByText('正在加载已触发的告警…')).toBeDefined()
  })

  it('lists fired alerts with their count and source', async () => {
    fetchAlertsMock.mockResolvedValue(
      alertList({
        count: 2,
        alerts: [{ name: 'High error rate' }, { name: 'Disk almost full' }],
      }),
    )

    render(<Alerts />)

    await screen.findByText('High error rate')
    expect(screen.getByText('Disk almost full')).toBeDefined()
    expect(screen.getByText('2 条告警 · splunk')).toBeDefined()
    expect(screen.getByText('已触发的告警')).toBeDefined()
  })

  it('names the empty state instead of rendering an empty list', async () => {
    fetchAlertsMock.mockResolvedValue(alertList({ count: 0, alerts: [] }))

    render(<Alerts />)

    await screen.findByText('暂无告警触发。')
    expect(screen.getByText('0 条告警 · splunk')).toBeDefined()
  })

  it('renders the backend note explaining a degraded alert list', async () => {
    fetchAlertsMock.mockResolvedValue(
      alertList({ count: 0, alerts: [], note: 'saved searches were not readable' }),
    )

    render(<Alerts />)

    await screen.findByText('saved searches were not readable')
  })

  it('omits the note when the backend sent none', async () => {
    fetchAlertsMock.mockResolvedValue(alertList())

    render(<Alerts />)

    await screen.findByText('High error rate')
    const noteNodes = screen.queryAllByText(/saved searches/)
    expect(noteNodes).toHaveLength(0)
  })

  it('reports a failed alerts request', async () => {
    fetchAlertsMock.mockRejectedValue(new ApiError('SplunkAuthenticationError', '认证失败', 401))

    render(<Alerts />)

    await screen.findByText('认证失败')
    expect(screen.getByText('SplunkAuthenticationError')).toBeDefined()
  })

  it('says there is no data when the request neither failed nor returned a list', async () => {
    fetchAlertsMock.mockResolvedValue(null as unknown as AlertList)

    render(<Alerts />)

    await screen.findByText('无数据。')
  })

  it('documents that alert mutation is not implemented', async () => {
    fetchAlertsMock.mockResolvedValue(alertList())

    render(<Alerts />)

    await screen.findByText(/启用、停用、编辑和删除告警均未实现/)
  })
})
