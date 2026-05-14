#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const TOKEN = process.env.COURTLISTENER_TOKEN;
if (!TOKEN) {
  console.error('Missing COURTLISTENER_TOKEN env var.');
  process.exit(1);
}

const BASE = 'https://www.courtlistener.com/api/rest/v4';
const HEADERS = { 'Authorization': `Token ${TOKEN}`, 'User-Agent': 'IALDF-sync-bot' };

const DOCKETS_FILE = 'data/dockets.json';
const OUT_FILE     = 'data/case-updates.json';

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`CourtListener ${res.status} for ${url}`);
  return res.json();
}

async function findDocket(seed) {
  if (seed.docket_id) {
    return fetchJson(`${BASE}/dockets/${seed.docket_id}/`);
  }
  if (!seed.docket_number) return null;
  // Use the dockets list endpoint with direct filters (this works reliably).
  const params = new URLSearchParams({ docket_number: seed.docket_number });
  if (seed.court) params.set('court', seed.court);
  const result = await fetchJson(`${BASE}/dockets/?${params.toString()}`);
  if (result.results && result.results.length > 0) return result.results[0];
  // Fallback: try search endpoint without the court filter
  const fallback = await fetchJson(`${BASE}/dockets/?docket_number=${encodeURIComponent(seed.docket_number)}`);
  return (fallback.results && fallback.results.length > 0) ? fallback.results[0] : null;
}

async function fetchLatestEntries(docketId, limit = 3) {
  try {
    const json = await fetchJson(`${BASE}/docket-entries/?docket=${docketId}&order_by=-entry_number&page_size=${limit}`);
    return json.results || [];
  } catch { return []; }
}

function toCaseCard(seed, docket, entries) {
  return {
    id: seed.id,
    name: seed.name || docket.case_name,
    court: seed.court || docket.court_id,
    docket: seed.docket_number || docket.docket_number,
    status: seed.status || 'PENDING',
    statusDetail: seed.statusDetail || '',
    stage: seed.stage || '',
    category: seed.category || 'Multiple',
    orderDate: seed.orderDate || null,
    filingDate: seed.filingDate || (docket.date_filed || null),
    hearingDate: seed.hearingDate || null,
    summary: seed.summary || '',
    relief: seed.relief || null,
    plaintiffs: seed.plaintiffs || null,
    notable: seed.notable || false,
    courtlistener_url: docket.absolute_url ? `https://www.courtlistener.com${docket.absolute_url}` : null,
    recent_entries: entries.slice(0, 3).map(e => ({
      date_filed: e.date_filed,
      entry_number: e.entry_number,
      description: e.description,
    })),
  };
}

async function main() {
  const seeds = JSON.parse(await fs.readFile(DOCKETS_FILE, 'utf8'));
  const out = [];
  let failed = 0;
  const failures = [];

  for (const seed of seeds) {
    try {
      const docket = await findDocket(seed);
      if (!docket) {
        failures.push(`#${seed.id} ${seed.name} (${seed.docket_number || 'no docket'})`);
        out.push(seed);
        failed++;
        continue;
      }
      const entries = await fetchLatestEntries(docket.id, 3);
      out.push(toCaseCard(seed, docket, entries));
      await new Promise(r => setTimeout(r, 350));
    } catch (e) {
      failures.push(`#${seed.id} ${seed.name}: ${e.message}`);
      out.push(seed);
      failed++;
    }
  }

  if (failures.length) {
    console.log('--- Failed cases ---');
    failures.forEach(f => console.log('  ' + f));
  }

  const result = {
    lastUpdated: new Date().toISOString(),
    source: 'CourtListener REST API v4',
    failed_count: failed,
    total: out.length,
    cases: out,
  };
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(result, null, 2));
  console.log(`Wrote ${OUT_FILE} — ${out.length} cases, ${failed} failed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
