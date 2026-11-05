// A Bash word: `raw` as typed, `value` with quotes and escapes removed.
export type Word = {
  start: number
  end: number
  raw: string
  value: string
  // An unquoted *, ?, [ or {a,b} brace.
  isGlob: boolean
  // Holds $var, ${...}, $(...), backticks, $'...' or a leading ~.
  isExpanded: boolean
  isQuoted: boolean
}

export type Segment = { words: Word[]; start: number; end: number; hasRedirect: boolean }

// A simple command, or the opening / closing of a subshell.
export type Item = Segment | 'open' | 'close'

type Builder = { start: number; value: string; isGlob: boolean; isExpanded: boolean; isQuoted: boolean; hasBrace: boolean }

const BRACE = /\{[^{}]*(,|\.\.)[^{}]*\}/

function balanced(t: string, from: number, open: string, close: string): number {
  let depth = 0
  let quote: string | null = null
  for (let j = from; j < t.length; j++) {
    const c = t[j]
    if (quote !== null) {
      if (c === '\\' && quote === '"') j++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === '\\') j++
    else if (c === open) depth++
    else if (c === close && --depth === 0) return j + 1
  }
  return t.length
}

// End of the expansion starting at t[i] ($ or `), or undefined where $ is literal.
function expansionEnd(t: string, i: number): number | undefined {
  if (t[i] === '`') {
    let j = i + 1
    while (j < t.length && t[j] !== '`') j += t[j] === '\\' ? 2 : 1
    return Math.min(j + 1, t.length)
  }
  const next = t[i + 1]
  if (next === '(') return balanced(t, i + 1, '(', ')')
  if (next === '{') return balanced(t, i + 1, '{', '}')
  if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let j = i + 1
    while (j < t.length && /\w/.test(t[j]!)) j++
    return j
  }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return i + 2
  return undefined
}

function heredocDelimiter(t: string, from: number): { delimiter: string; strip: boolean; end: number } {
  let j = from
  const strip = t[j] === '-'
  if (strip) j++
  while (t[j] === ' ' || t[j] === '\t') j++
  let delimiter = ''
  while (j < t.length && !/[\s;&|<>()]/.test(t[j]!)) {
    const c = t[j]!
    if (c === "'" || c === '"') {
      const close = t.indexOf(c, j + 1)
      const end = close < 0 ? t.length : close
      delimiter += t.slice(j + 1, end)
      j = end + 1
    } else {
      if (c !== '\\') delimiter += c
      j++
    }
  }
  return { delimiter, strip, end: j }
}

function skipHeredocBodies(t: string, from: number, pending: { delimiter: string; strip: boolean }[]): number {
  let at = from
  for (const h of pending) {
    while (at < t.length) {
      const nl = t.indexOf('\n', at)
      const lineEnd = nl < 0 ? t.length : nl
      let line = t.slice(at, lineEnd).replace(/\r$/, '')
      if (h.strip) line = line.replace(/^\t+/, '')
      at = lineEnd + 1
      if (line === h.delimiter) break
    }
  }
  pending.length = 0
  return Math.min(at, t.length)
}

