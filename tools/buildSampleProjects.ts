/**
 * Rebuild samples/sample_projects/*.scripthub from samples/sample_scripts/ (run after changing a sample script).
 * Port of tools/build_sample_projects.py. Each project takes some sample scripts (same sub-folders as in
 * sample_scripts/), adds sequences and presets, checks every sequence step the way a run would, and is saved with
 * the engine's own project code. It works in a throwaway data folder, so your own ScriptHub data is never touched.
 *
 * From code / tests:  await buildSampleProjects({ samplesDir, outDir })
 * Regenerate:         SCRIPTHUB_REBUILD_SAMPLES=1 npx vitest run packages/engine/test/sampleScripts.test.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Engine } from '../packages/engine/src/engine.js'
import { EXT, ProjectFiles } from '../packages/engine/src/projectFiles.js'

type Step = [key: string, script: string, values: Record<string, any>, x: number, y: number]
type Link = [from: string, to: string, when: 'success' | 'failure' | 'always']
interface Project {
  name: string
  files: string[]
  presets: Array<[script: string, name: string, values: Record<string, any>]>
  sequences: Array<{ name: string; steps: Step[]; links: Link[]; join?: Record<string, 'all' | 'any'> }>
}

export const PROJECTS: Project[] = [
  {
    name: 'Getting started',
    files: ['basics/hello.py', 'basics/hello.sh', 'basics/hello.bat', 'basics/parameter_tour.py', 'basics/outcome.py'],
    presets: [
      ['basics/hello.py', 'Formal', { greeting: 'Good morning', name: 'everyone' }],
      ['basics/hello.py', 'Loud', { shout: true, times: '3' }],
      ['basics/outcome.py', 'Fail after 2 seconds', { outcome: 'failure', seconds: '2' }],
    ],
    sequences: [{
      name: 'Try a sequence',
      steps: [
        ['hello', 'basics/hello.py', { name: 'sequence' }, 40, 140],
        ['work', 'basics/outcome.py', { outcome: 'success', seconds: '3' }, 300, 140],
        ['ok', 'basics/hello.py', { greeting: 'Hi', name: 'it worked' }, 560, 40],
        ['bad', 'basics/hello.py', { greeting: 'Hi', name: 'it failed', shout: true }, 560, 240],
      ],
      links: [['hello', 'work', 'success'], ['work', 'ok', 'success'], ['work', 'bad', 'failure']],
    }],
  },
  {
    name: 'Health check',
    files: ['system/system_info.py', 'system/disk_space.py', 'system/log_message.py', 'network/check_port.py', 'network/http_check.py'],
    presets: [
      ['system/disk_space.py', 'Strict (80%)', { max_used: '80' }],
      ['network/http_check.py', 'GitHub', { url: 'https://github.com/', contains: 'GitHub' }],
      ['network/check_port.py', 'DNS (1.1.1.1:53)', { host: '1.1.1.1', port: '53' }],
    ],
    sequences: [{
      name: 'Daily health check',
      steps: [
        ['info', 'system/system_info.py', {}, 40, 140],
        ['disk', 'system/disk_space.py', { max_used: '90' }, 300, 40],
        ['port', 'network/check_port.py', { host: 'github.com', port: '443' }, 300, 140],
        ['web', 'network/http_check.py', { url: 'https://example.com/', contains: 'Example Domain' }, 300, 240],
        ['good', 'system/log_message.py', { message: 'Health check passed.', level: 'info' }, 560, 80],
        ['alert', 'system/log_message.py', { message: 'A health check failed: see the run.', level: 'warning' }, 560, 220],
      ],
      links: [
        ['info', 'disk', 'always'], ['info', 'port', 'always'], ['info', 'web', 'always'],
        ['disk', 'good', 'success'], ['port', 'good', 'success'], ['web', 'good', 'success'],
        ['disk', 'alert', 'failure'], ['port', 'alert', 'failure'], ['web', 'alert', 'failure'],
      ],
      join: { alert: 'any' },
    }],
  },
  {
    name: 'Files and data',
    files: [
      'files/find_large_files.py', 'files/clean_old_files.py', 'files/backup_folder.py', 'files/file_checksum.py',
      'data/csv_summary.py', 'data/sales.csv', 'data/log_search.py', 'data/app.log', 'system/log_message.py',
    ],
    presets: [
      ['data/csv_summary.py', 'By product', { group_by: 'product', value: 'amount' }],
      ['data/csv_summary.py', 'Quantity per region', { group_by: 'region', value: 'quantity' }],
      ['data/log_search.py', 'Errors only', { pattern: 'ERROR|CRITICAL', context: '1' }],
      ['files/find_large_files.py', 'Logs over 1 MB', { pattern: '*.log', min_mb: '1' }],
    ],
    sequences: [{
      name: 'Log and sales report',
      steps: [
        ['sales', 'data/csv_summary.py', {}, 40, 40],
        ['errors', 'data/log_search.py', { pattern: 'ERROR|CRITICAL', fail_if_found: true }, 40, 200],
        ['clean', 'system/log_message.py', { message: 'app.log has no errors.' }, 300, 140],
        ['found', 'system/log_message.py', { message: 'app.log has errors: see the run.', level: 'warning' }, 300, 260],
      ],
      links: [['errors', 'clean', 'success'], ['errors', 'found', 'failure']],
    }],
  },
]

export interface BuildSamplesOptions {
  /** Folder holding sample_scripts's sub-folders (basics, files, ...). */
  samplesDir: string
  /** Where the .scripthub files are written. */
  outDir: string
  python?: string
  log?: (line: string) => void
}

