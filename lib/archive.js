/**
 * 归档导入：把浏览器下载的 GitHub 压缩包解开成工作区目录。
 *
 * 为什么用 tar：Windows 10+ 自带 `C:\Windows\System32\tar.exe`（bsdtar），
 * 它能同时处理 zip / tar / tar.gz，不用为解压引入任何 npm 依赖。
 *
 * 安全：bsdtar 默认拒绝绝对路径与 `..`（对 zip-slip 有内建防护）；解压后
 * 调用方还会再校验一遍所有产物确实落在目标目录内。
 */

import fs from 'node:fs'
import path from 'node:path'
import { run } from './proc.js'

/** tar 可执行文件候选。 */
const TAR_CANDIDATES = ['tar', 'C:\\Windows\\System32\\tar.exe']

/** 按文件名判断归档类型；不支持的返回空串。 */
export function archiveKind(name) {
  const lower = String(name ?? '').toLowerCase()
  if (lower.endsWith('.zip')) return 'zip'
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz'
  if (lower.endsWith('.tar')) return 'tar'
  return ''
}

/** 取错误输出里最有信息量的尾部。 */
function tail(text, limit = 400) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length <= limit ? value : value.slice(value.length - limit)
}

/**
 * 解压归档到目标目录（目录必须已存在且为空）。
 * @param {string} archivePath - 归档文件的绝对路径。
 * @param {string} destDir - 解压目标目录。
 * @param {{signal?: AbortSignal, onStage?: Function}} [options]
 * @returns {Promise<{ok: boolean, error?: string, aborted?: boolean}>}
 */
export async function extractArchive(archivePath, destDir, { signal, onStage } = {}) {
  onStage?.({ stage: 'extract', text: '解压中…' })
  for (const candidate of TAR_CANDIDATES) {
    const result = await run(candidate, ['-xf', archivePath, '-C', destDir], { timeoutMs: 900_000, signal })
    if (result.code === 0) return { ok: true }
    if (result.aborted === true) return { ok: false, aborted: true, error: '已取消' }
    // 第一个候选可能只是不存在（ENOENT），换下一个
    if (result.code === null && typeof result.error === 'string' && /ENOENT|not found/i.test(result.error)) continue
    return { ok: false, error: tail(result.stderr || result.error || '解压失败') }
  }
  return { ok: false, error: '没找到可用的 tar：Windows 10+ 自带 C:\\Windows\\System32\\tar.exe' }
}

/**
 * GitHub 的归档往往是「单层目录 + 内容」（repo-branch/…）。
 * 这里把唯一的那层目录摊平，让工作区根目录就是仓库根。
 * @param {string} dir - 解压目标目录。
 * @returns {boolean} 是否发生了摊平。
 */
export function unwrapSingleDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  if (entries.length !== 1 || entries[0].isDirectory() !== true) return false
  const inner = path.join(dir, entries[0].name)
  for (const child of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, child), path.join(dir, child))
  }
  fs.rmdirSync(inner)
  return true
}

/**
 * 校验目录里所有条目都在 dir 之内（防 zip-slip 兜底）。
 * @param {string} dir - 目标目录。
 * @returns {number} 超出边界的条目数（0 表示安全）。
 */
export function countEscapes(dir) {
  const root = path.resolve(dir)
  let escapes = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const resolved = path.resolve(full)
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        escapes += 1
        continue
      }
      if (entry.isDirectory() && entry.isSymbolicLink() === false) walk(full)
    }
  }
  walk(root)
  return escapes
}

/**
 * 从归档文件名推测 `repo`（GitHub 的包名形如 `repo-branch.zip`）。
 * 只作为输入框的预填值，用户可改。
 * @param {string} name - 文件名或完整路径。
 * @returns {string} 推测出来的仓库名。
 */
export function guessRepoName(name) {
  const base = path.basename(String(name ?? ''))
    .replace(/\.(zip|tar\.gz|tgz|tar)$/i, '')
  // 去掉尾部 -main / -master / -<branch>
  const matched = /^(.+)-(main|master|trunk|develop|dev|HEAD)$/i.exec(base)
  if (matched !== null) return matched[1]
  const lastDash = base.lastIndexOf('-')
  return lastDash > 0 ? base.slice(0, lastDash) : base
}
