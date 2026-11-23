import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { installAuthFetch } from './auth';
import { ToastProvider } from './components/ui';
import './styles.css';
import './styles/canvas.css';

// Apply the saved theme before the first paint (dark by default).
try {
  const saved = JSON.parse(localStorage.getItem('stubyard.theme') ?? '"dark"');
  document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark';
} catch {
  document.documentElement.dataset.theme = 'dark';
}
// Density (compact / comfortable) when chosen; without it each direction's default applies.
try {
  const d = JSON.parse(localStorage.getItem('stubyard.density') ?? 'null');
  if (d === 'compact' || d === 'comfortable') document.documentElement.dataset.density = d;
} catch {
  /* storage unavailable */
}

// CSRF header on mutating hub calls, and back to the sign-in page when the session ends (Single admin mode only).
installAuthFetch();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
