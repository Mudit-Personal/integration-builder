import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

const useHover = () => {
  const [hover, setHover] = useState(false);
  return [hover, { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) }] as const;
};

export const AppLogo = ({ src }: { src: string }) => <img src={src} alt="" width={20} height={20} style={{ display: 'block', flex: 'none' }} onError={e => { e.currentTarget.style.display = 'none'; }} />;

export function AppChip({ name, icon, selected = false, onClick }: { name: string; icon?: string; selected?: boolean; onClick?: () => void }) {
  const [h, hp] = useHover();
  return <button onClick={onClick} {...hp} aria-pressed={selected} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 'var(--chip-h)', padding: '0 12px', font: 'var(--fw-regular) var(--fs-body)/1 var(--font-sans)', color: 'var(--text-strong)', background: h && !selected ? 'var(--hover-wash)' : 'transparent', border: `1px solid ${selected ? 'var(--border-strong)' : 'var(--border-hairline)'}`, borderRadius: 0, cursor: 'pointer' }}>
    {icon ? <AppLogo src={icon} /> : null}{name}
  </button>;
}

export type ButtonProps = { type?: 'button' | 'submit'; variant?: 'primary' | 'secondary' | 'inverse' | 'link'; disabled?: boolean; autoFocus?: boolean; onClick?: (e: MouseEvent<HTMLButtonElement>) => void; style?: CSSProperties; children?: ReactNode };
export function Button({ variant = 'primary', type = 'button', disabled = false, autoFocus, children, onClick, style }: ButtonProps) {
  const [h, hp] = useHover();
  const base: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 'var(--control-h)', padding: '0 24px', font: 'var(--fw-medium) var(--fs-body)/1 var(--font-sans)', borderWidth: 1, borderStyle: 'solid', borderColor: 'transparent', borderRadius: 0, cursor: disabled ? 'not-allowed' : 'pointer', transition: 'background var(--dur) var(--ease),color var(--dur) var(--ease)', whiteSpace: 'nowrap' };
  const v: Record<string, CSSProperties> = {
    primary: { background: h ? 'var(--action-primary-hover)' : 'var(--action-primary)', color: 'var(--text-on-accent)' },
    secondary: { background: h ? 'var(--hover-wash)' : 'transparent', color: 'var(--text-strong)', borderColor: 'var(--border-strong)', fontWeight: 400 },
    inverse: { background: h ? '#000' : 'var(--surface-inverse)', color: 'var(--text-on-accent)' },
    link: { background: 'none', height: 'auto', padding: 0, color: h ? 'var(--text-accent)' : 'var(--text-strong)', fontWeight: 400, textDecoration: 'underline', textUnderlineOffset: 4, textDecorationThickness: 1 },
  };
  const dis: CSSProperties = disabled && variant !== 'link' ? { background: 'var(--action-disabled)', color: 'var(--text-disabled)', borderColor: 'transparent' } : disabled ? { color: 'var(--text-disabled)' } : {};
  return <button type={type} className={variant === 'link' ? 'tap' : undefined} disabled={disabled} autoFocus={autoFocus} onClick={onClick} {...hp} style={{ ...base, ...v[variant], ...dis, ...style }}>{children}</button>;
}

export function TextLink({ onClick, children, style }: { onClick: () => void; children: ReactNode; style?: CSSProperties }) {
  return <a href="#" className="tap" onClick={e => { e.preventDefault(); onClick(); }} style={{ fontSize: 14, whiteSpace: 'nowrap', ...style }}>{children}</a>;
}

export function ToggleGroup({ options, value, onChange, style }: { options: string[]; value?: string; onChange?: (value: string) => void; style?: CSSProperties }) {
  return <div role="radiogroup" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, ...style }}>{options.map(o => {
    const on = o === value;
    return <button key={o} role="radio" aria-checked={on} onClick={() => onChange?.(o)} style={{ height: 48, padding: '0 17px', whiteSpace: 'nowrap', font: 'var(--fw-regular) var(--fs-body)/1 var(--font-sans)', borderRadius: 0, cursor: 'pointer', border: '1px solid var(--border-strong)', background: on ? 'var(--action-selected)' : 'transparent', color: on ? 'var(--text-on-accent)' : 'var(--text-strong)' }}>{o}</button>;
  })}</div>;
}

