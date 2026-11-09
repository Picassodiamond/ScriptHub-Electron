import type { Dict, DebugState, RunStatus, ScanStatus, SequenceRunStatus } from './dto.js'

/** Events the engine side pushes to the UI: name -> payload. */
export interface Events {
  'scan.progress': ScanStatus
  /** A watched run changed status (the same fields as runs.status, without output). */
  'run.status': { id: string } & Omit<RunStatus, 'stdout' | 'stdout_next' | 'stderr' | 'stderr_next' | 'debug'>
  /** New output of a watched run since the last event, with the offsets to continue from. */
  'run.output': { id: string; stdout: string; stdout_next: number; stderr: string; stderr_next: number }
  'debug.state': { id: string; debug: DebugState | null }
  'sequence.status': SequenceRunStatus
  'workspace.changed': { reason: string; detail?: Dict }
  /**
   * A run or a sequence run started or finished anywhere (this window, a sequence, a quick run). Carries the new
   * running / queued counts, so the status bar and the Runs lists need no polling.
   */
  'runs.changed': { counts: { running: number; queued: number }; started: string[]; finished: string[]; sequences: { started: string[]; finished: string[] } }
  /** The host (native menu, tray, drag and drop) asks the UI to run a command, e.g. { name: 'file.openFolder' }. */
  'app.command': { name: string; args?: Dict }
  /** Files or folders dropped on the window (absolute paths, desktop only). */
  'app.drop': { paths: string[] }
  /** A message from the host (e.g. the result of a native Save dialog). */
  'app.toast': { kind: 'success' | 'error' | 'info' | 'warning'; text: string }
}
export type EventName = keyof Events
export const eventNames: EventName[] = ['scan.progress', 'run.status', 'run.output', 'debug.state', 'sequence.status', 'workspace.changed', 'runs.changed', 'app.command', 'app.drop', 'app.toast']
