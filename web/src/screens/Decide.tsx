import { Fragment, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { BUSINESS_QUESTIONS, decisionRows, isAllowed, isRequired, type DecisionRow, type Question } from '../decisions.ts';
import { Button, Marker, Mono, PageTitle, Push, TextLink, ToggleGroup, type Tone } from '../ds.tsx';
import type { Sensitivity } from '../pack.ts';
import { JOURNEYS, stepBefore } from '../journey.ts';
import { CHECKS, DECIDE, type Flow } from '../state.ts';

type Tag = 'docs' | 'default' | 'you' | 'off' | 'recommended' | 'chosen';
const TAGS: Record<Tag, [Tone, string, string]> = {
  docs: ['done', 'From the docs', 'var(--blue)'], default: ['hollow', 'Our default', 'var(--ink-3)'], you: ['ink', 'Needs you', 'var(--ink)'], off: ['hollow', 'Left out', 'var(--ink-3)'],
  recommended: ['ink', 'Recommended', 'var(--ink)'], chosen: ['ink', 'Your choice', 'var(--ink)'],
};
const SENS: Record<Sensitivity, [Tone, string, string]> = { low: ['hollow', 'Low', 'var(--ink-3)'], personal: ['pending', 'Personal', 'var(--ink-2)'], sensitive: ['ink', 'Sensitive', 'var(--ink)'] };

const Label = ({ tag: [tone, text, color] }: { tag: [Tone, string, string] }) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, font: '400 13px/1 var(--font-mono)', color, whiteSpace: 'nowrap' }}><Marker tone={tone} style={tone === 'hollow' ? { borderColor: 'var(--ink-4)' } : undefined} />{text}</span>;

function DataAccess({ s, dispatch, pack, plain }: Pick<ScreenProps, 's' | 'dispatch' | 'pack'> & { plain: boolean }) {
  const allowed = (e: typeof pack.endpoints[number]) => isAllowed(e, s.decisions.access);
  return <div>
    <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap', padding: '22px 0 10px', borderBottom: 'var(--rule-strong)' }}><span style={{ font: 'var(--type-label)' }}>Data access</span><Mono>Sample data is always masked</Mono></div>
    {pack.endpoints.map(e => {
      const on = allowed(e);
      return <div key={e.key} className="access-row">
        <span style={{ fontWeight: 500, color: on ? 'var(--ink)' : 'var(--ink-2)', overflowWrap: 'anywhere' }}>{e.name}</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>{plain ? null : <span className="access-path" style={{ font: '400 13px/1.3 var(--font-mono)', color: 'var(--ink-2)' }}>{e.path}</span>}<span style={{ color: 'var(--ink-2)', fontSize: 14 }}>{e.note}</span></span>
        <Label tag={SENS[e.sensitivity]} />
        <div className="access-action" style={{ justifySelf: 'end', display: 'flex', alignItems: 'center', gap: 12 }}>
          {isRequired(e) ? <Mono c="var(--ink)">Required</Mono>
            : <ToggleGroup options={['Allow', 'Block']} value={on ? 'Allow' : 'Block'} onChange={v => dispatch({ type: 'decide', patch: { access: { ...s.decisions.access, [e.key]: v === 'Allow' } } })} />}
        </div></div>;
    })}
  </div>;
}

function QuestionBody({ q, s, dispatch }: { q: Question; s: Flow; dispatch: ScreenProps['dispatch'] }) {
  const answered = !!s.answers[q.id];
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
    <span>{q.text}</span>
    <ToggleGroup options={q.options} value={answered ? q.options[q.current] : undefined} onChange={v => dispatch({ type: 'decide', patch: q.patch(q.options.indexOf(v)), answer: [q.id, 'chosen'] })} />
    {!answered ? <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 14 }}>
      <span style={{ color: 'var(--ink-2)' }}>Recommended: <b style={{ fontWeight: 500, color: 'var(--ink)' }}>{q.options[q.recommended]}</b>. {q.why}</span>
      <TextLink onClick={() => dispatch({ type: 'decide', patch: q.patch(q.recommended), answer: [q.id, 'recommended'] })}>Use recommended</TextLink>
    </div> : null}
  </div>;
}

