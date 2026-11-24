// A stored screenshot. Loaded with fetch (which carries the hub's API token, see shared/hubAuth.ts) and shown from
// a blob: URL, because a plain <img src> cannot send the token to a hub with sign-in on.
import { useEffect, useState } from 'react';

export function HubShot({ src }: { src: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setFailed(false);
    fetch(src)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (!live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [src]);
  if (failed) return <span className="muted small">screenshot unavailable</span>;
  if (!url) return <span className="muted small">…</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="screenshot" />
    </a>
  );
}
