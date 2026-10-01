// lib/path-rewrite.mjs — 本机路径翻译：git/镜像侧保留远端规范 cwd，本机 sessionRoot
// 映射到可解析目录。映射表落在 $DSH_HOME/dsh-session-sync/path-rewrite.json（不进 git）。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { projectKey } from './project-key.mjs'

/**
 * @typedef {object} PathRewriteConfig
 * @property {boolean} enabled
 * @property {string} localRoot - 自动分配本机工作区目录的父路径。
 * @property {Array<{from: string, to: string}>} rules - 种子映射（规范 → 本机）。
 */

/**
 * @param {string} dshHome - $DSH_HOME。
 * @returns {string}
 */
export function pathRewriteStatePath(dshHome) {
  return path.join(dshHome, 'dsh-session-sync', 'path-rewrite.json')
}

/**
 * @param {string} cwd - 任意路径。
 * @returns {string} 规范化比较键（统一分隔符，去尾部分隔符）。
 */
export function normalizeCwdKey(cwd) {
  return path.normalize(cwd).replace(/[/\\]+$/u, '')
}

/**
 * @param {string} cwd - 规范 cwd。
 * @param {string} localRoot - 本机根。
 * @returns {string}
 */
function allocateLocalPath(cwd, localRoot) {
  const base = path.basename(normalizeCwdKey(cwd)) || 'workspace'
  const safe = base.replace(/[<>:"|?*\u0000-\u001f]/gu, '_').slice(0, 64) || 'workspace'
  const hash = createHash('sha1').update(normalizeCwdKey(cwd)).digest('hex').slice(0, 8)
  return path.join(localRoot, `${safe}-${hash}`)
}

/**
 * 路径翻译器：规范 cwd（远端/git）↔ 本机 cwd。
 */
export class PathRewriter {
  /** @param {PathRewriteConfig} config */
  /** @param {string} stateFile - 持久化路径。 */
  /** @param {{warn?: Function, info?: Function}} [logger] */
  constructor(config, stateFile, logger = {}) {
    this.#enabled = config.enabled === true
    this.#localRoot = config.localRoot
    this.#stateFile = stateFile
    this.#logger = logger
    /** @type {Map<string, string>} 规范 → 本机 */
    this.#forward = new Map()
    /** @type {Map<string, string>} 本机 → 规范 */
    this.#reverse = new Map()
    for (const rule of config.rules ?? []) {
      if (typeof rule?.from === 'string' && typeof rule?.to === 'string' && rule.from && rule.to) {
        this.#remember(rule.from, rule.to, false)
      }
    }
  }

  #enabled
  #localRoot
  #stateFile
  #logger
  #forward
  #reverse
  #loaded = false

  get enabled() {
    return this.#enabled && typeof this.#localRoot === 'string' && this.#localRoot.length > 0
  }

  /** @param {string} canonical @param {string} local @param {boolean} persist */
  #remember(canonical, local, persist) {
    const c = normalizeCwdKey(canonical)
    const l = normalizeCwdKey(local)
    this.#forward.set(c, l)
    this.#reverse.set(l, c)
    if (persist) this.#dirty = true
  }

  #dirty = false

  async #ensureLoaded() {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const raw = await fs.readFile(this.#stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      const entries = parsed?.entries
      if (entries && typeof entries === 'object') {
        for (const [from, to] of Object.entries(entries)) {
          if (typeof from === 'string' && typeof to === 'string') this.#remember(from, to, false)
        }
      }
    } catch {
      // 无文件或损坏 → 从空表 + 种子规则开始。
    }
  }

  async #flush() {
    if (!this.#dirty) return
    await fs.mkdir(path.dirname(this.#stateFile), { recursive: true })
    const entries = Object.fromEntries(this.#forward.entries())
    const body = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`
    await fs.writeFile(this.#stateFile, body)
    this.#dirty = false
  }

  /**
   * 规范 cwd → 本机 cwd。若本机路径已可解析且未映射，原样返回。
   * @param {string} canonicalCwd
   * @returns {Promise<string>}
   */
  async toLocal(canonicalCwd) {
    if (!this.enabled) return canonicalCwd
    await this.#ensureLoaded()
    const key = normalizeCwdKey(canonicalCwd)
    const mapped = this.#forward.get(key)
    if (mapped !== undefined) {
      await fs.mkdir(mapped, { recursive: true })
      return mapped
    }
    // 本机已能访问该路径 → 不翻译（本机会话）。
    try {
      const st = await fs.stat(key)
      if (st.isDirectory()) return key
    } catch {
      // 不存在 → 分配本机目录。
    }
    const local = allocateLocalPath(key, this.#localRoot)
    this.#remember(key, local, true)
    await fs.mkdir(local, { recursive: true })
    await this.#flush()
    this.#logger.info?.(`path-rewrite: map ${key} → ${local}`)
    return local
  }

  /**
   * 本机 cwd → 规范 cwd；无映射则 undefined（表示按原路径提交）。
   * @param {string} localCwd
   * @returns {Promise<string|undefined>}
   */
  async toCanonical(localCwd) {
    if (!this.enabled) return undefined
    await this.#ensureLoaded()
    return this.#reverse.get(normalizeCwdKey(localCwd))
  }

  /**
   * 某项目目录（projectKey）若对应已映射的规范侧，返回规范 projectKey（用于清理重复）。
   * @param {string} localProjectKey
   * @returns {Promise<string|undefined>}
   */
  async canonicalProjectKeyForLocal(localProjectKey) {
    if (!this.enabled) return undefined
    await this.#ensureLoaded()
    for (const [canonical, local] of this.#forward) {
      if (projectKey(local) === localProjectKey) return projectKey(canonical)
    }
    return undefined
  }

  /**
   * 所有「规范 projectKey」（用于 pull 后清掉 sessionRoot 里未翻译的残留）。
   * @returns {Promise<string[]>}
   */
  async canonicalProjectKeys() {
    if (!this.enabled) return []
    await this.#ensureLoaded()
    return [...this.#forward.keys()].map(projectKey)
  }
}

/**
 * 从配置片段构造 rewriter；未启用时返回 enabled=false 的实例。
 * @param {object} resolved - resolveConfig 结果。
 * @param {string|undefined} dshHome
 * @param {{warn?: Function, info?: Function}} [logger]
 * @returns {PathRewriter}
 */
export function createPathRewriter(resolved, dshHome, logger) {
  const enabled = resolved.pathRewriteEnabled === true
  const localRoot = typeof resolved.pathRewriteLocalRoot === 'string' ? resolved.pathRewriteLocalRoot : ''
  const rules = Array.isArray(resolved.pathRewriteRules) ? resolved.pathRewriteRules : []
  const stateFile = typeof dshHome === 'string' && dshHome.length > 0
    ? pathRewriteStatePath(dshHome)
    : path.join(path.resolve('.'), 'dsh-session-sync', 'path-rewrite.json')
  return new PathRewriter({ enabled, localRoot, rules }, stateFile, logger)
}
