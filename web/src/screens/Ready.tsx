import type { ScreenProps } from '../App.tsx';
import { Button, KeyValueRow, Mono, P, PageTitle, Push, SectionHeading, SplitLayout, StatusLabel } from '../ds.tsx';
import { JOURNEYS, stepBefore } from '../journey.ts';
import { CODE, DECIDE, READY } from '../state.ts';

type Props = Pick<ScreenProps, 's' | 'go' | 'name'> & { onHome: () => void; onAnother: () => void };

export function Ready({ s, go, name, onHome, onAnother }: Props) {
  const j = JOURNEYS[s.audience];
  const prompted = j.handoff === 'prompt';
  return <SplitLayout footer={<><Button variant="link" onClick={() => go(stepBefore(j, READY))}>Back</Button><Push /><Button variant="secondary" onClick={onAnother}>Connect another app</Button></>} panel={<>
    <SectionHeading>Where it stands</SectionHeading>
    <KeyValueRow label="Checks" value={`${s.result?.passed} passed`} />
    <KeyValueRow label={prompted ? 'Preview' : 'First sync'} value="Finished on a simulated copy" />
    <KeyValueRow label={`Your real ${name}`} value="Not touched" />
    <SectionHeading size="group" style={{ marginTop: 36 }}>Changing it</SectionHeading>
    <P>Go back to {j.steps[DECIDE]} and change anything. Its checks run again before it's ready.</P></>}>
    <PageTitle title={`${name} is ready`} lead={`It passed its checks and ran on a simulated copy. Next, get it to where it will run.`} aside={<StatusLabel size="lg">Saved to your list</StatusLabel>} />
    <div className="ready-list">
      <div className="ready-row">
        <div><h2>{prompted ? 'Hand it to your developer' : 'Add it to your app'}</h2><p>{prompted ? 'Send the summary. It carries every choice you made.' : 'Download the code, or give the prompt to your AI coding tool.'}</p></div>
        <Button onClick={() => go(CODE)}>{prompted ? 'Open the summary' : 'Get the code'}</Button>
      </div>
      <div className="ready-row">
        <div><h2>Try it on your real account</h2><p>Paste a token and see your real people. Read only.</p></div>
        <Mono>Not available yet</Mono>
      </div>
      <div className="ready-row">
        <div><h2>Stop here for now</h2><p>It stays on your list, ready to pick up any time.</p></div>
        <Button variant="secondary" onClick={onHome}>Back to your connectors</Button>
      </div>
    </div>
  </SplitLayout>;
}