/** Build every sample project; returns the written files. Throws when a sequence step would not run. */
export async function buildSampleProjects(opts: BuildSamplesOptions): Promise<string[]> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scripthub-samples-')))
  const data = path.join(home, 'data')
  fs.mkdirSync(data)
  // every sample type counts as a script, also where .bat is not one by default
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ interpreters: { '.py': opts.python ?? 'python', '.sh': 'bash', '.bat': 'cmd' } }))
  const engine = new Engine({ runtimeDir: data, appDir: home, pythonExecutable: opts.python })
  const projects = new ProjectFiles({
    dirs: engine.dirs, config: engine.config, discovery: engine.discovery, workspace: engine.workspace,
    sequences: engine.sequences, presets: engine.presets, appDir: home,
  })
  fs.mkdirSync(opts.outDir, { recursive: true })
  const written: string[] = []
  try {
    for (const proj of PROJECTS) {
      const folder = path.join(home, proj.name)
      for (const rel of proj.files) {
        const target = path.join(folder, ...rel.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(opts.samplesDir, ...rel.split('/')), target)
      }
      engine.workspace.openFolder(folder)
      const [found] = await engine.discovery.scan(true)
      const byPath = new Map(found.map((s) => [path.relative(folder, s.path).split(path.sep).join('/'), s]))
      const missing = proj.files.filter((r) => ['.py', '.sh', '.bat'].includes(path.extname(r)) && !byPath.has(r))
      if (missing.length) throw new Error(`${proj.name}: not discovered: ${missing.join(', ')}`)
      for (const [rel, name, values] of proj.presets) {
        const s = byPath.get(rel)!
        engine.presets.savePreset({ id: s.id, path: s.path }, name, s.meta.parameters ?? [], values, 'local')
      }
      const slugs: string[] = []
      for (const seq of proj.sequences) {
        const slug = engine.sequences.create(seq.name)
        const ids: Record<string, string> = {}
        for (const [key, rel, values, x, y] of seq.steps) ids[key] = engine.sequences.addStep(slug, engine.sequences.newStep(byPath.get(rel)!, values, '', x, y))
        for (const [a, b, when] of seq.links) engine.sequences.link(slug, ids[a], ids[b], when)
        for (const [key, join] of Object.entries(seq.join ?? {})) engine.sequences.updateStep(slug, ids[key], { join })
        const { errors } = engine.sequencer.prepare(engine.sequences.load(slug))
        if (errors.length) throw new Error(`${proj.name} / ${seq.name}: ${errors.join('; ')}`)
        slugs.push(slug)
      }
      const files = projects.folderFiles(folder).included.map((f) => f.path)
      const { bytes, report } = projects.build(folder, proj.name, files, slugs)
      const out = path.join(opts.outDir, proj.name + EXT)
      fs.writeFileSync(out, bytes)
      written.push(out)
      opts.log?.(`${path.basename(out)}: ${report.files} files (${report.scripts} scripts), ${report.sequences} sequence(s), ${report.presets} preset(s)`)
      for (const slug of slugs) engine.sequences.delete(slug)
    }
  } finally {
    engine.workspace.closeFolder()
    fs.rmSync(home, { recursive: true, force: true })
  }
  return written
}
