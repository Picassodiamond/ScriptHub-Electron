/** Home (the old Dashboard): welcome / open a folder, counts, recent runs, samples, quick run and most used scripts. */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { Icon, Lang } from '../../components/Icon'
import { api, counts, errorText, openPaths, openTab, registerPanel, runCommand, shell, toast, useApi, usePoll, type PanelProps } from '../../core'

function Stat({ label, num, sub, cls = '', onClick }: { label: string; num: number | string; sub: string; cls?: string; onClick?: () => void }) {
  return (
    <a class={`stat ${cls}`} href="#" onClick={(e) => { e.preventDefault(); onClick?.() }}>
      <div class="stat-label">{label}</div>
      <div class="stat-num">{num}</div>
      <div class="stat-sub">{sub}</div>
    </a>
  )
}

function Home({ active }: PanelProps) {
  const s = shell.value
  const f = s?.folder.folder ?? null
  const scripts = useMemo(() => (s?.tree ?? []).flatMap((g) => g.scripts), [s?.tree])
  const recent = useApi('runs.recent', { limit: 8 }, [], true)
  const info = useApi('app.info', {}, [], true)
  const samples = useApi('project.samples', {}, [], true)
  const [totals, setTotals] = useState({ success: 0, failed: 0 })

  const loadTotals = async () => {
    try {
      const [ok, bad] = await Promise.all([api['runs.query']({ status: 'success' }), api['runs.query']({ status: 'failed' })])
      setTotals({ success: ok.total, failed: bad.total })
    } catch { /* keep the last numbers */ }
  }
  useEffect(() => { void loadTotals() }, [])
  usePoll(() => { void recent.reload(); void loadTotals() }, 5000, active)

  const frequent = useMemo(() => {
    const byId = new Map<string, number>()
    for (const r of (s?.runs ?? []) as any[]) if (r.script_id) byId.set(r.script_id, (byId.get(r.script_id) ?? 0) + 1)
    return [...byId.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, n]) => ({ script: scripts.find((x) => x.id === id), runs: n })).filter((x) => x.script)
  }, [s?.runs, scripts])

  const open = (path: string) => void openPaths([path]).catch((e) => toast.error(errorText(e)))
  const welcomeFolders = [...(s?.folder.favorites ?? []).slice(0, 5).map((x) => ({ ...x, kind: 'fav' })), ...(s?.folder.recent ?? []).slice(0, 5).map((x) => ({ ...x, kind: 'recent' }))].filter((x) => x.exists)
  const invalid = 0

  return (
    <div class="page">
      {!f && (
        <section class="panel welcome">
          <div class="panel-body">
            <h2 style="margin:0 0 6px">Open a script folder to start</h2>
            <p class="muted" style="margin:0 0 12px">ScriptHub lists and runs the scripts in one folder at a time. Pick it once; it is reopened next time.</p>
            <button type="button" class="btn btn-primary" onClick={() => void runCommand('file.openFolder')}><Icon name="folder" /> Open folder…</button>{' '}
            {welcomeFolders.map((x) => (
              <button type="button" key={x.path} class={`btn ${x.kind === 'recent' ? 'btn-ghost' : ''}`} title={x.path} onClick={() => open(x.path)}>
                <Icon name={x.kind === 'fav' ? 'star' : 'clock'} /> {x.name}
              </button>
            ))}
          </div>
        </section>
      )}

      <div class="stats">
        <Stat label="Scripts" num={scripts.length} sub={invalid ? `${invalid} need fixing` : 'in the open folder'} onClick={() => void runCommand('view.library')} />
        <Stat label="Running" num={counts.value.running} sub={`${counts.value.queued} queued`} cls="stat-run" onClick={() => void runCommand('view.runs')} />
        <Stat label="Succeeded" num={totals.success} sub="in history" cls="stat-ok" onClick={() => void runCommand('view.runs')} />
        <Stat label="Failed" num={totals.failed} sub="incl. timeouts" cls="stat-bad" onClick={() => void runCommand('view.runs')} />
      </div>

      <div class="cols-main">
        <section class="panel">
          <div class="panel-head">
            <h2>Recent executions</h2><span class="spacer" />
            {(recent.data?.length ?? 0) > 0 && <button type="button" class="btn btn-ghost btn-sm" onClick={() => void runCommand('view.runs')}>All runs</button>}
          </div>
          {recent.data && recent.data.length > 0 ? (
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Script</th><th>Status</th><th class="hide-sm">Host</th><th class="num">Duration</th><th class="num">When</th></tr></thead>
                <tbody>
                  {recent.data.map((r: any) => (
                    <tr key={r.id}>
                      <td>
                        <a class="plain strong" href="#" onClick={(e) => { e.preventDefault(); openTab({ kind: 'run', id: r.id, title: r.script_name ?? r.id, params: { scriptId: r.script_id } }) }}>{r.script_name}</a>{' '}
                        <span class="faint mono small">{String(r.id).slice(4)}</span>
                      </td>
                      <td><span class={`st st-${r.status}`}>{r.status_label ?? r.status}</span></td>
                      <td class="small muted hide-sm">{r.host}</td>
                      <td class="num mono small">{r.duration}</td>
                      <td class="num muted small nowrap">{r.ago}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div class="empty">
              <Icon name="pulse" />
              <h2>Nothing has run yet</h2>
              <p>Pick a script from the explorer and press <kbd>R</kbd> to run it.</p>
            </div>
          )}
        </section>

        <div class="stack">
          <section class="panel" id="samples">
            <div class="panel-head"><h2>Samples</h2></div>
            <ul class="quick">
              <li>
                <Icon name="folder-open" class="faint" />
                <button type="button" class="plain q-btn q-name" title={info.data?.samplesDir} disabled={!info.data?.samplesDir} onClick={() => info.data && open(info.data.samplesDir)}>Sample scripts</button>
              </li>
              {(samples.data ?? []).map((p: any) => (
                <li key={p.name}>
                  <Icon name="sequence" class="faint" />
                  <button type="button" class="plain q-btn q-name" title="Project with a sequence and presets: see what it adds, then open it"
                    onClick={() => openTab({ kind: 'project-open', params: { sample: p.name, nonce: Date.now() } })}>{p.name}</button>
                </li>
              ))}
            </ul>
          </section>

          <section class="panel">
            <div class="panel-head"><h2><Icon name="zap" /> Quick run</h2></div>
            {scripts.length ? (
              <ul class="quick">
                {scripts.filter((x) => x.runnable).slice(0, 6).map((x) => (
                  <li key={x.id}>
                    <Lang ext={x.ext} />
                    <a class="q-name plain" href="#" onClick={(e) => { e.preventDefault(); openTab({ kind: 'script', id: x.id, title: x.name }) }}>{x.name}</a>
                    <button type="button" class="btn btn-sm play" onClick={() => openTab({ kind: 'script', id: x.id, title: x.name, params: { run: 'normal', nonce: Date.now() } })}><Icon name="play" /> Run</button>
                  </li>
                ))}
              </ul>
            ) : <div class="panel-body muted">No runnable scripts. Open a folder that has some.</div>}
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Most used</h2></div>
            {frequent.length ? (
              <ul class="quick">
                {frequent.map(({ script, runs }) => (
                  <li key={script!.id}>
                    <Lang ext={script!.ext} />
                    <a class="q-name plain" href="#" onClick={(e) => { e.preventDefault(); openTab({ kind: 'script', id: script!.id, title: script!.name }) }}>{script!.name}</a>
                    <span class="count-pill" title="Runs recorded">{runs}×</span>
                  </li>
                ))}
              </ul>
            ) : <div class="panel-body muted">Your most-run scripts will show up here.</div>}
          </section>
        </div>
      </div>
    </div>
  )
}

registerPanel('home', Home)
