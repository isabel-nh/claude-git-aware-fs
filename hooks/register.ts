import type { Register } from 'claude-code'
import { applyRewrites, decide, DIR_ARGS, findCommands, isWindowsPath, LIST_ARGS, parseDirInfo, queries, type Facts, type Mode } from './rules.ts'

const QUICK = /(^|[\s;&|(`'"\\/])(rm|mv|remove-item|ri|del|erase|rd|rmdir|move-item|mi|move)([\s;&|)`'"]|\.exe|$)/i

// Fail-closed: a guard that crashes before the tool runs denies. A git call that fails
// (not a repository, git missing) counts as "not tracked".
export const register: Register = (on, options) => {
  const mode: Mode = options.mode === 'deny' ? 'deny' : 'rewrite'

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!QUICK.test(e.command)) return next(e)
    const cwd = await $.session.cwd()
    const isWindows = isWindowsPath(cwd)
    const cmds = findCommands(e.command, cwd)
    if (cmds.length === 0) return next(e)

    const git = async (argv: string[]) => {
      try {
        const r = await $.process.run(argv, { timeoutMs: 10_000 })
        return r.exitCode === 0 ? r.stdout : undefined
      } catch {
        return undefined
      }
    }
    const asked = queries(cmds, isWindows)
    const facts: Facts = { dirs: new Map(), listed: new Map() }
    await Promise.all(
      [...asked].map(async ([dir, leaves]) => {
        const out = await git(DIR_ARGS(dir))
        const info = out === undefined ? null : parseDirInfo(out, isWindows)
        facts.dirs.set(dir, info)
        if (info === null || leaves.size === 0) return
        const listed = await git(LIST_ARGS(dir, [...leaves]))
        facts.listed.set(dir, (listed ?? '').split('\0').filter(p => p !== ''))
      }),
    )

    const d = decide(cmds, facts, mode, isWindows)
    if (d.globs.length > 0) {
      return { deny: `${$.plugin.name}: Bash blocked: ${d.globs.join(', ')} ${d.globs.length === 1 ? 'is a glob' : 'are globs'} inside a git working tree. List the paths explicitly so tracked files can go through git rm / git mv.` }
    }
    if (d.suggestions.length > 0) {
      const why = mode === 'deny' ? 'the command deletes or moves git-tracked files' : 'the command deletes or moves git-tracked files in a form that cannot be rewritten (mixed tracked and untracked paths, several repositories, unsupported options, expansions, redirects or PowerShell)'
      return { deny: `${$.plugin.name}: Bash blocked: ${why}. Run these instead so the git index stays in sync:\n${d.suggestions.map(s => `  ${s}`).join('\n')}` }
    }
    if (d.rewrites.length === 0) return next(e)

    const ran = await next({ ...e, command: applyRewrites(e.command, d.rewrites) })
    if (ran.deny !== undefined) return ran
    const note = d.rewrites.map(r => `${$.plugin.name}: ran \`${r.text}\` in place of \`${r.from}\` so the git index stays in sync.`).join('\n')
    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its Bash guard failed.` }))
}
