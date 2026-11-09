/**
 * Narrow interfaces for the services the handlers reach through `engine.projects` / `engine.newScript`
 * (ProjectFiles and NewScript satisfy them). When a host leaves one unset, those calls answer
 * ApiError('unavailable'), which also lets tests substitute fakes.
 */
import type { ProjectInstallResult } from '@scripthub/protocol'

export interface ProjectsPort {
  sampleProjects(): Array<{ name: string }>
  /** The project file of the open folder with the default contents. Throws Error with a user message. */
  saveCurrent(name?: string): { bytes: Uint8Array; fileName: string; report: Record<string, any>; summary: string }
  /** Keep a project file chosen by the user; returns its token. */
  saveUploadFromFile(file: string): string
  importSample(name: string): string
  uploadPath(token: string): string
  inspect(file: string): Record<string, any>
  defaultDestination(name: string): string
  install(file: string, destination: string): ProjectInstallResult
  forgetUpload(token: string): void
}

export interface NewScriptPort {
  /** Why New script is unavailable, or null. */
  blocked(): string | null
  /** Creates the file, refreshes discovery; throws Error with a user message (never overwrites). */
  create(form: { language: string; filename: string; subfolder: string; name?: string; category?: string }): Promise<{ path: string; id: string }>
}

export interface EngineWithPorts {
  projects?: ProjectsPort
  newScript?: NewScriptPort
}
