import { useState } from 'react';
import type { SavedConnector } from '../connectors.ts';
import { AppLogo, Button, Marker, Mono, P, PageTitle } from '../ds.tsx';
import { audienceOf, JOURNEYS } from '../journey.ts';
import { APPS } from '../state.ts';

const logoOf = (slug: string) => APPS.find(a => a.slug === slug)?.logo;

const statusText = (c: SavedConnector) => {
  const steps = JOURNEYS[audienceOf(c.flow.audience)].steps.slice(0, c.step + 1).filter(s => s !== null);
  return c.status === 'ready' ? 'Ready' : `In progress, step ${steps.length} ${steps.at(-1)!.toLowerCase()}`;
};

const checkText = ({ flow: { result }, hash }: SavedConnector) => {
  if (!result || result.hash !== hash) return 'Checks not run';
  return result.failed ? `${result.failed} ${result.failed === 1 ? 'check' : 'checks'} failed` : `${result.passed} checks passed`;
};

const summary = (list: SavedConnector[]) => {
  const ready = list.filter(c => c.status === 'ready').length;
  return `${ready} ready, ${list.length - ready} in progress. ${APPS.length} apps to choose from, or any API with docs.`;
};

const updated = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

type Props = { connectors: SavedConnector[]; onNew: () => void; onOpen: (c: SavedConnector) => void; onRemove: (id: string) => void };

export function Home({ connectors, onNew, onOpen, onRemove }: Props) {
  const [removing, setRemoving] = useState<string | null>(null);
  const add = <Button onClick={onNew}>{connectors.length ? 'Connect another app' : 'Connect your first app'}</Button>;
  return <main className="centered">
    <PageTitle title="Your connectors" lead={connectors.length ? summary(connectors) : undefined} aside={connectors.length ? add : null} />
    {connectors.length ? <ul className="home-list">
      {connectors.map(c => <li key={c.id} className="home-row">
        <Marker tone={c.status === 'ready' ? 'done' : 'pending'} />
        <span className="home-name">{logoOf(c.slug) ? <AppLogo src={`./apps/${logoOf(c.slug)}`} /> : null}{c.name}</span>
        {removing === c.id ? <div className="home-remove">
          <span>Remove {c.name}? You can't undo this.</span>
          <Button variant="link" onClick={() => onRemove(c.id)}>Yes, remove</Button>
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
    </ul> : <div style={{ marginTop: 16 }}>
      <P style={{ margin: '0 0 24px' }}>You haven't connected an app yet.</P>
      {add}
    </div>}
  </main>;
}
