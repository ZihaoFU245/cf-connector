import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SandboxPage } from '../app/SandboxPage';
import { UrlHistory } from '../app/UrlHistory';
import { CookieStore } from '../app/CookieStore';
import { prepareSandboxDocument } from '../app/sandboxDom';

function uuid(): string {
  // RFC4122 v4-ish
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 0xf) >> 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type SandboxDocument = {
  html?: string;
  text?: string;
  finalUrl?: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  note?: string;
};

type SandboxState = {
  page: SandboxPage;
  document?: SandboxDocument;
  error?: string;
  notice?: string;
  isLoading?: boolean;
};

type NavigateInit = {
  method?: 'GET' | 'POST' | 'HEAD';
  bodyB64?: string;
  headers?: Record<string, string>;
};

function headerLookup(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

const ConnectorApp: React.FC = () => {
  const [sandboxes, setSandboxes] = useState<Map<string, SandboxState>>(new Map());
  const [activeId, setActiveId] = useState<string>('');
  const [urlValue, setUrlValue] = useState<string>('https://example.com');
  const [workerBase, setWorkerBase] = useState<string | undefined>(() => {
    return localStorage.getItem('workerBase') || (import.meta.env.VITE_WORKER_BASE as string | undefined) || undefined;
  });

  const sandboxesRef = useRef(sandboxes);
  useEffect(() => { sandboxesRef.current = sandboxes; }, [sandboxes]);
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // SW messages: cookie propagation per sandbox
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const data = ev.data as any;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'set-cookie') {
        const { sid, header } = data;
        setSandboxes(prev => {
          const next = new Map(prev);
          const sb = next.get(sid);
          if (sb) {
            sb.page.cookieStore.applyFromHeader(header);
            next.set(sid, { ...sb });
          }
          sandboxesRef.current = next;
          return next;
        });
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);

  // Apply workerBase to SW when changed
  useEffect(() => {
    if (!workerBase) return;
    const msg = { type: 'config', workerBase } as const;
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(msg);
      navigator.serviceWorker.controller.postMessage({ type: 'warmup' });
    }
  }, [workerBase]);

  const handleAdd = useCallback((seedUrl?: string) => {
    const id = uuid();
    const history = new UrlHistory();
    const cookieStore = new CookieStore(id);
    const page = new SandboxPage({ id, title: 'New Sandbox', homeUrl: seedUrl ?? 'https://example.com', history, cookieStore });
    setSandboxes(prev => {
      const next = new Map(prev);
      next.set(id, { page });
      sandboxesRef.current = next;
      return next;
    });
    setActiveId(id);
    setUrlValue(seedUrl ?? 'https://example.com');
    return id;
  }, []);

  const handleRemove = useCallback((id: string) => {
    setSandboxes(prev => {
      const next = new Map(prev);
      next.delete(id);
      sandboxesRef.current = next;
      if (activeIdRef.current === id) {
        const first = next.keys().next().value ?? '';
        setActiveId(first);
      }
      return next;
    });
  }, []);

  const sandboxesCount = sandboxes.size;
  useEffect(() => {
    if (sandboxesCount === 0) {
      handleAdd('https://example.com');
    }
  }, [sandboxesCount, handleAdd]);

  const navigateSandbox = useCallback(async (sandboxId: string, url: string, init?: NavigateInit) => {
    const map = sandboxesRef.current;
    const sb = map.get(sandboxId);
    if (!sb) return;
    const target = url?.trim() || sb.page.homeUrl;
    setSandboxes(prev => {
      const next = new Map(prev);
      const current = next.get(sandboxId);
      if (current) {
        next.set(sandboxId, { ...current, error: undefined, notice: undefined, isLoading: true });
      }
      sandboxesRef.current = next;
      return next;
    });
    try {
      const result = await sb.page.navigate(target, init);
      const finalUrl = result.finalUrl || target;
      const contentType = headerLookup(result.headers, 'content-type') || '';
      const doc: SandboxDocument = {
        finalUrl,
        status: result.status,
        statusText: result.statusText,
        contentType,
        note: result.body?.note,
      };

      if (result.body?.encoding === 'text' && typeof result.body.data === 'string' && contentType.includes('text/html')) {
        const prepared = prepareSandboxDocument(result.body.data, { baseUrl: finalUrl, sandboxId, frameId: sandboxId });
        doc.html = prepared.html;
        if (prepared.title) {
          sb.page.title = prepared.title;
        }
      } else if (result.body?.encoding === 'text' && typeof result.body.data === 'string') {
        doc.text = result.body.data;
      } else if (result.body?.encoding === 'json') {
        doc.text = JSON.stringify(result.body.data, null, 2);
      } else if (result.body?.encoding === 'base64' && typeof result.body.data === 'string') {
        doc.text = '[binary payload omitted]';
      } else if (typeof result.body?.data !== 'undefined') {
        doc.text = String(result.body.data);
      } else if (!result.body && !result.ok) {
        doc.text = result.error || `Request failed with status ${result.status}`;
      }

      setSandboxes(prev => {
        const next = new Map(prev);
        const current = next.get(sandboxId);
        if (current) {
          next.set(sandboxId, { ...current, document: doc, error: undefined, notice: undefined, isLoading: false });
        }
        sandboxesRef.current = next;
        return next;
      });
      if (activeIdRef.current === sandboxId) {
        setUrlValue(finalUrl);
      }
    } catch (e: any) {
      setSandboxes(prev => {
        const next = new Map(prev);
        const current = next.get(sandboxId);
        if (current) {
          const message = e?.message || String(e);
          next.set(sandboxId, { ...current, error: `Request failed: ${message}`, isLoading: false });
        }
        sandboxesRef.current = next;
        return next;
      });
    }
  }, []);

  useEffect(() => {
    function onSandboxEvent(ev: MessageEvent) {
      const data = ev.data as any;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'sandbox:navigate') {
        const frameId = data.frameId as string;
        const targetUrl = data.url as string;
        const method = (data.method as 'GET' | 'POST' | 'HEAD' | undefined) || 'GET';
        const headers = (data.headers as Record<string, string> | undefined) || undefined;
        const bodyB64 = data.bodyB64 as string | undefined;
        if (data.openNew) {
          const newId = handleAdd(targetUrl);
          navigateSandbox(newId, targetUrl, { method, headers, bodyB64 });
          setActiveId(newId);
        } else {
          setActiveId(frameId);
          navigateSandbox(frameId, targetUrl, { method, headers, bodyB64 });
        }
      }
      if (data.type === 'sandbox:notify') {
        const frameId = data.frameId as string;
        const message = typeof data.message === 'string' ? data.message : 'Sandbox notification';
        setSandboxes(prev => {
          const next = new Map(prev);
          const current = next.get(frameId);
          if (current) {
            next.set(frameId, { ...current, notice: message, isLoading: false });
          }
          sandboxesRef.current = next;
          return next;
        });
      }
    }
    window.addEventListener('message', onSandboxEvent);
    return () => window.removeEventListener('message', onSandboxEvent);
  }, [handleAdd, navigateSandbox]);

  const active = sandboxes.get(activeId);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const navigateActive = useCallback((url: string, method: 'GET' | 'POST' | 'HEAD' = 'GET') => {
    if (!active) return;
    navigateSandbox(active.page.id, url, { method });
  }, [active, navigateSandbox]);

  const cookieEntries = useMemo(() => {
    if (!active) return [] as string[];
    return active.page.cookieStore.getDisplay();
  }, [active]);

  function configureWorkerBase() {
    const current = workerBase ?? '';
    const next = window.prompt('Enter Cloudflare Worker Base URL (e.g. https://<sub>.workers.dev)', current || '');
    if (next == null) return; // canceled
    const trimmed = next.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      alert('Please provide a valid http(s) URL.');
      return;
    }
    localStorage.setItem('workerBase', trimmed);
    setWorkerBase(trimmed || undefined);
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">Connector</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="chip">Worker: {workerBase ?? 'not set'}</div>
          <button className="btn secondary" onClick={configureWorkerBase}>Configure</button>
        </div>
      </div>

      <aside className="sidebar">
        <button className="btn" onClick={() => handleAdd('https://example.com')}>New Sandbox</button>
        <div className="sandboxes">
          {Array.from(sandboxes.values()).map(s => (
            <div key={s.page.id} className={`sandbox-item ${activeId === s.page.id ? 'active' : ''}`} onClick={() => setActiveId(s.page.id)}>
              <div className="sandbox-title">{s.page.title || s.page.homeUrl}</div>
              <button className="btn secondary" onClick={(e) => { e.stopPropagation(); handleRemove(s.page.id); }}>×</button>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {active && (
          <>
            <div className="urlbar">
              <button className="btn secondary" onClick={() => navigateActive(active.page.history.back(), 'GET')}>Back</button>
              <button className="btn secondary" onClick={() => navigateActive(active.page.history.forward(), 'GET')}>Forward</button>
              <input
                type="text"
                value={urlValue}
                placeholder="https://example.com"
                onChange={(e) => setUrlValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigateActive(urlValue); }}
              />
              <button className="btn" onClick={() => { if (urlValue) navigateActive(urlValue); }}>Go</button>
              <button className="btn secondary" onClick={() => { if (iframeRef.current?.requestFullscreen) iframeRef.current.requestFullscreen().catch(() => undefined); }}>Full Screen</button>
            </div>

            <section className="viewer">
              <div className="doc">
                {active.isLoading ? (
                  <div className="loading">Loading…</div>
                ) : active.document?.html ? (
                  <iframe
                    key={active.document.finalUrl ?? active.page.id}
                    ref={iframeRef}
                    title="document"
                    sandbox="allow-scripts allow-forms"
                    srcDoc={active.document.html}
                    allow="fullscreen"
                  />
                ) : active.document?.text ? (
                  <pre>{active.document.text}</pre>
                ) : active.error ? (
                  <pre className="error">{active.error}</pre>
                ) : (
                  <pre>Enter a URL and press Go to fetch via the Worker router.</pre>
                )}
              </div>
              <div className="statusbar">
                {active.document ? (
                  <>
                    <span>Status: {active.document.status} {active.document.statusText}</span>
                    <span>URL: {active.document.finalUrl}</span>
                    <span>Type: {active.document.contentType ?? 'unknown'}</span>
                    {active.document.note ? <span>Note: {active.document.note}</span> : null}
                  </>
                ) : null}
                {active.notice ? <span className="notice">{active.notice}</span> : null}
              </div>
              {cookieEntries.length ? (
                <div className="cookie-panel">
                  <div className="cookie-title">Cookies ({cookieEntries.length})</div>
                  <ul>
                    {cookieEntries.map(entry => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          </>
        )}
      </main>
    </div>
  );
};

export default ConnectorApp;
