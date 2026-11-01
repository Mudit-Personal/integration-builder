import manifest from '../../src/manifest.ts?raw';
import runtime from '../../src/runtime.ts?raw';

/** The real engine text, so the download runs on its own. */
export const ENGINE_SOURCES = { runtime, manifest };
