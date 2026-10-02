// lib/session-cwd.mjs — 读写会话日志首行 header 的 cwd（支持明文 jsonl 与多帧 zstd）。
// DSH 的 session.v4.jsonl.zstd 是「拼接的独立 zstd 帧」（首帧=header，后续帧=事件批）。
// Node 的 zstdDecompress 只会解出第一帧；必须按帧边界只改首帧、其余字节原样保留。
// 零 DSH 依赖。

import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)

/** 与 dsh-session-persistence-jsonl 一致：帧带 checksum，便于宿主校验。 */
const CHECKSUM_OPTIONS = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}

const SESSION_LOG_RE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/iu
const ZSTD_MAGIC = 0xFD2FB528

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
 * 定位拼接 zstd 流中完整帧的字节范围（不解码块内容）。
 * 逻辑对齐 @deepseek-ai/dsh-session-persistence-jsonl 的 scanZstdFrames。
 * @param {Buffer} buffer
 * @param {number} [maxFrames]
 * @returns {{start: number, end: number}[]}
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0

  while (offset < buffer.length && frames.length < maxFrames) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) {
        return frames
      }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) {
        return frames
      }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) {
        return frames
      }
      offset += 4
    }
    frames.push({ start, end: offset })
  }

  return frames
}

/**
 * 从首帧（或明文首行）解析 header.cwd。
 * @param {Buffer} content
 * @param {string} basename
 * @returns {Promise<string|undefined>}
 */
export async function readSessionCwd(content, basename) {
  if (!isSessionLogBasename(basename)) return undefined
  try {
    let firstLine
    if (isZstdBasename(basename)) {
      const frames = scanZstdFrames(content, 1)
      if (frames.length === 0) return undefined
      const plain = await zstdDecompressAsync(content.subarray(frames[0].start, frames[0].end))
      firstLine = plain.toString('utf8').split(/\r?\n/u, 1)[0] ?? ''
    } else {
      firstLine = content.toString('utf8').split(/\r?\n/u, 1)[0] ?? ''
    }
    if (firstLine.trim() === '') return undefined
    const header = JSON.parse(firstLine)
    if (header?.type !== 'session' || typeof header.cwd !== 'string' || header.cwd.length === 0) {
      return undefined
    }
    return header.cwd
  } catch {
    return undefined
  }
}

/**
 * 在首行 session header 中把 cwd 从 fromCwd 改为 toCwd。
 * zstd：只重写第一帧，后续帧字节原样拼接，避免丢掉事件内容。
 * @param {Buffer} content
 * @param {string} basename
 * @param {string} fromCwd
 * @param {string} toCwd
 * @returns {Promise<{content: Buffer, changed: boolean}>}
 */
export async function rewriteSessionCwd(content, basename, fromCwd, toCwd) {
  if (!isSessionLogBasename(basename) || fromCwd === toCwd) {
    return { content, changed: false }
  }

  if (isZstdBasename(basename)) {
    const frames = scanZstdFrames(content, 1)
    if (frames.length === 0) return { content, changed: false }
    const { start, end } = frames[0]
    const firstFrame = content.subarray(start, end)
    const plain = await zstdDecompressAsync(firstFrame)
    const text = plain.toString('utf8')
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
    const nextPlain = Buffer.from(lines.join(nl), 'utf8')
    const nextFirst = await zstdCompressAsync(nextPlain, CHECKSUM_OPTIONS)
    const next = Buffer.concat([nextFirst, content.subarray(end)])
    return { content: next, changed: true }
  }

  // 明文 jsonl
  const text = content.toString('utf8')
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
  return { content: Buffer.from(lines.join(nl), 'utf8'), changed: true }
}
