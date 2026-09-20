import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { createApp } from '../../server/app'
import { loadSettings } from '../../server/config/settings'
import {
  API_ROUTES,
  ownsApiPath,
  resolveWebDir,
  webDirCandidates,
} from '../../server/web/static'

const SETTINGS = () =>
  loadSettings({}, { SPLUNK_CONFIG_DIR: '/nonexistent-for-tests' }, '/nonexistent-cwd')

describe('静态资源 / SPA fallback', () => {
  let build: string

  beforeEach(() => {
    build = mkdtempSync(join(tmpdir(), 'splunk-cli-web-'))
    writeFileSync(join(build, 'index.html'), '<!doctype html><title>dashboard</title>')
    mkdirSync(join(build, 'assets'))
    writeFileSync(join(build, 'assets', 'app-abc123.js'), 'console.log(1)')
    // 构建目录之外的文件，用于验证目录穿越防护
    writeFileSync(join(build, '..', 'outside-secret.txt'), 'secret')
  })

  afterEach(() => {
    rmSync(build, { recursive: true, force: true })
  })

  it('前端未构建 → 503 + FrontendNotBuilt，且提示里给出可行做法', async () => {
    const app = createApp({ settings: SETTINGS(), webDir: null })
    const response = await request(app).get('/')
    expect(response.status).toBe(503)
    expect(response.body.success).toBe(false)
    expect(response.body.error.type).toBe('FrontendNotBuilt')
    expect(response.body.error.message).toContain('npm run build')
    expect(response.body.error.message).toContain('/api')
  })

  it('已构建 → / 返回 index.html', async () => {
    const app = createApp({ settings: SETTINGS(), webDir: build })
    const response = await request(app).get('/')
    expect(response.status).toBe(200)
    expect(response.text).toContain('dashboard')
  })

  it('构建目录的路径含点目录段时，/ 仍然返回 index.html', async () => {
    // 回归：`res.sendFile(绝对路径)` 不带 `root` 时，`send` 会把**整条绝对路径**按
    // dotfile 检查，任何一段以 `.` 开头就 404——于是装在 `~/.nvm`、`~/.local`、
    // `~/.pnpm` 下的面板首页 404，再被错误中间件变成 500 `internal error`。
    // `/index.html` 反而正常，因为它走 express.static（那里 root 是传了的）。
    const dotted = mkdtempSync(join(tmpdir(), 'splunk-cli-dot-'))
    const dottedBuild = join(dotted, '.hidden', 'web')
    mkdirSync(dottedBuild, { recursive: true })
    writeFileSync(join(dottedBuild, 'index.html'), '<!doctype html><title>dotted dashboard</title>')
    writeFileSync(join(dottedBuild, 'app.js'), 'console.log(2)')
    try {
      const app = createApp({ settings: SETTINGS(), webDir: dottedBuild })

      const root = await request(app).get('/')
      expect(root.status).toBe(200)
      expect(root.text).toContain('dotted dashboard')

      // SPA 深链走同一条 fallback
      const deep = await request(app).get('/some/spa/route')
      expect(deep.status).toBe(200)
      expect(deep.text).toContain('dotted dashboard')

      // 真实存在的静态文件也要能取到
      const asset = await request(app).get('/app.js')
      expect(asset.status).toBe(200)
      expect(asset.text).toContain('console.log(2)')
    } finally {
      rmSync(dotted, { recursive: true, force: true })
    }
  })

  it('已构建 → 静态资源按原样提供', async () => {
    const app = createApp({ settings: SETTINGS(), webDir: build })
    const response = await request(app).get('/assets/app-abc123.js')
    expect(response.status).toBe(200)
    expect(response.text).toContain('console.log')
  })

  it('未知的前端路径回落 index.html（SPA 路由）', async () => {
    const app = createApp({ settings: SETTINGS(), webDir: build })
    const response = await request(app).get('/alerts')
    expect(response.status).toBe(200)
    expect(response.text).toContain('dashboard')
  })

  it('目录穿越被挡住（不会把构建目录之外的文件吐出去）', async () => {
    const app = createApp({ settings: SETTINGS(), webDir: build })
    const response = await request(app).get('/..%2Foutside-secret.txt')
    expect(response.text).not.toContain('secret')
  })

  it('index.html 带 no-store，避免页面一直加载已删除的资源', async () => {
    const app = createApp({ settings: SETTINGS(), webDir: build })
    const response = await request(app).get('/')
    expect(response.headers['cache-control']).toContain('no-store')
  })
})

