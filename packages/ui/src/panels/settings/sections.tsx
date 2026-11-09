/** The sections of the Settings page. Form sections edit the shared draft; Hosts, Data, Appearance and About act on their own. */
import type { ComponentChildren } from 'preact'
import { useReducer, useState } from 'preact/hooks'
import type { SettingsState } from '@scripthub/protocol'
import { Icon } from '../../components/Icon'
import { api, confirm, errorText, helpOpen, hostCall, hostInfo, paletteOpen, readStore, setTheme, theme, toast, writeStore } from '../../core'
import {
  INTS, clearable, howText, itemVisible, newRow,
  type Draft, type FieldName, type IntMeta, type ListName, type Problems, type Row, type SectionId,
} from './model'

export interface Ctx {
  draft: Draft
  set(patch: Partial<Draft>): void
  problems: Problems
  /** show client-side problems of unchanged fields too (after a Save attempt) */
  attempted: boolean
  server: Partial<Record<FieldName, string[]>>
  changed: Set<FieldName>
  query: string
  platform: string
  restore(section: SectionId): void
}

const errorOf = (ctx: Ctx, name: FieldName): string | null => {
  const s = ctx.server[name]
  if (s && s.length) return s.join(' ')
  const p = ctx.problems.fields[name]
  return p && (ctx.attempted || ctx.changed.has(name)) ? p : null
}

// ----------------------------------------------------------------- pieces ---
export function Field({ name, label, help, error, changed, wide, children, htmlFor }: {
  name: string; label: string; help?: ComponentChildren; error?: string | null; changed?: boolean; wide?: boolean
  children: ComponentChildren; htmlFor?: string
}) {
  return (
    <div class={`field${wide ? ' field-wide' : ''}${error ? ' has-error' : ''}${changed ? ' is-changed' : ''}`} data-field={name}>
      <label class="field-label" for={htmlFor}>{label}</label>
      {children}
      {error && <div class="field-error" role="alert">{error}</div>}
      {help && <div class="help">{help}</div>}
    </div>
  )
}

function NumField({ m, ctx }: { m: IntMeta; ctx: Ctx }) {
  const id = `st-${m.name}`
  const err = errorOf(ctx, m.name)
  return (
    <Field name={m.name} label={m.label} htmlFor={id} error={err} changed={ctx.changed.has(m.name)} help={<>{m.help} <span class="faint">({m.min}–{m.max})</span></>}>
      <div class="st-numrow">
        <input class="input" id={id} name={m.name} type="number" inputMode="numeric" min={m.min} max={m.max} step={m.step ?? 1}
          value={ctx.draft[m.name]} aria-invalid={err ? 'true' : undefined}
          onInput={(e) => ctx.set({ [m.name]: (e.currentTarget as HTMLInputElement).value })} />
      </div>
    </Field>
  )
}

/** key / value rows with add and remove (the old textareas of `.py=python` lines). */
export function RowList({ ctx, name, noun, keyLabel, valueLabel, keyPlaceholder, valuePlaceholder, addLabel, env, suggestKeys, suggestValues }: {
  ctx: Ctx; name: ListName; noun: string; keyLabel: string; valueLabel: string; keyPlaceholder: string; valuePlaceholder: string; addLabel: string
  env?: boolean; suggestKeys?: string[]; suggestValues?: string[]
}) {
  const list = ctx.draft[name]
  const rowErrors = ctx.problems.rows[name]
  const show = ctx.attempted || ctx.changed.has(name)
  const update = (id: number, patch: Partial<Row>) => ctx.set({ [name]: list.map((r) => (r.id === id ? { ...r, ...patch } : r)) })
  const keyList = `st-${name}-keys`
  const valList = `st-${name}-vals`
  return (
    <div class="rowlist" data-list={name}>
      {list.length > 0 && <div class={`rl-head${env ? ' is-env' : ''}`} aria-hidden="true"><span>{keyLabel}</span><span>{valueLabel}</span><span /></div>}
      {list.map((r, i) => {
        const msg = show ? rowErrors[r.id] : undefined
        return (
          <div key={r.id} class={`rl-row${env ? ' is-env' : ''}${msg ? ' has-error' : ''}`}>
            <input class="input mono" aria-label={`${keyLabel} ${i + 1}`} value={r.key} placeholder={keyPlaceholder} spellcheck={false}
              list={suggestKeys ? keyList : undefined} onInput={(e) => update(r.id, { key: (e.currentTarget as HTMLInputElement).value })} />
            <input class="input mono" aria-label={`${valueLabel} ${i + 1}`} value={r.value} placeholder={valuePlaceholder} spellcheck={false}
              list={suggestValues ? valList : undefined} onInput={(e) => update(r.id, { value: (e.currentTarget as HTMLInputElement).value })} />
            <button type="button" class="btn btn-ghost btn-icon btn-sm" title={`Remove this ${noun}`} aria-label={`Remove ${noun} ${i + 1}`}
              onClick={() => ctx.set({ [name]: list.filter((x) => x.id !== r.id) })}><Icon name="x" /></button>
            {msg && <div class="rl-err" role="alert">{msg}</div>}
          </div>
        )
      })}
      {suggestKeys && <datalist id={keyList}>{suggestKeys.map((k) => <option key={k} value={k} />)}</datalist>}
      {suggestValues && <datalist id={valList}>{suggestValues.map((k) => <option key={k} value={k} />)}</datalist>}
      <button type="button" class="btn btn-sm rl-add" onClick={() => ctx.set({ [name]: [...list, newRow()] })}><Icon name="plus" /> {addLabel}</button>
    </div>
  )
}

