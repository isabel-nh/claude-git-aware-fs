import { expect, test } from 'claude-code/testing'
import { findCommands, normalize, quote, resolvePath } from '../hooks/rules.ts'
import { parseBash, type Segment } from '../hooks/shell.ts'

const values = (command: string) => parseBash(command).filter((i): i is Segment => typeof i !== 'string').map(s => s.words.map(w => w.value))

test('parseBash: quotes, separators and redirect targets', () => {
  expect(values(`rm "my file.txt" 'b c' && mv a\\ b c; ls > out.txt 2>&1 | cat`)).toEqual([['rm', 'my file.txt', 'b c'], ['mv', 'a b', 'c'], ['ls'], ['cat']])
})

test('parseBash: heredoc bodies and comments are dropped', () => {
  expect(values("cat <<'EOF' > x.sh\nrm a.txt\nEOF\necho done # rm b.txt")).toEqual([['cat'], ['echo', 'done']])
  expect(values('cat <<-EOF\n\trm a.txt\n\tEOF\nrm b.txt')).toEqual([['cat'], ['rm', 'b.txt']])
})

test('parseBash: globs and expansions are flagged only when unquoted', () => {
  const [seg] = parseBash(`rm *.log "x*.txt" $HOME/a "$(pwd)/b" ~/c {a,b}.txt`) as Segment[]
  expect(seg!.words.slice(1).map(w => [w.isGlob, w.isExpanded])).toEqual([
    [true, false],
    [false, false],
    [false, true],
    [false, true],
    [false, true],
    [true, false],
  ])
})

test('normalize and resolvePath: MinGW and Windows paths, posix untouched', () => {
  expect(normalize('/c/git/repo/', true)).toBe('C:/git/repo')
  expect(normalize('C:\\git\\repo', true)).toBe('C:/git/repo')
  expect(normalize('/c/git/repo', false)).toBe('/c/git/repo')
  expect(resolvePath('../x/./y', 'C:/repo/sub', true)).toBe('C:/repo/x/y')
  expect(resolvePath('a', undefined, false)).toBeUndefined()
  expect(resolvePath('/home/u/a', undefined, false)).toBe('/home/u/a')
})

test('quote: plain paths bare, others single-quoted', () => {
  expect(quote('src/a.ts')).toBe('src/a.ts')
  expect(quote('my file.txt')).toBe("'my file.txt'")
  expect(quote("it's")).toBe(`'it'\\''s'`)
})

test('findCommands: rm / mv only at command position, cwd from cd', () => {
  expect(findCommands('echo "rm x" && grep rm y', 'C:/repo')).toEqual([])
  const [c] = findCommands('cd sub && rm -rf -- -odd', 'C:/repo')
  expect([c!.kind, c!.cwd, c!.isRecursive, c!.isForced, c!.sources[0]!.abs]).toEqual(['rm', 'C:/repo/sub', true, true, 'C:/repo/sub/-odd'])
  const [m] = findCommands('(cd sub); mv -f a b', '/home/u/repo')
  expect([m!.kind, m!.cwd, m!.isForced, m!.sources[0]!.abs, m!.dst!.abs]).toEqual(['mv', '/home/u/repo', true, '/home/u/repo/a', '/home/u/repo/b'])
})

test('findCommands: unsupported options, redirects and assignments are not simple', () => {
  for (const cmd of ['rm -i a', 'rm a > log', 'X=1 rm a', 'mv -n a b', 'mv -t dir a']) expect(findCommands(cmd, 'C:/repo')[0]!.isSimple).toBe(false)
  expect(findCommands('rm -r -f a', 'C:/repo')[0]!.isSimple).toBe(true)
})

test('findCommands: temp paths are marked', () => {
  const [c] = findCommands('rm -f "$TEMP/x.log" /tmp/y C:/Users/me/AppData/Local/Temp/z', 'C:/repo')
  expect(c!.sources.map(o => o.isTemp)).toEqual([true, true, true])
})

test('findCommands: PowerShell Remove-Item / Move-Item inside -Command', () => {
  const [r, m] = findCommands(`powershell -NoProfile -Command "Remove-Item -LiteralPath 'a b.txt' -Recurse -Force; Move-Item c.txt -Destination d/"`, 'C:/repo')
  expect([r!.kind, r!.shell, r!.isRecursive, r!.isForced, r!.sources[0]!.abs]).toEqual(['rm', 'pwsh', true, true, 'C:/repo/a b.txt'])
  expect([m!.kind, m!.sources[0]!.abs, m!.dst!.abs]).toEqual(['mv', 'C:/repo/c.txt', 'C:/repo/d'])
})
