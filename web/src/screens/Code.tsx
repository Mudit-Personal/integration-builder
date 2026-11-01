import { strToU8, zipSync } from 'fflate';
import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { applyDecisions } from '../decisions.ts';
import { Button, Callout, P, CodeBlock, Marker, Mono, PageTitle, Push, SectionHeading, SplitLayout, StatusLabel, Tabs, ToggleGroup } from '../ds.tsx';
import { buildFiles, buildPrompt, buildSummary, FOLDER, usageSnippet, type BundleFile } from '../handover.ts';
import { JOURNEYS } from '../journey.ts';
import { ENGINE_SOURCES } from '../sources.ts';
import { CHECKS, RUN } from '../state.ts';

const TOOLS: Record<string, string> = { 'Claude Code': 'In your repo root, run claude and paste the prompt.', Cursor: 'Open the Agent panel in your repo and paste the prompt.', Copilot: 'Open Copilot Chat in agent mode and paste the prompt.', 'Any tool': 'Paste into any coding assistant that can edit your repo.' };
const PROMPT = 'AI tool prompt';
const SUMMARY = 'Summary';
const MODES = { code: ['Code', PROMPT], prompt: [SUMMARY, PROMPT, 'Show the files'] };
const LEADS: Record<string, (folder: string) => string> = { Code: folder => `Read the files, then download them into ${folder} in your repo.`, [PROMPT]: () => 'Hand the work to your AI coding tool. The prompt carries every decision you made and the guardrails.' };

const download = (name: string, files: BundleFile[]) => {
  const zip = zipSync(Object.fromEntries(files.map(f => [f.name, strToU8(f.code)])));
  const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

export function Code({ s, go, pack, name }: ScreenProps) {
  const d = s.decisions;
  const passed = s.checks.kind === 'done' ? s.checks.results.filter(r => r.status === 'pass').length : 0;
  const m = useMemo(() => applyDecisions(pack.manifest, d), [pack, d]);
  const files = useMemo(() => buildFiles(pack, d, ENGINE_SOURCES, passed), [pack, d, passed]);
  const prompt = useMemo(() => buildPrompt(pack, d, files, passed), [pack, d, files, passed]);
  const summary = useMemo(() => buildSummary(pack, d, passed), [pack, d, passed]);
  const prompted = JOURNEYS[s.audience].handoff === 'prompt';
  const modes = MODES[JOURNEYS[s.audience].handoff];
  const [mode, setMode] = useState(modes[0]);
  const [tab, setTab] = useState(files[0].name);
  const [tool, setTool] = useState('Claude Code');
  const [note, setNote] = useState<string | null>(null);
  const file = files.find(f => f.name === tab) ?? files[0];
  const zipName = `${m.app.slug}-integration.zip`;
  const save = () => { download(zipName, files); setNote(`Downloaded ${zipName} (${files.length} files).`); };
  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setNote('Summary copied. Paste it into a ticket or a message.');
    } catch {
      setNote("Your browser didn't allow copying. Select the summary and copy it by hand.");
    }
  };
  const snippet = usageSnippet(m, d, `./${m.app.slug}.connector.ts`);
  const on = d.deliverables;
  const inc: [string, string][] = ([
    ['API client', on.client, `${m.app.slug}.connector.ts`], ['Auth setup', on.auth, m.authMethods[0].label],
    ['Users', on.users, `${m.users.request.method} ${m.users.request.path.slice(0, 28)}`], ['Usage data', m.usage.kind !== 'unavailable', m.usage.kind.replace(/_/g, ' ')],
    ['Error handling', on.errors, `${d.retries} retries`], ['Pagination', on.pagination, m.users.pagination.type.replace(/_/g, ' ')],
    ['Logging', on.logging, d.logLevel], ['Response caching', on.caching, `${d.cacheTtl} min`],
  ] as const).map(([label, kept, value]) => [label, kept ? value : 'Left out']);
  return <SplitLayout panel={<>
    {mode === PROMPT || mode === SUMMARY ? <><SectionHeading>How to use it</SectionHeading>
      {(prompted ? ['Copy the summary and send it to your developer, in a ticket or a message.', 'Or hand it to an AI coding tool yourself: download the files and copy the prompt from the AI tool prompt tab.', 'Before it goes live, someone runs one check with a real account.'] : ['Copy the prompt and download the files.', TOOLS[tool], 'Review the changes your tool makes, like any pull request.']).map((t, i) => <div key={i} style={{ display: 'flex', gap: 24, padding: '14px 0', borderBottom: 'var(--rule-hair)' }}><Mono>{i + 1}</Mono><span>{t}</span></div>)}</>
      : snippet ? <><SectionHeading>Use it in your app</SectionHeading><CodeBlock code={snippet} name="usage.ts" style={{ marginTop: 16 }} /></>
        : <><SectionHeading>Use it in your app</SectionHeading><P>You left out the API client. Build yours from manifest.json; it holds every request, field and limit.</P></>}
    {prompted ? null : <><SectionHeading size="label" style={{ marginTop: 24 }}>What's in it</SectionHeading>
      {inc.map(r => <div key={r[0]} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: 'var(--rule-hair)' }}><Marker tone={r[1] === 'Left out' ? 'hollow' : 'done'} /><span style={{ flex: 1 }}>{r[0]}</span><Mono>{r[1]}</Mono></div>)}</>}
    <div className="footer-row" style={{ gap: 12, marginTop: 24 }}><Button variant="link" onClick={() => go(CHECKS)}>Back</Button><Push />{mode === SUMMARY ? <Button variant="secondary" onClick={copySummary}>Copy summary</Button> : mode !== PROMPT ? <Button variant="secondary" onClick={save}>Download .zip</Button> : <Button variant="secondary" onClick={save}>Download files</Button>}<Button onClick={() => go(RUN)}>{prompted ? 'See a preview' : 'Run a sync'}</Button></div>
    {/* Below the buttons, so the one just pressed doesn't move. */}
    <div role="status">{note ? <Callout style={{ marginTop: 24 }}>{note}</Callout> : null}</div></>}>
    {prompted ? <PageTitle title="Hand it to your developer" lead={`Send this summary to whoever builds it. It carries every choice you made for ${name}.`} aside={<StatusLabel>Checks passed</StatusLabel>} />
      : <PageTitle title={`Your ${name} integration is ready`} lead={LEADS[mode](FOLDER(m))} aside={<StatusLabel>Checks passed</StatusLabel>} />}
    <Tabs tabs={modes} value={mode} onChange={v => { setMode(v); setNote(null); }} style={{ marginTop: 32 }} />
    {mode === SUMMARY ? <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 28 }}>
      <div className="prompt">{summary}</div>
      <Mono>Plain words, no code. Paste it into a ticket, an email or Slack.</Mono></div>
    : mode !== PROMPT ? <>
      <Tabs tabs={files.map(f => f.name)} value={file.name} onChange={setTab} style={{ marginTop: 20, borderBottomColor: 'var(--line)' }} />
      <CodeBlock key={file.name} code={file.code} name={file.name} style={{ marginTop: 16, maxHeight: '70vh' }} /></>
      : <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}><span style={{ font: 'var(--type-label)' }}>Your tool</span><ToggleGroup options={Object.keys(TOOLS)} value={tool} onChange={setTool} /></div>
        <CodeBlock code={prompt} name="Prompt" prose style={{ maxHeight: '70vh' }} />
        <Mono>The {files.length} generated files come with the prompt as a .zip.</Mono></div>}
  </SplitLayout>;
}
