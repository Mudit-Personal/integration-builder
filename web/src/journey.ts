export const [SOURCE, READ, DECIDE, CHECKS, CODE, RUN, READY] = [0, 1, 2, 3, 4, 5, 6];

export type Audience = 'developer' | 'business';
export type Journey = {
  label: string;
  blurb: string;
  /** Source's page title and lead. */
  title: [string, string];
  /** Nav label per step index, SOURCE to READY. Null hides the step from the step bar. */
  steps: (string | null)[];
  /** Where a finished read, or opening a known app's docs, lands. */
  afterRead: number;
  /** What happens next, as Source tells it. */
  next: string[];
  deliverables: 'all' | 'outcomes';
  decisions: 'all' | 'asks';
  checks: 'every' | 'verdict';
  handoff: 'code' | 'prompt';
  run: 'technical' | 'people';
};

export const JOURNEYS: Record<Audience, Journey> = {
  developer: {
    label: 'Developer',
    title: ['Connect an API', "Pick a known API or paste a link to its documentation. We'll read it and generate integration code for your app."],
    blurb: 'We show the technical detail and the code first.',
    steps: ['Source', 'Read docs', 'Decisions', 'Checks', 'Code', 'Run', 'Ready'],
    afterRead: READ,
    next: ['We read the documentation and work out how the API is built.', 'You get a list of every decision: what came from the docs, what we chose, what we need from you.', 'We test a simulated copy of the API, built from its docs, with safeguards on and results stored for replay.', 'You get code to drop into your app.'],
    deliverables: 'all', decisions: 'all', checks: 'every', handoff: 'code', run: 'technical',
  },
  business: {
    label: 'Not a developer',
    title: ['Connect an app', "Pick the app, or paste a link to its docs. We'll work out how to read your people from it, safely."],
    blurb: 'We ask only what needs you, in plain words, and hand you a prompt and a summary for your developer.',
    steps: ['Pick the app', null, 'Review', 'Test', 'Hand off', 'Preview', 'Ready'],
    afterRead: DECIDE,
    next: ["We read the app's docs and work out how it works.", 'You choose what data it may read. We handle the rest.', 'We test it on a simulated copy of the app. Nothing touches your real account.', 'You get a prompt and a short summary to hand to your developer.'],
    deliverables: 'outcomes', decisions: 'asks', checks: 'verdict', handoff: 'prompt', run: 'people',
  },
};

export const AUDIENCES = Object.keys(JOURNEYS) as Audience[];

/** Connectors saved before journeys stored the toggle's label. */
export const audienceOf = (saved: string | undefined): Audience => (saved === 'business' || saved === 'Not a developer' ? 'business' : 'developer');

/** The step a Back button returns to, skipping steps the journey hides. */
export const stepBefore = (j: Journey, step: number) => j.steps.slice(0, step).findLastIndex(s => s !== null);
