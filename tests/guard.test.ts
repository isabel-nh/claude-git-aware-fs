import { expect, test } from 'claude-code/testing'

const CWD = 'C:/repo'
const REPOS: Record<string, string[]> = {
  'C:/repo': ['a.txt', 'b.txt', 'my file.txt', 'dir/x.txt', 'dir/y.txt', 'sub/c.txt'],
  'C:/other': ['o.txt'],
}

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const fail = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false }

// A directory exists in the fake when it is a repository top or holds a tracked file.
function locate(dir: string): { top: string; prefix: string } | undefined {
  for (const [top, files] of Object.entries(REPOS)) {
    if (dir === top) return { top, prefix: '' }
    if (!dir.startsWith(`${top}/`)) continue
    const prefix = `${dir.slice(top.length + 1)}/`
    if (files.some(f => f.startsWith(prefix))) return { top, prefix }
  }
  return undefined
}

function fakeGit(argv: readonly string[]) {
  const dir = argv[argv.indexOf('-C') + 1]!
  const at = locate(dir)
  if (at === undefined) return fail
  if (argv.includes('rev-parse')) return ok(`${at.top}\n${at.prefix}\n`)
  const leaves = argv.slice(argv.indexOf('--') + 1)
  const here = REPOS[at.top]!.filter(f => f.startsWith(at.prefix)).map(f => f.slice(at.prefix.length))
  return ok(here.filter(f => leaves.some(l => f === l || f.startsWith(`${l}/`))).map(f => `${f}\0`).join(''))
}

function setup(on: any, run: (argv: readonly string[]) => unknown = fakeGit) {
  const ran: string[] = []
  const gitCalls: string[][] = []
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', (_: unknown, e: any) => {
    gitCalls.push([...e.argv])
    return { value: run(e.argv) }
  })
  on('tool.call', (_: unknown, e: any) => {
    ran.push(e.command)
    return { result: 'ran' }
  })
  return { ran, gitCalls }
}

const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command } as any)

test('untracked paths pass through unchanged', async ($, on) => {
  const { ran } = setup(on)
  const r = await bash($, 'rm -f notes.log && mv build.out dist/')
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual(['rm -f notes.log && mv build.out dist/'])
})

test('commands without rm or mv make no git calls', async ($, on) => {
  const { ran, gitCalls } = setup(on)
  await bash($, 'echo "rm a.txt" && grep -r mv .')
  expect(ran).toEqual(['echo "rm a.txt" && grep -r mv .'])
  expect(gitCalls).toEqual([])
})

test('heredoc bodies are ignored', async ($, on) => {
  const { ran, gitCalls } = setup(on)
  const cmd = "cat <<'EOF' > cleanup.sh\nrm a.txt\nmv b.txt c.txt\nEOF"
  await bash($, cmd)
  expect(ran).toEqual([cmd])
  expect(gitCalls).toEqual([])
})

test('temp paths pass without git calls', async ($, on) => {
  const { ran, gitCalls } = setup(on)
  await bash($, 'rm -rf "$TEMP/build.log" /tmp/x C:/Users/me/AppData/Local/Temp/y')
  expect(ran.length).toBe(1)
  expect(gitCalls).toEqual([])
})

test('tracked rm is rewritten to git rm', async ($, on) => {
  const { ran } = setup(on)
  const r = await bash($, 'rm a.txt')
  expect(ran).toEqual(['git rm -- a.txt'])
  expect(String(r.context)).toContain('ran `git rm -- a.txt` in place of `rm a.txt`')
})

test('rm -f maps to git rm -f; -f is never added', async ($, on) => {
  const { ran } = setup(on)
  await bash($, 'rm -f a.txt')
  await bash($, 'rm b.txt')
  expect(ran).toEqual(['git rm -f -- a.txt', 'git rm -- b.txt'])
})

test('tracked directory gets -r', async ($, on) => {
  const { ran } = setup(on)
  await bash($, 'rm -rf dir')
  await bash($, 'rm dir/')
  expect(ran).toEqual(['git rm -r -f -- dir', 'git rm -r -- dir/'])
})

test('tracked mv is rewritten to git mv', async ($, on) => {
  const { ran } = setup(on)
  await bash($, 'mv a.txt dir/a2.txt')
  await bash($, 'mv -f a.txt b.txt dir')
  expect(ran).toEqual(['git mv -- a.txt dir/a2.txt', 'git mv -f -- a.txt b.txt dir'])
})