export function Checkbox({ checked = false, onChange, label, description, disabled = false }: { checked?: boolean; onChange?: (checked: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return <label style={{ display: 'flex', gap: 12, cursor: disabled ? 'default' : 'pointer', padding: '18px 0', borderBottom: 'var(--rule-hair)' }}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange?.(e.target.checked)} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
    <span aria-hidden style={{ flex: 'none', width: 'var(--check)', height: 'var(--check)', marginTop: 3, background: checked ? 'var(--blue)' : 'var(--white)', border: checked ? 'none' : '1px solid var(--ink-4)' }} />
    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ font: 'var(--fw-medium) var(--fs-body)/var(--lh-body) var(--font-sans)', color: 'var(--text-strong)' }}>{label}</span>
      {description ? <span style={{ font: 'var(--type-body)', color: 'var(--text-muted)' }}>{description}</span> : null}
    </span>
  </label>;
}

export function TextField({ label, value, onChange, mono = false, type = 'text', autoComplete, style }: { label: string; value: string; onChange: (value: string) => void; mono?: boolean; type?: 'text' | 'password'; autoComplete?: string; style?: CSSProperties }) {
  const id = `tf-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const [focus, setFocus] = useState(false);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10, ...style }}>
    <label htmlFor={id} style={{ font: 'var(--type-label)', color: 'var(--text-strong)' }}>{label}</label>
    <input id={id} type={type} autoComplete={autoComplete} value={value} onChange={e => onChange(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} style={{ height: 'var(--control-h)', padding: '0 14px', border: '1px solid var(--border-strong)', outline: focus ? '2px solid var(--blue)' : 'none', outlineOffset: -1, borderRadius: 0, background: 'transparent', color: 'var(--text-strong)', font: mono ? 'var(--fw-regular) 15px/1 var(--font-mono)' : 'var(--type-body)', width: '100%' }} />
  </div>;
}

/** A null step is hidden. The rest are numbered as shown, and report their own index. */
export function AppHeader({ steps, current, maxStep, right, onStep, onHome }: { steps: (string | null)[]; current: number; maxStep: number; right: ReactNode; onStep: (index: number) => void; onHome: () => void }) {
  const nav = useRef<HTMLElement>(null);
  useEffect(() => { nav.current?.querySelector('[aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest' }); }, [current]);
  return <header className="app-header">
    <button type="button" className="app-brand" onClick={onHome}><span style={{ width: 10, height: 10, background: 'var(--blue)' }} />Integration Builder</button>
    <nav ref={nav} className="app-nav">{steps.flatMap((s, i) => (s === null ? [] : [[i, s] as const])).map(([i, s], n) => {
      const on = i === current;
      return <button key={s} aria-label={`Step ${n + 1}, ${s}`} disabled={i > maxStep} aria-current={on ? 'step' : undefined} onClick={() => onStep(i)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 0, background: 'none', border: 0, borderBottom: `2px solid ${on ? 'var(--blue)' : 'transparent'}`, marginBottom: -1, cursor: i > maxStep ? 'default' : 'pointer', color: i > current ? 'var(--text-muted)' : 'var(--text-strong)', font: 'var(--fw-regular) var(--fs-body)/1 var(--font-sans)', whiteSpace: 'nowrap' }}>
        <span style={{ font: 'var(--fw-regular) 12px/1 var(--font-mono)' }}>{n + 1}</span><span className="step-name">{s}</span></button>;
    })}</nav>
    <div className="app-right">{right}</div>
  </header>;
}

export function Tabs({ tabs, value, onChange, right, style }: { tabs: string[]; value: string; onChange: (tab: string) => void; right?: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: 'flex', alignItems: 'flex-end', gap: 40, overflowX: 'auto', overflowY: 'hidden', borderBottom: '1px solid var(--ink-4)', ...style }}>
    {tabs.map(t => {
      const on = t === value;
      return <button key={t} className="tap" onClick={() => onChange(t)} style={{ flex: 'none', whiteSpace: 'nowrap', padding: '0 0 16px', background: 'none', border: 0, borderBottom: `2px solid ${on ? 'var(--blue)' : 'transparent'}`, marginBottom: -1, cursor: 'pointer', font: 'var(--fw-regular) var(--fs-body)/1 var(--font-sans)', color: on ? 'var(--text-strong)' : 'var(--text-muted)' }}>{t}</button>;
    })}
    {right ? <div style={{ marginLeft: 'auto', paddingBottom: 16, whiteSpace: 'nowrap', font: 'var(--type-meta)', color: 'var(--text-meta)' }}>{right}</div> : null}
  </div>;
}

export type Tone = 'done' | 'pending' | 'ink' | 'hollow';
export function Marker({ tone = 'done', size = 10, style }: { tone?: Tone; size?: number; style?: CSSProperties }) {
  if (tone === 'hollow') return <span aria-hidden style={{ display: 'inline-block', flex: 'none', width: size, height: size, border: '1.5px solid var(--ink)', ...style }} />;
  const c = { done: 'var(--status-done)', pending: 'var(--status-pending)', ink: 'var(--ink)' }[tone];
  return <span aria-hidden style={{ display: 'inline-block', flex: 'none', width: size, height: size, background: c, ...style }} />;
}

export function CheckItem({ title, description, meta, status = 'done' }: { title: ReactNode; description?: ReactNode; meta?: ReactNode; status?: Tone }) {
  return <div style={{ display: 'flex', gap: 24, padding: '18px 0', borderBottom: 'var(--rule-hair)' }}>
    <Marker tone={status} style={{ marginTop: 7 }} />
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, overflowWrap: 'anywhere' }}>
      <div style={{ font: description ? 'var(--fw-medium) var(--fs-body)/var(--lh-body) var(--font-sans)' : 'var(--type-body)', color: 'var(--text-strong)' }}>{title}</div>
      {description ? <div style={{ font: 'var(--type-body)', color: 'var(--text-muted)' }}>{description}</div> : null}
    </div>
    {meta ? <div style={{ font: 'var(--type-meta)', letterSpacing: 'var(--ls-meta)', color: 'var(--text-meta)', paddingTop: 3, whiteSpace: 'nowrap' }}>{meta}</div> : null}
  </div>;
}

export function CodeBlock({ code, style }: { code: string; style?: CSSProperties }) {
  const lines = code.replace(/\n$/, '').split('\n');
  const comment = (l: string) => /^\s*(\/\/|\*|\/\*|#)/.test(l);
  return <div style={{ overflow: 'auto', background: 'var(--surface-panel)', ...style }}>
    <pre style={{ margin: 0, padding: '16px 0', font: 'var(--fw-regular) var(--fs-code)/var(--lh-code) var(--font-mono)', color: 'var(--text-strong)' }}>{lines.map((l, i) => <div key={i} style={{ display: 'flex' }}>
      <span style={{ flex: 'none', width: 48, textAlign: 'right', paddingRight: 16, color: 'var(--text-meta)', userSelect: 'none' }}>{i + 1}</span>
      <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0, paddingRight: 16, color: comment(l) ? 'var(--text-muted)' : undefined }}>{l || ' '}</span></div>)}</pre>
  </div>;
}

export function KeyValueRow({ label, value, monoLabel = false }: { label: ReactNode; value: ReactNode; monoLabel?: boolean }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 24, padding: '14px 0', borderBottom: 'var(--rule-hair)' }}>
    <span style={{ whiteSpace: 'nowrap', flex: 'none', font: monoLabel ? 'var(--fw-regular) 14px/1.3 var(--font-mono)' : 'var(--type-body)', color: 'var(--text-strong)' }}>{label}</span>
    <span style={{ minWidth: 0, font: 'var(--type-body)', color: monoLabel ? 'var(--text-strong)' : 'var(--text-muted)', textAlign: 'right', overflowWrap: 'anywhere' }}>{value}</span>
  </div>;
}

export function StatusLabel({ children, size = 'md' }: { children: ReactNode; size?: 'md' | 'lg' }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: size === 'lg' ? 12 : 10, whiteSpace: 'nowrap', font: `var(--fw-regular) ${size === 'lg' ? '18px' : 'var(--fs-body)'}/1 var(--font-sans)`, color: 'var(--text-accent)' }}><Marker size={size === 'lg' ? 11 : 10} />{children}</span>;
}

export function Callout({ title, children, action, style }: { title?: string; children: ReactNode; action?: ReactNode; style?: CSSProperties }) {
  return <div className="callout" style={{ padding: '22px 20px', background: 'var(--surface-callout)', border: '1px solid var(--border-callout)', ...style }}>
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {title ? <div style={{ font: 'var(--fw-regular) 20px/1.25 var(--font-sans)', letterSpacing: '-0.01em', color: 'var(--text-strong)' }}>{title}</div> : null}
      <div style={{ font: 'var(--type-body)', color: 'var(--text-strong)' }}>{children}</div>
    </div>
    {action ? <div style={{ flex: 'none' }}>{action}</div> : null}
  </div>;
}

export function PageTitle({ title, lead, aside, style }: { title: ReactNode; lead?: ReactNode; aside?: ReactNode; style?: CSSProperties }) {
  return <div className="page-title" style={style}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <h1 style={{ margin: 0, font: 'var(--type-display)', letterSpacing: 'var(--ls-display)', color: 'var(--text-strong)', textWrap: 'balance', overflowWrap: 'anywhere' }}>{title}</h1>
      {lead ? <p style={{ margin: '14px 0 0', font: 'var(--type-lead)', color: 'var(--text-muted)', maxWidth: 720, textWrap: 'pretty' }}>{lead}</p> : null}
    </div>
    {aside ? <div style={{ flex: 'none', paddingBottom: 4 }}>{aside}</div> : null}
  </div>;
}

export function SectionHeading({ children, size = 'title', lead, style }: { children: ReactNode; size?: 'title' | 'group' | 'label'; lead?: ReactNode; style?: CSSProperties }) {
  const t = size === 'title';
  const group = size === 'group';
  return <div style={{ paddingBottom: t ? 20 : 14, borderBottom: 'var(--rule-strong)', ...style }}>
    <div style={{ font: t ? 'var(--type-title)' : group ? '500 22px/1.2 var(--font-sans)' : 'var(--type-label)', letterSpacing: t ? 'var(--ls-title)' : group ? '-0.01em' : 0, color: 'var(--text-strong)' }}>{children}</div>
    {lead ? <div style={{ marginTop: 8, font: 'var(--type-body)', color: 'var(--text-muted)' }}>{lead}</div> : null}
  </div>;
}

export function SplitLayout({ children, panel, footer }: { children: ReactNode; panel: ReactNode; footer?: ReactNode }) {
  return <div className="split">
    <main className="split-main">
      <div style={{ flex: 1 }}>{children}</div>
      {footer ? <div className="footer-row">{footer}</div> : null}
    </main>
    <aside className="split-panel">{panel}</aside>
  </div>;
}

export const Push = () => <span className="push" style={{ marginLeft: 'auto' }} />;
export const Mono = ({ children, c = 'var(--ink-3)', s = 13 }: { children: ReactNode; c?: string; s?: number }) => <span className="mono" style={{ font: `400 ${s}px/1.3 var(--font-mono)`, color: c }}>{children}</span>;
export const P = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => <p style={{ color: 'var(--text-muted)', margin: '14px 0', ...style }}>{children}</p>;
