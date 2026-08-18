// isomorphic-git's index-file code calls the global `Buffer`, which browsers
// do not provide. Install the npm `buffer` polyfill before git is used.
import { Buffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;
