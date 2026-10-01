// lib/session-cwd.mjs — 读写会话日志首行 header 的 cwd（支持明文 jsonl 与 zstd）。
// 只改 type===session 的首行；其余行原样保留。零 DSH 依赖。

import { promisify } from 'node:util'
import { zstdCompress, zstdDecompress } from 'node:zlib'

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)

const SESSION_LOG_RE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/iu

/**
 * @param {string} basename - 文件名。
 * @returns {boolean}
 */
export function isSessionLogBasename(basename) {
  return SESSION_LOG_RE.test(basename)
}

/**
 * @param {string} basename - 文件名。
 * @returns {boolean}
 */
function isZstdBasename(basename) {
  return basename.toLowerCase().endsWith('.zstd')
}

/**
 * 解出会话日志文本（zstd 或明文）。
 * @param {Buffer} content - 文件字节。
 * @param {string} basename - 文件名（决定是否解压）。
 * @returns {Promise<string>}
 */
async function decodeLogText(content, basename) {
  if (!isZstdBasename(basename)) return content.toString('utf8')
  const plain = await zstdDecompressAsync(content)
  return plain.toString('utf8')
}

/**
 * 编码回磁盘字节。
 * @param {string} text - jsonl 文本。
 * @param {string} basename - 文件名。
 * @returns {Promise<Buffer>}
 */
async function encodeLogText(text, basename) {
  const buf = Buffer.from(text, 'utf8')
  if (!isZstdBasename(basename)) return buf
  return zstdCompressAsync(buf)
}

/**
 * 从会话日志字节读取 header.cwd（失败返回 undefined）。
 * @param {Buffer} content - 文件字节。
 * @param {string} basename - 文件名。
 * @returns {Promise<string|undefined>}
 */
export async function readSessionCwd(content, basename) {
  if (!isSessionLogBasename(basename)) return undefined
  try {
    const text = await decodeLogText(content, basename)
    const first = text.split(/\n/u, 1)[0] ?? ''
    if (first.trim() === '') return undefined
    const header = JSON.parse(first)
    if (header?.type !== 'session' || typeof header.cwd !== 'string' || header.cwd.length === 0) {
      return undefined
    }
    return header.cwd
  } catch {
    return undefined
  }
}

/**
 * 若首行 session header 的 cwd === fromCwd，则改为 toCwd 并重编码；否则原样返回。
 * @param {Buffer} content - 文件字节。
 * @param {string} basename - 文件名。
 * @param {string} fromCwd - 期望的原 cwd。
 * @param {string} toCwd - 目标 cwd。
 * @returns {Promise<{content: Buffer, changed: boolean}>}
 */
export async function rewriteSessionCwd(content, basename, fromCwd, toCwd) {
  if (!isSessionLogBasename(basename) || fromCwd === toCwd) {
    return { content, changed: false }
  }
  const text = await decodeLogText(content, basename)
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/u)
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    return { content, changed: false }
  }
  let header
  try {
    header = JSON.parse(lines[0] ?? '')
  } catch {
    return { content, changed: false }
  }
  if (header?.type !== 'session' || header.cwd !== fromCwd) {
    return { content, changed: false }
  }
  header.cwd = toCwd
  lines[0] = JSON.stringify(header)
  const next = await encodeLogText(lines.join(nl), basename)
  return { content: next, changed: true }
}
