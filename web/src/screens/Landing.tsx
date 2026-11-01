import { useEffect, useRef, useState, type FormEvent } from 'react';
import { APPS } from '../state.ts';

// Plate geometry for the isometric stack, ported from the Landing design.
const W = 400, H = 170, CX = 230, CY = 88, THICK = 8, ROW = 104, ROWS = 6;
const fix = (n: number) => +n.toFixed(1);
const pt = (u: number, v: number) => [fix(CX + (u - v) * W / 2), fix(CY + (u + v - 1) * H / 2)];
const seg = (a: number, b: number, c: number, d: number) => `M${pt(a, b).join(' ')}L${pt(c, d).join(' ')}`;
const quad = (a: number, b: number, c: number, d: number) => `${seg(a, b, c, b)}L${pt(c, d).join(' ')}L${pt(a, d).join(' ')}Z`;
const dot = (u: number, v: number, r: number) => { const [x, y] = pt(u, v); return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`; };
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
export const FACE = quad(0, 0, 1, 1);
export const SIDE = `M${CX - W / 2} ${CY}v${THICK}L${CX} ${CY + H / 2 + THICK}L${CX + W / 2} ${CY + THICK}v${-THICK}L${CX} ${CY + H / 2}Z`;
const MARKS = [
  range(9).map(i => seg(.16, .12 + i * .095, .46 + (i * 37 % 5) * .09, .12 + i * .095)).join(''),
  quad(.18, .18, .82, .38) + quad(.18, .46, .56, .82) + quad(.62, .46, .82, .82),
  range(25).map(i => { const u = .18 + (i % 5) * .16, v = .18 + Math.floor(i / 5) * .16; return seg(u - .025, v, u + .025, v) + seg(u, v - .025, u, v + .025); }).join(''),
  range(29).map(i => dot(.14 + (i % 6) * .144, .16 + Math.floor(i / 6) * .17, 3)).join(''),
  quad(.2, .2, .62, .62) + quad(.38, .38, .8, .8),
  quad(.36, .36, .64, .64) + 'M214 88l10 9 22-20',
];
const STAGES = [
  { name: 'Read', what: "Reads the docs so you don't have to.", got: 'Endpoints, sign-in and pages found.' },
  { name: 'Choose', what: 'Tick what you want: people, usage, or both.', got: 'Name, email, role and last active picked.' },
  { name: 'Review', what: 'Shows what it will read, what it will never do, and how it behaves.', got: 'Written in plain words. One question for you.' },
  { name: 'Test', what: 'Tries to break it with 29 real-world problems.', got: 'Every problem handled, or marked as not applying.' },
  { name: 'Try it', what: 'Paste your token and see your real people. Read only.', got: '' },
  { name: 'Go live', what: 'Approve it and we run it for you.', got: '' },
];
// The stages the preview runs on its own; the rest need a person.
const AUTO = 4;
const STEP_MS = 800;
const ACCENT = 'var(--blue)', INK = 'var(--ink)', GROUND = 'var(--paper)', MUTED = 'var(--ink-3)';

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const reveal = (el: HTMLElement | null) => el?.scrollIntoView({ block: 'nearest', behavior: still() ? 'auto' : 'smooth' });

type Props = { signedIn: boolean; onLogIn: () => void; onStart: (url?: string) => void };

export function Landing({ signedIn, onLogIn, onStart }: Props) {
  const [api, setApi] = useState('https://docs.yourapp.com/api');
  const [ran, setRan] = useState(0);
  const [running, setRunning] = useState(false);
  const [pick, setPick] = useState(3);
  const timers = useRef<number[]>([]);
  const stack = useRef<HTMLElement>(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const finished = ran >= AUTO;

  const run = (e: FormEvent) => {
    e.preventDefault();
    if (running) return;
    // The plates sit below the fold on most laptops, and they are what this button runs.
    stack.current?.scrollIntoView({ block: 'start', behavior: still() ? 'auto' : 'smooth' });
    if (still()) { setRan(AUTO); setPick(AUTO - 1); return; }
    setRan(0); setRunning(true); setPick(0);
    timers.current = range(AUTO).map(i => window.setTimeout(() => {
      const n = i + 1;
      setRan(n); setRunning(n < AUTO); setPick(Math.min(n, AUTO - 1));
    }, (i + 1) * STEP_MS));
  };

  const stages = STAGES.map((st, i) => {
    const done = i < ran, now = running && i === ran, yours = finished && i >= AUTO, isOn = pick === i, lit = now || isOn;
    return {
      ...st, i, isOn, done, n: `0${i + 1}`,
      tag: done ? 'Done' : now ? 'Running' : yours ? 'Needs you' : '', tagColor: now || yours ? ACCENT : MUTED,
      top: fix((ROW / 2 + ROW * i - CY) / (ROW * ROWS) * 100), z: ROWS - i, shift: isOn ? -14 : 0,
      line: lit ? ACCENT : INK, fill: lit ? 'var(--blue-tint)' : done ? 'var(--paper-raised)' : GROUND, sideFill: lit ? ACCENT : done ? 'var(--line)' : GROUND,
      mark: lit || done ? ACCENT : 'var(--ink-4)', markFill: i === 3 ? (lit || done ? ACCENT : 'var(--ink-4)') : 'none',
    };
  });

  return <div className="landing">
    <div className="landing-inner">
      <header className="landing-header">
        <span className="landing-brand"><span style={{ width: 10, height: 10, background: ACCENT }} />Integration Builder</span>
        <span className="landing-nav">
          {signedIn ? <a href="#app" onClick={e => { e.preventDefault(); onLogIn(); }} className="landing-cta landing-cta-ink">Open workspace</a> : <>
            <a href="#login" onClick={e => { e.preventDefault(); onLogIn(); }} className="landing-link">Log in</a>
            <a href="#signup" onClick={e => { e.preventDefault(); onStart(); }} className="landing-cta landing-cta-ink">Get started</a>
          </>}
        </span>
      </header>

      <section className="landing-hero">
        <h1>Working integrations, without reading the docs.</h1>
        <div style={{ flex: '1 1 400px', minWidth: 0 }}>
          <p className="landing-lead">Give Integration Builder any app's API docs. It works out the connection, tests it, lets you try it on your own account, then runs it for you. No code to read.</p>
          <form onSubmit={run} className="landing-form">
            <label htmlFor="landing-api" className="sr-only">API docs address</label>
            <input id="landing-api" value={api} onChange={e => setApi(e.target.value)} />
            <button type="submit" disabled={running}>{running ? 'Running' : finished ? 'Run it again' : 'Run it'}</button>
          </form>
        </div>
      </section>

      <section ref={stack} aria-label="What happens to an API" className="landing-stages">
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          {stages.map(p => <button key={p.name} type="button" className="landing-row" aria-pressed={p.isOn} onClick={() => { if (!running) setPick(p.i); }}>
            <span className="landing-n">{p.n}</span>
            <span style={{ minWidth: 0 }}>
              <span className="landing-stage">{p.name}</span>
              <span className="landing-stage-text" style={{ color: p.done ? INK : 'var(--ink-2)' }}>{p.done ? p.got : p.what}</span>
            </span>
            <span className="landing-n" style={{ color: p.tagColor }}>{p.tag}</span>
          </button>)}
        </div>
        <div className="landing-stack" aria-hidden="true">
          {stages.map(p => <svg key={p.name} className="landing-plate" viewBox="0 0 460 190" style={{ top: `${p.top}%`, zIndex: p.z, transform: `translateX(${p.shift}px)` }}>
            <path className="landing-leader" d="M0 88H30" style={{ fill: 'none', stroke: p.line, strokeWidth: 1 }} />
            <path d={SIDE} style={{ fill: p.sideFill, stroke: p.line, strokeWidth: 1.25 }} />
            <path d={FACE} style={{ fill: p.fill, stroke: p.line, strokeWidth: 1.25 }} />
            <path d={MARKS[p.i]} style={{ fill: p.markFill, stroke: p.mark, strokeWidth: 1 }} />
          </svg>)}
        </div>
      </section>

      {finished ? <div ref={reveal} aria-live="polite" className="landing-done">
        <p>Every problem handled. Ready for you to try.</p>
        <a href="#app" onClick={e => { e.preventDefault(); onStart(api); }} className="landing-cta landing-cta-blue">Build this for real</a>
      </div> : null}
      <p className="landing-foot">Tested on {APPS.length} real apps. About 30 seconds from docs to a checked integration.</p>
    </div>
  </div>;
}
