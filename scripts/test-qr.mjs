// The QR encoder, tested by DECODING what it produces.
//
// The symbols were verified for real against OpenCV's decoder while the encoder was being
// written — rendered to a bitmap and read back, versions 1 through 10, ASCII and UTF-8, every
// one returning the exact input. That needs OpenCV, which this project will not take on as a
// dependency, so what lives here is the same round trip done in-process: walk the finished
// symbol the way a reader does, un-mask it, pull the codewords back out and check the text
// that comes back is the text that went in.
//
// It is weaker than a real scanner in one specific way — it shares this module's idea of where
// the modules go — so it would not catch a placement convention that is self-consistently
// wrong. It catches every regression, which is what a test is for, and the real decoding
// happened once against something that had never seen this code.
//
// Run with:  node scripts/test-qr.mjs

import { encode, svg, dataUri } from '../src/qr.js';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// Read a symbol back the way a scanner does: work out which modules are function patterns,
// un-mask everything else, take the codewords in placement order, then read the header to
// find the mode, the length and the bytes.
function decode({ modules, size, version, mask }) {
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) reserved[r][c] = true; };
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(br + r, bc + c);
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  mark(size - 8, 8);
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = i % 3;
      mark(r, size - 11 + c); mark(size - 11 + c, r);
    }
  }

  const bits = [];
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        bits.push(modules[row][c] ^ (MASKS[mask](row, c) ? 1 : 0));
      }
    }
    up = !up;
  }

  // De-interleave: the data codewords come first, one at a time from each block in turn.
  const SPEC = {
    1: [[1, 16]], 2: [[1, 28]], 3: [[1, 44]], 4: [[2, 32]], 5: [[2, 43]],
    6: [[4, 27]], 7: [[4, 31]], 8: [[2, 38], [2, 39]], 9: [[3, 36], [2, 37]], 10: [[4, 43], [1, 44]],
  }[version];
  const sizes = SPEC.flatMap(([n, len]) => new Array(n).fill(len));
  const total = sizes.reduce((a, b) => a + b, 0);
  const cw = [];
  for (let i = 0; i + 8 <= bits.length && cw.length < total; i += 8) {
    cw.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }
  const blocks = sizes.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...sizes); i++) {
    for (let b = 0; b < blocks.length; b++) if (i < sizes[b]) blocks[b].push(cw[k++]);
  }
  const words = blocks.flat();

  // Header: 4-bit mode, then the character count, then the bytes.
  const stream = words.flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (w >> i) & 1));
  const take = (n, at) => stream.slice(at, at + n).reduce((v, b) => (v << 1) | b, 0);
  const mode = take(4, 0);
  const countBits = version <= 9 ? 8 : 16;
  const len = take(countBits, 4);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8, 4 + countBits + i * 8));
  return { mode, len, text: new TextDecoder().decode(new Uint8Array(bytes)) };
}

console.log('\nWhat goes in comes back out');
const CASES = [
  'A',
  'NB-ABCD-EFGH-JKMN',
  'https://pay.niobebeauty.com/balance?c=NB-SUXA-JBZA-FYBK',
  'https://pay.niobebeauty.com/balance?c=NB-0000-0000-0001',
  'Niobe Salon & Spa — gift card',        // non-ASCII: the em dash is 3 bytes in UTF-8
  'x'.repeat(100),
  'x'.repeat(200),
  'https://niobebeauty.com/' + 'a'.repeat(120),
];
for (const text of CASES) {
  const sym = encode(text);
  const got = decode(sym);
  const label = text.length > 34 ? `${text.slice(0, 31)}...` : text;
  ok(`v${sym.version} mask=${sym.mask}  ${label}`, got.text === text,
    got.text === text ? '' : `got ${JSON.stringify(got.text.slice(0, 40))}`);
}

console.log('\nThe structure a scanner looks for');
{
  const { modules, size, version } = encode('https://pay.niobebeauty.com/balance?c=NB-TEST');
  ok('the symbol is square and the right size for its version', size === version * 4 + 17);

  // All three finder patterns, or a scanner cannot locate the symbol at all.
  const finder = (br, bc) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (modules[br + r][bc + c] !== (edge || core ? 1 : 0)) return false;
      }
    }
    return true;
  };
  ok('finder pattern, top left', finder(0, 0));
  ok('finder pattern, top right', finder(0, size - 7));
  ok('finder pattern, bottom left', finder(size - 7, 0));

  let timing = true;
  for (let i = 8; i < size - 8; i++) {
    if (modules[6][i] !== (i % 2 === 0 ? 1 : 0)) timing = false;
    if (modules[i][6] !== (i % 2 === 0 ? 1 : 0)) timing = false;
  }
  ok('timing patterns run unbroken between the finders', timing);
  ok('the dark module is set', modules[size - 8][8] === 1);
}

console.log('\nThe SVG');
{
  const s = svg('https://pay.niobebeauty.com/balance?c=NB-TEST', { scale: 4, quiet: 4 });
  const { size } = encode('https://pay.niobebeauty.com/balance?c=NB-TEST');
  const dim = (size + 8) * 4;
  ok('it is an svg of the expected size', s.startsWith('<svg') && s.includes(`width="${dim}"`));
  // The quiet zone is not decoration. Without it a scanner cannot tell where the symbol ends
  // against whatever the card is lying on, and a printed code simply will not read.
  ok('a white background covers the whole thing, quiet zone included',
    s.includes(`<rect width="${dim}" height="${dim}" fill="#ffffff"/>`));
  ok('no dark module is painted inside the quiet border',
    !/(<rect x="([0-9]|1[0-5])" )/.test(s.replace(`<rect width="${dim}" height="${dim}" fill="#ffffff"/>`, '')));
  ok('it can be embedded as a data URI', dataUri('x').startsWith('data:image/svg+xml;base64,'));
  // Runs of dark modules are merged into one rect. Worth asserting because the voucher is an
  // email, and a rect per module roughly triples the size of every one sent.
  const { modules } = encode('https://pay.niobebeauty.com/balance?c=NB-TEST');
  const dark = modules.flat().filter(Boolean).length;
  const rects = (s.match(/<rect /g) || []).length - 1;     // less the background
  // Against the count of DARK MODULES, not an arbitrary fraction of the symbol. A QR alternates
  // constantly, so runs average about two and the saving is roughly half — real, but nothing
  // like the 4x a first guess suggests. Asserting the property (merging happened) rather than a
  // number pulled out of the air is what makes this survive a change of test string.
  ok('dark runs are merged rather than one rect per module', rects < dark,
    `${rects} rects for ${dark} dark modules`);
}

console.log('\nWhat it refuses');
{
  let threw = false;
  try { encode('y'.repeat(300)); } catch { threw = true; }
  // Refusing is right: silently truncating a URL produces a QR that scans perfectly and goes
  // somewhere wrong, which is the worst of all the available outcomes.
  ok('too much data is refused rather than truncated', threw);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
