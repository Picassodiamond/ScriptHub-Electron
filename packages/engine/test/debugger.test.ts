/** Step debugger: markers, local Python/Bash debugging, SSH via a fake ssh (port of runner/test_debugger.py). */
import { describe, expect, it } from 'vitest'
import { ExecutionError, buildCommand, debugSupported, makeSpec } from '../src/executor.js'
import { FINAL_STATUSES } from '../src/processManager.js'
import * as tracing from '../src/tracing.js'
import { BASH, BASH_CMD, PY_FWD, lf, makeCase, sleep, waitFor, type Case } from './execCase.js'

// ---- helpers on top of the case for driving a debug run ----
const state = (c: Case, rid: string): any => c.mgr.debugState(rid) ?? {}

async function waitPaused(c: Case, rid: string, line: number | null = null, timeoutMs = 20000) {
  // The Python debugger reports the stop (SRP) and then its variables/stack (SRV) in a second marker, so
  // "paused" can be seen a moment before the snapshot; wait for it (bash only reports the line).
  const python = String(c.meta(rid).script_path ?? '').endsWith('.py')
  const ready = () => state(c, rid).state === 'paused' && (line === null || state(c, rid).line === line) && (!python || state(c, rid).stack.length > 0)
  const ok = await waitFor(ready, timeoutMs)
  expect(ok, `not paused at ${line}: ${JSON.stringify(state(c, rid))} / ${c.readLog(rid, 'stderr')}`).toBe(true)
  return state(c, rid)
}

async function stepTo(c: Case, rid: string, line: number) {
  expect(c.mgr.debugCommand(rid, 'step')).toBe(true)
  return waitPaused(c, rid, line)
}

async function finished(c: Case, rid: string, timeoutMs = 30000) {
  expect(await waitFor(() => FINAL_STATUSES.includes(c.meta(rid).status), timeoutMs), `run did not finish: ${JSON.stringify(state(c, rid))}`).toBe(true)
  return c.meta(rid)
}

const varMap = (scope: any) => Object.fromEntries(scope.vars.map((v: any) => [v.name, v.value]))

describe('debug markers', () => {
  const run = (chunks: Buffer[], events = true) => {
    const lines: number[] = []
    const ev: Array<[string, any]> = []
    const f = new tracing.MarkerFilter((n) => lines.push(...n), events ? (k, v) => ev.push([k, v]) : null)
    const out = Buffer.concat([...chunks.map((c) => f.feed(c)), f.flush()])
    return { out: out.toString('latin1'), lines, ev }
  }
  const B = (s: string) => Buffer.from(s, 'latin1')

  it('handles pause, resume and variables across any chunk boundary', () => {
    const snap = JSON.stringify({ scopes: [{ name: 'Locals', vars: [{ name: 'x', type: 'int', value: '1' }] }], stack: [{ fn: 'f', line: 4 }] })
    const data = B('a\0SRL3,4\0b\0SRP4\0\0SRV' + snap + '\0c\0SRR\0d')
    for (let cut = 1; cut < data.length; cut++) {
      const { out, lines, ev } = run([data.subarray(0, cut), data.subarray(cut)])
      expect(out, String(cut)).toBe('abcd')
      expect(lines).toEqual([3, 4])
      expect(ev.map(([k]) => k)).toEqual(['P', 'V', 'R'])
      expect(ev[0][1]).toBe(4)
      expect(ev[1][1].stack[0].fn).toBe('f')
    }
  })

  it('ignores debug markers without an event callback', () => {
    const { out, lines } = run([B('x\0SRP4\0y\0SRL2\0')], false)
    expect(out).toBe('x\0SRP4\0y')
    expect(lines).toEqual([2])
  })

  it('accepts a long variables marker', () => {
    const big = JSON.stringify({ scopes: [{ name: 'Globals', vars: [{ name: 's', type: 'str', value: 'z'.repeat(50000) }] }], stack: [] })
    const { out, ev } = run([B('\0SRV' + big.slice(0, 1000)), B(big.slice(1000, 30000)), B(big.slice(30000) + '\0tail')])
    expect(out).toBe('tail')
    expect(ev[0][1].scopes[0].vars[0].value.length).toBe(50000)
  })

  it('leaves bad bodies in the stream', () => {
    const { out, ev } = run([B('\0SRPx\0|\0SRRy\0|\0SRV{nope\0')])
    expect(ev).toEqual([])
    expect(out).toBe('\0SRPx\0|\0SRRy\0|\0SRV{nope\0')
  })
})

