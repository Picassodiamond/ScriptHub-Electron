import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowedHosts, isValidHost, listHosts, shlexQuote, shlexSplit, splitCommand } from '../src/sshHosts.js'
import { tmpDir } from './helpers.js'

describe('shlex', () => {
  it('splits like Python in POSIX mode', () => {
    expect(shlexSplit(`a "b c" 'd e' f\\ g ""`)).toEqual(['a', 'b c', 'd e', 'f g', ''])
    expect(shlexSplit('x "q\\"r" # note', { comments: true })).toEqual(['x', 'q"r'])
    expect(() => shlexSplit('"open')).toThrow()
  })

  it('quotes like shlex.quote and round-trips hostile text', () => {
    expect(shlexQuote('plain-1_2/x.y')).toBe('plain-1_2/x.y')
    expect(shlexQuote('')).toBe("''")
    for (const s of ["it's", '$(id) `x` "y"', 'a b', '--name=x y', 'tab\there']) expect(shlexSplit(shlexQuote(s))).toEqual([s])
  })

  it('keeps Windows paths in non-POSIX mode and drops the surrounding quotes', () => {
    expect(splitCommand('"C:\\Program Files\\Python\\python.exe" -u', 'win32')).toEqual(['C:\\Program Files\\Python\\python.exe', '-u'])
    expect(splitCommand("python3 -u", 'linux')).toEqual(['python3', '-u'])
  })
})

describe('hosts', () => {
  it('validates host names', () => {
    for (const ok of ['local', 'prod-1', 'user@host.example.com']) expect(isValidHost(ok), ok).toBe(true)
    for (const bad of ['-oProxyCommand=evil', 'a b', 'x;y', '', 5]) expect(isValidHost(bad), String(bad)).toBe(false)
  })

  it('lists concrete Host aliases from ~/.ssh/config, following Include', () => {
    const home = tmpDir('sh-home-')
    fs.mkdirSync(path.join(home, '.ssh', 'conf.d'), { recursive: true })
    fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host web-1 web-2 *.wild\n  HostName x\n# Host hidden\nInclude conf.d/*.conf\nHost !neg ok-host # c\n')
    fs.writeFileSync(path.join(home, '.ssh', 'conf.d', 'a.conf'), 'Host db-1\n')
    expect(listHosts(home)).toEqual(['db-1', 'ok-host', 'web-1', 'web-2'])
    expect(allowedHosts(['extra', 'bad host'], home)).toEqual(['local', 'db-1', 'ok-host', 'web-1', 'web-2', 'extra'])
  })
})
