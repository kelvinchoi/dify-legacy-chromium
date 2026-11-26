/**
 * [legacy-chromium-patch] Tailwind v4 产物的 CSS 级联层拍平器。
 *
 * 背景：Dify 从 1.14 起把 Tailwind 从 v3 升到 v4。v4 的输出固定包在
 * `@layer theme, base, components, utilities` 里，而 CSS 级联层要 Chrome 99+
 * 才支持。低于 99 的 Chromium 内核（如 Chrome 90）会把 @layer 当成未知
 * at-rule，连同整块内容一起丢弃 —— 表现就是所有 Tailwind 工具类失效、页面
 * 完全没有样式。
 *
 * 这个脚本在构建后遍历产物里的 CSS，把层声明删掉、层块原位展开，语义上等价
 * 于「按声明顺序落成普通 CSS」。幂等：已经拍平过的文件不会被二次处理。
 *
 * 用法：
 *   node scripts/legacy-css-downlevel.mjs            # 处理 web/.next 下的产物
 *   node scripts/legacy-css-downlevel.mjs <dir>      # 处理指定目录（递归找 *.css）
 */
import fs from 'node:fs'
import path from 'node:path'

function readString(css, i) {
  const quote = css[i]
  let j = i + 1
  while (j < css.length) {
    if (css[j] === '\\') { j += 2; continue }
    if (css[j] === quote) return j + 1
    j++
  }
  return css.length
}

function findBlockEnd(css, openIdx) {
  let depth = 0
  let k = openIdx
  while (k < css.length) {
    const ch = css[k]
    if ((ch === '"' || ch === "'") && css[k - 1] !== '\\') { k = readString(css, k); continue }
    if (ch === '/' && css[k + 1] === '*') {
      const end = css.indexOf('*/', k + 2)
      k = end === -1 ? css.length : end + 2
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return k }
    k++
  }
  return css.length
}

const stats = { blocks: 0, statements: 0 }

function flatten(css) {
  let out = ''
  let i = 0
  const n = css.length
  while (i < n) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const e = end === -1 ? n : end + 2
      out += css.slice(i, e)
      i = e
      continue
    }
    // 注意：CSS 类名里会出现转义引号（如 \\'until-found\\'），不能当成字符串起点
    if ((c === '"' || c === "'") && css[i - 1] !== '\\') {
      const e = readString(css, i)
      out += css.slice(i, e)
      i = e
      continue
    }
    if (c === '@') {
      const m = /^@([a-zA-Z-]+)/.exec(css.slice(i, i + 24))
      if (m && m[1].toLowerCase() === 'layer') {
        let j = i + 6
        let paren = 0
        let braceAt = -1
        let semiAt = -1
        while (j < n) {
          const ch = css[j]
          if ((ch === '"' || ch === "'") && css[j - 1] !== '\\') { j = readString(css, j); continue }
          if (ch === '(') paren++
          else if (ch === ')') paren--
          else if (paren === 0 && ch === '{') { braceAt = j; break }
          else if (paren === 0 && ch === ';') { semiAt = j; break }
          j++
        }
        if (semiAt !== -1) {
          stats.statements++
          i = semiAt + 1
          continue
        }
        if (braceAt !== -1) {
          stats.blocks++
          const end = findBlockEnd(css, braceAt)
          out += flatten(css.slice(braceAt + 1, end))
          i = end + 1
          continue
        }
      }
    }
    out += c
    i++
  }
  return out
}

function braceBalance(s) {
  let d = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') d++
    else if (s[i] === '}') d--
  }
  return d
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(p, out)
    }
    else if (entry.name.endsWith('.css')) {
      out.push(p)
    }
  }
  return out
}

function processFile(file) {
  const src = fs.readFileSync(file, 'utf8')
  if (!src.includes('@layer')) return 0
  const res = flatten(src)
  const bal = braceBalance(res)
  if (bal !== 0) {
    throw new Error(`brace imbalance (${bal}) after flattening ${file}`)
  }
  fs.writeFileSync(file, res)
  return src.length - res.length
}

const root = process.argv[2] || path.join(process.cwd(), '.next')
const files = walk(root)
if (files.length === 0) {
  console.log(`[legacy-css] no css found under ${root}`)
  process.exit(0)
}
let touched = 0
let saved = 0
for (const f of files) {
  const d = processFile(f)
  if (d) {
    touched++
    saved += d
    console.log(`[legacy-css] flattened ${path.relative(root, f)} (-${d}B)`)
  }
}
console.log(`[legacy-css] files=${files.length} touched=${touched} layers=${stats.blocks} order_stmts=${stats.statements} saved=${saved}B`)
