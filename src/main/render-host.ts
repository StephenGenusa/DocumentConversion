import { BrowserWindow, session, type Session } from 'electron'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { renderCacheKey } from '../core/draw-blocks'
import { sanitizeSvg } from '../core/svg-sanitize'
import { MAX_SOURCE_BYTES, type RenderBlocks, type RenderKind, type RenderRequest, type RenderResult } from '../core/rendered-blocks'

/**
 * The render host (spec B5): one hidden window that draws diagrams (and, in
 * later steps, formulas) from vendored engines, for conversions now and for
 * the editor (render-ipc.ts).
 *
 *   window      hidden, sandboxed, context-isolated, no preload, JavaScript
 *               on (the engines are scripts). Created on first need, closed
 *               after a minute with nothing to do.
 *   network     its own in-memory session partition, whose every request is
 *               cancelled except the bundled page and the engine files beside
 *               it (resources/render). Navigation, redirects, new windows,
 *               downloads and permission requests are all refused. The page's
 *               own CSP says the same.
 *   engines     each loaded by the page the first time a block of its kind
 *               is drawn, never at start.
 *   queue       one block at a time (the page is one thread), by priority:
 *               editor blocks on screen, then conversions, then editor
 *               prefetch; first come first served within a priority.
 *   cache       one LRU for every caller, keyed by renderCacheKey (kind,
 *               display, format, source, engine version): 2,000 drawings or
 *               64 MB. A diagram the editor has drawn converts without being
 *               drawn again.
 *   time        a block over its time limit gets an error, and the window is
 *               closed (a stuck engine cannot be interrupted any other way);
 *               the next block opens a fresh one.
 *
 * Every SVG an engine returns is sanitised here (svg-sanitize.ts, spec B6)
 * before it is cached, rasterised or handed back. Arguments reach the page
 * only as JSON literals in executeJavaScript.
 */

/** Engine versions, part of every cache key. Keep in step with scripts/build-render-assets.mjs. */
export const ENGINE_VERSIONS: Partial<Record<RenderKind, string>> = { mermaid: '11.12.0' }

/** The engine files the page may load, by kind. */
const ENGINE_FILES: Partial<Record<RenderKind, string>> = { mermaid: 'mermaid.min.js' }

/** Who is waiting: visible editor blocks first, conversions next, editor prefetch last. */
export type RenderPriority = 'visible' | 'convert' | 'prefetch'
const PRIORITY_ORDER: Record<RenderPriority, number> = { visible: 0, convert: 1, prefetch: 2 }

/** The largest source drawn; the editor's IPC applies the same cap (spec B11). */
export { MAX_SOURCE_BYTES }

/** PNG is the SVG drawn at this many device pixels per CSS px (spec B5). */
const PNG_SCALE = 2

export interface RenderCallOptions {
  priority?: RenderPriority
  signal?: AbortSignal
  /** Drawing time allowed once the block reaches the page. */
  timeoutMs?: number
}

export interface RenderHostOptions {
  /** Where host.html and the engines are. Defaults to resources/render. */
  pageDir?: string
  /** Close the window after this long with nothing to draw. */
  idleMs?: number
  cacheEntries?: number
  cacheBytes?: number
  /** Default per-block time limit. */
  timeoutMs?: number
  /** Session partition (in memory: no `persist:` prefix). */
  partition?: string
  /** Every request the window makes, allowed or not (the host test's request log). */
  onRequest?: (url: string, allowed: boolean) => void
  /** The raw answer from the page, before sanitising (tests: what a directive could change). */
  onDrawn?: (req: RenderRequest, raw: { svg: string; config?: Record<string, unknown> }) => void
}

export interface RenderHostStats {
  windowOpen: boolean
  /** Windows opened so far. */
  windows: number
  /** Blocks the engines actually drew (cache misses). */
  draws: number
  cacheEntries: number
  cacheBytes: number
}

export interface RenderHost {
  /** One block, for the editor (render-ipc.ts) or anything else. */
  render(req: RenderRequest, opts?: RenderCallOptions): Promise<RenderResult>
  /** ConverterDeps.renderBlocks: conversion priority, results in order. */
  renderBlocks: RenderBlocks
  stats(): RenderHostStats
  /** Close the window now (the cache is kept). */
  close(): void
}

/** resources/render, wherever this run keeps it (see sqliteAssetDir for why several roots). */
export function renderAssetDir(): string {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  const unpacked = (p: string): string => p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, 'app.asar.unpacked', 'resources', 'render')] : []),
    unpacked(join(__dirname, '..', '..', 'resources', 'render')),
    join(process.cwd(), 'resources', 'render'),
  ]
  return candidates.find((dir) => existsSync(join(dir, 'host.html'))) ?? candidates[0]
}

interface Job {
  req: RenderRequest
  key: string
  priority: number
  seq: number
  timeoutMs: number
  waiters: Array<{ resolve: (r: RenderResult) => void; reject: (e: Error) => void; signal?: AbortSignal }>
}

