import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigStore, defaultConfig } from '../src/config.js'
import { atomicWriteText, readJson } from '../src/fsutil.js'
import { runtimeLocation } from '../src/paths.js'
import { ValidationError, validateConfig } from '../src/validators.js'
import { tmpDir, tmpDirs } from './helpers.js'

describe('config', () => {
  it('defaults validate and round-trip through the store with a .bak', () => {
    const dirs = tmpDirs()
    const store = new ConfigStore(dirs, 'win32')
    expect(store.load()).toEqual(validateConfig(defaultConfig('win32')))
    expect(store.load().interpreters['.bat']).toBe('cmd')
    const cfg = store.load()
    cfg.max_concurrent_executions = 5
    store.save(cfg)
    expect(store.load().max_concurrent_executions).toBe(5)
    store.save({ ...cfg, max_concurrent_executions: 6 })
    expect(readJson(dirs.configFile + '.bak').max_concurrent_executions).toBe(5)
  })

  it('rejects bad values with readable errors', () => {
    const bad = { ...defaultConfig(), interpreters: { py: 'python' }, polling_interval: 10, environment: { '1x': 'a' }, enable_script_editing: 'yes' }
    try {
      validateConfig(bad)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      expect((e as ValidationError).errors.join('|')).toMatch(/Invalid file extension.*Polling interval.*|environment variable name/s)
      expect((e as ValidationError).errors.length).toBe(4)
    }
  })

  it('drops enable_adhoc and keeps a corrupt file from crashing load', () => {
    const dirs = tmpDirs()
    atomicWriteText(dirs.configFile, '{ not json')
    expect(new ConfigStore(dirs).load().max_concurrent_executions).toBe(3)
    expect(validateConfig({ ...defaultConfig(), enable_adhoc: true })).not.toHaveProperty('enable_adhoc')
  })

  it('picks the data folder: env, portable, then the user folder', () => {
    const home = tmpDir('sh-home-')
    expect(runtimeLocation({ env: { SCRIPTHUB_HOME: path.join(home, 'x') } }).mode).toBe('env')
    const portable = path.join(home, 'runtime')
    expect(runtimeLocation({ env: {}, portableDir: portable, platform: 'win32', homeDir: home }).mode).toBe('user')
    fs.mkdirSync(portable)
    expect(runtimeLocation({ env: {}, portableDir: portable }).mode).toBe('portable')
    expect(runtimeLocation({ env: { LOCALAPPDATA: 'C:\\L' }, platform: 'win32', homeDir: home }).dir).toBe(path.join('C:\\L', 'ScriptHub'))
    expect(runtimeLocation({ env: {}, platform: 'linux', homeDir: '/h' }).dir).toBe(path.join('/h', '.local', 'share', 'scripthub'))
  })
})
