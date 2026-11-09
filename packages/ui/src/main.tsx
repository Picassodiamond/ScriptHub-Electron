import { render } from 'preact'
import './styles/workbench.css'
import './styles/extra.css'
import './panels'
import { startApp } from './bootstrap'
import { App } from './shell/App'

render(<App />, document.getElementById('app')!)
void startApp()
