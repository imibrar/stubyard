window.shotCheck = async (tabId, windowId, x, y) => {
  const px = async () => { const d = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }); const b = await (await fetch(d)).blob(); const bm = await createImageBitmap(b); const c = new OffscreenCanvas(bm.width, bm.height); const g = c.getContext('2d'); g.drawImage(bm, 0, 0); const p = g.getImageData(x, y, 1, 1).data; return { w: bm.width, h: bm.height, rgb: [p[0], p[1], p[2]] }; };
  const out = {};
  try { out.before = await px(); } catch (e) { out.before = 'ERR ' + e.message; }
  try { out.suspend = await chrome.tabs.sendMessage(tabId, { type: 'suspend' }); out.hidden = await px(); } catch (e) { out.hidden = 'ERR ' + e.message; }
  finally { out.resume = await chrome.tabs.sendMessage(tabId, { type: 'resume' }).catch((e) => 'ERR ' + e.message); }
  try { await new Promise((r) => setTimeout(r, 600)); out.after = await px(); } catch (e) { out.after = 'ERR ' + e.message; }
  return JSON.stringify(out);
};