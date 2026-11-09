/** The run tab (port of console.html + console.js): live output over engine events, trace and step debugger. */
import { registerPanel } from '../../core'
import { RunConsole } from './RunConsole'
import './run.css'

registerPanel('run', RunConsole, { fill: true })

export { RunConsole }
