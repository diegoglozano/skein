import { useState } from 'react';

export function App() {
  const [showVerify, setShowVerify] = useState(false);

  return (
    <div className="shell">
      <header>
        <h1>skein</h1>
        <button className="privacy-badge" onClick={() => setShowVerify((v) => !v)}>
          ● your data never leaves this tab
        </button>
      </header>

      {showVerify && (
        <aside className="verify">
          <h2>Verify it yourself</h2>
          <p>
            skein makes zero network requests after the page loads. To confirm: open
            devtools (F12) → Network tab → clear the log → load a graph file. The log
            stays empty — parsing, layout, and storage all happen in this tab. A
            Content-Security-Policy on this page additionally blocks requests to any
            other origin, and an automated test enforces this on every change.
          </p>
        </aside>
      )}

      <main className="dropzone" aria-label="file drop zone">
        <p>Drop an edge list here — CSV, Parquet, or Arrow</p>
        <p className="muted">
          (Ingest pipeline lands in M1. This build is the M0 scaffold; the renderer
          spike lives at <a href="/spike.html?fixture=tiny">/spike.html</a>.)
        </p>
      </main>
    </div>
  );
}
