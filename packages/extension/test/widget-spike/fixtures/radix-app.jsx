import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import * as Dialog from '@radix-ui/react-dialog';
window.__log = [];
const log = (m) => { window.__log.push(m); };
function App() {
  const [open, setOpen] = useState(true);
  useEffect(() => { window.__dialogOpen = open; log('open=' + open); }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)' }} />
        <Dialog.Content style={{ position: 'fixed', left: 40, top: 40, width: 400, background: '#fff', padding: 20 }}>
          <Dialog.Title>Radix modal</Dialog.Title>
          <Dialog.Description>Form in a dialog</Dialog.Description>
          <input id="app-field" defaultValue="" />
          <Dialog.Close>Close</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
document.addEventListener('focusin', (e) => log('focusin:' + (e.target.id || e.target.tagName)), true);
document.addEventListener('focusout', (e) => log('focusout:' + (e.target.id || e.target.tagName) + '->' + (e.relatedTarget ? (e.relatedTarget.id || e.relatedTarget.tagName) : 'null')), true);
createRoot(document.getElementById('root')).render(<App />);