class Lru {
  private map = new Map<string, { value: RenderResult; bytes: number }>()
  bytes = 0
  constructor(
    private maxEntries: number,
    private maxBytes: number,
  ) {}
  get size(): number {
    return this.map.size
  }
  get(key: string): RenderResult | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }
  set(key: string, value: RenderResult): void {
    const bytes =
      'error' in value ? value.error.length * 2 : (value.png?.length ?? 0) + (value.svg?.length ?? 0) * 2 + 64
    if (bytes > this.maxBytes) return
    const old = this.map.get(key)
    if (old) {
      this.bytes -= old.bytes
      this.map.delete(key)
    }
    this.map.set(key, { value, bytes })
    this.bytes += bytes
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [oldest, entry] = this.map.entries().next().value as [string, { bytes: number }]
      this.map.delete(oldest)
      this.bytes -= entry.bytes
    }
  }
}

class TimeoutError extends Error {}

/** A CSS px size the page may answer: a whole, positive, sane number. */
const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 100_000

const cancelled = (): Error => Object.assign(new Error('Cancelled'), { name: 'AbortError' })

export function createRenderHost(opts: RenderHostOptions = {}): RenderHost {
  const pageDir = resolve(opts.pageDir ?? renderAssetDir())
  const pagePath = join(pageDir, 'host.html')
  const idleMs = opts.idleMs ?? 60_000
  const defaultTimeout = opts.timeoutMs ?? 10_000
  const cache = new Lru(opts.cacheEntries ?? 2000, opts.cacheBytes ?? 64 * 1024 * 1024)
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const allowedFiles = new Set(
    [pagePath, join(pageDir, 'host.js'), ...Object.values(ENGINE_FILES).map((f) => join(pageDir, f!))].map(fold),
  )

  const queue: Job[] = []
  const inQueue = new Map<string, Job>()
  let seq = 0
  let running = false
  let win: BrowserWindow | undefined
  let opening: Promise<BrowserWindow> | undefined
  let idleTimer: NodeJS.Timeout | undefined
  let windows = 0
  let draws = 0
  let renderSession: Session | undefined

  function mayLoad(url: string): boolean {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    if (parsed.protocol !== 'file:' || parsed.host !== '' || parsed.search || parsed.hash) return false
    try {
      return allowedFiles.has(fold(resolve(fileURLToPath(parsed))))
    } catch {
      return false
    }
  }

  function offlineSession(): Session {
    if (!renderSession) {
      renderSession = session.fromPartition(opts.partition ?? 'docconv-render')
      renderSession.webRequest.onBeforeRequest((details, callback) => {
        const allowed = mayLoad(details.url)
        opts.onRequest?.(details.url, allowed)
        callback({ cancel: !allowed })
      })
      renderSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      renderSession.setPermissionCheckHandler(() => false)
      renderSession.on('will-download', (e) => e.preventDefault())
    }
    return renderSession
  }

  async function openWindow(): Promise<BrowserWindow> {
    const w = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        webSecurity: true,
        // A hidden window's timers and frames are throttled; the engines must not be.
        backgroundThrottling: false,
        spellcheck: false,
        session: offlineSession(),
      },
    })
    windows++
    w.webContents.on('will-navigate', (e) => e.preventDefault())
    w.webContents.on('will-redirect', (e) => e.preventDefault())
    w.webContents.on('will-attach-webview', (e) => e.preventDefault())
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.webContents.on('render-process-gone', () => discard(w))
    w.on('closed', () => {
      if (win === w) win = undefined
    })
    try {
      await w.loadFile(pagePath)
      const ready = await w.webContents.executeJavaScript('Boolean(window.renderHost && window.renderHost.ready)')
      if (!ready) throw new Error('The render page did not start')
    } catch (err) {
      discard(w)
      throw err
    }
    return w
  }

  function discard(w: BrowserWindow | undefined, stuck = false): void {
    if (!w) return
    if (win === w) win = undefined
    if (!w.isDestroyed()) {
      // A renderer stuck in an engine's loop does not answer a close; ending
      // its process is the only reliable stop.
      if (stuck) {
        try {
          w.webContents.forcefullyCrashRenderer()
        } catch {
          /* already gone */
        }
      }
      w.destroy()
    }
  }

  async function windowForWork(): Promise<BrowserWindow> {
    if (win && !win.isDestroyed()) return win
    if (!opening) {
      opening = openWindow().finally(() => {
        opening = undefined
      })
    }
    win = await opening
    return win
  }

  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (!running && queue.length === 0) discard(win)
    }, idleMs)
    idleTimer.unref?.()
  }

  function call<T>(w: BrowserWindow, fn: string, args: unknown[], timeoutMs: number): Promise<T> {
    const code = `window.renderHost.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`
    let timer: NodeJS.Timeout | undefined
    return Promise.race([
      w.webContents.executeJavaScript(code) as Promise<T>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError()), timeoutMs)
      }),
    ]).finally(() => clearTimeout(timer))
  }

  /** Draw one block in the page: the engine's SVG, sanitised, and for PNG rasterised. */
  async function draw(job: Job): Promise<{ result: RenderResult; cacheable: boolean }> {
    const { req } = job
    const started = Date.now()
    let w: BrowserWindow
    try {
      w = await windowForWork()
    } catch (err) {
      return { result: { error: `the render window could not start: ${(err as Error).message}` }, cacheable: false }
    }
    const left = (): number => Math.max(1, job.timeoutMs - (Date.now() - started))
    try {
      type Answer<T> = { ok: true; value: T } | { ok: false; error: string }
      const drawn = await call<Answer<{ svg: string; width: number; height: number; config?: Record<string, unknown> }>>(
        w,
        'draw',
        [req.kind, req.source],
        left(),
      )
      draws++
      if (!drawn.ok) return { result: { error: drawn.error }, cacheable: true }
      opts.onDrawn?.(req, { svg: drawn.value.svg, config: drawn.value.config })
      // The page is the engines' playground: nothing it answers is trusted.
      const { width, height } = drawn.value
      if (!isSize(width) || !isSize(height) || typeof drawn.value.svg !== 'string') {
        return { result: { error: 'the engine returned a picture with no usable size' }, cacheable: true }
      }
      const svg = sanitizeSvg(drawn.value.svg)
      if (!svg) return { result: { error: 'the engine returned something that is not an SVG' }, cacheable: true }
      if (req.format === 'svg') return { result: { svg, width, height }, cacheable: true }
      const png = await call<Answer<string>>(w, 'rasterize', [svg, width, height, PNG_SCALE], left())
      if (!png.ok) return { result: { error: png.error }, cacheable: false }
      if (typeof png.value !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(png.value)) {
        return { result: { error: 'the picture could not be made' }, cacheable: false }
      }
      return { result: { png: png.value, width, height }, cacheable: true }
    } catch (err) {
      discard(w, true)
      if (err instanceof TimeoutError) {
        return { result: { error: `drawing took longer than ${Math.round(job.timeoutMs / 1000)} s` }, cacheable: false }
      }
      return { result: { error: `the render window stopped: ${(err as Error).message}` }, cacheable: false }
    }
  }

  async function pump(): Promise<void> {
    if (running) return
    running = true
    if (idleTimer) clearTimeout(idleTimer)
    try {
      while (queue.length > 0) {
        queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
        const job = queue.shift()!
        inQueue.delete(job.key)
        job.waiters = job.waiters.filter((wt) => !wt.signal?.aborted)
        if (job.waiters.length === 0) continue
        const { result, cacheable } = await draw(job)
        if (cacheable) cache.set(job.key, result)
        for (const wt of job.waiters) wt.resolve(result)
      }
    } finally {
      running = false
      armIdle()
    }
  }

  function render(req: RenderRequest, callOpts: RenderCallOptions = {}): Promise<RenderResult> {
    const { signal } = callOpts
    if (signal?.aborted) return Promise.reject(cancelled())
    const version = ENGINE_VERSIONS[req.kind]
    if (!version) return Promise.resolve({ error: `${req.kind} is not drawn yet` })
    if (typeof req.source !== 'string' || Buffer.byteLength(req.source, 'utf8') > MAX_SOURCE_BYTES) {
      return Promise.resolve({ error: `the source is over ${MAX_SOURCE_BYTES / 1024} KB` })
    }
    if (req.format !== 'png' && req.format !== 'svg') return Promise.resolve({ error: `no format ${String(req.format)}` })
    const key = renderCacheKey(req, version)
    const hit = cache.get(key)
    if (hit) return Promise.resolve(hit)
    const priority = PRIORITY_ORDER[callOpts.priority ?? 'convert']
    return new Promise<RenderResult>((resolvePromise, reject) => {
      const waiter = { resolve: resolvePromise, reject, signal }
      let job = inQueue.get(key)
      if (job) {
        // Asked again while waiting: one drawing, at the most urgent priority asked.
        job.priority = Math.min(job.priority, priority)
        job.timeoutMs = Math.max(job.timeoutMs, callOpts.timeoutMs ?? defaultTimeout)
        job.waiters.push(waiter)
      } else {
        job = { req: { ...req }, key, priority, seq: seq++, timeoutMs: callOpts.timeoutMs ?? defaultTimeout, waiters: [waiter] }
        inQueue.set(key, job)
        queue.push(job)
      }
      signal?.addEventListener(
        'abort',
        () => {
          const queued = inQueue.get(key)
          if (queued) queued.waiters = queued.waiters.filter((wt) => wt !== waiter)
          reject(cancelled())
        },
        { once: true },
      )
      void pump()
    })
  }

  const renderBlocks: RenderBlocks = (requests, blockOpts) =>
    Promise.all(
      requests.map((req) => render(req, { priority: 'convert', signal: blockOpts.signal, timeoutMs: blockOpts.timeoutMs })),
    )

  return {
    render,
    renderBlocks,
    stats: () => ({
      windowOpen: Boolean(win && !win.isDestroyed()),
      windows,
      draws,
      cacheEntries: cache.size,
      cacheBytes: cache.bytes,
    }),
    close: () => {
      if (idleTimer) clearTimeout(idleTimer)
      discard(win)
    },
  }
}