// Splits a Bash command into simple commands. Heredoc bodies and comments are dropped,
// redirect targets are left out of the words, and substitutions stay inside their word.
export function parseBash(text: string): Item[] {
  const items: Item[] = []
  const pending: { delimiter: string; strip: boolean }[] = []
  let words: Word[] = []
  let hasRedirect = false
  let isRedirectTarget = false
  let cur: Builder | undefined
  let i = 0

  const begin = (): Builder => (cur ??= { start: i, value: '', isGlob: false, isExpanded: false, isQuoted: false, hasBrace: false })
  const endWord = () => {
    if (cur === undefined) return
    const b = cur
    cur = undefined
    const word: Word = {
      start: b.start,
      end: i,
      raw: text.slice(b.start, i),
      value: b.value,
      isGlob: b.isGlob || (b.hasBrace && BRACE.test(text.slice(b.start, i))),
      isExpanded: b.isExpanded,
      isQuoted: b.isQuoted,
    }
    if (isRedirectTarget) isRedirectTarget = false
    else words.push(word)
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) items.push({ words, start: words[0]!.start, end: words[words.length - 1]!.end, hasRedirect })
    words = []
    hasRedirect = false
    isRedirectTarget = false
  }

  while (i < text.length) {
    const c = text[i]!
    if (c === '\\') {
      if (text[i + 1] === '\n') {
        i += 2
        continue
      }
      const b = begin()
      b.isQuoted = true
      b.value += text[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === "'") {
      const b = begin()
      b.isQuoted = true
      const close = text.indexOf("'", i + 1)
      const end = close < 0 ? text.length : close
      b.value += text.slice(i + 1, end)
      i = end + 1
      continue
    }
    if (c === '"') {
      const b = begin()
      b.isQuoted = true
      i++
      while (i < text.length && text[i] !== '"') {
        const d = text[i]!
        if (d === '\\' && i + 1 < text.length && '$`"\\\n'.includes(text[i + 1]!)) {
          b.value += text[i + 1]
          i += 2
          continue
        }
        const end = d === '$' || d === '`' ? expansionEnd(text, i) : undefined
        if (end !== undefined) {
          b.isExpanded = true
          b.value += text.slice(i, end)
          i = end
          continue
        }
        b.value += d
        i++
      }
      i++
      continue
    }
    if (c === '$' && text[i + 1] === "'") {
      const b = begin()
      b.isQuoted = true
      b.isExpanded = true
      const close = text.indexOf("'", i + 2)
      const end = close < 0 ? text.length : close
      b.value += text.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (c === '$' || c === '`') {
      const end = expansionEnd(text, i)
      const b = begin()
      if (end !== undefined) {
        b.isExpanded = true
        b.value += text.slice(i, end)
        i = end
      } else {
        b.value += c
        i++
      }
      continue
    }
    if (c === '#' && cur === undefined) {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
      continue
    }
    if (c === '\n') {
      endSegment()
      i++
      if (pending.length > 0) {
        i = skipHeredocBodies(text, i, pending)
      }
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
      continue
    }
    if (c === '&' && text[i + 1] === '>') {
      endWord()
      hasRedirect = true
      i += text[i + 2] === '>' ? 3 : 2
      isRedirectTarget = true
      continue
    }
    if (c === ';' || c === '|' || c === '&') {
      endSegment()
      i++
      continue
    }
    if (c === '(' || c === ')') {
      endSegment()
      items.push(c === '(' ? 'open' : 'close')
      i++
      continue
    }
    if (c === '<' || c === '>') {
      // A file-descriptor prefix (2>) belongs to the operator, not the words.
      if (cur !== undefined && /^\d+$/.test(text.slice(cur.start, i))) cur = undefined
      else endWord()
      hasRedirect = true
      if (text.startsWith('<<<', i)) {
        i += 3
        isRedirectTarget = true
        continue
      }
      if (text.startsWith('<<', i)) {
        const h = heredocDelimiter(text, i + 2)
        pending.push({ delimiter: h.delimiter, strip: h.strip })
        i = h.end
        continue
      }
      i += '<>&|'.includes(text[i + 1] ?? '') ? 2 : 1
      isRedirectTarget = true
      continue
    }
    const isFresh = cur === undefined
    const b = begin()
    if (c === '*' || c === '?' || c === '[') b.isGlob = true
    if (c === '{') b.hasBrace = true
    if (c === '~' && isFresh) b.isExpanded = true
    b.value += c
    i++
  }
  endSegment()
  return items
}

// A PowerShell statement's words: `isQuoted` for '...' / "...", `isExpanded` for $ uses.
export type PsWord = { raw: string; value: string; isQuoted: boolean; isExpanded: boolean }

// Best-effort split of a PowerShell script into statements of words. Commas separate
// array elements, so they end a word as whitespace does.
export function parsePowerShell(text: string): PsWord[][] {
  const statements: PsWord[][] = []
  let words: PsWord[] = []
  let cur: { start: number; value: string; isQuoted: boolean; isExpanded: boolean } | undefined
  let i = 0
  const begin = () => (cur ??= { start: i, value: '', isQuoted: false, isExpanded: false })
  const endWord = () => {
    if (cur !== undefined) words.push({ raw: text.slice(cur.start, i), value: cur.value, isQuoted: cur.isQuoted, isExpanded: cur.isExpanded })
    cur = undefined
  }
  const endStatement = () => {
    endWord()
    if (words.length > 0) statements.push(words)
    words = []
  }
  while (i < text.length) {
    const c = text[i]!
    if (c === "'") {
      const b = begin()
      b.isQuoted = true
      i++
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          b.value += "'"
          i += 2
        } else if (text[i] === "'") break
        else b.value += text[i++]
      }
      i++
      continue
    }
    if (c === '"') {
      const b = begin()
      b.isQuoted = true
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '`') {
          b.value += text[i + 1] ?? ''
          i += 2
          continue
        }
        if (text[i] === '$') b.isExpanded = true
        b.value += text[i++]
      }
      i++
      continue
    }
    if (c === '`') {
      const b = begin()
      b.value += text[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === '$') {
      const b = begin()
      b.isExpanded = true
      const end = text[i + 1] === '(' ? balanced(text, i + 1, '(', ')') : text[i + 1] === '{' ? balanced(text, i + 1, '{', '}') : undefined
      if (end !== undefined) {
        b.value += text.slice(i, end)
        i = end
        continue
      }
      b.value += c
      i++
      continue
    }
    if (c === '#' && cur === undefined) {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
      continue
    }
    if (/[;|&\n{}()]/.test(c)) {
      endStatement()
      i++
      continue
    }
    if (/[\s,]/.test(c)) {
      endWord()
      i++
      continue
    }
    begin().value += c
    i++
  }
  endStatement()
  return statements
}
