import { describe, expect, it } from 'vitest'
import request from 'supertest'

import { createApp } from '../../server/app'
import { loadSettings } from '../../server/config/settings'
import { okSearchClient } from './stub'
import {
  ALLOWED_HOSTNAMES,
  bareHostname,
  hostAllowed,
  originAllowed,
} from '../../server/web/security'

describe('bareHostname（剥离端口，含 IPv6）', () => {
  it.each([
    ['127.0.0.1:8765', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['localhost:8765', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['[::1]:8765', '::1'],
    ['[::1]', '::1'],
    ['  localhost:1  ', 'localhost'],
  ])('%s -> %s', (input, expected) => {
    expect(bareHostname(input)).toBe(expected)
  })
})

describe('hostAllowed / originAllowed', () => {
  it('只接受回环主机名', () => {
    expect([...ALLOWED_HOSTNAMES].sort()).toEqual(['127.0.0.1', '::1', 'localhost'])
    expect(hostAllowed('127.0.0.1:8765')).toBe(true)
    expect(hostAllowed('localhost:8765')).toBe(true)
    expect(hostAllowed('[::1]:8765')).toBe(true)
    expect(hostAllowed('evil.com:8765')).toBe(false)
    expect(hostAllowed('127.0.0.1.evil.com')).toBe(false)
    expect(hostAllowed('0.0.0.0:8765')).toBe(false)
    expect(hostAllowed(undefined)).toBe(false)
    expect(hostAllowed('')).toBe(false)
  })

  it('Origin 缺失时放行（非浏览器客户端不带该头）', () => {
    expect(originAllowed(undefined)).toBe(true)
    expect(originAllowed('http://127.0.0.1:8765')).toBe(true)
    expect(originAllowed('http://localhost:5173')).toBe(true)
    expect(originAllowed('http://evil.com')).toBe(false)
    // 畸形或 "null" Origin 一律拒绝
    expect(originAllowed('null')).toBe(false)
    expect(originAllowed('')).toBe(false)
    expect(originAllowed('not a url')).toBe(false)
  })
})

describe('HostGuard 中间件（端到端）', () => {
  const app = createApp({
    settings: loadSettings({}, { SPLUNK_CONFIG_DIR: '/nonexistent-for-tests' }, '/nonexistent-cwd'),
    webDir: null,
  })

  it('合法 Host 通过守卫（走到 503，说明没被 403 拦下）', async () => {
    const response = await request(app).get('/')
    expect(response.status).toBe(503)
  })

  it('非法 Host → 403 + 标准错误信封（type=ForbiddenOrigin）', async () => {
    const response = await request(app).get('/api/health').set('Host', 'evil.com:8765')
    expect(response.status).toBe(403)
    expect(response.body.success).toBe(false)
    expect(response.body.error.type).toBe('ForbiddenOrigin')
    expect(response.body.error.message).toContain('Host header')
  })

  it('跨源 Origin → 403', async () => {
    const response = await request(app)
      .post('/api/search')
      .set('Origin', 'http://evil.com')
      .send({ query: 'index=x' })
    expect(response.status).toBe(403)
    expect(response.body.error.type).toBe('ForbiddenOrigin')
    expect(response.body.error.message).toContain('Origin header')
  })

  it('守卫先于 body 解析：敌意 Host + 合法 body 得到 403 而不是 422', async () => {
    const response = await request(app)
      .post('/api/search')
      .set('Host', 'evil.com')
      .send({ query: 'index=x' })
    expect(response.status).toBe(403)
  })

  it('同源 Origin 放行（改用离线客户端，避免"未配置"造成的 500 干扰判断）', async () => {
    const healthy = createApp({
      settings: loadSettings({}, { SPLUNK_CONFIG_DIR: '/nonexistent-for-tests' }, '/nonexistent-cwd'),
      client: okSearchClient(),
      webDir: null,
    })
    const response = await request(healthy).get('/api/health?include_license=false')
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
  })
})
