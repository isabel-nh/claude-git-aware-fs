import { parseBash, parsePowerShell, type PsWord, type Word } from './shell.ts'

export type Mode = 'rewrite' | 'deny'

export type Operand = {
  raw: string
  value: string
  isGlob: boolean
  // Absolute, normalized; undefined when it cannot be known without running the shell.
  abs?: string
  // Under a temp directory: never asked about.
  isTemp: boolean
}

export type FsCommand = {
  kind: 'rm' | 'mv'
  shell: 'bash' | 'pwsh'
  // The span a rewrite replaces, from the command word to the last argument.
  start: number
  end: number
  text: string
  isRecursive: boolean
  isForced: boolean
  // Plain options and literal paths only: no globs, expansions, redirects or assignments.
  isSimple: boolean
  sources: Operand[]
  dst?: Operand
  cwd?: string
}

export type DirInfo = { top: string; prefix: string }

// What git said: a directory's work tree (null outside one) and its ls-files entries.
export type Facts = { dirs: Map<string, DirInfo | null>; listed: Map<string, string[]> }

export type Rewrite = { start: number; end: number; text: string; from: string }

export type Decision = { rewrites: Rewrite[]; suggestions: string[]; globs: string[] }

const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'command'])
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/
const PS_SHELLS = new Set(['powershell', 'pwsh'])
const PS_RM = new Set(['remove-item', 'ri', 'del', 'erase', 'rm', 'rd', 'rmdir'])
const PS_MV = new Set(['move-item', 'mi', 'move', 'mv'])
const PS_CD = new Set(['cd', 'sl', 'chdir', 'set-location', 'push-location', 'pushd'])
const PS_VALUED = new Set(['erroraction', 'ea', 'include', 'exclude', 'filter', 'credential', 'stream', 'warningaction', 'wa'])

const TEMP_VAR = /^(\$\{?(TEMP|TMP|TMPDIR|RUNNER_TEMP)\}?|\$env:(TEMP|TMP))([\\/]|$)/i
const TEMP_DIR = /^(\/tmp|\/var\/tmp|\/private\/tmp|\/private\/var\/folders|\/var\/folders|\/dev|[a-z]:\/windows\/temp|[a-z]:\/users\/[^/]+\/appdata\/local\/temp)(\/|$)/i

export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:([\\/]|$)/.test(p) || p.includes('\\')

export function normalize(p: string, isWindows: boolean): string {
  let s = isWindows ? p.replace(/\\/g, '/') : p
  s = s.replace(/\/{2,}/g, '/')
  const msys = isWindows ? /^\/([A-Za-z])(\/|$)/.exec(s) : null
  if (msys) s = `${msys[1]!.toUpperCase()}:/${s.slice(3)}`
  if (/^[a-z]:/.test(s)) s = s[0]!.toUpperCase() + s.slice(1)
  return s.length > 1 && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, '') : s
}

const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(p)