describe('API 命名空间的 404 / 405（保留框架既有的 detail 形状）', () => {
  const app = createApp({ settings: SETTINGS(), webDir: null })

  it('未知 API 路径 → 404 {"detail":"Not Found"}', async () => {
    const response = await request(app).get('/api/nope')
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ detail: 'Not Found' })
  })

  it('已知 API 路径但方法不对 → 405 {"detail":"Method Not Allowed"}', async () => {
    const response = await request(app).post('/api/health').send({})
    expect(response.status).toBe(405)
    expect(response.body).toEqual({ detail: 'Method Not Allowed' })
  })

  it('GET 到只接受 POST 的路径同样 405', async () => {
    const response = await request(app).get('/api/search')
    expect(response.status).toBe(405)
  })

  it('ownsApiPath 的边界：/api 本身属于 API，/apix 不属于', () => {
    expect(ownsApiPath('/api')).toBe(true)
    expect(ownsApiPath('/api/health')).toBe(true)
    expect(ownsApiPath('/apix')).toBe(false)
    expect(ownsApiPath('/')).toBe(false)
  })

  it('API 路由表与文档一致（8 条）', () => {
    expect([...API_ROUTES.keys()].sort()).toEqual([
      '/api/alerts',
      '/api/health',
      '/api/overview',
      '/api/search',
      // 唯一一条不动 Splunk 的端点：它关的是这个进程自己。
      '/api/shutdown',
      '/api/stats',
      '/api/timeline',
      '/api/version',
    ])
  })
})

describe('resolveWebDir 探测', () => {
  it('没有 index.html 的目录不算构建产物', () => {
    const empty = mkdtempSync(join(tmpdir(), 'splunk-cli-web-empty-'))
    try {
      expect(resolveWebDir([empty])).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('候选目录覆盖源码形态与打包形态', () => {
    const candidates = webDirCandidates()
    expect(candidates).toHaveLength(2)
    expect(candidates.some((path) => path.endsWith(join('dist', 'web')))).toBe(true)
  })
})

describe('前端外壳的图标', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8')

  it('标题栏声明了图标，并且图标确实会被构建复制进 dist/web', () => {
    // 白色 mark 在浏览器标签页的浅色底上等于看不见，所以页面必须自己带上
    // 「黑底 + 白 mark」的那一份，而它得先在 Vite 的 publicDir 里才发得出去。
    expect(html).toContain('rel="icon"')
    expect(html).toContain('href="/appIcon.png"')

    const icon = join(root, 'web', 'public', 'appIcon.png')
    expect(existsSync(icon)).toBe(true)
    expect(statSync(icon).size).toBeGreaterThan(0)
  })

  it('保留白色 mark 的原图，图标可以从它重新生成', () => {
    // 原图是 36×36 的透明底白色 mark；黑底那一份是它的派生物。两个都留着，
    // 否则改尺寸或改底色时只能从成品里去反推。
    const source = readFileSync(join(root, 'web', 'assets', 'appIcon.png'))
    expect(source.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(source.readUInt32BE(16)).toBe(36)
    expect(source.readUInt32BE(20)).toBe(36)

    const rendered = readFileSync(join(root, 'web', 'public', 'appIcon.png'))
    // 标签页要的是 180×180（苹果触屏尺寸），浏览器自己缩到 16/32。
    expect(rendered.readUInt32BE(16)).toBe(180)
    expect(rendered.readUInt32BE(20)).toBe(180)
  })

  it('苹果触屏图标与浏览器 chrome 底色也用同一份资源', () => {
    expect(html).toContain('rel="apple-touch-icon"')
    expect(html).toContain('content="#08090C"')
  })
})
