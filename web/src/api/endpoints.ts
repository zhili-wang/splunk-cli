/** Typed wrappers for each dashboard endpoint. */

import { getJson, postJson } from './client'
import type {
  AlertList,
  HealthReport,
  OverviewResponse,
  SearchResult,
  StatsResult,
  TimelineResult,
  VersionInfo,
} from '../types/api'

export interface RangeArgs {
  query: string
  earliest?: string
  latest?: string
}

export function fetchHealth(): Promise<HealthReport> {
  // Probe connectivity and auth only. The license pools are a second backend
  // call per poll, and the dashboard renders no license field, so asking for
  // them would cost a request every 30s and let a license-only failure make a
  // reachable Splunk look offline.
  return getJson<HealthReport>('/api/health?include_license=false')
}

export function fetchOverview(args: RangeArgs & { span?: string }): Promise<OverviewResponse> {
  return postJson<OverviewResponse>('/api/overview', args)
}

export function fetchSearch(args: RangeArgs & { limit?: number }): Promise<SearchResult> {
  return postJson<SearchResult>('/api/search', args)
}

export function fetchStats(
  args: RangeArgs & { by?: string; function?: string; limit?: number },
): Promise<StatsResult> {
  return postJson<StatsResult>('/api/stats', args)
}

export function fetchTimeline(args: RangeArgs & { span?: string }): Promise<TimelineResult> {
  return postJson<TimelineResult>('/api/timeline', args)
}

export function fetchAlerts(includeSaved = false): Promise<AlertList> {
  return getJson<AlertList>(`/api/alerts?include_saved=${String(includeSaved)}`)
}

/**
 * The version of the CLI that served this page.
 *
 * Not Splunk data: the footer states which build is running, so a mismatch with
 * `splunk-cli --version` is visible without opening a terminal.
 */
export function fetchVersion(): Promise<VersionInfo> {
  return getJson<VersionInfo>('/api/version')
}
