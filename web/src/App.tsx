import { lazy, Suspense, useEffect, useReducer, useRef, useState, type ComponentType } from 'react';
import { dropPack, loadConnectors, loadRole, packLost, readPack, saveConnectors, savePack, saveRole, upsert, type SavedConnector } from './connectors.ts';
import { AppHeader, Button, Callout, P } from './ds.tsx';
import { readDocs } from './live.ts';
import { loadPack, type AppPack } from './pack.ts';
import { Checks } from './screens/Checks.tsx';
import { Decide } from './screens/Decide.tsx';
import { Home } from './screens/Home.tsx';
import { LiveReading, Read } from './screens/Read.tsx';
import { Source } from './screens/Source.tsx';
import { CHECKS, CODE, DECIDE, initial, READ, reducer, RUN, SOURCE, STEPS, type Action, type Flow } from './state.ts';

export type ScreenProps = { s: Flow; dispatch: (a: Action) => void; go: (step: number) => void; pack: AppPack; name: string };

const Code = lazy(() => import('./screens/Code.tsx').then(m => ({ default: m.Code })));
const Run = lazy(() => import('./screens/Run.tsx').then(m => ({ default: m.Run })));
const SCREENS: Record<number, ComponentType<ScreenProps>> = { [READ]: Read, [DECIDE]: Decide, [CHECKS]: Checks, [CODE]: Code, [RUN]: Run };

const NOT_SAVED = "We couldn't save your connectors in this browser. They last until you close this page.";
const PACK_NOT_SAVED = "This browser is out of space, so this read lasts until you close this page. Remove a connector you don't need to make room.";
const PACK_LOST = "We no longer have this read in this browser. Read the docs again to carry on.";

export function App() {
  const [s, dispatch] = useReducer(reducer, undefined, () => ({ ...initial(), role: loadRole() }));
  const [connectors, setConnectors] = useState(loadConnectors);
  const [notice, setNotice] = useState<string | null>(null);
  const [pack, setPack] = useState<AppPack | null>(null);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState('');
  const reading = useRef<AbortController | null>(null);
  useEffect(() => { saveRole(s.role); }, [s.role]);
  useEffect(() => { if (!saveConnectors(connectors)) setNotice(NOT_SAVED); }, [connectors]);
  useEffect(() => () => reading.current?.abort(), []);
  useEffect(() => {
    let live = true;
    setPack(null);
    setFailed(false);
    if (!s.id) return;
    if (!s.live) dropPack(s.id);
    const held = s.live && readPack(s.id);
    (held ? Promise.resolve(held) : loadPack(s.slug)).then(p => { if (live) setPack(p); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [s.id, s.slug, s.live?.hash]);
  // A read in flight is not saved: it dies with the page, and the slug is still the previous app's.
  useEffect(() => {
    if (s.id && s.read.kind === 'idle' && pack?.manifest.app.slug === s.slug) setConnectors(list => upsert(list, s, pack, Date.now()));
  }, [s, pack]);
  const stopReading = () => {
    reading.current?.abort();
    if (s.read.kind !== 'idle') dispatch({ type: 'read-clear' });
  };
  const go = (step: number) => {
    if (step !== READ || s.read.kind === 'denied') stopReading();
    dispatch({ type: 'go', step });
    window.scrollTo(0, 0);
  };
  // Runs from a click, never an effect, so a remount can't spend a second read.
  const startRead = (url: string, text?: string) => {
    reading.current?.abort();
    const ctrl = reading.current = new AbortController();
    dispatch({ type: 'read-start', url });
    window.scrollTo(0, 0);
    readDocs({ url, text, code }, message => { if (!ctrl.signal.aborted) dispatch({ type: 'read-progress', message }); }, ctrl.signal)
      .catch(() => ({ kind: 'failed' as const, message: 'The connection dropped during the read. Check your network and try again.' }))
      .then(out => {
        if (ctrl.signal.aborted) return;
        if (out.kind === 'done') {
          if (!savePack(s.id!, out.pack)) setNotice(PACK_NOT_SAVED);
          dispatch({ type: 'read-done', pack: out.pack });
        } else {
          if (out.kind === 'denied') setCode('');
          dispatch({ type: 'read-stopped', read: out });
        }
      });
  };
  const leave = (action: Action, message: string | null = null) => {
    stopReading();
    setCode('');
    setNotice(message);
    dispatch(action);
    window.scrollTo(0, 0);
  };
  const open = (saved: SavedConnector) => {
    const lost = packLost(saved);
    leave({ type: 'open', saved, lost }, lost ? PACK_LOST : null);
  };
  const remove = (id: string) => {
    setConnectors(list => list.filter(c => c.id !== id));
    dropPack(id);
  };
  const Screen = SCREENS[s.step];
  return <>
    <AppHeader steps={s.id ? STEPS : []} current={s.step} maxStep={s.maxStep} onStep={go} onHome={() => leave({ type: 'home' }, notice === NOT_SAVED ? notice : null)} right={<>
      <label className="role-label"><span className="role-text">View as</span>
        <select className="role-select" aria-label="View as" value={s.role} onChange={e => dispatch({ type: 'set', patch: { role: e.target.value as Flow['role'] } })}>
          {['Viewer', 'Builder', 'Admin'].map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      {s.id ? <Button variant="link" style={{ font: '400 13px/1 var(--font-mono)' }} onClick={() => leave({ type: 'reset' })}>Start over</Button> : null}
    </>} />
    {notice ? <div className="notice"><Callout>{notice}</Callout></div> : null}
    {!s.id ? <Home connectors={connectors} onNew={() => leave({ type: 'new', id: crypto.randomUUID() })} onOpen={open} onRemove={remove} />
      : s.step === SOURCE ? <Source s={s} dispatch={dispatch} go={go} code={code} setCode={setCode} onRead={startRead} />
      : s.step === READ && s.read.kind !== 'idle' ? <LiveReading read={s.read} url={s.url} go={go} onPaste={text => startRead(s.url, text)} />
      : pack ? <Suspense><Screen key={s.slug} s={s} dispatch={dispatch} go={go} pack={pack} name={pack.manifest.app.name} /></Suspense>
      : <div className="centered"><P>{failed ? "This app's data didn't load. Reload the page to try again." : 'Loading…'}</P></div>}
  </>;
}
