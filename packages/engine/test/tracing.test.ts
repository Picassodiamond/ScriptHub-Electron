/** Line tracing: markers, local Python/Bash runs, stopping a trace mid-run, SSH (port of runner/test_tracing.py). */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExecutionError, buildCommand, makeSpec, traceSupported } from '../src/executor.js'
import { MarkerFilter } from '../src/tracing.js'
import { BASH, BASH_CMD, PY_FWD, lf, makeCase, sleep, waitFor } from './execCase.js'

describe('MarkerFilter', () => {
  const run = (chunks: string[]) => {
    const seen: number[] = []
    const f = new MarkerFilter((n) => seen.push(...n))
    const out = Buffer.concat([...chunks.map((c) => f.feed(Buffer.from(c, 'latin1'))), f.flush()])
    return { out: out.toString('latin1'), seen }
  }

  it('removes markers and reports the numbers', () => {
    const { out, seen } = run(['hello\n\0SRL3\0world\n\0SRL4,5,6\0'])
    expect(out).toBe('hello\nworld\n')
    expect(seen).toEqual([3, 4, 5, 6])
  })

  it('handles a marker split across chunks', () => {
    const data = 'a\0SRL12,13\0b'
    for (let cut = 1; cut < data.length; cut++) {
      const { out, seen } = run([data.slice(0, cut), data.slice(cut)])
      expect([out, seen], String(cut)).toEqual(['ab', [12, 13]])
    }
  })

  it('keeps what is not a marker', () => {
    const { out, seen } = run(['x\0SRLabc\0y', '\0SR'])
    expect(seen).toEqual([])
    expect(out).toBe('x\0SRLabc\0y\0SR')
  })
})

describe('command building', () => {
  it('traces only Python and Bash', () => {
    expect(traceSupported('.py', 'python3')).toBe(true)
    expect(traceSupported('.py', '"C:/Python312/python.exe"')).toBe(true)
    expect(traceSupported('.sh', 'bash')).toBe(true)
    expect(traceSupported('.sh', 'sh')).toBe(false)
    expect(traceSupported('.bat', 'cmd')).toBe(false)
  })

  it('refuses an unsupported script', () => {
    const spec = makeSpec({ scriptId: 'x', scriptName: 'x', scriptPath: 'x.bat', extension: '.bat', interpreter: 'cmd', host: 'local', argv: [], trace: {} })
    expect(() => buildCommand(spec, { interpreters: {}, remote_interpreters: {}, ssh_executable: 'ssh', ssh_connect_timeout: 10 })).toThrow(ExecutionError)
  })
})

describe('local Python trace', () => {
  it('reports lines, keeps output and stderr clean', async () => {
    const c = makeCase()
    const p = c.script('t.py', `
      import sys
      print("one")
      x = 1
      print("two", sys.argv[1:], __name__, file=sys.stderr)
    `)
    const rid = c.mgr.submit(c.spec(p, ['a b'], { trace: {} }))
    const m = await c.finished(rid)
    expect([m.status, m.exit_code], c.readLog(rid, 'stderr')).toEqual(['success', 0])
    expect(c.readLog(rid, 'stdout').trim()).toBe('one')
    expect(c.readLog(rid, 'stderr').trim()).toBe("two ['a b'] __main__") // no markers
    const nums = c.traceNumbers(rid)
    expect(nums[0]).toBe(2) // line 1 is blank (dedent keeps the leading newline)
    expect(nums[nums.length - 1]).toBe(5)
    expect([...new Set(nums)].sort((a, b) => a - b)).toEqual([2, 3, 4, 5])
    expect(fs.existsSync(path.join(c.store.runDir(rid), 'trace_source'))).toBe(true)
    expect(m.trace.enabled).toBe(true)
  })

  it('shows the traceback and exit code of an uncaught exception', async () => {
    const c = makeCase()
    const p = c.script('boom.py', `
      def f():
          raise ValueError("bad")
      f()
    `)
    const rid = c.mgr.submit(c.spec(p, [], { trace: {} }))
    const m = await c.finished(rid)
    expect([m.status, m.exit_code]).toEqual(['failed', 1])
    const err = c.readLog(rid, 'stderr')
    expect(err).toContain('ValueError: bad')
    expect(err).toContain('boom.py')
    expect(err).not.toContain('File "<string>"') // the launcher frame is hidden
    const nums = c.traceNumbers(rid)
    expect(nums[nums.length - 1]).toBe(3)
  })

  it('keeps the exit code and imports next to the script', async () => {
    const c = makeCase()
    fs.writeFileSync(path.join(c.scripts, 'helper_mod.py'), 'VALUE = 7\n')
    const p = c.script('ex.py', `
      import helper_mod, sys
      print(helper_mod.VALUE)
      sys.exit(3)
    `)
    const m = await c.finished(c.mgr.submit(c.spec(p, [], { trace: {} })))
    expect(m.exit_code).toBe(3)
  })

  it('stopping the trace mid-run keeps the script running', async () => {
    const c = makeCase()
    const p = c.script('loop.py', `
      import time
      for i in range(60):
          time.sleep(0.1)
      print("done")
    `)
    const rid = c.mgr.submit(c.spec(p, [], { trace: {} }))
    expect(await waitFor(() => c.traceNumbers(rid).length > 3, 15000), 'no trace appeared').toBe(true)
    expect(c.mgr.stopTrace(rid)).toBe(true)
    expect(c.meta(rid).trace.stopped).toBe(true)
    await sleep(1000) // let the launcher notice and flush
    const log = path.join(c.store.runDir(rid), 'trace.log')
    const size = fs.statSync(log).size
    expect(c.meta(rid).status).toBe('running')
    await sleep(1000)
    expect(fs.statSync(log).size).toBe(size) // nothing new
    const m = await c.finished(rid)
    expect([m.status, m.exit_code]).toEqual(['success', 0])
    expect(c.readLog(rid, 'stdout')).toContain('done')
  })

  it('refuses to stop the trace of an untraced or finished run', async () => {
    const c = makeCase()
    const p = c.script('q.py', 'print(1)')
    const rid = c.mgr.submit(c.spec(p))
    await c.finished(rid)
    expect(c.mgr.stopTrace(rid)).toBe(false)
    expect(c.meta(rid).trace).toBeNull()
  })
})

