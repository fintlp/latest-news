'use strict';

/**
 * Derives data/press.json — the auto-updating half of the "In the press"
 * section — from data/linkedin-posts.json.
 *
 * Why LinkedIn is the source: it is the only record that reliably says "I was
 * actually quoted here". The Latest Coverage feed is a name search and mostly
 * returns topic news; data/featured-media.json is hand-curated and goes stale.
 *
 * Why we link to the LinkedIn post rather than the article: of the ~100 media
 * posts, only a handful carry a direct article URL. Most carry an lnkd.in
 * short link, which sits behind a reCAPTCHA and cannot be resolved
 * programmatically. A post permalink always resolves, and it is where the
 * commentary on the coverage lives. Where a direct article URL *is* present,
 * we prefer it.
 *
 * featured-media.json stays as the pinned head of the section (entries with
 * "pinned": true) — marquee items that should sit on top regardless of date.
 *
 * Run via: node scripts/build-press.js  (or npm run build:press)
 *   --dry   print the derived entries instead of writing the file
 */

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const IN_FILE  = path.join(ROOT, 'data', 'linkedin-posts.json');
const OUT_FILE = path.join(ROOT, 'data', 'press.json');

// How many derived cards to emit. Sits below the pinned entries, so the
// rendered section is this plus however many are pinned.
const MAX_ENTRIES = 9;

// ─── Outlets ─────────────────────────────────────────────────────────────────
// canonical name → regex matching how it shows up in post text. Order matters:
// first match wins, so put the more specific patterns first.
const OUTLETS = [
  ['Tagesschau',                    /\b(tagesschau|ARD[- ]aktuell)\b/i],
  ['ARD',                           /\bARD\b/],
  ['ORF',                           /\bORF\b|Zeit im Bild/i],
  ['Deutsche Welle',                /\b(deutsche welle|DW[ -]?(news|TV)?)\b/i],
  ['Handelsblatt',                  /\bhandelsblatt\b/i],
  ['Süddeutsche Zeitung',           /\bs(ü|ue)ddeutsche\b/i],
  ['Frankfurter Allgemeine Zeitung',/\b(frankfurter allgemeine|F\.A\.Z\.|FAZ)\b/i],
  ['Neue Zürcher Zeitung',          /\b(neue z(ü|ue)rcher|NZZ)\b/i],
  ['WirtschaftsWoche',              /\bwirtschaftswoche\b/i],
  ['Automobilwoche',                /\bautomobilwoche\b/i],
  ['Automobil Industrie',           /\bautomobil[- ]industrie\b/i],
  ['Table.Briefings',               /\btable\.?(briefings|media)\b/i],
  ['Münchner Merkur',               /\b(m(ü|ue)nchner )?merkur\b/i],
  ['firmenauto',                    /\bfirmenauto\b/i],
  ['electrive',                     /\belectrive\b/i],
  ['Reuters',                       /\breuters\b/i],
  ['Bloomberg',                     /\bbloomberg\b/i],
  ['Capital',                       /\bcapital\b/i],
];

// Phrases that mark a post as "I was in the media", rather than "here is an
// article I read". Without one of these, naming an outlet is not enough.
const CUE = /(featured|interview|quoted|zitiert|im Gespräch|my comment|I was invited|had the (pleasure|privilege|honou?r)|I was allowed|spoke (with|to)|contributed)/i;

// ─── Text cleaning ───────────────────────────────────────────────────────────

