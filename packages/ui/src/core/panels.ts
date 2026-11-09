/**
 * Panels are the pages shown in editor tabs. Each panel kind registers one component; the shell never imports a
 * panel directly. See packages/ui/README.md for the contract.
 */
import type { ComponentType } from 'preact'
import type { Tab } from './tabs'

export type PanelKind =
  | 'home' | 'script' | 'run' | 'history' | 'settings' | 'sequences' | 'sequence' | 'sequence-run' | 'project-open' | 'folder'
  | 'new-script' | 'library'

export const PANEL_KINDS: PanelKind[] = [
  'home', 'script', 'run', 'history', 'settings', 'sequences', 'sequence', 'sequence-run', 'project-open', 'folder', 'new-script', 'library',
]

export interface PanelProps {
  /** The tab this panel instance lives in (`tab.params` = what it was opened with). */
  tab: Tab
  /** False while another tab is shown. Panels stay mounted so their state survives; pause polling when inactive. */
  active: boolean
}

export interface PanelOptions {
  /** Content of the collapsible bottom panel (Ctrl+J) while a tab of this kind is active. */
  bottom?: ComponentType<PanelProps>
  bottomTitle?: string
  /** Full-bleed page: no padding, the panel manages its own scrolling (editors, diagrams, consoles). */
  fill?: boolean
}

interface Entry { component: ComponentType<PanelProps>; options: PanelOptions }
const registry = new Map<PanelKind, Entry>()

export function registerPanel(kind: PanelKind, component: ComponentType<PanelProps>, options: PanelOptions = {}): void {
  registry.set(kind, { component, options })
}

export const getPanel = (kind: string): Entry | undefined => registry.get(kind as PanelKind)
export const registeredKinds = (): PanelKind[] => [...registry.keys()]