describe('command building', () => {
  it('refuses to debug a batch file', () => {
    const spec = makeSpec({ scriptId: 'x', scriptName: 'x', scriptPath: 'x.bat', extension: '.bat', interpreter: 'cmd', host: 'local', argv: [], trace: {}, debug: true })
    expect(() => buildCommand(spec, { interpreters: {}, remote_interpreters: {}, ssh_executable: 'ssh', ssh_connect_timeout: 10 })).toThrow(/Step debugging/)
    expect(() => buildCommand(spec, {})).toThrow(ExecutionError)
    expect(debugSupported('.bat', 'cmd')).toBe(false)
    expect(debugSupported('.py', 'python3')).toBe(true)
  })

  it('writes the bash prologue as one line', () => {
    expect(tracing.bashDebugPrologue(1).split('\n').length - 1).toBe(1)
    expect(tracing.bashDebugPrologue(1).endsWith('\n')).toBe(true)
  })
})

describe('local Python debug', () => {
  const SRC = `x = 10
def double(a):
    b = a * 2
    return b
y = double(x)
items = [1, 2, 3]
for i in items:
    y += i
print("y", y)
`
  const debugRun = (c: Case, src: string = SRC, over: Record<string, any> = {}) => {
    const p = lf(c.script('dbg.py', src))
    return c.mgr.submit(c.spec(p, [], { debug: true, ...over }))
  }

  it('pauses on entry and steps line by line', async () => {
    const c = makeCase()
    const rid = debugRun(c)
    let st = await waitPaused(c, rid, 1)
    expect(st.stack).toEqual([{ fn: '<module>', line: 1 }])
    expect(c.meta(rid).debug.enabled).toBe(true)
    expect(c.meta(rid).trace.enabled).toBe(true)
    await stepTo(c, rid, 2)
    await stepTo(c, rid, 5)
    st = await stepTo(c, rid, 3) // steps into double()
    expect(st.stack.map((f: any) => f.fn)).toEqual(['double', '<module>'])
    st = await stepTo(c, rid, 4)
    const local = Object.fromEntries(st.scopes[0].vars.map((v: any) => [v.name, v]))
    expect(st.scopes[0].name).toBe('Locals')
    expect(local.a.value).toBe('10')
    expect(local.b).toEqual({ name: 'b', type: 'int', value: '20' })
    const glob = new Set(st.scopes[1].vars.map((v: any) => v.name))
    expect(glob.has('x')).toBe(true)
    expect(glob.has('double')).toBe(false) // functions are left out at module level
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    const m = await finished(c, rid)
    expect([m.status, m.exit_code], c.readLog(rid, 'stderr')).toEqual(['success', 0])
    expect(c.readLog(rid, 'stdout').trim()).toBe('y 26')
    expect(c.readLog(rid, 'stderr')).toBe('') // no markers leak
  }, 90000)

  it('honours breakpoints and continue', async () => {
    const c = makeCase()
    const rid = debugRun(c)
    await waitPaused(c, rid, 1)
    expect(c.mgr.debugCommand(rid, 'breakpoints', [8])).toBe(true)
    expect(state(c, rid).breakpoints).toEqual([8])
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    const st = await waitPaused(c, rid, 8)
    expect(varMap(st.scopes[0]).i).toBe('1')
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    expect(await waitFor(() => state(c, rid).state === 'paused' && varMap(state(c, rid).scopes[0]).i === '2', 20000)).toBe(true)
    expect(c.mgr.debugCommand(rid, 'breakpoints', [])).toBe(true) // clear
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    const m = await finished(c, rid)
    expect(m.status, c.readLog(rid, 'stderr')).toBe('success')
  }, 90000)

  it('keeps breakpoints set before the first stop', async () => {
    const c = makeCase()
    const rid = debugRun(c)
    expect(await waitFor(() => ['starting', 'paused'].includes(state(c, rid).state), 10000)).toBe(true)
    expect(c.mgr.debugCommand(rid, 'breakpoints', [6])).toBe(true)
    await waitPaused(c, rid, 1)
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    await waitPaused(c, rid, 6)
    c.mgr.debugCommand(rid, 'detach')
    expect((await finished(c, rid)).status).toBe('success')
  }, 90000)

  it('can pause while running', async () => {
    const c = makeCase()
    const rid = debugRun(c, "import time\nfor i in range(400):\n    time.sleep(0.02)\nprint('done')\n")
    await waitPaused(c, rid, 1)
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    expect(await waitFor(() => state(c, rid).state === 'running', 10000)).toBe(true)
    await sleep(300)
    expect(c.mgr.debugCommand(rid, 'pause')).toBe(true)
    const st = await waitPaused(c, rid)
    expect([2, 3]).toContain(st.line)
    expect(c.mgr.debugCommand(rid, 'detach')).toBe(true)
    expect(state(c, rid).state).toBe('detached')
    expect(c.mgr.debugCommand(rid, 'step')).toBe(false) // nothing to control any more
    const m = await finished(c, rid)
    expect(m.status).toBe('success')
    expect(m.trace.stopped).toBe(true)
    expect(c.readLog(rid, 'stdout')).toContain('done')
  }, 90000)

  it('detach runs at full speed', async () => {
    const c = makeCase()
    const rid = debugRun(c, 'total = 0\nfor i in range(200000):\n    total += i\nprint(total)\n')
    await waitPaused(c, rid, 1)
    expect(c.mgr.stopTrace(rid)).toBe(true) // stop_trace = detach for debug runs
    const m = await finished(c, rid, 20000)
    expect(m.status).toBe('success')
    const expected = (199999 * 200000) / 2
    expect(c.readLog(rid, 'stdout').trim()).toBe(String(expected))
  }, 90000)

  it('cancels while paused', async () => {
    const c = makeCase()
    const rid = debugRun(c)
    await waitPaused(c, rid, 1)
    expect(c.mgr.cancel(rid)).toBe(true)
    const m = await finished(c, rid)
    expect(m.status).toBe('cancelled')
    expect(c.mgr.debugState(rid)).toBeNull()
    expect(c.mgr.debugCommand(rid, 'step')).toBe(false)
  }, 90000)

  it('hides the control stream from the script and its children', async () => {
    const c = makeCase()
    const rid = debugRun(
      c,
      'import subprocess, sys\n' +
        "r = subprocess.run([sys.executable, '-c', 'import sys; print(repr(sys.stdin.read()))'], capture_output=True, text=True)\n" +
        "print('child', r.stdout.strip(), repr(sys.stdin.read()))\n",
    )
    await waitPaused(c, rid, 1)
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    const m = await finished(c, rid)
    expect(m.status, c.readLog(rid, 'stderr')).toBe('success')
    expect(c.readLog(rid, 'stdout').trim()).toBe("child '' ''")
  }, 90000)

  it('reports an uncaught exception while debugging', async () => {
    const c = makeCase()
    const rid = debugRun(c, "def f():\n    raise ValueError('bad')\nf()\n")
    await waitPaused(c, rid, 1)
    c.mgr.debugCommand(rid, 'continue')
    const m = await finished(c, rid)
    expect([m.status, m.exit_code]).toEqual(['failed', 1])
    expect(c.readLog(rid, 'stderr')).toContain('ValueError: bad')
    expect(c.readLog(rid, 'stderr')).not.toContain('File "<string>"')
  }, 90000)

  it('refuses unknown actions and untraced runs', async () => {
    const c = makeCase()
    const p = c.script('plain.py', 'import time\ntime.sleep(1)\n')
    const rid = c.mgr.submit(c.spec(p))
    expect(await waitFor(() => c.meta(rid).status === 'running', 10000)).toBe(true)
    expect(c.mgr.debugState(rid)).toBeNull()
    expect(c.mgr.debugCommand(rid, 'step')).toBe(false)
    expect(c.meta(rid).debug).toBeNull()
    await finished(c, rid)
    const rid2 = debugRun(c)
    await waitPaused(c, rid2, 1)
    expect(c.mgr.debugCommand(rid2, 'jump')).toBe(false)
    c.mgr.debugCommand(rid2, 'detach')
    await finished(c, rid2)
  }, 90000)
})

