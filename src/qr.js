// A QR encoder, because a gift card needs one and this project has no dependencies.
//
// Niobe, 9 Sep 2026: "A QR is also a good idea to implement." A printed card whose holder can
// scan it and see the balance removes the phone call that runs through this entire project —
// but it has to work from a piece of card in somebody's hand, which means it has to be right.
// A QR that scans as the wrong URL, or does not scan at all, is worse than none: the customer
// has already trusted it before they find out.
//
// Byte mode, error correction level M (~15% recoverable), versions 1–10 — which covers any URL
// up to 216 bytes and comfortably fits a balance link. M rather than L because this is printed
// on card that gets carried in a wallet: some of it WILL be scuffed, and L leaves no margin.
//
// Output is SVG, not PNG. It stays crisp at any size, prints at the printer's own resolution
// rather than the image's, and is a few hundred bytes of text — so it can be embedded straight
// into the voucher without a second request or a binary asset to lose.
//
// VERIFIED BY DECODING IT, which is the only test that answers the question actually being
// asked. Every symbol this produces was rendered to a bitmap and read back with OpenCV's
// decoder — versions 1, 3, 4, 6, 8 and 10, several masks, ASCII and UTF-8 — and every one
// returned the exact input string. scripts/test-qr.mjs keeps a dependency-free version of that
// round trip so a future edit cannot quietly break it.
//
// Worth recording why the obvious check was the wrong one: comparing module-for-module against
// another encoder (segno) showed a difference, and the difference was harmless. Padding after
// the data is not uniquely determined — a decoder reads the length from the header and never
// looks at the rest — so two encoders can disagree byte-for-byte and both be correct. A
// reference implementation disagreeing is a question, not a verdict. Decoding is the verdict.

// --- capacity and block structure, error level M, versions 1..10 -------------
// [total codewords, EC codewords per block, [group1 blocks, group1 data cw], [group2...]]
const VERSIONS = {
  1:  { total: 26,  ecPerBlock: 10, groups: [[1, 16]] },
  2:  { total: 44,  ecPerBlock: 16, groups: [[1, 28]] },
  3:  { total: 70,  ecPerBlock: 26, groups: [[1, 44]] },
  4:  { total: 100, ecPerBlock: 18, groups: [[2, 32]] },
  5:  { total: 134, ecPerBlock: 24, groups: [[2, 43]] },
  6:  { total: 172, ecPerBlock: 16, groups: [[4, 27]] },
  7:  { total: 196, ecPerBlock: 18, groups: [[4, 31]] },
  8:  { total: 242, ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  9:  { total: 292, ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  10: { total: 346, ecPerBlock: 26, groups: [[4, 43], [1, 44]] },
};

// Centres of the alignment patterns, per version. v1 has none.
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const dataCapacity = (v) => VERSIONS[v].groups.reduce((n, [b, d]) => n + b * d, 0);

// --- GF(256) arithmetic for Reed-Solomon ------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;          // the QR field polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Generator polynomial for `degree` error-correction codewords.
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    // Coefficients are held in DESCENDING order, so multiplying by (x + a^i) puts the x term
    // at the same index and the constant term one further along. Writing these two the other
    // way round builds the polynomial reversed — which still produces well-formed-looking
    // error correction, and a QR code no scanner will read.
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecCodewords(data, count) {
  const gen = generator(count);
  const rem = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < count; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// --- BCH codes for the format and version information -----------------------
function bch(value, poly, bits) {
  let v = value << (bits - 1);
  const top = 1 << (bits - 1);
  for (let i = value === 0 ? 0 : 31; i >= 0; i--) {
    if (v & (top << i)) v ^= poly << i;
  }
  return v;
}
// Error level M is 0b00. Format = 5 bits (2 level + 3 mask), BCH(15,5), XOR 0x5412.
const formatBits = (mask) => {
  const data = (0b00 << 3) | mask;
  return ((data << 10) | bch(data, 0b10100110111, 11)) ^ 0b101010000010010;
};
const versionBits = (v) => (v << 12) | bch(v, 0b1111100100101, 13);

// --- the 8 data masks -------------------------------------------------------
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// --- building the symbol ----------------------------------------------------
function blankMatrix(size) {
  return {
    m: Array.from({ length: size }, () => new Array(size).fill(null)),   // null = data area
    reserved: Array.from({ length: size }, () => new Array(size).fill(false)),
    size,
  };
}

function placeFunctionPatterns(g, version) {
  const { m, reserved, size } = g;
  const set = (r, c, v) => { m[r][c] = v; reserved[r][c] = true; };

  // Three finder patterns plus their separators.
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = br + r, cc = bc + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        set(rr, cc, inside && (edge || core) ? 1 : 0);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0 ? 1 : 0);
    set(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centres = ALIGN[version];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          set(r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }

  // The dark module, always set, always here.
  set(size - 8, 8, 1);

  // Reserve the format areas so data placement skips them.
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) { m[8][i] = 0; reserved[8][i] = true; }
    if (!reserved[i][8]) { m[i][8] = 0; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) { m[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; }
    if (!reserved[size - 1 - i][8]) { m[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; }
  }

  // Version information blocks, v7 and up.
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      set(r, size - 11 + c, bit);
      set(size - 11 + c, r, bit);
    }
  }
}

function placeData(g, bytes) {
  const { m, reserved, size } = g;
  let bitIndex = 0;
  const nextBit = () => {
    if (bitIndex >= bytes.length * 8) return 0;   // remainder bits are zero
    const bit = (bytes[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
    bitIndex += 1;
    return bit;
  };

  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;                       // the vertical timing column is skipped
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        m[row][c] = nextBit();
      }
    }
    up = !up;
  }
}

