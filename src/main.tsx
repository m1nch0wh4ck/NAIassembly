import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import { getConfig } from './config'
import { initClient } from './supabase'
import { initAuth } from './data/store'
import { App } from './App'
import { SetupScreen } from './ui/Setup'

const root = createRoot(document.getElementById('root')!)
const cfg = getConfig()

if (!cfg) {
  root.render(<SetupScreen />)
} else {
  initClient(cfg)
  void initAuth()
  root.render(
    <StrictMode>
      <App config={cfg} />
    </StrictMode>,
  )
}