export function Decide({ s, dispatch, go, pack, name }: ScreenProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [showRest, setShowRest] = useState(false);
  const rows = decisionRows(pack, s.decisions);
  const j = JOURNEYS[s.audience];
  const plain = j.decisions === 'asks';
  const count = (k: DecisionRow['source']) => rows.filter(r => r.source === k).length;
  const openRows = rows.filter(r => r.question && !s.answers[r.question.id]);
  const acceptAll = () => openRows.forEach(({ question: q }) => dispatch({ type: 'decide', patch: q!.patch(q!.recommended), answer: [q!.id, 'recommended'] }));
  const asks = rows.filter(r => r.question && (!plain || BUSINESS_QUESTIONS.includes(r.question.id)));
  const rest = rows.filter(r => !asks.includes(r));
  const openAsks = asks.filter(r => !s.answers[r.question!.id]);
  const access = <DataAccess s={s} dispatch={dispatch} pack={pack} plain={plain} />;
  const renderRows = (list: DecisionRow[], grouped: boolean) =>
    list.map((r, i) => {
      const head = grouped && list[i - 1]?.group !== r.group;
      const key = `${r.group}/${r.title}`;
      const answer = r.question && s.answers[r.question.id];
      const toOpen = !!(r.why && !r.question) || !!r.choice;
      return <Fragment key={key}>
        {head ? <div className="dgroup">{r.group}</div> : null}
        <div className={r.question && !answer ? 'drow ask' : 'drow'}>
          <span style={{ fontWeight: 500 }}>{r.title}</span>
          {r.question ? <QuestionBody q={r.question} s={s} dispatch={dispatch} /> : <span style={{ color: 'var(--ink-2)', minWidth: 0, overflowWrap: 'anywhere' }}>{plain ? r.plain : r.value}</span>}
          <Label tag={TAGS[answer ?? (plain && r.question && !asks.includes(r) ? 'recommended' : r.source)]} />
          {toOpen ? <TextLink style={{ justifySelf: 'end' }} onClick={() => setOpen(open === key ? null : key)}>{open === key ? 'Close' : r.choice ? 'Change' : 'Why'}</TextLink> : <span />}
        </div>
        {open === key ? <div className="dopen">
          {r.why ? <span style={{ font: '400 14px/1.5 var(--font-mono)', color: 'var(--ink-2)', maxWidth: 560, overflowWrap: 'anywhere' }}>Docs: {r.why}</span> : null}
          {r.choice ? <ToggleGroup options={r.choice.options} value={r.choice.current} onChange={v => dispatch({ type: 'decide', patch: r.choice!.patch(v) })} /> : null}
        </div> : null}
      </Fragment>;
    });
  return <div className="centered">
    {plain ? <PageTitle title="Review what it will do" lead={`${asks.length === 1 ? 'One question needs you, with our recommended answer.' : asks.length ? `${asks.length} questions need you, each with our recommended answer.` : 'Nothing needs you.'} Choose what data it may read. We handle the rest.`} />
    : <><PageTitle title="Here's how the integration will work" lead={`${count('docs')} decisions came straight from ${name}'s docs, ${count('default')} ${count('default') === 1 ? 'is our default' : 'are our defaults'}, ${count('you') ? `${count('you')} ${count('you') === 1 ? 'needs' : 'need'} you` : 'nothing needs you'}${count('off') ? `, ${count('off')} left out` : ''}. Change anything before code is generated.`} />
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 20 }}>{(['docs', 'default', 'you', ...(count('off') ? ['off' as const] : [])] as const).map(k => <Label key={k} tag={TAGS[k]} />)}</div></>}
    <div style={{ marginTop: 32, flex: 1 }}>
      {asks.length ? <><div className="dgroup">Needs you</div>{renderRows(asks, false)}</> : null}
      {plain ? access : null}
      <div className="dgroup dsummary">
        <span>{plain ? `${rest.length} technical details, handled for you` : `${rest.length} ${asks.length ? 'more decisions' : 'decisions'}: ${rest.filter(r => r.source === 'docs').length} from the docs, ${rest.filter(r => r.source === 'default').length} our defaults${count('off') ? `, ${count('off')} left out` : ''}`}</span>
        <TextLink onClick={() => setShowRest(v => !v)}>{showRest ? 'Hide' : plain ? 'Show them' : 'Review them'}</TextLink>
      </div>
      {showRest ? renderRows(rest, true) : null}
      {plain ? null : access}
    </div>
    <div className="footer-row" style={{ gap: 20, marginTop: 40 }}>
      <Button variant="link" onClick={() => go(stepBefore(j, DECIDE))}>Back</Button><Push />
      {openAsks.length ? <Mono c="var(--ink-2)">{openAsks.length} not answered</Mono> : null}
      <Button style={{ whiteSpace: 'normal' }} onClick={() => { acceptAll(); go(CHECKS); }}>{openAsks.length ? `Use ${openAsks.length === 1 ? 'the recommended answer' : `${openAsks.length} recommended answers`} and ${plain ? 'test it' : 'run checks'}` : plain ? 'Test it' : 'Run checks'}</Button>
    </div>
  </div>;
}
