// lib/mirror.mjs — 会话目录 ↔ git 工作树的字节镜像（node:fs；零 DSH 依赖）。
//
// 默认同口径：不透明字节复制。可选 PathRewriter：在边界上改项目目录名并改写
// session header 的 cwd（git 侧始终保留规范路径，本机侧映射到可解析目录）。
// 安全边界：
// - 绝不跟随符号链接；
// - 删除仅限目标树内、源已不存在、且非 fork / 宿主私有产物；
// - fork 文件与宿主私有产物永不复制、永不删除。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { FORK_NAME_RE, HOST_ARTIFACT_NAME_RE } from './constants.mjs'
import { projectKey } from './project-key.mjs'
import { isSessionLogBasename, readSessionCwd, rewriteSessionCwd } from './session-cwd.mjs'

/** 递归枚举 root 下全部常规文件（POSIX 相对路径；符号链接跳过并回报）。 */
async function listFiles(root) {
  const files = []
  const skipped = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        skipped.push(absolute)
        continue
      }
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (entry.isFile()) {
        files.push({ absolute, rel: path.relative(root, absolute).split(path.sep).join('/') })
      }
    }
  }
  await walk(root)
  return { files, skipped }
}

/** 内容一致则跳过写（返回 false），否则覆写（返回 true）。 */
async function writeIfDifferent(target, content) {
  try {
    const existing = await fs.readFile(target)
    if (existing.equals(content)) return false
  } catch {
    // 目标不存在 → 照写。
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  return true
}

/**
 * 按会话目录缓存 cwd（读任一 session 日志 header）。
 * @param {Map<string, string|undefined>} cache
 * @param {string} sourceRoot
 * @param {string} rel
 * @param {(abs: string) => Promise<Buffer>} readFile
 * @returns {Promise<string|undefined>}
 */
async function cwdForRel(cache, sourceRoot, rel, readFile) {
  const parts = rel.split('/')
  if (parts.length < 2) return undefined
  const sessionDirRel = parts.slice(0, 2).join('/')
  if (cache.has(sessionDirRel)) return cache.get(sessionDirRel)
  let cwd
  try {
    const absDir = path.join(sourceRoot, ...sessionDirRel.split('/'))
    const entries = await fs.readdir(absDir)
    for (const name of entries) {
      if (!isSessionLogBasename(name)) continue
      const content = await readFile(path.join(absDir, name))
      cwd = await readSessionCwd(content, name)
      if (cwd !== undefined) break
    }
  } catch {
    cwd = undefined
  }
  cache.set(sessionDirRel, cwd)
  return cwd
}

/**
 * 删除目标树中不在 keep 集合、且非 fork / 宿主私有产物的文件。
 * @param {string} targetRoot
 * @param {Set<string>} keep
 * @param {RegExp} forkRe
 */
async function pruneTarget(targetRoot, keep, forkRe) {
  const deleted = []
  const forkedPreserved = []
  const hostArtifactsPreserved = []
  const targetFiles = []
  try {
    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await walk(absolute)
          continue
        }
        if (entry.isFile()) targetFiles.push(absolute)
      }
    }
    await walk(targetRoot)
  } catch {
    return { deleted, forkedPreserved, hostArtifactsPreserved }
  }
  for (const absolute of targetFiles) {
    const rel = path.relative(targetRoot, absolute).split(path.sep).join('/')
    const basename = path.posix.basename(rel)
    if (forkRe.test(basename)) {
      forkedPreserved.push(rel)
      continue
    }
    if (HOST_ARTIFACT_NAME_RE.test(basename)) {
      hostArtifactsPreserved.push(rel)
      continue
    }
    if (!keep.has(rel)) {
      await fs.unlink(absolute)
      deleted.push(rel)
    }
  }
  return { deleted, forkedPreserved, hostArtifactsPreserved }
}

/**
 * 把 sessionRoot 镜像进 <repoDir>/<mirrorDir>/…（push 方向）。
 * 若提供 rewriter：本机 cwd → 规范 cwd，改路径与 header，使 git 侧保持规范路径。
 * @param {object} deps - {sessionRoot, repoDir, mirrorDir, forkNameRe?, rewriter?}。
 */
