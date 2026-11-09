/**
 * The protocol as the browser side needs it: types, the event names and the client. It leaves out `calls.ts` (the zod
 * argument schemas, used by the engine side to validate) so the UI bundle stays small.
 */
export * from './dto.js'
export type { Api, CallName } from './calls.js'
export * from './events.js'
export * from './client.js'
