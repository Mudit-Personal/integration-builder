import { strToU8, zipSync } from 'fflate';
import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { applyDecisions } from '../decisions.ts';
import { Button, Callout, CodeBlock, Marker, Mono, PageTitle, Push, SectionHeading, SplitLayout, StatusLabel, Tabs, ToggleGroup } from '../ds.tsx';
import { buildFiles, buildPrompt, FOLDER, usageSnippet, type BundleFile } from '../handover.ts';
import { ENGINE_SOURCES } from '../sources.ts';
import { CHECKS, RUN } from '../state.ts';

const TOOLS: Record<string, string> = { 'Claude Code': 'In your repo root, run claude and paste the prompt.', Cursor: 'Open the Agent panel in your repo and paste the prompt.', Copilot: 'Open Copilot Chat in agent mode and paste the prompt.', 'Any tool': 'Paste into any coding assistant that can edit your repo.' };
const MODES = ['Code', 'AI tool prompt'];
const LEADS: Record<string, (folder: string) => string> = { Code: folder => `Read the files, then download them into ${folder} in your repo.`, 'AI tool prompt': () => 'Hand the work to your AI coding tool. The prompt carries every decision you made and the guardrails.' };

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
  const [mode, setMode] = useState(s.audience === 'Developer' ? 'Code' : 'AI tool prompt');
  const [tab, setTab] = useState(files[0].name);
  const [tool, setTool] = useState('Claude Code');
  const [note, setNote] = useState<string | null>(null);
  const file = files.find(f => f.name === tab) ?? files[0];
  const zipName = `${m.app.slug}-integration.zip`;
  const save = () => { download(zipName, files); setNote(`Downloaded ${zipName} (${files.length} files).`); };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setNote(`Prompt copied. ${TOOLS[tool]}`);
    } catch {
      setNote("Your browser didn't allow copying. Select the prompt and copy it by hand.");
    }
  };
  const snippet = usageSnippet(m, `./${m.app.slug}.connector.ts`);
  const inc: [string, string][] = [
    ['API client', `${m.app.slug}.connector.ts`], ['Auth setup', m.authMethods[0].label],
    ['Users', `${m.users.request.method} ${m.users.request.path.slice(0, 28)}`], ['Usage data', m.usage.kind === 'unavailable' ? 'Left out' : m.usage.kind.replace(/_/g, ' ')],
    ['Error handling', `${d.retries} retries`], ['Pagination', m.users.pagination.type.replace(/_/g, ' ')],
    ['Logging', d.logLevel], ['Response caching', d.deliverables.caching ? `${d.cacheTtl} min` : 'Off'],
  ];
  return <SplitLayout panel={<>
    {mode === 'AI tool prompt' ? <><SectionHeading>How to use it</SectionHeading>
      {['Copy the prompt and download the files.', TOOLS[tool], 'Review the changes your tool makes, like any pull request.'].map((t, i) => <div key={i} style={{ display: 'flex', gap: 24, padding: '14px 0', borderBottom: 'var(--rule-hair)' }}><Mono>{i + 1}</Mono><span>{t}</span></div>)}</>
      : <><SectionHeading>Use it in your app</SectionHeading><CodeBlock code={snippet} style={{ margin: '8px calc(var(--page-pad) * -1) 0', background: 'transparent' }} /></>}
    <SectionHeading size="label" style={{ marginTop: 24 }}>What's in it</SectionHeading>
    {inc.map(r => <div key={r[0]} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: 'var(--rule-hair)' }}><Marker /><span style={{ flex: 1 }}>{r[0]}</span><Mono>{r[1]}</Mono></div>)}
    {note ? <Callout style={{ marginTop: 24 }}>{note}</Callout> : null}
    <div className="footer-row" style={{ gap: 12, marginTop: 24 }}><Button variant="link" onClick={() => go(CHECKS)}>Back</Button><Push />{mode === 'Code' ? <Button variant="secondary" onClick={save}>Download .zip</Button> : <><Button variant="secondary" onClick={save}>Download files</Button><Button variant="secondary" onClick={copy}>Copy prompt</Button></>}<Button onClick={() => go(RUN)}>Run a sync</Button></div></>}>
    <PageTitle title={`Your ${name} integration is ready`} lead={LEADS[mode](FOLDER(m))} aside={<StatusLabel>Checks passed</StatusLabel>} />
    <Tabs tabs={MODES} value={mode} onChange={v => { setMode(v); setNote(null); }} style={{ marginTop: 32 }} />
    {mode === 'Code' ? <>
      <Tabs tabs={files.map(f => f.name)} value={file.name} onChange={setTab} style={{ marginTop: 20, borderBottomColor: 'var(--line)' }} />
      <CodeBlock code={file.code} style={{ margin: '0 calc(var(--page-pad) * -1)', background: 'transparent', maxHeight: '70vh' }} /></>
      : <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}><span style={{ font: 'var(--type-label)' }}>Your tool</span><ToggleGroup options={Object.keys(TOOLS)} value={tool} onChange={setTool} /></div>
        <div className="prompt">{prompt}</div>
        <Mono>The {files.length} generated files come with the prompt as a .zip.</Mono></div>}
  </SplitLayout>;
}
