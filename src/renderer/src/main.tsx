import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/global.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PortForwardProvider } from './state/portForwards'
import { ToastProvider } from './state/toast'

const container = document.getElementById('root')!
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <PortForwardProvider>
          <App />
        </PortForwardProvider>
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
