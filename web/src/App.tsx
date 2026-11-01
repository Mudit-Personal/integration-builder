import { lazy, Suspense, useEffect, useReducer, useRef, useState, type ComponentType } from 'react';
import { displayName, initialsOf, loadWorkspace, removeConnector, saveConnector, type Account } from './api.ts';
import { dropPack, holdPacks, isStale, packLost, readPack, savePack, upsert, type SavedConnector } from './connectors.ts';
import { AppHeader, Button, Callout, P } from './ds.tsx';
import { readDocs } from './live.ts';
import { loadPack, type AppPack } from './pack.ts';
import { Checks } from './screens/Checks.tsx';
import { Decide } from './screens/Decide.tsx';
import { Home } from './screens/Home.tsx';
import { Profile } from './screens/Profile.tsx';
import { LiveReading, Read } from './screens/Read.tsx';
import { Ready } from './screens/Ready.tsx';
import { Source } from './screens/Source.tsx';
import { audienceOf, JOURNEYS } from './journey.ts';
import { CHECKS, CODE, DECIDE, initial, READ, READY, reducer, RUN, SOURCE, type Action, type Flow } from './state.ts';

export type ScreenProps = { s: Flow; dispatch: (a: Action) => void; go: (step: number) => void; pack: AppPack; name: string };

const Code = lazy(() => import('./screens/Code.tsx').then(m => ({ default: m.Code })));
const Run = lazy(() => import('./screens/Run.tsx').then(m => ({ default: m.Run })));
const SCREENS: Record<number, ComponentType<ScreenProps>> = { [READ]: Read, [DECIDE]: Decide, [CHECKS]: Checks, [CODE]: Code, [RUN]: Run };

const NOT_SAVED = "We couldn't save your latest change. Check your connection. We'll save it again with your next change.";
const PACK_LOST = "We no longer have this read. Read the docs again to carry on.";

// A new connector starts in the journey its owner used last.
const lastAudience = (list: SavedConnector[]) => audienceOf(list.reduce<SavedConnector | null>((a, c) => (!a || c.updatedAt > a.updatedAt ? c : a), null)?.flow.audience);

type Props = { account: Account; start?: { url?: string } | null; profile: boolean; onProfile: (open: boolean) => void; onAccount: (account: Account) => void; onLogOut: () => void };

