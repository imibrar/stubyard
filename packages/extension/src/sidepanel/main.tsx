import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installHubAuth } from '../shared/hubAuth';
import { App } from './App';
import './panel.css';

installHubAuth();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