// The four penalty rules from the spec. Applied to every mask; lowest total wins.
function penalty(m, size) {
  let score = 0;

  // Rule 1 — runs of five or more of the same colour, in both directions.
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map((row) => row[i])]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) { run += 1; continue; }
        if (run >= 5) score += run - 2;
        run = 1;
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Rule 2 — every 2x2 block of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3 — the finder-like 1:1:3:1:1 pattern with four light modules either side,
  // which is what confuses a scanner into misreading where the symbol is.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, at, pat) => pat.every((v, k) => line[at + k] === v);
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map((row) => row[i])]) {
      for (let j = 0; j + 11 <= size; j++) {
        if (matches(line, j, A) || matches(line, j, B)) score += 40;
      }
    }
  }

  // Rule 4 — deviation from an even balance of dark and light.
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark += 1;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

// Smallest version that holds `len` bytes. The character-count field grows from 8 to 16 bits
// at version 10, so the header cost is version-dependent and has to be worked out per version
// rather than assumed — getting this wrong silently overflows the last codeword.
function pickVersion(len) {
  for (let v = 1; v <= 10; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + len * 8 <= dataCapacity(v) * 8) return v;
  }
  throw new Error(`QR: ${len} bytes is more than version 10 at level M can carry`);
}

export function encode(text) {
  const data = [...new TextEncoder().encode(String(text))];
  const version = pickVersion(data.length);
  const spec = VERSIONS[version];
  const capacity = dataCapacity(version);

  // --- bit stream ---
  const bits = [];
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(0b0100, 4);                                  // byte mode
  push(data.length, version <= 9 ? 8 : 16);
  for (const b of data) push(b, 8);
  // Terminator, then pad to a byte boundary, then the alternating pad bytes.
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }
  for (let i = 0; words.length < capacity; i++) words.push(i % 2 ? 0x11 : 0xec);

  // --- split into blocks, compute EC, interleave ---
  const blocks = [];
  let at = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const chunk = words.slice(at, at + size);
      at += size;
      blocks.push({ data: chunk, ec: ecCodewords(chunk, spec.ecPerBlock) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < spec.ecPerBlock; i++) for (const b of blocks) out.push(b.ec[i]);

  // --- place, mask, score ---
  const size = version * 4 + 17;
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = blankMatrix(size);
    placeFunctionPatterns(g, version);
    placeData(g, out);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!g.reserved[r][c] && MASKS[mask](r, c)) g.m[r][c] ^= 1;
      }
    }
    // Format information, written after masking because it encodes which mask was used.
    const fbits = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const bit = (fbits >> i) & 1;
      // Copy one: down the left column and along the top row, skipping the timing module.
      if (i < 6) g.m[i][8] = bit;
      else if (i < 8) g.m[i + 1][8] = bit;
      else if (i === 8) g.m[8][7] = bit;
      else g.m[8][14 - i] = bit;
      // Copy two, so a damaged corner does not lose the format entirely.
      if (i < 8) g.m[8][size - 1 - i] = bit;
      else g.m[size - 15 + i][8] = bit;
    }
    const score = penalty(g.m, size);
    if (!best || score < best.score) best = { score, m: g.m, mask };
  }

  return { version, size, mask: best.mask, modules: best.m };
}

// An SVG of the symbol. `quiet` is the mandatory light border — four modules by the spec, and
// leaving it out is the single most common reason a printed QR will not scan: the scanner
// cannot find the symbol's edge against whatever the card is sitting on.
export function svg(text, { scale = 4, quiet = 4, dark = '#2b2320', light = '#ffffff' } = {}) {
  const { modules, size } = encode(text);
  const dim = (size + quiet * 2) * scale;
  const rects = [];
  for (let r = 0; r < size; r++) {
    // One <rect> per run of dark modules rather than per module — same picture, a third of
    // the bytes, and it matters when this is inlined into an email.
    let c = 0;
    while (c < size) {
      if (!modules[r][c]) { c += 1; continue; }
      let end = c;
      while (end + 1 < size && modules[r][end + 1]) end += 1;
      rects.push(`<rect x="${(quiet + c) * scale}" y="${(quiet + r) * scale}" width="${(end - c + 1) * scale}" height="${scale}"/>`);
      c = end + 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/><g fill="${dark}">${rects.join('')}</g></svg>`;
}

// SVG as a data: URI, for an <img src>. Email clients are far happier with an <img> than with
// inline <svg>, and this keeps the voucher a single self-contained document.
export function dataUri(text, opts) {
  return `data:image/svg+xml;base64,${Buffer.from(svg(text, opts), 'utf8').toString('base64')}`;
}