export function App({ account, start = null, profile, onProfile, onAccount, onLogOut }: Props) {
  const [s, dispatch] = useReducer(reducer, undefined, initial);
  const [connectors, setConnectors] = useState<SavedConnector[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  // What the server holds, by id, so only real changes are sent.
  const saved = useRef(new Map<string, string>());
  const [notice, setNotice] = useState<string | null>(null);
  const [pack, setPack] = useState<AppPack | null>(null);
  const [failed, setFailed] = useState(false);
  const reading = useRef<AbortController | null>(null);
  const load = () => {
    setLoadFailed(null);
    loadWorkspace().then(r => {
      if (!r.ok) return setLoadFailed(r.error);
      holdPacks(r.value.packs);
      saved.current = new Map(r.value.connectors.map(c => [c.id, JSON.stringify(c)]));
      setConnectors(r.value.connectors);
    });
  };
  useEffect(load, []);
  useEffect(() => {
    if (!connectors) return;
    const failed = () => setNotice(NOT_SAVED);
    for (const c of connectors) {
      const json = JSON.stringify(c);
      if (saved.current.get(c.id) === json) continue;
      saved.current.set(c.id, json);
      saveConnector(c, readPack(c.id)).then(r => { if (!r.ok) { saved.current.delete(c.id); failed(); } });
    }
    for (const id of saved.current.keys()) {
      if (connectors.some(c => c.id === id)) continue;
      saved.current.delete(id);
      removeConnector(id).then(r => { if (!r.ok) failed(); });
    }
  }, [connectors]);
  useEffect(() => () => reading.current?.abort(), []);
  // Arriving from the landing page's Get started opens a new connector once, then the address settles on #app.
  useEffect(() => {
    if (!start) return;
    dispatch({ type: 'new', id: crypto.randomUUID(), audience: 'developer' });
    if (start.url) dispatch({ type: 'url', url: start.url });
    history.replaceState(null, '', '#app');
  }, []);
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
    if (s.id && s.read.kind === 'idle' && pack?.manifest.app.slug === s.slug) setConnectors(list => list && upsert(list, s, pack, Date.now()));
  }, [s, pack]);
  // A connector saved as ready can outlive the pack it was checked against.
  useEffect(() => {
    if (s.step === READY && pack?.manifest.app.slug === s.slug && isStale(s, pack)) dispatch({ type: 'go', step: CHECKS });
  }, [s, pack]);
  const stopReading = () => {
    reading.current?.abort();
    if (s.read.kind !== 'idle') dispatch({ type: 'read-clear' });
  };
  const go = (step: number) => {
    onProfile(false);
    if (step !== READ) stopReading();
    dispatch({ type: 'go', step });
    window.scrollTo(0, 0);
  };
  // Runs from a click, never an effect, so a remount can't spend a second read.
  const startRead = (url: string, text?: string) => {
    reading.current?.abort();
    const ctrl = reading.current = new AbortController();
    dispatch({ type: 'read-start', url });
    window.scrollTo(0, 0);
    readDocs({ url, text }, message => { if (!ctrl.signal.aborted) dispatch({ type: 'read-progress', message }); }, ctrl.signal)
      .catch(() => ({ kind: 'failed' as const, message: 'The connection dropped during the read. Check your network and try again.' }))
      .then(out => {
        if (ctrl.signal.aborted) return;
        if (out.kind === 'done') {
          savePack(s.id!, out.pack);
          dispatch({ type: 'read-done', pack: out.pack });
        } else dispatch({ type: 'read-stopped', read: out });
      });
  };
  const leave = (action: Action, message: string | null = null) => {
    onProfile(false);
    stopReading();
    setNotice(message);
    dispatch(action);
    window.scrollTo(0, 0);
  };
  const home = () => leave({ type: 'home' }, notice === NOT_SAVED ? notice : null);
  const open = (saved: SavedConnector) => {
    const lost = packLost(saved);
    leave({ type: 'open', saved, lost }, lost ? PACK_LOST : null);
  };
  const remove = (id: string) => {
    setConnectors(list => list && list.filter(c => c.id !== id));
    dropPack(id);
  };
  const Screen = SCREENS[s.step];
  return <>
    <AppHeader steps={s.id && !profile ? JOURNEYS[s.audience].steps : []} current={s.step} maxStep={s.maxStep} onStep={go} onHome={home} right={<>
      {s.id && !profile ? <Button variant="link" style={{ font: '400 13px/1 var(--font-mono)' }} onClick={() => leave({ type: 'reset' })}>Start over</Button> : null}
      <span className="account"><button type="button" className="account-open" aria-label={`Your profile, signed in as ${account.email}`} aria-current={profile ? 'page' : undefined} onClick={() => onProfile(true)}>
        <span className="avatar" title={displayName(account)}>{initialsOf(account)}</span></button>
        <Button variant="link" style={{ font: '400 13px/1 var(--font-mono)' }} onClick={onLogOut}>Log out</Button></span>
    </>} />
    {profile ? <Profile account={account} connectors={connectors && connectors.length} onAccount={onAccount} onBack={() => onProfile(false)} backLabel={s.id ? `Back to ${pack?.manifest.app.name ?? 'your connector'}` : 'Back to your connectors'} /> : null}
    {/* Hidden, not unmounted, so a read, a check run or a half-made decision carries on behind the profile. */}
    <div hidden={profile}>
    {notice ? <div className="notice"><Callout>{notice}</Callout></div> : null}
    {!s.id && !connectors ? <div className="centered">{loadFailed ? <><Callout>{loadFailed}</Callout><Button variant="secondary" style={{ marginTop: 16 }} onClick={load}>Try again</Button></> : <P>Loading your workspace…</P>}</div>
      : !s.id ? <Home connectors={connectors!} onNew={() => leave({ type: 'new', id: crypto.randomUUID(), audience: lastAudience(connectors!) })} onOpen={open} onRemove={remove} />
      : s.step === SOURCE ? <Source s={s} dispatch={dispatch} go={go} onRead={startRead} />
      : s.step === READ && s.read.kind !== 'idle' ? <LiveReading read={s.read} url={s.url} go={go} onPaste={text => startRead(s.url, text)} />
      : pack && s.step === READY ? <Ready s={s} go={go} name={pack.manifest.app.name} onHome={home} onAnother={() => leave({ type: 'new', id: crypto.randomUUID(), audience: s.audience })} />
      : pack ? <Suspense><Screen key={s.slug} s={s} dispatch={dispatch} go={go} pack={pack} name={pack.manifest.app.name} /></Suspense>
      : <div className="centered"><P>{failed ? "This app's data didn't load. Reload the page to try again." : 'Loading…'}</P></div>}
    </div>
  </>;
}
