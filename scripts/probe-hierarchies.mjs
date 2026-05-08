#!/usr/bin/env node
/**
 * One-off probe — hit each Roon browse hierarchy at level 0 and print
 * what's there. The Roon API docs list these hierarchies:
 *   browse, playlists, settings, internet_radio, albums, artists,
 *   genres, composers, search
 *
 * We've only used `browse` and `search`. The others might surface
 * sort/filter sub-pages (Recently Added / Played / Most Played) that
 * `browse → Library → Albums` doesn't expose.
 *
 *   node scripts/probe-hierarchies.mjs --base http://10.1.10.59:5173
 */

const args = process.argv.slice(2);
let base = 'http://localhost:5173';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base' && args[i + 1]) {
    base = args[i + 1].replace(/\/+$/, '');
    i++;
  }
}

const HIERARCHIES = [
  'browse',
  'playlists',
  'settings',
  'internet_radio',
  'albums',
  'artists',
  'genres',
  'composers',
  'tracks'
];

async function browse(hierarchy) {
  const res = await fetch(`${base}/api/browse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hierarchy,
      multiSessionKey: `probe-${hierarchy}`,
      popAll: true
    })
  });
  if (!res.ok) {
    const body = await res.text();
    return { error: `${res.status} ${body}` };
  }
  return res.json();
}

function summarize(items) {
  return items.slice(0, 12).map((it) => {
    const hint = it.hint ?? '—';
    const itemType = it.itemType ?? '—';
    const sub = it.subtitle ? ` (${it.subtitle})` : '';
    return `  - ${it.title}${sub}  [hint: ${hint}, itemType: ${itemType}]`;
  });
}

for (const hierarchy of HIERARCHIES) {
  process.stderr.write(`\n=== hierarchy: ${hierarchy} ===\n`);
  const r = await browse(hierarchy);
  if (r.error) {
    process.stderr.write(`  ERROR: ${r.error}\n`);
    continue;
  }
  process.stderr.write(`  title: ${r.title}\n`);
  process.stderr.write(`  count: ${r.count}, totalCount: ${r.totalCount}\n`);
  process.stderr.write(`  level: ${r.level}\n`);
  if (r.items && r.items.length) {
    process.stderr.write(`  items (first ${Math.min(r.items.length, 12)} of ${r.items.length}):\n`);
    summarize(r.items).forEach((line) => process.stderr.write(line + '\n'));
  } else {
    process.stderr.write(`  (no items)\n`);
  }
}