// LinkedIn posts often use Mathematical Alphanumeric Symbols (U+1D400–U+1D7FF)
// for fake bold/italic. Those render as tofu in most UI fonts and break search,
// so fold them back to ASCII.
function foldMathAlphanumerics(s) {
  return s.replace(/[\u{1D400}-\u{1D7FF}]/gu, ch => {
    const cp = ch.codePointAt(0);
    const blocks = [
      [0x1D400, 26, 'A'], [0x1D41A, 26, 'a'], [0x1D434, 26, 'A'], [0x1D44E, 26, 'a'],
      [0x1D468, 26, 'A'], [0x1D482, 26, 'a'], [0x1D49C, 26, 'A'], [0x1D4B6, 26, 'a'],
      [0x1D4D0, 26, 'A'], [0x1D4EA, 26, 'a'], [0x1D504, 26, 'A'], [0x1D51E, 26, 'a'],
      [0x1D538, 26, 'A'], [0x1D552, 26, 'a'], [0x1D56C, 26, 'A'], [0x1D586, 26, 'a'],
      [0x1D5A0, 26, 'A'], [0x1D5BA, 26, 'a'], [0x1D5D4, 26, 'A'], [0x1D5EE, 26, 'a'],
      [0x1D608, 26, 'A'], [0x1D622, 26, 'a'], [0x1D63C, 26, 'A'], [0x1D656, 26, 'a'],
      [0x1D670, 26, 'A'], [0x1D68A, 26, 'a'],
    ];
    for (const [start, len, base] of blocks) {
      if (cp >= start && cp < start + len) {
        return String.fromCharCode(base.charCodeAt(0) + (cp - start));
      }
    }
    if (cp >= 0x1D7CE && cp <= 0x1D7FF) return String((cp - 0x1D7CE) % 10);
    return '';
  });
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

function clean(s) {
  return foldMathAlphanumerics(String(s || ''))
    .replace(EMOJI, ' ')
    .replace(/#(\w)/g, '$1')          // #chipshortage → chipshortage
    .replace(/https?:\/\/\S+/g, ' ')  // URLs never belong in display copy
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')  // stripping emoji can strand punctuation
    .replace(/([(“„])\s+/g, '$1')     // opening delimiters only — a straight
                                      // quote here would eat the space after a
                                      // *closing* quote too
    .trim();
}

// Trims matched wrapping quotes so a headline quoted in the post doesn't come
// out of the pipeline still wearing them.
function unwrapQuotes(s) {
  const m = s.match(/^["“„'](.+)["“”']$/);
  return m ? m[1].trim() : s;
}

// Splits cleaned text into sentence-ish chunks so we can take a headline and a
// summary without cutting mid-word.
function sentences(s) {
  return s.split(/(?<=[.!?…])\s+|(?<=[.!?…])(?=[A-ZÄÖÜ])/)
          .map(x => x.trim())
          .filter(Boolean);
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at  = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:–—-]$/, '').trim() + '…';
}

// ─── Field derivation ────────────────────────────────────────────────────────

// LinkedIn activity IDs carry a millisecond timestamp in their high bits. The
// export's own publishDate is relative ("4yr"), so this is the only real date.
function dateFromId(id) {
  try {
    const d = new Date(Number(BigInt(id) >> 22n));
    return d.getFullYear() > 2000 && d.getFullYear() < 2100 ? d : null;
  } catch { return null; }
}

function inferType(text, outlet) {
  if (/\b(live on air|live interview|on air|broadcast|TV interview|im fernsehen)\b/i.test(text)
      || /^(Tagesschau|ARD|ORF|Deutsche Welle)$/.test(outlet)) return 'TV Interview';
  if (/\bpodcast\b/i.test(text))  return 'Podcast';
  if (/\binterview\b/i.test(text)) return 'Interview';
  return 'Expert Commentary';
}

function pickUrl(rawText, permalink) {
  const urls = (String(rawText || '').match(/https?:\/\/[^\s")\]<]+/g) || [])
    .map(u => u.replace(/[.,;:]+$/, ''));
  // A direct article link is better than the post; lnkd.in is behind a
  // reCAPTCHA and linkedin.com/* is just the post by another name.
  const direct = urls.find(u => !/lnkd\.in|linkedin\.com/i.test(u));
  if (direct) return { url: direct, linksTo: 'article' };
  if (permalink) return { url: String(permalink).split('?')[0], linksTo: 'post' };
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function build() {
  const posts = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
  const out = [];

  for (const p of posts) {
    const raw = `${p.text || ''} ${p.title || ''}`;
    const flat = raw.replace(/\s+/g, ' ');
    if (!CUE.test(flat)) continue;

    const found = OUTLETS.find(([, re]) => re.test(flat));
    if (!found) continue;

    // Require the outlet name and the cue phrase to sit near each other.
    // Without this, any post that happens to mention Handelsblatt anywhere and
    // says "interview" anywhere else gets miscounted as an appearance.
    const oAt = flat.search(found[1]);
    const cAt = flat.search(CUE);
    if (oAt < 0 || cAt < 0 || Math.abs(oAt - cAt) > 220) continue;

    const date = dateFromId(p.id);
    if (!date) continue;

    const link = pickUrl(raw, p.permalink);
    if (!link) continue;

    const body = clean(raw);
    if (body.length < 60) continue;          // too thin to make a card from

    // A post that opens on a bare statistic ("834,000 jobs in 2018.") gives a
    // useless headline on its own, so keep absorbing sentences until there is
    // enough to read.
    const parts = sentences(body);
    let take = 1;
    while (take < parts.length && parts.slice(0, take).join(' ').length < 30) take++;

    const title = truncate(unwrapQuotes(parts.slice(0, take).join(' ')), 95);
    const rest  = parts.slice(take).join(' ');
    const summary = truncate(rest || body, 190);
    if (!summary || summary.length < 40) continue;

    out.push({
      outlet:   found[0],
      type:     inferType(flat, found[0]),
      title,
      date:     date.toISOString().slice(0, 10),
      summary,
      url:      link.url,
      linksTo:  link.linksTo,
      source:   'linkedin',
      postId:   p.id,
    });
  }

  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // One card per outlet+date, so a run of posts about one appearance collapses.
  const seen = new Set();
  const deduped = out.filter(e => {
    const k = `${e.outlet}|${e.date}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return deduped.slice(0, MAX_ENTRIES);
}

const entries = build();

if (process.argv.includes('--dry')) {
  entries.forEach((e, i) => {
    console.log(`\n${i + 1}. [${e.outlet}] ${e.date}  (${e.type}, →${e.linksTo})`);
    console.log(`   T: ${e.title}`);
    console.log(`   S: ${e.summary}`);
    console.log(`   U: ${e.url}`);
  });
  console.log(`\n${entries.length} entries (dry run — nothing written)`);
} else {
  fs.writeFileSync(OUT_FILE, JSON.stringify(entries, null, 2) + '\n');
  console.log(`✓ data/press.json — ${entries.length} entries`);
}