export function resolvePath(p: string, cwd: string | undefined, isWindows: boolean): string | undefined {
  const s = normalize(p, isWindows)
  if (!isAbsolute(s) && cwd === undefined) return undefined
  const abs = isAbsolute(s) ? s : `${normalize(cwd!, isWindows)}/${s}`
  const root = /^[A-Za-z]:\//.test(abs) ? abs.slice(0, 3) : '/'
  const out: string[] = []
  for (const seg of abs.slice(root.length).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return root + out.join('/')
}

export const parentOf = (abs: string): string => {
  const at = abs.lastIndexOf('/')
  const root = /^[A-Za-z]:\//.test(abs) ? 3 : 1
  return at < root ? abs.slice(0, root) : abs.slice(0, at)
}

export const leafOf = (abs: string): string => abs.slice(abs.lastIndexOf('/') + 1)

const fold = (s: string, isWindows: boolean): string => (isWindows ? s.toLowerCase() : s)

const isWithin = (p: string, top: string, isWindows: boolean): boolean => {
  const a = fold(p, isWindows)
  const b = fold(top, isWindows)
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`)
}

// Single-quotes a word for Bash where it holds anything beyond plain path characters.
export const quote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

const commandName = (w: Word): string => w.value.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')

function operand(raw: string, value: string, isGlob: boolean, isExpanded: boolean, cwd: string | undefined, isWindows: boolean): Operand {
  const abs = isExpanded ? undefined : resolvePath(value, cwd, isWindows)
  const isTemp = TEMP_VAR.test(value) || (abs !== undefined && TEMP_DIR.test(abs))
  return { raw, value, isGlob, abs, isTemp }
}

function bashRm(words: Word[], cwd: string | undefined, isWindows: boolean) {
  let isRecursive = false
  let isForced = false
  let isSimple = true
  let isEndOfOptions = false
  const sources: Operand[] = []
  for (const w of words) {
    if (!isEndOfOptions && !w.isQuoted && w.value === '--') isEndOfOptions = true
    else if (!isEndOfOptions && !w.isQuoted && /^-./.test(w.value)) {
      if (w.value === '--recursive') isRecursive = true
      else if (w.value === '--force') isForced = true
      else if (/^-[rRf]+$/.test(w.value)) {
        if (/[rR]/.test(w.value)) isRecursive = true
        if (w.value.includes('f')) isForced = true
      } else isSimple = false
    } else {
      sources.push(operand(w.raw, w.value, w.isGlob, w.isExpanded, cwd, isWindows))
      if (w.isGlob || w.isExpanded) isSimple = false
    }
  }
  return { isRecursive, isForced, isSimple, sources }
}

function bashMv(words: Word[], cwd: string | undefined, isWindows: boolean) {
  let isForced = false
  let isSimple = true
  let isEndOfOptions = false
  let target: Word | undefined
  const rest: Word[] = []
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    if (!isEndOfOptions && !w.isQuoted && w.value === '--') isEndOfOptions = true
    else if (!isEndOfOptions && !w.isQuoted && /^-./.test(w.value)) {
      if (w.value === '-f' || w.value === '--force') isForced = true
      else if (w.value === '-t' || w.value === '--target-directory') {
        target = words[++k]
        isSimple = false
      } else if (/^(-t|--target-directory=)./.test(w.value)) {
        target = { ...w, value: w.value.replace(/^(-t|--target-directory=)/, ''), raw: w.raw.replace(/^(-t|--target-directory=)/, '') }
        isSimple = false
      } else isSimple = false
    } else {
      rest.push(w)
      if (w.isGlob || w.isExpanded) isSimple = false
    }
  }
  const dstWord = target ?? rest.pop()
  const toOperand = (w: Word) => operand(w.raw, w.value, w.isGlob, w.isExpanded, cwd, isWindows)
  return { isForced, isSimple, sources: rest.map(toOperand), dst: dstWord && toOperand(dstWord) }
}

function psCommand(statement: PsWord[], kind: 'rm' | 'mv', cwd: string | undefined, isWindows: boolean) {
  let isRecursive = false
  let isForced = false
  const sources: Operand[] = []
  let dst: Operand | undefined
  const positional: Operand[] = []
  const toOperand = (w: PsWord, isLiteral: boolean) => operand(w.raw, w.value, !isLiteral && /[*?[]/.test(w.value), w.isExpanded, cwd, isWindows)
  for (let k = 1; k < statement.length; k++) {
    const w = statement[k]!
    const param = !w.isQuoted && /^-[A-Za-z]/.test(w.value) ? w.value.slice(1).toLowerCase() : undefined
    if (param === undefined) {
      positional.push(toOperand(w, false))
      continue
    }
    const [name, attached] = param.split(/:(.*)/s) as [string, string | undefined]
    const take = () => (attached !== undefined ? { ...w, raw: attached, value: attached } : statement[++k])
    if (name === 'lp' || name === 'pspath' || (name.length >= 2 && 'literalpath'.startsWith(name))) {
      const v = take()
      if (v) sources.push(toOperand(v, true))
    } else if ('path'.startsWith(name)) {
      const v = take()
      if (v) sources.push(toOperand(v, false))
    } else if ('destination'.startsWith(name)) {
      const v = take()
      if (v) dst = toOperand(v, false)
    } else if ('recurse'.startsWith(name)) isRecursive = true
    else if (name.length >= 2 && 'force'.startsWith(name)) isForced = true
    else if (PS_VALUED.has(name)) take()
  }
  if (kind === 'mv') {
    if (sources.length === 0 && positional.length > 0) sources.push(positional.shift()!)
    dst ??= positional.shift()
  } else sources.push(...positional)
  return { isRecursive, isForced, sources, dst }
}

function psCommands(script: string, at: { start: number; end: number; text: string }, cwd: string | undefined, isWindows: boolean): FsCommand[] {
  const out: FsCommand[] = []
  let here = cwd
  for (const statement of parsePowerShell(script)) {
    const name = statement[0]!.value.toLowerCase()
    if (PS_CD.has(name)) {
      const arg = statement.slice(1).find(w => !/^-/.test(w.value))
      here = arg === undefined || arg.isExpanded ? undefined : resolvePath(arg.value, here, isWindows)
      continue
    }
    const kind = PS_RM.has(name) ? 'rm' : PS_MV.has(name) ? 'mv' : undefined
    if (kind === undefined) continue
    out.push({ kind, shell: 'pwsh', ...at, ...psCommand(statement, kind, here, isWindows), isSimple: false, cwd: here })
  }
  return out
}

// Every rm / mv the command would run, each with the directory it runs in.
export function findCommands(command: string, sessionCwd: string): FsCommand[] {
  const isWindows = isWindowsPath(sessionCwd)
  const out: FsCommand[] = []
  const saved: (string | undefined)[] = []
  let cwd: string | undefined = normalize(sessionCwd, isWindows)
  for (const item of parseBash(command)) {
    if (item === 'open') {
      saved.push(cwd)
      continue
    }
    if (item === 'close') {
      cwd = saved.length > 0 ? saved.pop() : cwd
      continue
    }
    let k = 0
    let hasAssignment = false
    while (k < item.words.length) {
      const w = item.words[k]!
      if (!w.isQuoted && KEYWORDS.has(w.value)) k++
      else if (!w.isQuoted && ASSIGNMENT.test(w.raw)) {
        hasAssignment = true
        k++
      } else break
    }
    const head = item.words[k]
    if (head === undefined || head.isExpanded) continue
    const name = commandName(head)
    const args = item.words.slice(k + 1)
    const at = { start: head.start, end: item.end, text: command.slice(head.start, item.end) }

    if (name === 'cd' || name === 'pushd') {
      const dirs = args.filter(w => !(!w.isQuoted && /^-[LPe@]*$/.test(w.value) && w.value !== '-'))
      const dir = dirs[0]
      cwd = dirs.length !== 1 || dir!.isExpanded || dir!.value === '-' ? undefined : resolvePath(dir!.value, cwd, isWindows)
    } else if (name === 'popd') cwd = undefined
    else if (name === 'rm') {
      const r = bashRm(args, cwd, isWindows)
      out.push({ kind: 'rm', shell: 'bash', ...at, ...r, isSimple: r.isSimple && !item.hasRedirect && !hasAssignment, cwd })
    } else if (name === 'mv') {
      const m = bashMv(args, cwd, isWindows)
      out.push({ kind: 'mv', shell: 'bash', ...at, ...m, isRecursive: false, isSimple: m.isSimple && !item.hasRedirect && !hasAssignment, cwd })
    } else if (PS_SHELLS.has(name.toLowerCase())) {
      const flag = args.findIndex(w => /^-(c|command)$/i.test(w.value))
      const script = flag < 0 ? undefined : args[flag + 1]
      if (script !== undefined) out.push(...psCommands(script.value, at, cwd, isWindows))
    }
  }
  return out
}

// The directory a glob's fixed part names: `src/*.ts` -> src, `*.log` -> the cwd.
const globDir = (o: Operand, cwd: string | undefined, isWindows: boolean): string | undefined => {
  const fixed = o.value.slice(0, o.value.search(/[*?[{]/))
  const cut = fixed.replace(/\\/g, '/').lastIndexOf('/')
  return resolvePath(cut < 0 ? '.' : fixed.slice(0, cut + 1) || '/', cwd, isWindows)
}

// The directories git is asked about, each with the leaves ls-files checks there.
export function queries(cmds: readonly FsCommand[], isWindows: boolean): Map<string, Set<string>> {
  const dirs = new Map<string, Set<string>>()
  const ask = (dir: string, leaf?: string) => {
    const leaves = dirs.get(dir) ?? new Set<string>()
    if (leaf !== undefined && leaf !== '') leaves.add(leaf)
    dirs.set(dir, leaves)
  }
  for (const c of cmds) {
    for (const o of [...c.sources, ...(c.dst ? [c.dst] : [])]) {
      if (o.isTemp) continue
      if (o.isGlob) {
        const dir = globDir(o, c.cwd, isWindows)
        if (dir !== undefined) ask(dir)
      } else if (o.abs !== undefined && o.abs !== parentOf(o.abs)) {
        if (o === c.dst) ask(o.abs)
        ask(parentOf(o.abs), o === c.dst ? undefined : leafOf(o.abs))
      }
    }
  }
  return dirs
}

type Tracked = { top: string; rel: string; isDir: boolean }

function trackedAs(o: Operand, facts: Facts, isWindows: boolean): Tracked | undefined {
  if (o.isTemp || o.isGlob || o.abs === undefined) return undefined
  const dir = parentOf(o.abs)
  const info = facts.dirs.get(dir)
  if (!info) return undefined
  const leaf = fold(leafOf(o.abs), isWindows)
  const entries = (facts.listed.get(dir) ?? []).map(e => fold(e, isWindows))
  const isFile = entries.includes(leaf)
  const isDir = entries.some(e => e.startsWith(`${leaf}/`))
  if (!isFile && !isDir) return undefined
  return { top: info.top, rel: info.prefix + leafOf(o.abs), isDir: isDir && !isFile }
}

// Where a destination lands: its repository and its path from the top.
function landing(o: Operand, facts: Facts): Tracked | undefined {
  if (o.abs === undefined || o.isGlob) return undefined
  const asDir = facts.dirs.get(o.abs)
  if (asDir) return { top: asDir.top, rel: asDir.prefix.replace(/\/$/, '') || '.', isDir: true }
  const parent = facts.dirs.get(parentOf(o.abs))
  return parent ? { top: parent.top, rel: parent.prefix + leafOf(o.abs), isDir: false } : undefined
}

const shown = (o: Operand): string => (o.abs !== undefined ? quote(o.abs) : o.raw)
const flags = (...f: (string | false)[]): string => f.filter(Boolean).map(s => `${s} `).join('')

function decideRm(c: FsCommand, facts: Facts, isWindows: boolean, d: Decision) {
  const marks = c.sources.map(o => trackedAs(o, facts, isWindows))
  const tracked = marks.filter((t): t is Tracked => t !== undefined)
  if (tracked.length === 0) return
  const tops = [...new Set(tracked.map(t => t.top))]
  const r = c.isRecursive || tracked.some(t => t.isDir) ? '-r' : false
  const f = c.isForced && '-f'

  if (c.shell === 'bash' && c.isSimple && tracked.length === marks.length && tops.length === 1) {
    const top = tops[0]!
    const text =
      c.cwd !== undefined && isWithin(c.cwd, top, isWindows)
        ? `git rm ${flags(r, f)}-- ${c.sources.map(o => o.raw).join(' ')}`
        : `git -C ${quote(top)} rm ${flags(r, f)}-- ${tracked.map(t => quote(t.rel)).join(' ')}`
    d.rewrites.push({ start: c.start, end: c.end, text, from: c.text })
    return
  }
  for (const top of tops) {
    const group = tracked.filter(t => t.top === top)
    const gr = c.isRecursive || group.some(t => t.isDir) ? '-r' : false
    d.suggestions.push(`git -C ${quote(top)} rm ${flags(gr, f)}-- ${group.map(t => quote(t.rel)).join(' ')}`)
  }
  const rest = c.sources.filter((_, k) => marks[k] === undefined)
  if (rest.length > 0) d.suggestions.push(`rm ${flags(c.isRecursive && '-r', c.isForced && '-f')}-- ${rest.map(shown).join(' ')}`)
}

function decideMv(c: FsCommand, facts: Facts, isWindows: boolean, d: Decision) {
  if (c.dst === undefined) return
  const marks = c.sources.map(o => trackedAs(o, facts, isWindows))
  const tracked = marks.filter((t): t is Tracked => t !== undefined)
  if (tracked.length === 0) return
  const to = landing(c.dst, facts)
  const f = c.isForced && '-f'
  const sameRepo = (t: Tracked) => to !== undefined && fold(t.top, isWindows) === fold(to.top, isWindows)

  if (c.shell === 'bash' && c.isSimple && tracked.length === marks.length && to !== undefined && tracked.every(sameRepo)) {
    const text =
      c.cwd !== undefined && isWithin(c.cwd, to.top, isWindows)
        ? `git mv ${flags(f)}-- ${c.sources.map(o => o.raw).join(' ')} ${c.dst.raw}`
        : `git -C ${quote(to.top)} mv ${flags(f)}-- ${tracked.map(t => quote(t.rel)).join(' ')} ${quote(to.rel)}`
    d.rewrites.push({ start: c.start, end: c.end, text, from: c.text })
    return
  }
  const inRepo = tracked.filter(sameRepo)
  if (inRepo.length > 0) d.suggestions.push(`git -C ${quote(to!.top)} mv ${flags(f)}-- ${inRepo.map(t => quote(t.rel)).join(' ')} ${quote(to!.rel)}`)
  const leaving = c.sources.filter((_, k) => marks[k] !== undefined && !sameRepo(marks[k]!))
  const plain = c.sources.filter((_, k) => marks[k] === undefined)
  if (leaving.length + plain.length > 0) d.suggestions.push(`mv ${flags(f)}-- ${[...leaving, ...plain].map(shown).join(' ')} ${shown(c.dst)}`)
  for (const t of tracked.filter(t => !sameRepo(t))) d.suggestions.push(`git -C ${quote(t.top)} rm -r --cached -q -- ${quote(t.rel)}`)
}

export function decide(cmds: readonly FsCommand[], facts: Facts, mode: Mode, isWindows: boolean): Decision {
  const d: Decision = { rewrites: [], suggestions: [], globs: [] }
  for (const c of cmds) {
    const globs = [...c.sources, ...(c.dst ? [c.dst] : [])].filter(o => {
      if (!o.isGlob || o.isTemp) return false
      const dir = globDir(o, c.cwd, isWindows)
      return dir !== undefined && Boolean(facts.dirs.get(dir))
    })
    if (globs.length > 0) {
      d.globs.push(...globs.map(o => o.raw))
      continue
    }
    if (c.kind === 'rm') decideRm(c, facts, isWindows, d)
    else decideMv(c, facts, isWindows, d)
  }
  // Deny mode offers the rewrite it would have made.
  if (mode === 'deny') {
    d.suggestions.unshift(...d.rewrites.map(r => r.text))
    d.rewrites = []
  }
  return d
}

// The command with each rewrite applied, last first so earlier offsets hold.
export function applyRewrites(command: string, rewrites: readonly Rewrite[]): string {
  let out = command
  for (const r of [...rewrites].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + r.text + out.slice(r.end)
  return out
}

export const DIR_ARGS = (dir: string): string[] => ['git', '-C', dir, 'rev-parse', '--show-toplevel', '--show-prefix']
export const LIST_ARGS = (dir: string, leaves: readonly string[]): string[] => ['git', '--literal-pathspecs', '-C', dir, 'ls-files', '-z', '--', ...leaves]

export function parseDirInfo(stdout: string, isWindows: boolean): DirInfo | null {
  const [top, prefix] = stdout.split('\n').map(l => l.replace(/\r$/, ''))
  return top ? { top: normalize(top, isWindows), prefix: prefix ?? '' } : null
}
