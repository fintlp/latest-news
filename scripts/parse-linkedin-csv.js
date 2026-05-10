'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CSV parser (handles multiline quoted fields) ─────────────────────────────
function parseCSV(raw) {
  // Strip BOM
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  const rows = [];
  let i = 0;
  const len = raw.length;

  function parseField() {
    if (i < len && raw[i] === '"') {
      i++; // skip opening quote
      let val = '';
      while (i < len) {
        if (raw[i] === '"') {
          if (i + 1 < len && raw[i + 1] === '"') {
            val += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          val += raw[i++];
        }
      }
      return val;
    } else {
      let val = '';
      while (i < len && raw[i] !== ',' && raw[i] !== '\n' && raw[i] !== '\r') {
        val += raw[i++];
      }
      return val;
    }
  }

  function parseRow() {
    const fields = [];
    while (i < len) {
      fields.push(parseField());
      if (i < len && raw[i] === ',') {
        i++;
      } else {
        // end of row
        if (i < len && raw[i] === '\r') i++;
        if (i < len && raw[i] === '\n') i++;
        break;
      }
    }
    return fields;
  }

  // Parse header
  const header = parseRow();
  // Parse data rows
  while (i < len) {
    const row = parseRow();
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = row[idx] || ''; });
      rows.push(obj);
    }
  }
  return rows;
}

// ─── Topic classification ─────────────────────────────────────────────────────
const TOPIC_RULES = [
  {
    label: 'China & EV',
    patterns: ['china', 'chinese', 'byd', 'xpeng', 'nio', 'geely', 'saic', 'nev', 'beijing', 'shanghai', 'caam']
  },
  {
    label: 'ADAS & Autonomous',
    patterns: ['adas', 'autonomous', 'self-driv', 'lidar', 'radar', ' l2 ', ' l3 ', ' l4 ', 'waymo', 'mobileye', 'robotaxi']
  },
  {
    label: 'SDV & Software',
    patterns: ['software-defined', 'sdv', 'e/e', 'cariad', 'autosar', 'eclipse', 'ota', 'over-the-air']
  },
  {
    label: 'Semiconductors',
    patterns: ['semiconductor', 'chip', 'tsmc', 'intel', 'nvidia', 'qualcomm', 'asml', 'foundry', 'fab', 'wafer', 'dram', 'memory chip']
  },
  {
    label: 'Physical AI & Robotics',
    patterns: ['robot', 'humanoid', 'physical ai', 'embodied', 'manipulat', 'gripper', 'optimus']
  },
  {
    label: 'Events & Speaking',
    patterns: ['hannover', 'embedded world', 'ces ', 'mwc', 'auto china', 'iaa', 'car it', 'trade show', 'booth', /hall \d/, /stand \d/]
  },
  {
    label: 'Industry & Manufacturing',
    patterns: ['manufactur', 'industri', 'shopfloor', 'factory', 'production', 'supply chain', 'capgemini']
  }
];

function classifyTopics(text) {
  const lower = text.toLowerCase();
  const matched = [];
  for (const rule of TOPIC_RULES) {
    for (const p of rule.patterns) {
      const hit = p instanceof RegExp ? p.test(lower) : lower.includes(p);
      if (hit) { matched.push(rule.label); break; }
    }
  }
  return matched.length > 0 ? matched : ['Industry & Manufacturing'];
}

// ─── Extract activity ID from permalink ───────────────────────────────────────
function extractId(permalink, index) {
  const m = String(permalink).match(/activity-(\d+)/);
  return m ? m[1] : String(index);
}

// ─── Strip leading emoji characters from a string ─────────────────────────────
function stripLeadingEmojis(s) {
  return s.replace(/^[\p{Emoji}\s]+/u, '').trim();
}

// ─── Transform a CSV row into a post object ───────────────────────────────────
function transformRow(row, index) {
  const text = (row.text || '').trim();
  if (!text) return null;

  // Images — may be newline-separated
  const rawImages = (row.images || '').trim();
  const imageUrls = rawImages
    ? rawImages.split('\n').map(u => u.trim()).filter(Boolean)
    : [];
  const imageUrl = imageUrls[0] || null;

  const videoUrl    = (row.videoUrl    || '').trim() || null;
  const documentUrl = (row.documentUrl || '').trim() || null;

  const likes    = parseInt(row.likes    || '0', 10) || 0;
  const comments = parseInt(row.comments || '0', 10) || 0;
  const shares   = parseInt(row.shares   || '0', 10) || 0;
  const engagement = likes + comments * 3 + shares * 5;

  // Title: first non-empty line, max 120 chars, strip leading emojis
  const firstLine = text.split('\n').find(l => l.trim()) || '';
  let title = stripLeadingEmojis(firstLine).slice(0, 120);
  if (!title) title = text.slice(0, 120);

  const topics = classifyTopics(text);
  const permalink = (row.permalink || '').trim();
  const id = extractId(permalink, index);

  return {
    id,
    permalink,
    title,
    text,
    topics,
    imageUrl,
    imageUrls,
    videoUrl,
    documentUrl,
    likes,
    comments,
    shares,
    engagement,
    publishDate: (row.publishDate || '').trim(),
    source: 'LinkedIn',
    author: 'Peter Fintl'
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const csvPath  = path.join(__dirname, '..', 'LI_POSTS_fintlp_568.csv');
  const outPath  = path.join(__dirname, '..', 'data', 'linkedin-posts.json');

  const raw  = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(raw);

  console.log(`Parsed ${rows.length} CSV rows`);

  const posts = rows
    .map((r, i) => transformRow(r, i))
    .filter(Boolean);

  console.log(`Valid posts: ${posts.length}`);

  // Sort by engagement descending
  posts.sort((a, b) => b.engagement - a.engagement);

  // Topic distribution stats
  const topicCounts = {};
  posts.forEach(p => p.topics.forEach(t => { topicCounts[t] = (topicCounts[t] || 0) + 1; }));
  console.log('Topic distribution:', topicCounts);

  fs.writeFileSync(outPath, JSON.stringify(posts, null, 2), 'utf8');
  console.log(`Written ${posts.length} posts to ${outPath}`);
}

main();
