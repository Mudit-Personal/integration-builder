import { sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const HASHES = { sha1, sha256 };

export const createHash = (algorithm: keyof typeof HASHES) => {
  let text = '';
  const hash = {
    update: (chunk: string) => { text += chunk; return hash; },
    digest: (_encoding: 'hex') => bytesToHex(HASHES[algorithm](utf8ToBytes(text))),
  };
  return hash;
};
