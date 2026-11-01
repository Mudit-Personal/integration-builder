import { useState } from 'react';
import { flushSync } from 'react-dom';
import type { SavedConnector } from '../connectors.ts';
import { AppLogo, Button, Marker, Mono, P, PageTitle } from '../ds.tsx';
import { audienceOf, JOURNEYS } from '../journey.ts';
import { APPS } from '../state.ts';

const logoOf = (slug: string) => APPS.find(a => a.slug === slug)?.logo;

const statusText = (c: SavedConnector) => {
  const steps = JOURNEYS[audienceOf(c.flow.audience)].steps.slice(0, c.step + 1).filter(s => s !== null);
  return c.status === 'draft' ? `In progress, step ${steps.length} ${steps.at(-1)!.toLowerCase()}` : c.status === 'ready' ? 'Ready' : 'Handed off';
};

const checkText = ({ flow: { result }, hash }: SavedConnector) => {
  if (!result || result.hash !== hash) return 'Checks not run';
  return result.failed ? `${result.failed} ${result.failed === 1 ? 'check' : 'checks'} failed` : `${result.passed} checks passed`;
};

const summary = (list: SavedConnector[]) => {
  const count = (status: SavedConnector['status']) => list.filter(c => c.status === status).length;
  const handedOff = count('handed-off');
  return `${count('ready')} ready, ${handedOff ? `${handedOff} handed off, ` : ''}${count('draft')} in progress. ${APPS.length} apps to choose from, or any API with docs.`;
};

const updated = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

type Props = { connectors: SavedConnector[]; onNew: () => void; onOpen: (c: SavedConnector) => void; onRemove: (id: string) => void };

export function Home({ connectors, onNew, onOpen, onRemove }: Props) {
  const [removing, setRemoving] = useState<string | null>(null);
  // The rows below slide up into the gap instead of jumping.
  const remove = (id: string) => (document.startViewTransition ? document.startViewTransition(() => flushSync(() => onRemove(id))) : onRemove(id));
  const add = <Button onClick={onNew}>{connectors.length ? 'Connect another app' : 'Connect your first app'}</Button>;
  return <main className="centered">
    <PageTitle title="Your connectors" lead={connectors.length ? summary(connectors) : undefined} aside={connectors.length ? add : null} />
    {connectors.length ? <ul className="home-list">
      {connectors.map(c => <li key={c.id} className="home-row" style={{ viewTransitionName: `home-${c.id}` }}>
        <Marker tone={c.status === 'draft' ? 'pending' : 'done'} />
        <span className="home-name">{logoOf(c.slug) ? <AppLogo src={`./apps/${logoOf(c.slug)}`} /> : null}{c.name}</span>
        {removing === c.id ? <div className="home-remove">
          <span>Remove {c.name}? You can't undo this.</span>
          <Button variant="link" onClick={() => remove(c.id)}>Yes, remove</Button>
          <Button variant="link" autoFocus onClick={() => setRemoving(null)}>Keep it</Button>
        </div> : <>
          <span>{statusText(c)}</span>
          <Mono>{checkText(c)}</Mono>
          <Mono>{updated(c.updatedAt)}</Mono>
          <div className="home-actions">
            <Button variant="link" onClick={() => onOpen(c)}>Open</Button>
            <Button variant="link" onClick={() => setRemoving(c.id)}>Remove</Button>
          </div>
        </>}
      </li>)}
    </ul> : <div className="home-empty" style={{ marginTop: 16 }}>
      <P style={{ margin: '0 0 24px' }}>You haven't connected an app yet.</P>
      {add}
    </div>}
  </main>;
}