export function Section({ id, title, ctx, children, restorable = true, extra, count }: {
  id: SectionId; title: string; ctx?: Ctx; children: ComponentChildren; restorable?: boolean; extra?: ComponentChildren; count?: number
}) {
  return (
    <section class="panel" id={`st-section-${id}`} data-section={id}>
      <div class="panel-head">
        <h2>{title}</h2>
        {count !== undefined && <span class="count-pill">{count}</span>}
        <span class="spacer" />
        {extra}
        {ctx && restorable && (
          <button type="button" class="btn btn-ghost btn-sm" title="Put this section back to the built-in values (not saved until you press Save)" onClick={() => ctx.restore(id)}>
            Restore defaults
          </button>
        )}
      </div>
      <div class="panel-body">{children}</div>
    </section>
  )
}

// ------------------------------------------------------------ form sections ---
export function FeaturesSection({ ctx }: { ctx: Ctx }) {
  return (
    <Section id="features" title="Features" ctx={ctx}>
      <div class="flash flash-warning settings-warn"><span>This application has no login. Anyone who can open it can use every feature that is switched on here.</span></div>
      <div class="check-row">
        <label class="check">
          <input type="checkbox" name="enable_script_editing" checked={ctx.draft.enable_script_editing}
            onChange={(e) => ctx.set({ enable_script_editing: (e.currentTarget as HTMLInputElement).checked })} />
          <span>Create and edit scripts in the app{ctx.changed.has('enable_script_editing') && <span class="badge badge-accent" style="margin-left:8px">changed</span>}</span>
        </label>
      </div>
      <p class="help" style="margin-top:8px">Switching this off also hides “New script” and makes the script editor read-only. Writing a script is the same as running arbitrary code.</p>
    </Section>
  )
}

const intsOf = (section: SectionId) => INTS.filter((i) => i.section === section)

export function ExecutionSection({ ctx }: { ctx: Ctx }) {
  const items = intsOf('execution').filter((m) => itemVisible(ctx.query, 'execution', m.label))
  return (
    <Section id="execution" title="Execution" ctx={ctx}>
      <div class="form-grid form-grid-3">{items.map((m) => <NumField key={m.name} m={m} ctx={ctx} />)}</div>
    </Section>
  )
}

export function RetentionSection({ ctx }: { ctx: Ctx }) {
  const items = intsOf('retention').filter((m) => itemVisible(ctx.query, 'retention', m.label))
  return (
    <Section id="retention" title="Retention" ctx={ctx}>
      <p class="muted small">Cleanup runs when the app starts and when the History page is opened. Queued and running executions are never removed.</p>
      <div class="form-grid">{items.map((m) => <NumField key={m.name} m={m} ctx={ctx} />)}</div>
    </Section>
  )
}

export function InterpretersSection({ ctx }: { ctx: Ctx }) {
  const local = itemVisible(ctx.query, 'interpreters', 'On this computer')
  const remote = itemVisible(ctx.query, 'interpreters', 'On SSH hosts (Linux)')
  return (
    <Section id="interpreters" title="Interpreters" ctx={ctx}>
      <p class="muted small">Only files with one of these extensions are treated as scripts. The command can be a name on your PATH or a full path.</p>
      <div class="form-grid">
        {local && (
          <Field name="interpreters" label="On this computer" error={errorOf(ctx, 'interpreters')} changed={ctx.changed.has('interpreters')}
            help={<>e.g. <span class="mono">.py = python</span>, <span class="mono">.bat = cmd</span>, <span class="mono">.ps1 = powershell</span></>}>
            <RowList ctx={ctx} name="interpreters" noun="interpreter" keyLabel="Extension" valueLabel="Command" keyPlaceholder=".py" valuePlaceholder="python" addLabel="Add interpreter"
              suggestKeys={['.py', '.sh', '.bash', '.bat', '.cmd', '.ps1']} suggestValues={['python', 'python3', 'bash', 'cmd', 'powershell', 'pwsh']} />
          </Field>
        )}
        {remote && (
          <Field name="remote_interpreters" label="On SSH hosts (Linux)" error={errorOf(ctx, 'remote_interpreters')} changed={ctx.changed.has('remote_interpreters')}
            help={<>e.g. <span class="mono">.py = python3</span>, <span class="mono">.sh = bash</span>. The script is streamed to this command; nothing is installed on the host.</>}>
            <RowList ctx={ctx} name="remote_interpreters" noun="remote interpreter" keyLabel="Extension" valueLabel="Command" keyPlaceholder=".py" valuePlaceholder="python3" addLabel="Add remote interpreter"
              suggestKeys={['.py', '.sh', '.bash']} suggestValues={['python3', 'python', 'bash', 'sh']} />
          </Field>
        )}
      </div>
    </Section>
  )
}