test('quoted paths with spaces keep their quoting', async ($, on) => {
  const { ran } = setup(on)
  await bash($, 'rm "my file.txt"')
  expect(ran).toEqual(['git rm -- "my file.txt"'])
})

test('several segments are rewritten in place', async ($, on) => {
  const { ran } = setup(on)
  await bash($, 'rm a.txt && mv b.txt dir/ && ls')
  expect(ran).toEqual(['git rm -- a.txt && git mv -- b.txt dir/ && ls'])
})

test('mixed tracked and untracked operands are denied with both commands', async ($, on) => {
  const { ran } = setup(on)
  const r = await bash($, 'rm "my file.txt" notes.log')
  expect(ran).toEqual([])
  expect(String(r.deny)).toContain("git -C C:/repo rm -- 'my file.txt'")
  expect(String(r.deny)).toContain('rm -- C:/repo/notes.log')
})

test('unsupported options are denied with the git command', async ($, on) => {
  setup(on)
  const r = await bash($, 'rm -v a.txt')
  expect(String(r.deny)).toContain('git -C C:/repo rm -- a.txt')
})

test('a tracked file moved out of its repository is denied with mv and git rm --cached', async ($, on) => {
  setup(on)
  const r = await bash($, 'mv a.txt C:/elsewhere/a.txt')
  expect(String(r.deny)).toContain('mv -- C:/repo/a.txt C:/elsewhere/a.txt')
  expect(String(r.deny)).toContain('git -C C:/repo rm -r --cached -q -- a.txt')
})

test('a glob inside a work tree is denied; outside one it passes', async ($, on) => {
  const { ran } = setup(on)
  const r = await bash($, 'rm *.txt')
  expect(String(r.deny)).toContain('List the paths explicitly')
  await bash($, 'rm C:/elsewhere/*.txt')
  await bash($, 'rm "*.txt"')
  expect(ran).toEqual(['rm C:/elsewhere/*.txt', 'rm "*.txt"'])
})

test('cd sets the directory git is asked in', async ($, on) => {
  const { ran, gitCalls } = setup(on)
  await bash($, 'cd sub && rm c.txt')
  expect(ran).toEqual(['cd sub && git rm -- c.txt'])
  expect(gitCalls).toContainEqual(['git', '-C', 'C:/repo/sub', 'rev-parse', '--show-toplevel', '--show-prefix'])
  expect(gitCalls).toContainEqual(['git', '--literal-pathspecs', '-C', 'C:/repo/sub', 'ls-files', '-z', '--', 'c.txt'])
})

test('a subshell cd does not leak', async ($, on) => {
  const { ran } = setup(on)
  await bash($, '(cd sub && rm c.txt); rm a.txt')
  expect(ran).toEqual(['(cd sub && git rm -- c.txt); git rm -- a.txt'])
})

test('a path in another repository runs with git -C', async ($, on) => {
  const { ran } = setup(on)
  await bash($, 'rm /c/other/o.txt')
  expect(ran).toEqual(['git -C C:/other rm -- o.txt'])
})

test('operands in two repositories are denied with one git rm each', async ($, on) => {
  setup(on)
  const r = await bash($, 'rm a.txt C:/other/o.txt')
  expect(String(r.deny)).toContain('git -C C:/repo rm -- a.txt')
  expect(String(r.deny)).toContain('git -C C:/other rm -- o.txt')
})

test('deny mode denies with the rewrite as the suggestion', { options: { mode: 'deny' } }, async ($, on) => {
  const { ran } = setup(on)
  const r = await bash($, 'rm a.txt')
  expect(ran).toEqual([])
  expect(String(r.deny)).toContain('  git rm -- a.txt')
  await bash($, 'rm notes.log')
  expect(ran).toEqual(['rm notes.log'])
})

test('PowerShell Remove-Item of a tracked file is denied with git rm', async ($, on) => {
  setup(on)
  const r = await bash($, `pwsh -c "Remove-Item -Recurse dir"`)
  expect(String(r.deny)).toContain('git -C C:/repo rm -r -- dir')
})

test('a git failure counts as untracked', async ($, on) => {
  const { ran } = setup(on, () => fail)
  await bash($, 'rm a.txt')
  expect(ran).toEqual(['rm a.txt'])
})

test('a guard crash denies', async ($, on) => {
  on('session.cwd', () => {
    throw new Error('boom')
  })
  on('tool.call', () => ({ result: 'ran' }))
  const r = await bash($, 'rm a.txt')
  expect(String(r.deny)).toContain('its Bash guard failed')
})
