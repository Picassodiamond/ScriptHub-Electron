/** Execution engine tests: real subprocesses (port of runner/test_execution.py). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExecutionError, buildCommand, makeSpec, resolveInterpreter } from '../src/executor.js'
import { ExecutionManager, FileRunStore, FINAL_STATUSES, pidAlive, validRunId } from '../src/processManager.js'
import { shlexSplit } from '../src/sshHosts.js'
import { BASH, PY, PY_FWD, makeCase, sleep, waitFor } from './execCase.js'

describe('basic execution', () => {
  it('passes arguments and separates the streams', async () => {
    const c = makeCase()
    const p = c.script('echo.py', `
      import sys
      print("args:", sys.argv[1:])
      print("to-stderr", file=sys.stderr)
    `)
    const rid = c.mgr.submit(c.spec(p, ['--name', 'a b; rm -rf /', 'x']))
    const m = await c.finished(rid)
    expect([m.status, m.exit_code]).toEqual(['success', 0])
    expect(c.readLog(rid, 'stdout')).toContain("['--name', 'a b; rm -rf /', 'x']") // no shell parsing
    expect(c.readLog(rid, 'stdout')).not.toContain('to-stderr')
    expect(c.readLog(rid, 'stderr')).toContain('to-stderr')
    expect(m.duration_seconds).not.toBeNull()
    expect(m.id.startsWith('RUN-')).toBe(true)
  })

  it('reports the exit code of a failure', async () => {
    const c = makeCase()
    const p = c.script('fail.py', "import sys; print('boom', file=sys.stderr); sys.exit(3)")
    const m = await c.finished(c.mgr.submit(c.spec(p)))
    expect([m.status, m.exit_code]).toEqual(['failed', 3])
    expect(m.error).toContain('code 3')
  })

  it('sets the environment and working directory', async () => {
    const c = makeCase()
    const p = c.script('env.py', "import os; print(os.environ['MY_VAR'], os.getcwd())")
    const work = path.join(c.tmp, 'work')
    fs.mkdirSync(work)
    const rid = c.mgr.submit(c.spec(p, [], { env: { MY_VAR: 'hello' }, cwd: work }))
    await c.finished(rid)
    const out = c.readLog(rid, 'stdout').trim().split(/\s+/)
    expect(out[0]).toBe('hello')
    expect(fs.realpathSync(out.slice(1).join(' '))).toBe(fs.realpathSync(work))
  })

  it('shows output live, not buffered until exit', async () => {
    const c = makeCase()
    const p = c.script('live.py', `
      import time
      print("first", flush=True)
      time.sleep(3)
      print("second")
    `)
    const rid = c.mgr.submit(c.spec(p))
    expect(await waitFor(() => c.readLog(rid, 'stdout').includes('first'), 2500)).toBe(true)
    expect(c.meta(rid).status).toBe('running') // still running while output is visible
    await c.finished(rid)
  })

  it('fails cleanly when the interpreter is missing', async () => {
    const c = makeCase()
    const p = c.script('x.py', 'print(1)')
    const m = await c.finished(c.mgr.submit(c.spec(p, [], { interpreter: 'definitely-not-installed-xyz' })))
    expect(m.status).toBe('failed')
    expect(m.error).toContain('Could not start')
    expect(c.readLog(m.id, 'stderr')).toContain('Could not start')
  })

  it('gives unique, dated run ids', async () => {
    const c = makeCase()
    const p = c.script('n.py', 'print(1)')
    const ids = [1, 2, 3].map(() => c.mgr.submit(c.spec(p)))
    expect(new Set(ids).size).toBe(3)
    expect(ids.every(validRunId)).toBe(true)
    await c.mgr.waitIdle()
  })
})

describe('stop and timeout', () => {
  const SLEEPER = `
    import time
    print("started", flush=True)
    time.sleep(60)
  `

  it('a timeout stops the process', async () => {
    const c = makeCase()
    const p = c.script('slow.py', SLEEPER)
    const t0 = Date.now()
    const m = await c.finished(c.mgr.submit(c.spec(p, [], { timeout: 2 })))
    expect(m.status).toBe('timed_out')
    expect(m.error).toContain('2s timeout')
    expect(Date.now() - t0).toBeLessThan(15000)
    expect(pidAlive(m.pid)).toBe(false)
  })

  it('cancels a running process', async () => {
    const c = makeCase()
    const p = c.script('slow.py', SLEEPER)
    const rid = c.mgr.submit(c.spec(p))
    expect(await waitFor(() => c.readLog(rid, 'stdout').includes('started'))).toBe(true)
    const pid = c.meta(rid).pid
    expect(c.mgr.cancel(rid)).toBe(true)
    const m = await c.finished(rid)
    expect(m.status).toBe('cancelled')
    expect(pidAlive(pid)).toBe(false)
  })

  it('cancel kills child processes too', async () => {
    const c = makeCase()
    const p = c.script('parent.py', `
      import subprocess, sys, time
      child = subprocess.Popen([${JSON.stringify(PY)}, "-c", "import time; time.sleep(60)"])
      print(child.pid, flush=True)
      time.sleep(60)
    `)
    const rid = c.mgr.submit(c.spec(p))
    expect(await waitFor(() => /^\d+$/.test(c.readLog(rid, 'stdout').trim()))).toBe(true)
    const childPid = Number(c.readLog(rid, 'stdout').trim())
    expect(pidAlive(childPid)).toBe(true)
    c.mgr.cancel(rid)
    await c.finished(rid)
    expect(await waitFor(() => !pidAlive(childPid), 10000)).toBe(true)
  })

  it('refuses to cancel an unknown run', () => {
    expect(makeCase().mgr.cancel('RUN-20200101-001')).toBe(false)
  })

  it('does not report success before the process exits', async () => {
    const c = makeCase()
    const p = c.script('slow.py', SLEEPER)
    const rid = c.mgr.submit(c.spec(p))
    await waitFor(() => c.meta(rid).status === 'running')
    expect(c.meta(rid).status).not.toBe('success')
    expect(c.meta(rid).exit_code).toBeNull()
  })
})

describe('concurrency', () => {
  it('queues the second run then starts it, strictly sequentially', async () => {
    const c = makeCase({ maxConcurrent: 1 })
    const p = c.script('short.py', "import time; time.sleep(1.5); print('done')")
    const first = c.mgr.submit(c.spec(p, [], { scriptId: 'a' }))
    const second = c.mgr.submit(c.spec(p, [], { scriptId: 'b' }))
    expect(c.meta(second).status).toBe('queued')
    expect(c.mgr.queuePosition(second)).toBe(1)
    expect((await c.finished(first)).status).toBe('success')
    expect((await c.finished(second)).status).toBe('success')
    expect(c.meta(first).finished_at <= c.meta(second).started_at).toBe(true)
  })

  it('cancels a queued run', async () => {
    const c = makeCase({ maxConcurrent: 1 })
    const p = c.script('short.py', 'import time; time.sleep(2)')
    c.mgr.submit(c.spec(p, [], { scriptId: 'a' }))
    const queued = c.mgr.submit(c.spec(p, [], { scriptId: 'b' }))
    expect(c.mgr.cancel(queued)).toBe(true)
    const m = c.meta(queued)
    expect(m.status).toBe('cancelled')
    expect(m.started_at).toBeNull()
    expect(c.mgr.queuePosition(queued)).toBeNull()
  })

  it('a non-concurrent script waits, others do not', async () => {
    const c = makeCase()
    const p = c.script('work.py', 'import time; time.sleep(2)')
    const other = c.script('other.py', "print('quick')")
    const a1 = c.mgr.submit(c.spec(p, [], { scriptId: 'solo', allowConcurrent: false }))
    const a2 = c.mgr.submit(c.spec(p, [], { scriptId: 'solo', allowConcurrent: false }))
    const b = c.mgr.submit(c.spec(other, [], { scriptId: 'other' }))
    expect(c.meta(a2).status).toBe('queued') // blocked by a1...
    expect((await c.finished(b)).status).toBe('success') // ...but does not block others
    expect(c.meta(a2).status).toBe('queued')
    expect((await c.finished(a1)).status).toBe('success')
    expect((await c.finished(a2)).status).toBe('success')
  })

  it('a concurrent script runs in parallel', async () => {
    const c = makeCase()
    const p = c.script('work.py', 'import time; time.sleep(2)')
    const a = c.mgr.submit(c.spec(p, [], { scriptId: 'par', allowConcurrent: true }))
    const b = c.mgr.submit(c.spec(p, [], { scriptId: 'par', allowConcurrent: true }))
    expect(await waitFor(() => c.meta(a).status === 'running' && c.meta(b).status === 'running', 5000)).toBe(true)
    await c.mgr.waitIdle()
  })

  it('applies the host limit per host', async () => {
    const c = makeCase({ perHost: 1 })
    const p = c.script('work.py', 'import time; time.sleep(1.5)')
    const first = c.mgr.submit(c.spec(p, [], { scriptId: 'a' }))
    const second = c.mgr.submit(c.spec(p, [], { scriptId: 'b' }))
    expect(c.meta(second).status).toBe('queued')
    await c.finished(first)
    await c.finished(second)
  })

  it('wait_any / wait_finished report finished runs', async () => {
    const c = makeCase()
    const quick = c.script('q.py', 'print(1)')
    const a = c.mgr.submit(c.spec(quick, [], { scriptId: 'a' }))
    expect(await c.mgr.waitFinished(a, 15000)).toBe(true)
    expect(await c.mgr.waitAny([a], 1000)).toEqual([a])
    const slow = c.script('s.py', 'import time; time.sleep(5)')
    const b = c.mgr.submit(c.spec(slow, [], { scriptId: 'b' }))
    expect(await c.mgr.waitAny([b], 300)).toEqual([])
    c.mgr.cancel(b)
    expect(await c.mgr.waitFinished(b, 15000)).toBe(true)
  })
})

describe('duplicates and recovery', () => {
  it('a duplicate submit token returns the same run', async () => {
    const c = makeCase()
    const p = c.script('n.py', 'print(1)')
    const a = c.mgr.submit(c.spec(p, [], { token: 'tok-1' }))
    const b = c.mgr.submit(c.spec(p, [], { token: 'tok-1' }))
    expect(a).toBe(b)
    expect(c.store.listRuns().length).toBe(1)
    await c.mgr.waitIdle()
  })

  it('recovery marks orphaned runs interrupted', () => {
    const c = makeCase()
    const rows: Array<[string, number, string]> = [
      ['RUN-20260101-001', 99999999, 'running'],
      ['RUN-20260101-002', 99999999, 'queued'],
      ['RUN-20260101-003', process.pid, 'running'],
      ['RUN-20260101-004', 99999999, 'success'],
    ]
    for (const [rid, owner, status] of rows) {
      fs.mkdirSync(c.store.runDir(rid), { recursive: true })
      c.store.writeMeta(rid, { id: rid, status, owner_pid: owner, host: 'local', started_at: c.store.nowIso(), pid: null })
    }
    const fixed = c.mgr.recoverInterrupted()
    expect(fixed.sort()).toEqual(['RUN-20260101-001', 'RUN-20260101-002'])
    expect(c.meta('RUN-20260101-001').status).toBe('interrupted')
    expect(c.meta('RUN-20260101-003').status).toBe('running') // live owner untouched
    expect(c.meta('RUN-20260101-004').status).toBe('success')
    expect(c.meta('RUN-20260101-001').finished_at).not.toBeNull()
  })

  it('history survives a new manager', async () => {
    const c = makeCase()
    const p = c.script('n.py', "print('persisted')")
    const rid = c.mgr.submit(c.spec(p))
    await c.finished(rid)
    const fresh = new ExecutionManager({ store: new FileRunStore(c.dirs), getConfig: () => c.cfg }) // an application restart
    fresh.recoverInterrupted()
    expect(c.meta(rid).status).toBe('success')
    expect(c.readLog(rid, 'stdout')).toContain('persisted')
  })
})

describe.skipIf(process.platform !== 'win32')('batch files (Windows only)', () => {
  it('runs with a positional argument', async () => {
    const c = makeCase()
    const bat = c.script('hello.bat', '@echo off\r\necho Hello %~1\r\nexit /b 0\r\n')
    const rid = c.mgr.submit(c.spec(bat, ['World'], { interpreter: 'cmd', extension: '.bat' }))
    const m = await c.finished(rid)
    expect(m.status).toBe('success')
    expect(c.readLog(rid, 'stdout')).toContain('Hello World')
  })

  it('reports the exit code', async () => {
    const c = makeCase()
    const bat = c.script('bad.bat', '@echo off\r\nexit /b 7\r\n')
    const m = await c.finished(c.mgr.submit(c.spec(bat, [], { interpreter: 'cmd', extension: '.bat' })))
    expect([m.status, m.exit_code]).toEqual(['failed', 7])
  })

  it('rejects command injection characters', async () => {
    const c = makeCase()
    const marker = path.join(c.tmp, 'pwned.txt')
    const bat = c.script('echo.bat', '@echo off\r\necho %~1\r\n')
    for (const evil of ['a & echo x > ' + marker, 'a | dir', '%PATH%', 'a" & dir', 'a^b', '!x!']) {
      const m = await c.finished(c.mgr.submit(c.spec(bat, [evil], { interpreter: 'cmd', extension: '.bat' })))
      expect(m.status, evil).toBe('failed')
      expect(m.error).toContain('not allowed for batch files')
    }
    expect(fs.existsSync(marker)).toBe(false)
  })
})

describe('command building', () => {
  const CFG = {
    interpreters: { '.py': 'python' }, remote_interpreters: { '.py': 'python3', '.sh': 'bash' },
    ssh_executable: 'ssh', ssh_connect_timeout: 10,
  }
  const mk = (over: Record<string, any> = {}) =>
    makeSpec({ scriptId: 's', scriptName: 's', scriptPath: '/tmp/x.py', extension: '.py', interpreter: 'python3', host: 'local', argv: [], ...over })
  const withTemp = (name: string, body: string, f: (file: string) => void) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-cmd-'))
    try {
      const file = path.join(d, name)
      fs.writeFileSync(file, body)
      f(file)
    } finally {
      fs.rmSync(d, { recursive: true, force: true })
    }
  }

  it('quotes the remote command fully and streams the script', () => {
    withTemp('x.py', "print('hi')", (file) => {
      const nasty = '$(touch /tmp/pwned); `id` \'q\' "d"'
      const cmd = buildCommand(mk({ scriptPath: file, host: 'prod-1', argv: ['--name', nasty], env: { A: 'b c' }, cwd: '/srv/app dir' }), CFG)
      expect(cmd.remote).toBe(true)
      expect(cmd.stdin!.toString()).toBe("print('hi')")
      expect(cmd.args.slice(0, 7)).toEqual(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', '--'])
      expect(cmd.args[7]).toBe('prod-1')
      const remoteArgv = shlexSplit(cmd.args[8]) // what the remote shell will see
      expect(remoteArgv.slice(0, 2)).toEqual(['sh', '-c'])
      const tail = remoteArgv.slice(4)
      expect(tail[0]).toBe('/srv/app dir')
      expect(tail).toContain('A=b c')
      expect(tail).toContain('PYTHONUNBUFFERED=1')
      expect(tail.slice(-3)).toEqual(['-', '--name', nasty]) // hostile text survives as ONE argument
    })
  })

  it('uses stdin flags for bash remotely', () => {
    withTemp('x.sh', 'echo hi', (file) => {
      const cmd = buildCommand(mk({ scriptPath: file, extension: '.sh', interpreter: 'bash', host: 'h1', argv: ['a'] }), CFG)
      expect(shlexSplit(cmd.args[8]).slice(-4)).toEqual(['bash', '-s', '--', 'a'])
    })
  })

  it('rejects invalid hosts and remote batch files', () => {
    for (const host of ['-oProxyCommand=evil', 'a b', 'x;y', '']) expect(() => buildCommand(mk({ host }), CFG), host).toThrow(ExecutionError)
    expect(() => buildCommand(mk({ host: 'h1', extension: '.bat', scriptPath: '/tmp/x.bat' }), CFG)).toThrow(ExecutionError)
  })

  it('resolves the interpreter per target', () => {
    expect(resolveInterpreter(null, '.py', 'local', CFG)).toBe('python')
    expect(resolveInterpreter(null, '.py', 'h1', CFG)).toBe('python3')
    expect(resolveInterpreter('custom', '.py', 'h1', CFG)).toBe('custom')
    expect(() => resolveInterpreter(null, '.bat', 'h1', CFG)).toThrow(ExecutionError)
  })
})

describe.skipIf(!BASH)('remote execution against a fake ssh', () => {
  const remote = (c: ReturnType<typeof makeCase>, p: string, argv: string[] = [], over: Record<string, any> = {}) =>
    c.mgr.submit(c.spec(p, argv, { host: 'prod-1', interpreter: PY_FWD, ...over }))

  it('streams a Python script over stdin with arguments', async () => {
    const c = makeCase({ fakeSsh: true })
    const p = c.script('remote.py', `
      import sys, os
      print("argv", sys.argv[1:])
      print("who", os.environ.get("REMOTE_VAR"))
      print("err", file=sys.stderr)
    `)
    const rid = remote(c, p, ['--x', 'one two', '$HOME'], { env: { REMOTE_VAR: 'yes' } })
    const m = await c.finished(rid)
    expect([m.status, m.exit_code], c.readLog(rid, 'stderr')).toEqual(['success', 0])
    const out = c.readLog(rid, 'stdout')
    expect(out).toContain("argv ['--x', 'one two', '$HOME']") // not expanded by the remote shell
    expect(out).toContain('who yes')
    expect(out).not.toContain('__SR_PID__') // marker line is stripped
    expect(c.readLog(rid, 'stderr')).toContain('err')
    expect(Number.isInteger(m.remote_pid)).toBe(true)
  }, 60000)

  it('runs a remote bash script', async () => {
    const c = makeCase({ fakeSsh: true })
    const p = c.script('remote.sh', 'echo "n=$#"; echo "first=$1"\n')
    const rid = c.mgr.submit(c.spec(p, ['a b', 'c'], { host: 'prod-1', interpreter: 'bash', extension: '.sh' }))
    const m = await c.finished(rid)
    expect(m.status, c.readLog(rid, 'stderr')).toBe('success')
    expect(c.readLog(rid, 'stdout')).toContain('n=2')
    expect(c.readLog(rid, 'stdout')).toContain('first=a b')
  }, 60000)

  it('reports a connection failure as an ssh failure', async () => {
    const c = makeCase({ fakeSsh: true })
    const p = c.script('remote.py', 'print(1)')
    const m = await c.finished(c.mgr.submit(c.spec(p, [], { host: 'down', interpreter: PY_FWD })))
    expect([m.status, m.exit_code]).toEqual(['failed', 255])
    expect(m.error).toContain('SSH connection failed')
    expect(c.readLog(m.id, 'stderr')).toContain('Connection refused')
  }, 60000)

  it('reports a remote failure exit code', async () => {
    const c = makeCase({ fakeSsh: true })
    const p = c.script('remote.py', 'import sys; sys.exit(4)')
    const m = await c.finished(remote(c, p))
    expect([m.status, m.exit_code]).toEqual(['failed', 4])
  }, 60000)

  it('cancel sends the remote stop command', async () => {
    const c = makeCase({ fakeSsh: true })
    const p = c.script('remote.py', "import time; print('up', flush=True); time.sleep(20)")
    const rid = remote(c, p)
    expect(await waitFor(() => c.readLog(rid, 'stdout').includes('up'), 15000)).toBe(true)
    expect(await waitFor(() => Number.isInteger(c.meta(rid).remote_pid), 5000)).toBe(true)
    c.mgr.cancel(rid)
    const ok = await waitFor(() => FINAL_STATUSES.includes(c.meta(rid).status), 60000)
    const calls = fs.readFileSync(c.sshLog, 'utf8')
    expect(ok, `still running\nssh calls:\n${calls}`).toBe(true)
    expect(c.meta(rid).status).toBe('cancelled')
    expect(calls).toContain(`kill -TERM ${c.meta(rid).remote_pid}`)
  }, 90000)
})

void sleep