export function SshSection({ ctx }: { ctx: Ctx }) {
  const timeout = INTS.find((i) => i.name === 'ssh_connect_timeout')!
  const show = (label: string) => itemVisible(ctx.query, 'ssh', label)
  const sshErr = errorOf(ctx, 'ssh_executable')
  return (
    <Section id="ssh" title="SSH & environment" ctx={ctx}>
      <div class="form-grid">
        {show('SSH command') && (
          <Field name="ssh_executable" label="SSH command" htmlFor="st-ssh" error={sshErr} changed={ctx.changed.has('ssh_executable')}
            help={<>Uses your existing <span class="mono">~/.ssh/config</span>. It must log in without a password.</>}>
            <input class="input mono" id="st-ssh" name="ssh_executable" value={ctx.draft.ssh_executable} spellcheck={false} aria-invalid={sshErr ? 'true' : undefined}
              onInput={(e) => ctx.set({ ssh_executable: (e.currentTarget as HTMLInputElement).value })} />
          </Field>
        )}
        {itemVisible(ctx.query, 'ssh', timeout.label) && <NumField m={timeout} ctx={ctx} />}
        {show('Environment variables') && (
          <Field name="environment" wide label="Environment variables for every run" error={errorOf(ctx, 'environment')} changed={ctx.changed.has('environment')}
            help="A script's own environment settings and parameters override these. Names may use letters, digits and underscores.">
            <RowList ctx={ctx} name="environment" noun="variable" env keyLabel="Name" valueLabel="Value" keyPlaceholder="NAME" valuePlaceholder="value" addLabel="Add variable" />
          </Field>
        )}
      </div>
    </Section>
  )
}

// -------------------------------------------------------------- SSH hosts ---
type HostResult = { state: 'busy' | 'ok' | 'bad'; message: string }

