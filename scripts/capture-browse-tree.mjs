#!/usr/bin/env node
/**
 * Capture the live Roon browse-hierarchy STRUCTURE into a sanitized
 * artifact under docs/. Run against the deployed service:
 *
 *   node scripts/capture-browse-tree.mjs --base http://<host>:<port>
 *
 * Default capture is structural-only — what entries exist at level 0
 * and at level 1 under `Library`. That is the layer the rail design
 * needs and nothing more. Personal library content (album titles,
 * artist names, playlist names, composer lists, etc.) is NOT
 * captured by default. The base URL is replaced with a stable
 * placeholder so the artifact is safe to commit.
 *
 * Every browse call uses a dedicated `multiSessionKey` so the
 * capture run does not disturb the live UI's main browse stack —
 * Roon's browse hierarchy is per-session, and a `popAll: true` on
 * the default session would clobber whatever the user was browsing
 * when the script was run.
 *
 * Flags:
 *   --base URL                  Service URL to call (default localhost:5173)
 *   --include-content-samples   Also drill level 2 under Library and
 *                               level 1 under non-Library level-0
 *                               containers. Captured artifact will
 *                               include personal content samples and
 *                               must be treated as private (do not
 *                               commit).
 *   --force                     Overwrite an existing same-day artifact.
 *   --help                      Print usage.
 *
 * Output:
 *   docs/roon-browse-tree-<YYYY-MM-DD>.md     human-readable tree
 *   docs/roon-browse-tree-<YYYY-MM-DD>.json   machine-readable copy
 *
 * Item_keys are always redacted to stable shape tokens (`<key:N>`)
 * regardless of mode.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let base = 'http://localhost:5173';
let includeContentSamples = false;
let force = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--base' && args[i + 1]) {
    base = args[i + 1].replace(/\/+$/, '');
    i++;
  } else if (a === '--include-content-samples') {
    includeContentSamples = true;
  } else if (a === '--force') {
    force = true;
  } else if (a === '--help' || a === '-h') {
    console.log(
      'Usage: node scripts/capture-browse-tree.mjs [--base URL]\n' +
        '                                          [--include-content-samples]\n' +
        '                                          [--force]\n\n' +
        'Default mode captures structural data only (level 0 + level 1 under\n' +
        '`Library`). Use --include-content-samples to drill deeper; the resulting\n' +
        'artifact will contain personal library content and must NOT be committed.'
    );
    process.exit(0);
  }
}

// ── Key redactor ─────────────────────────────────────────────────────
const keyMap = new Map();
function redactKey(raw) {
  if (!raw) return null;
  if (!keyMap.has(raw)) keyMap.set(raw, `<key:${keyMap.size + 1}>`);
  return keyMap.get(raw);
}

// ── HTTP helper ──────────────────────────────────────────────────────
// Dedicated multiSessionKey — keeps capture traffic off the user's
// main browse session. Without this, popAll: true would reset
// whatever the live UI was browsing.
const CAPTURE_SESSION_KEY = 'capture-browse-tree';

async function browse(options) {
  const body = { multiSessionKey: CAPTURE_SESSION_KEY, ...options };
  const res = await fetch(`${base}/api/browse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`POST /api/browse → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ── Capture ──────────────────────────────────────────────────────────
function sanitizeItem(item, level, path) {
  return {
    level,
    path,
    title: item.title,
    itemKey: redactKey(item.itemKey),
    hint: item.hint ?? null,
    itemType: item.itemType ?? null,
    subtitle: item.subtitle ?? undefined
  };
}

async function captureChildren(parentItem, level, path) {
  if (!parentItem.itemKey || parentItem.hint !== 'list') return null;
  let result;
  try {
    result = await browse({ hierarchy: 'browse', itemKey: parentItem.itemKey });
  } catch (err) {
    return { error: err.message };
  }
  return {
    title: result.title,
    items: result.items.map((it) => sanitizeItem(it, level, [...path, it.title]))
  };
}

async function main() {
  console.error(`[capture] base=${base}`);
  console.error(
    `[capture] mode=${includeContentSamples ? 'content-samples (PRIVATE)' : 'structural-only (safe)'}`
  );

  // Level 0
  const root = await browse({ hierarchy: 'browse', popAll: true });
  console.error(`[capture] level 0: ${root.items.length} items`);

  const tree = {
    capturedAt: new Date().toISOString(),
    base: '<configured-base>',
    mode: includeContentSamples ? 'content-samples' : 'structural-only',
    level0: {
      title: root.title,
      items: root.items.map((it) => sanitizeItem(it, 0, [it.title]))
    },
    level1: {},
    level2: {}
  };

  // Level 1 — under Library only by default; everything by
  // --include-content-samples. popAll before each iteration so
  // sibling drills always start from the root level (Roon's browse
  // hierarchy is per-session stack-based, and a previous drill
  // leaves the session at the wrong level for the next sibling).
  for (const item of root.items) {
    if (item.hint !== 'list' || !item.itemKey) continue;
    if (!includeContentSamples && item.title !== 'Library') continue;

    console.error(`[capture] level 1: drilling "${item.title}"`);
    await browse({ hierarchy: 'browse', popAll: true });
    const children = await captureChildren(item, 1, [item.title]);
    if (children) tree.level1[item.title] = children;
  }

  // Level 2 — only with --include-content-samples
  if (includeContentSamples) {
    const liveLibrary = root.items.find((it) => it.title === 'Library');
    if (liveLibrary?.itemKey) {
      console.error(`[capture] level 2: drilling Library children`);
      // Roon's browse hierarchy is stack-based per multi-session.
      // The level-1 loop above has left the capture session at the
      // level-1 children of whichever level-0 container was drilled
      // last. Reset to root before re-entering Library so the drill
      // resolves correctly.
      await browse({ hierarchy: 'browse', popAll: true });
      const liveLibraryResult = await browse({
        hierarchy: 'browse',
        itemKey: liveLibrary.itemKey
      });
      for (const child of liveLibraryResult.items) {
        if (child.hint !== 'list' || !child.itemKey) continue;
        console.error(`[capture] level 2: drilling Library/"${child.title}"`);
        // Same reasoning — popAll between siblings to keep each
        // drill rooted from a known level (Library, level 1).
        await browse({ hierarchy: 'browse', popAll: true });
        await browse({ hierarchy: 'browse', itemKey: liveLibrary.itemKey });
        const grand = await captureChildren(child, 2, ['Library', child.title]);
        if (grand) tree.level2[child.title] = grand;
      }
    }
  }

  // ── Render artifacts ───────────────────────────────────────────────
  const date = new Date().toISOString().slice(0, 10);
  const suffix = includeContentSamples ? '-with-content' : '';
  const jsonPath = resolve(`docs/roon-browse-tree-${date}${suffix}.json`);
  const mdPath = resolve(`docs/roon-browse-tree-${date}${suffix}.md`);

  for (const p of [jsonPath, mdPath]) {
    if (existsSync(p) && !force) {
      console.error(
        `[capture] refusing to overwrite ${p} — pass --force to replace`
      );
      process.exit(2);
    }
  }

  writeFileSync(jsonPath, JSON.stringify(tree, null, 2) + '\n');
  writeFileSync(mdPath, renderMarkdown(tree));

  console.error(`[capture] wrote ${mdPath}`);
  console.error(`[capture] wrote ${jsonPath}`);
  console.error(`[capture] redacted ${keyMap.size} item_key values`);
  if (includeContentSamples) {
    console.error(
      `[capture] WARNING: artifact contains personal library content — do NOT commit.`
    );
  }
}

function renderMarkdown(tree) {
  const lines = [];
  lines.push(`# Roon browse tree capture`);
  lines.push('');
  lines.push(`Captured: ${tree.capturedAt}`);
  lines.push(`Source: ${tree.base}`);
  lines.push(`Mode: ${tree.mode}`);
  lines.push('');
  if (tree.mode === 'content-samples') {
    lines.push(
      '> **Private artifact.** Generated with ' +
        '`--include-content-samples`; contains personal library content. ' +
        'Do not commit.'
    );
    lines.push('');
  }
  lines.push('Item keys are redacted to stable shape tokens (`<key:N>`).');
  lines.push('Same raw key → same token across the whole artifact, so');
  lines.push('cross-references are preserved without leaking session state.');
  lines.push('');

  lines.push(`## Level 0 (browse root) — "${tree.level0.title}"`);
  lines.push('');
  lines.push(renderItemTable(tree.level0.items));
  lines.push('');

  for (const [parentLabel, sub] of Object.entries(tree.level1)) {
    lines.push(`## Level 1 — under "${parentLabel}" → "${sub.title}"`);
    lines.push('');
    if (sub.error) {
      lines.push(`_Error: ${sub.error}_`);
    } else {
      lines.push(renderItemTable(sub.items));
    }
    lines.push('');
  }

  for (const [parentLabel, sub] of Object.entries(tree.level2)) {
    lines.push(`## Level 2 — under "Library / ${parentLabel}" → "${sub.title}"`);
    lines.push('');
    if (sub.error) {
      lines.push(`_Error: ${sub.error}_`);
    } else {
      lines.push(renderItemTable(sub.items));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderItemTable(items) {
  if (!items?.length) return '_(empty)_';
  const out = [];
  out.push('| Title | Hint | itemType | Subtitle | Key |');
  out.push('|---|---|---|---|---|');
  for (const it of items) {
    const cell = (v) =>
      v === undefined || v === null || v === '' ? '—' : String(v).replace(/\|/g, '\\|');
    out.push(
      `| ${cell(it.title)} | ${cell(it.hint)} | ${cell(it.itemType)} | ${cell(it.subtitle)} | ${cell(it.itemKey)} |`
    );
  }
  return out.join('\n');
}

main().catch((err) => {
  console.error(`[capture] failed: ${err.message}`);
  process.exit(1);
});