describe.skipIf(!BASH)('local Bash debug', () => {
  const SRC = `echo one
f() {
  echo "in f $1"
}
f x
echo "two $(echo sub)"
echo three
`

  it('steps and stops at a breakpoint', async () => {
    const c = makeCase()
    const p = lf(c.script('d.sh', SRC))
    const rid = c.mgr.submit(c.spec(p, [], { interpreter: BASH_CMD, extension: '.sh', debug: true }))
    await waitPaused(c, rid, 1)
    expect(c.readLog(rid, 'stdout')).toBe('')
    await stepTo(c, rid, 5)
    expect(await waitFor(() => c.readLog(rid, 'stdout').includes('one'), 10000)).toBe(true)
    await stepTo(c, rid, 2) // entering f
    expect(c.mgr.debugCommand(rid, 'breakpoints', [7])).toBe(true)
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    const st = await waitPaused(c, rid, 7)
    expect(st.scopes).toEqual([]) // bash: no variables
    expect(c.readLog(rid, 'stdout')).toContain('two sub')
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    const m = await finished(c, rid)
    expect([m.status, m.exit_code], c.readLog(rid, 'stderr')).toEqual(['success', 0])
    expect(c.readLog(rid, 'stdout').split(/\r?\n/).slice(0, 4)).toEqual(['one', 'in f x', 'two sub', 'three'])
    expect(c.readLog(rid, 'stderr')).not.toContain('SR')
  }, 90000)

  it('reports the exit code and can be cancelled', async () => {
    const c = makeCase()
    const p = lf(c.script('e.sh', 'echo a\nexit 4\n'))
    let rid = c.mgr.submit(c.spec(p, [], { interpreter: BASH_CMD, extension: '.sh', debug: true }))
    await waitPaused(c, rid, 1)
    c.mgr.debugCommand(rid, 'continue')
    expect((await finished(c, rid)).exit_code).toBe(4)
    rid = c.mgr.submit(c.spec(p, [], { interpreter: BASH_CMD, extension: '.sh', debug: true }))
    await waitPaused(c, rid, 1)
    expect(c.mgr.cancel(rid)).toBe(true)
    expect((await finished(c, rid)).status).toBe('cancelled')
  }, 90000)
})