describe.skipIf(!BASH)('local Bash trace', () => {
  it('reports bash lines and leaves the script unchanged', async () => {
    const c = makeCase()
    const p = lf(c.script('t.sh', `
      #!/usr/bin/env bash
      echo "start"
      f() {
        echo "in f"
      }
      f
      echo "end $0" >&2
    `))
    const rid = c.mgr.submit(c.spec(p, [], { interpreter: BASH_CMD, extension: '.sh', trace: {} }))
    const m = await c.finished(rid)
    expect([m.status, m.exit_code], c.readLog(rid, 'stderr')).toEqual(['success', 0])
    expect(c.readLog(rid, 'stdout')).toContain('start')
    const err = c.readLog(rid, 'stderr')
    expect(err).toContain('end ')
    expect(err).not.toContain('SRL')
    expect(err).not.toContain('\0')
    const nums = c.traceNumbers(rid)
    expect(new Set(nums)).toEqual(new Set([3, 4, 5, 7, 8])) // echo, f() definition, echo in f, call f, final echo
    expect(nums[nums.length - 1]).toBe(8)
    expect(err).toContain('t.sh') // $0 is still the real script
  }, 60000)

  it('stops the bash trace on request', async () => {
    const c = makeCase()
    const p = lf(c.script('loop.sh', `
      for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
        sleep 0.1
      done
      echo finished
    `))
    const rid = c.mgr.submit(c.spec(p, [], { interpreter: BASH_CMD, extension: '.sh', trace: {} }))
    expect(await waitFor(() => c.traceNumbers(rid).length > 3, 15000)).toBe(true)
    expect(c.mgr.stopTrace(rid)).toBe(true)
    await sleep(600)
    const log = path.join(c.store.runDir(rid), 'trace.log')
    const size = fs.statSync(log).size
    await sleep(800)
    expect(fs.statSync(log).size).toBe(size)
    const m = await c.finished(rid)
    expect(m.status).toBe('success')
    expect(c.readLog(rid, 'stdout')).toContain('finished')
  }, 60000)
})

describe.skipIf(!BASH)('remote trace (fake ssh)', () => {
  it('traces a remote Python script', async () => {
    const c = makeCase({ fakeSsh: true })
    const p = c.script('r.py', `
      print("hi")
      y = 2
    `)
    const rid = c.mgr.submit(c.spec(p, [], { host: 'prod-1', interpreter: PY_FWD, trace: {} }))
    const m = await c.finished(rid)
    expect([m.status, m.exit_code], c.readLog(rid, 'stderr')).toEqual(['success', 0])
    expect(c.readLog(rid, 'stdout').trim()).toBe('hi')
    expect(c.readLog(rid, 'stderr')).not.toContain('SRL')
    expect([...new Set(c.traceNumbers(rid))].sort((a, b) => a - b)).toEqual([2, 3])
  }, 60000)

  it('remote bash trace lines match the file', async () => {
    const c = makeCase({ fakeSsh: true })
    const p = lf(c.script('r.sh', `
      echo one
      echo two
    `))
    const rid = c.mgr.submit(c.spec(p, [], { host: 'prod-1', interpreter: 'bash', extension: '.sh', trace: {} }))
    const m = await c.finished(rid)
    expect(m.status, c.readLog(rid, 'stderr')).toBe('success')
    expect(c.readLog(rid, 'stdout').split(/\s+/).filter(Boolean)).toEqual(['one', 'two'])
    expect([...new Set(c.traceNumbers(rid))].sort((a, b) => a - b)).toEqual([2, 3]) // prologue line is not counted
  }, 60000)

  it('remote bash trace stop sends USR1', async () => {
    const c = makeCase({ fakeSsh: true })
    const p = lf(c.script('r2.sh', `
      for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
        sleep 0.1
      done
      echo finished
    `))
    const rid = c.mgr.submit(c.spec(p, [], { host: 'prod-1', interpreter: 'bash', extension: '.sh', trace: {} }))
    expect(await waitFor(() => c.traceNumbers(rid).length > 3 && Number.isInteger(c.meta(rid).remote_pid), 15000)).toBe(true)
    expect(c.mgr.stopTrace(rid)).toBe(true)
    expect(await waitFor(() => fs.readFileSync(c.sshLog, 'utf8').includes('kill -USR1'), 10000)).toBe(true)
    await sleep(800)
    const log = path.join(c.store.runDir(rid), 'trace.log')
    const size = fs.statSync(log).size
    await sleep(800)
    expect(fs.statSync(log).size).toBe(size)
    const m = await c.finished(rid)
    expect(m.status, c.readLog(rid, 'stderr')).toBe('success')
    expect(c.readLog(rid, 'stdout')).toContain('finished')
  }, 90000)
})
