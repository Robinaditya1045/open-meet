import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// No StrictMode: its double-mounted effects would open every camera and
// signaling socket twice in development, and the second join would replace the
// first participant.
createRoot(document.getElementById('root')!).render(<App />)