describe.skipIf(!BASH)('remote debug (fake ssh)', () => {
  it('steps a remote Python script and continues', async () => {
    const c = makeCase({ fakeSsh: true })
    const p = lf(c.script('r.py', "import sys\na = 5\nb = a + 1\nprint('b', b, sys.argv[1:])\nsys.exit(3)\n"))
    const rid = c.mgr.submit(c.spec(p, ['x y'], { host: 'prod-1', interpreter: PY_FWD, debug: true }))
    await waitPaused(c, rid, 1)
    await stepTo(c, rid, 2)
    const st = await stepTo(c, rid, 3)
    expect(varMap(st.scopes[0]).a).toBe('5')
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    const m = await finished(c, rid)
    expect([m.status, m.exit_code], c.readLog(rid, 'stderr')).toEqual(['failed', 3])
    expect(c.readLog(rid, 'stdout').trim()).toBe("b 6 ['x y']")
    expect(c.readLog(rid, 'stderr')).not.toContain('SR')
  }, 120000)

  it('steps a remote bash script, with a breakpoint and an exit code', async () => {
    const c = makeCase({ fakeSsh: true })
    const p = lf(c.script('r.sh', 'echo "one $1"\necho two\necho three\nexit 2\n'))
    const rid = c.mgr.submit(c.spec(p, ['a b'], { host: 'prod-1', interpreter: 'bash', extension: '.sh', debug: true }))
    await waitPaused(c, rid, 1) // the prologue line is not counted
    await stepTo(c, rid, 2)
    expect(c.mgr.debugCommand(rid, 'breakpoints', [4])).toBe(true)
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    await waitPaused(c, rid, 4)
    expect(c.mgr.debugCommand(rid, 'continue')).toBe(true)
    const m = await finished(c, rid)
    expect([m.status, m.exit_code], c.readLog(rid, 'stderr')).toEqual(['failed', 2])
    expect(c.readLog(rid, 'stdout').split(/\s+/).filter(Boolean)).toEqual(['one', 'a', 'b', 'two', 'three'])
  }, 120000)
})
