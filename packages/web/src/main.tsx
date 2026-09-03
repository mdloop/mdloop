import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { ErrorBoundary } from './components/error-boundary.js';
import { installGlobalErrorReporting } from './error-reporting.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

// Catch escaped rejections / event-handler throws the boundary can't see.
installGlobalErrorReporting();

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
