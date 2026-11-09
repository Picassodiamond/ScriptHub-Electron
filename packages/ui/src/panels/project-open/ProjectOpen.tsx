/**
 * Open project (.scripthub): choose the file (or a sample), see what is in it and what opening it does, choose a new
 * folder, unpack. Also the other direction: save the open folder as a project file.
 * Opening runs nothing; the folder it creates becomes the open folder.
 */
import type { ProjectInstallResult, ProjectPreview } from '@scripthub/protocol'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import {
  api, closeTab, errorText, hostCall, hostInfo, openTab, refreshShell, runCommand, shell, toast, useApi, type PanelProps,
} from '../../core'

type Stage = 'choose' | 'checking' | 'preview' | 'installing' | 'done'

/** `<picked>/<folderName>` with the separator the picked path already uses. */
export function joinDestination(picked: string, folderName: string): string {
  const sep = picked.includes('\\') && !picked.includes('/') ? '\\' : '/'
  const base = picked.replace(/[\\/]+$/, '')
  return `${base}${sep}${folderName}`
}

export function ProjectOpen({ tab }: PanelProps) {
  const [stage, setStage] = useState<Stage>('choose')
  const [preview, setPreview] = useState<ProjectPreview | null>(null)
  const [result, setResult] = useState<ProjectInstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [destination, setDestination] = useState('')
  const [typedPath, setTypedPath] = useState('')
  const [showFiles, setShowFiles] = useState(false)
  const desktop = !!hostInfo.value?.desktop
  const samples = useApi('project.samples', {}, [])
  const hasFolder = !!shell.value?.folder.folder
  const token = useRef<string | null>(null)
  const handled = useRef('')

  const cancelToken = (t: string | null) => { if (t) void api['project.cancel']({ token: t }).catch(() => {}) }

  const start = async (kind: 'path' | 'sample', value: string) => {
    cancelToken(token.current)
    token.current = null
    setError(null)
    setResult(null)
    setStage('checking')
    try {
      const p = kind === 'path' ? await api['project.open']({ path: value }) : await api['project.openSample']({ name: value })
      token.current = p.token
      setPreview(p)
      setDestination(p.destination)
      setShowFiles(false)
      setStage('preview')
    } catch (e) {
      setError(errorText(e))
      setStage('choose')
    }
  }

  // opened from the menu / Home with a file or a sample (a new nonce asks again)
  useEffect(() => {
    const { path, sample, nonce } = tab.params ?? {}
    const sig = `${path ?? ''}|${sample ?? ''}|${nonce ?? ''}`
    if (sig === '||' || handled.current === sig) return
    handled.current = sig
    if (path) void start('path', path)
    else if (sample) void start('sample', sample)
  }, [tab.params?.path, tab.params?.sample, tab.params?.nonce])

  // closing the tab with a file still waiting forgets the uploaded copy
  useEffect(() => () => cancelToken(token.current), [])

  const choose = async () => {
    try {
      const p = await hostCall<string | null>('host.openProject')
      if (p) await start('path', p)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const browse = async () => {
    if (!preview) return
    try {
      const picked = await api['workspace.pickFolder']({})
      if (picked) setDestination(joinDestination(picked, preview.folderName))
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const install = async () => {
    if (!preview || stage === 'installing') return
    const dest = destination.trim()
    if (!dest) return void setError('Choose a folder to unpack into.')
    setError(null)
    setStage('installing')
    try {
      const r = await api['project.install']({ token: preview.token, destination: dest })
      token.current = null
      setResult(r)
      setStage('done')
      toast.success(`Opened ${preview.preview.name}: ${r.files} file${r.files === 1 ? '' : 's'} unpacked.`)
      await refreshShell()
    } catch (e) {
      setError(errorText(e))
      setStage('preview')
    }
  }

  const cancel = () => {
    cancelToken(token.current)
    token.current = null
    setPreview(null)
    setError(null)
    setStage('choose')
  }

  const saveCurrent = async () => {
    try {
      const r = await hostCall<{ path: string; report: Record<string, any> } | null>('host.saveProject')
      if (r) toast.success(r.report?.summary ? `Saved ${r.path}: ${r.report.summary}` : `Saved ${r.path}`)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const info = preview?.preview

  return (
    <div class="page page-narrow">
      {error && <div class="flash flash-error" role="alert"><span>{error}</span></div>}

      {(stage === 'choose' || stage === 'checking') && (
        <>
          <section class="panel">
            <div class="panel-head"><h2><Icon name="download" class="faint" /> Open project</h2></div>
            <div class="panel-body">
              <p class="muted small">
                Choose a ScriptHub project file (.scripthub). You see what is in it before anything is written; then its files are unpacked into a
                new folder, its sequences and presets are added, and the folder opens.
              </p>
              {desktop ? (
                <button type="button" class="btn btn-primary" disabled={stage === 'checking'} onClick={() => void choose()}>
                  <Icon name="folder-open" /> {stage === 'checking' ? 'Checking…' : 'Choose project file…'}
                </button>
              ) : (
                <form class="inline-form" onSubmit={(e) => { e.preventDefault(); if (typedPath.trim()) void start('path', typedPath.trim()) }}>
                  <input class="input mono" value={typedPath} placeholder="Path of a .scripthub file" aria-label="Project file path" onInput={(e) => setTypedPath((e.target as HTMLInputElement).value)} />
                  <button class="btn btn-primary" type="submit" disabled={!typedPath.trim() || stage === 'checking'}>{stage === 'checking' ? 'Checking…' : 'Check the file'}</button>
                </form>
              )}
            </div>
          </section>

          <section class="panel" id="samples">
            <div class="panel-head"><h2>Samples</h2></div>
            {(samples.data ?? []).length ? (
              <ul class="quick">
                {(samples.data ?? []).map((p) => (
                  <li key={p.name}>
                    <Icon name="sequence" class="faint" />
                    <button type="button" class="plain q-btn q-name" disabled={stage === 'checking'} title="A project with a sequence and presets: see what it adds, then open it" onClick={() => void start('sample', p.name)}>{p.name}</button>
                  </li>
                ))}
              </ul>
            ) : <div class="panel-body muted">No sample projects are installed.</div>}
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Save the open folder as a project</h2></div>
            <div class="panel-body">
              <p class="muted small">Packs the scripts of the open folder, their sequences and saved values into one .scripthub file you can share. Passwords are never included.</p>
              <button type="button" class="btn" disabled={!hasFolder || !desktop} title={!desktop ? 'Saving a project file needs the desktop app.' : !hasFolder ? 'Open a folder first.' : ''} onClick={() => void saveCurrent()}>
                <Icon name="save" /> Save project as…
              </button>
              {!hasFolder && <span class="muted small"> Open a folder first.</span>}
              {hasFolder && !desktop && <span class="muted small"> Needs the desktop app.</span>}
            </div>
          </section>
        </>
      )}

      {(stage === 'preview' || stage === 'installing') && preview && info && (
        <form class="panel" onSubmit={(e) => { e.preventDefault(); void install() }}>
          <div class="panel-head">
            <h2><Icon name="download" class="faint" /> {info.name}</h2><span class="spacer" />
            <span class="small muted">{preview.fileName ? `${preview.fileName} · ` : ''}saved {info.created_at}{info.scripthub ? ` with ScriptHub ${info.scripthub}` : ''}</span>
          </div>
          <div class="panel-body">
            <div class="proj-stats">
              <div><strong>{info.scripts}</strong><span>scripts</span></div>
              <div><strong>{info.files}</strong><span>files in all</span></div>
              <div><strong>{info.sequences.length}</strong><span>sequences</span></div>
              <div><strong>{info.presets}</strong><span>presets</span></div>
            </div>
            {info.sequences.length > 0 && (
              <ul class="small proj-seqs">
                {info.sequences.map((s: any) => (
                  <li key={s.name}><Icon name="sequence" small class="faint" /> {s.name} <span class="muted">· {s.steps} step{s.steps === 1 ? '' : 's'}{s.as !== s.name ? ` · added as “${s.as}” (the name is taken)` : ''}</span></li>
                ))}
              </ul>
            )}
            <details class="small proj-files" open={showFiles} onToggle={(e) => setShowFiles((e.target as HTMLDetailsElement).open)}>
              <summary>Files ({info.files})</summary>
              <ul class="mono small muted">{info.file_list.map((f: string) => <li key={f}>{f}</li>)}</ul>
            </details>
            {info.warnings.length > 0 && (
              <div class="flash flash-warning notes" style="margin-top:12px">
                <span><strong>Check after opening:</strong><ul class="small">{info.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul></span>
              </div>
            )}
            <div class="field" style="margin-top:14px">
              <label class="field-label" for="p-dest">Unpack into this new folder</label>
              <div class="inline-form">
                <input class="input mono" id="p-dest" value={destination} required onInput={(e) => setDestination((e.target as HTMLInputElement).value)} />
                {desktop && <button type="button" class="btn" title={`Where to put the project (a “${preview.folderName}” folder is made in it)`} onClick={() => void browse()}>Browse…</button>}
              </div>
              <div class="help">
                {desktop ? `Browse… picks where it goes; a “${preview.folderName}” folder is made there. ` : ''}It must be new or empty: nothing is overwritten. It becomes the open folder.
              </div>
            </div>
            <p class="small muted">Opening runs nothing. The project's scripts will run with your rights when you run them: open projects only from people you trust.</p>
          </div>
          <div class="panel-foot">
            <button class="btn btn-primary" type="submit" disabled={stage === 'installing'}><Icon name="folder-open" /> {stage === 'installing' ? 'Unpacking…' : 'Open project'}</button>
            <button class="btn btn-ghost" type="button" disabled={stage === 'installing'} onClick={cancel}>Cancel</button>
          </div>
        </form>
      )}

      {stage === 'done' && result && (
        <section class="panel" data-testid="project-done">
          <div class="panel-head"><h2><Icon name="check" class="faint" /> Project opened</h2></div>
          <div class="panel-body">
            <p>Unpacked <strong>{result.files}</strong> file{result.files === 1 ? '' : 's'} into <span class="mono">{result.folder}</span>. It is now the open folder.</p>
            <ul class="small">
              {result.sequences.length > 0 && <li>Sequences added: {result.sequences.join(', ')}</li>}
              <li>{result.presets} preset{result.presets === 1 ? '' : 's'} added{result.kept.length ? `; ${result.kept.length} existing kept` : ''}.</li>
            </ul>
            {result.kept.length > 0 && <p class="small muted">Kept as they were: {result.kept.join(', ')}</p>}
            {result.warnings.length > 0 && (
              <div class="flash flash-warning notes"><span><strong>Check:</strong><ul class="small">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul></span></div>
            )}
          </div>
          <div class="panel-foot">
            <button type="button" class="btn btn-primary" onClick={() => { void runCommand('view.library'); closeTab(tab.key) }}><Icon name="list" /> Show the scripts</button>
            {result.sequences.length > 0 && <button type="button" class="btn" onClick={() => { openTab({ kind: 'sequences' }); closeTab(tab.key) }}><Icon name="sequence" /> Sequences</button>}
            <button type="button" class="btn btn-ghost" onClick={() => closeTab(tab.key)}>Close</button>
          </div>
        </section>
      )}
    </div>
  )
}