export function HostsSection({ hosts, reload }: { hosts: string[]; reload(): Promise<void> }) {
  const [results, setResults] = useState<Record<string, HostResult>>({})
  const put = (h: string, r: HostResult) => setResults((x) => ({ ...x, [h]: r }))
  const test = async (h: string) => {
    put(h, { state: 'busy', message: 'Connecting…' })
    try {
      const r = await api['settings.testHost']({ host: h })
      put(h, { state: r.ok ? 'ok' : 'bad', message: r.message })
    } catch (e) {
      put(h, { state: 'bad', message: errorText(e) })
    }
  }
  const testAll = async () => { for (const h of hosts) await test(h) }
  return (
    <Section id="hosts" title="SSH hosts" count={hosts.length} restorable={false}
      extra={<>
        {hosts.length > 1 && <button type="button" class="btn btn-ghost btn-sm" onClick={() => void testAll()}>Test all</button>}
        <button type="button" class="btn btn-ghost btn-sm" title="Read ~/.ssh/config again" onClick={() => void reload()}><Icon name="refresh" /> Reload</button>
      </>}>
      <p class="muted small">Remote Linux hosts come from <span class="mono">Host</span> entries (without wildcards) in your <span class="mono">~/.ssh/config</span>. Scripts are streamed to the remote interpreter, so nothing is installed on the host.</p>
      {hosts.length ? (
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {hosts.map((h) => {
                const r = results[h]
                return (
                  <tr key={h} data-host={h}>
                    <td class="mono"><Icon name="server" /> {h}{r && <span class={`st-host-result is-${r.state}`} role="status">{r.message}</span>}</td>
                    <td class="actions"><button type="button" class="btn btn-sm" disabled={r?.state === 'busy'} onClick={() => void test(h)}>Test connection</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div class="muted">No hosts found. Add a <span class="mono">Host</span> entry to <span class="mono">~/.ssh/config</span> and press Reload.</div>
      )}
    </Section>
  )
}

// ------------------------------------------------------------------- data ---
export function DataSection({ state, reload, onCleared }: { state: SettingsState; reload(): Promise<void>; onCleared(kind: string): void | Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const rows = clearable(state.dataRows)
  const desktop = !!hostInfo.value?.desktop
  const clear = async (kind: string, label: string) => {
    const message = kind === 'all'
      ? "Clear all of ScriptHub's data: run history, saved values, sequences, backups, recent folders and settings? Your script files are not touched."
      : `Clear ${label.toLowerCase()}? This cannot be undone.`
    if (!(await confirm({ title: kind === 'all' ? 'Clear all data' : 'Clear data', message, confirmLabel: 'Clear', danger: true }))) return
    setBusy(kind)
    try {
      const r = await api['settings.clear']({ kind })
      for (const m of r.messages) toast.success(m)
      for (const m of r.errors) toast.error(m)
      await onCleared(kind)
      await reload()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Section id="data" title="Data" restorable={false}
      extra={<>
        {desktop && <button type="button" class="btn btn-ghost btn-sm" onClick={() => void hostCall('host.dataFolder').catch((e) => toast.error(errorText(e)))}><Icon name="folder-open" /> Open folder</button>}
        <button type="button" class="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void clear('all', 'all data')}>Clear all</button>
      </>}>
      <p class="muted small">In <span class="mono st-data-path" title={state.dataLocation.how}>{state.dataLocation.path}</span> ({howText(state.dataLocation.how)}). Your script files are never touched.</p>
      <div class="table-wrap">
        <table class="table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-kind={r.key}>
                <td><strong>{r.label}</strong><div class="muted small">{r.help}</div></td>
                <td class="num muted">{r.files ? r.size : 'empty'}</td>
                <td class="actions">
                  <button type="button" class="btn btn-sm" disabled={!r.files || busy !== null} onClick={() => void clear(r.key, r.label)}>Clear</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

// ------------------------------------------------------------- appearance ---
type Mode = 'dark' | 'light' | 'system'

export function AppearanceSection() {
  void theme.value // re-render when the shell's toggle changes the theme
  const [, rerender] = useReducer((n: number) => n + 1, 0) // picking "System" can leave the theme itself unchanged
  const saved = readStore('sr.theme')
  const mode: Mode = saved === 'light' || saved === 'dark' ? saved : 'system'
  const pick = (m: Mode) => {
    if (m === 'system') {
      writeStore('sr.theme', null) // the shell follows the operating system again until a theme is picked
      setTheme(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark', false)
    } else setTheme(m)
    rerender(0)
  }
  const opts: Array<[Mode, string, string]> = [['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'System', 'layout']]
  return (
    <Section id="appearance" title="Appearance" restorable={false}>
      <div class="field">
        <span class="field-label" id="st-theme-label">Theme</span>
        <div class="seg" role="radiogroup" aria-labelledby="st-theme-label">
          {opts.map(([m, label, icon]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} class={`seg-btn${mode === m ? ' is-active' : ''}`} onClick={() => pick(m)}>
              <Icon name={icon} /> {label}
            </button>
          ))}
        </div>
        <div class="help">Applies at once and is remembered on this computer. “System” follows the operating system's dark or light setting.</div>
      </div>
    </Section>
  )
}

// ------------------------------------------------------------------ about ---
export function AboutSection({ info }: { info: { version: string; runtimeDir: string; runtimeMode: string; platform: string; editingEnabled: boolean } | undefined }) {
  const desktop = !!hostInfo.value?.desktop
  return (
    <Section id="about" title="About" restorable={false}>
      <dl class="st-about">
        <dt>Version</dt><dd>{info?.version ?? '…'}</dd>
        <dt>Data folder</dt><dd class="mono st-data-path">{info?.runtimeDir ?? '…'}{info && <span class="muted"> ({howText(info.runtimeMode)})</span>}</dd>
        <dt>Platform</dt><dd>{info?.platform ?? '…'}</dd>
        <dt>Script editing</dt><dd>{info ? (info.editingEnabled ? 'on' : 'off') : '…'}</dd>
      </dl>
      <div class="btn-row" style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-sm" onClick={() => { helpOpen.value = true }}><Icon name="keyboard" /> Keyboard shortcuts</button>
        <button type="button" class="btn btn-sm" onClick={() => { paletteOpen.value = true }}><Icon name="command" /> Command palette</button>
        {desktop && <button type="button" class="btn btn-sm" onClick={() => void hostCall('host.dataFolder').catch((e) => toast.error(errorText(e)))}><Icon name="folder-open" /> Open data folder</button>}
      </div>
    </Section>
  )
}
