// The on-page step widget (docs/design/floating-widget.md): an extension page framed by the content script's host.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../sidepanel/panel.css';
import './widget.css';
import { WidgetApp } from './WidgetApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WidgetApp />
  </StrictMode>,
);