export async function mirrorSessionRoot(deps) {
  const forkRe = deps.forkNameRe ?? FORK_NAME_RE
  const rewriter = deps.rewriter
  const source = await listFiles(deps.sessionRoot)
  const mirrorRoot = path.join(deps.repoDir, deps.mirrorDir)
  const targets = new Set()
  const cwdCache = new Map()

  let mirrored = 0
  let unchanged = 0
  let hostArtifactsSkipped = 0
  let rewritten = 0

  for (const file of source.files) {
    if (HOST_ARTIFACT_NAME_RE.test(path.posix.basename(file.rel))) {
      hostArtifactsSkipped += 1
      continue
    }
    let content = await fs.readFile(file.absolute)
    let outRel = file.rel
    if (rewriter?.enabled) {
      const cwd = await cwdForRel(cwdCache, deps.sessionRoot, file.rel, async (abs) => fs.readFile(abs))
      if (cwd !== undefined) {
        const canonical = await rewriter.toCanonical(cwd)
        if (canonical !== undefined && canonical !== cwd) {
          const parts = file.rel.split('/')
          parts[0] = projectKey(canonical)
          outRel = parts.join('/')
          const basename = path.posix.basename(file.rel)
          const result = await rewriteSessionCwd(content, basename, cwd, canonical)
          content = result.content
          if (result.changed) rewritten += 1
        }
      }
    }
    targets.add(outRel)
    const target = path.join(mirrorRoot, ...outRel.split('/'))
    const wrote = await writeIfDifferent(target, content)
    if (wrote) mirrored += 1
    else unchanged += 1
  }

  const pruned = await pruneTarget(mirrorRoot, targets, forkRe)
  return {
    mirrored,
    unchanged,
    rewritten,
    skippedLinks: source.skipped,
    deleted: pruned.deleted,
    forkedPreserved: pruned.forkedPreserved,
    hostArtifactsSkipped,
    hostArtifactsPreserved: pruned.hostArtifactsPreserved,
  }
}

/**
 * 把 <repoDir>/<mirrorDir>/… 回写到 sessionRoot（pull 后）。
 * 若提供 rewriter：规范 cwd → 本机 cwd；并尽量清掉 sessionRoot 里对应的规范侧残留目录文件。
 * @param {object} deps - {sessionRoot, repoDir, mirrorDir, forkNameRe?, rewriter?}。
 */
export async function applyMirrorToSessionRoot(deps) {
  const forkRe = deps.forkNameRe ?? FORK_NAME_RE
  const rewriter = deps.rewriter
  const mirrorRoot = path.join(deps.repoDir, deps.mirrorDir)
  const source = await listFiles(mirrorRoot)
  const targets = new Set()
  const cwdCache = new Map()

  let mirrored = 0
  let unchanged = 0
  let hostArtifactsSkipped = 0
  let rewritten = 0

  for (const file of source.files) {
    if (HOST_ARTIFACT_NAME_RE.test(path.posix.basename(file.rel))) {
      hostArtifactsSkipped += 1
      continue
    }
    let content = await fs.readFile(file.absolute)
    let outRel = file.rel
    if (rewriter?.enabled) {
      const cwd = await cwdForRel(cwdCache, mirrorRoot, file.rel, async (abs) => fs.readFile(abs))
      if (cwd !== undefined) {
        const local = await rewriter.toLocal(cwd)
        if (local !== cwd) {
          const parts = file.rel.split('/')
          parts[0] = projectKey(local)
          outRel = parts.join('/')
          const basename = path.posix.basename(file.rel)
          const result = await rewriteSessionCwd(content, basename, cwd, local)
          content = result.content
          if (result.changed) rewritten += 1
        }
      }
    }
    targets.add(outRel)
    const target = path.join(deps.sessionRoot, ...outRel.split('/'))
    const wrote = await writeIfDifferent(target, content)
    if (wrote) mirrored += 1
    else unchanged += 1
  }

  // 清掉本机仍残留的「规范 projectKey」树（已映射走的那一侧），避免未分组重复。
  if (rewriter?.enabled) {
    const canonicalKeys = new Set(await rewriter.canonicalProjectKeys())
    try {
      const top = await fs.readdir(deps.sessionRoot, { withFileTypes: true })
      for (const entry of top) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        if (!canonicalKeys.has(entry.name)) continue
        // 只删已被 targets 覆盖到本机 key 的规范残留：若仍有文件要以规范 key 存在则保留。
        const stillNeeded = [...targets].some(rel => rel.split('/')[0] === entry.name)
        if (stillNeeded) continue
        await fs.rm(path.join(deps.sessionRoot, entry.name), { recursive: true, force: true })
      }
    } catch {
      // sessionRoot 尚不存在等。
    }
  }

  const pruned = await pruneTarget(deps.sessionRoot, targets, forkRe)
  return {
    mirrored,
    unchanged,
    rewritten,
    skippedLinks: source.skipped,
    deleted: pruned.deleted,
    forkedPreserved: pruned.forkedPreserved,
    hostArtifactsSkipped,
    hostArtifactsPreserved: pruned.hostArtifactsPreserved,
  }
}

/**
 * 确保设备身份文件内容为 deviceId（不同才写；返回是否写入）。
 * @param {string} repoDir - 同步仓库根。
 * @param {string} deviceFile - 文件名（repoDir 直下）。
 * @param {string} deviceId - 设备 id。
 * @returns {Promise<boolean>} 是否写入。
 */
export async function ensureDeviceFile(repoDir, deviceFile, deviceId) {
  const target = path.join(repoDir, deviceFile)
  const content = Buffer.from(`${deviceId}\n`)
  return writeIfDifferent(target, content)
}
