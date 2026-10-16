// Data-agnostic sanity checks. Run with `npm run check` after `npm run ingest-history`.
// Test inputs are derived from YOUR data (your top artist, your first year, ...), so nothing here assumes whose it is.
// The live-Spotify section runs only if you've already run `npm run auth`.
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadHistory } from '../src/dataStore.js';
import {
  topArtists, yearlyTopArtists, artistHistory, tasteDrift, discoveries,
  selectTracks, forgottenFavorites, checkArtists, mostFinishedTracks,
} from '../src/historyTools.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (msg) => { passed++; console.log('OK:', msg); };

const history = await loadHistory();
assert.ok(history, 'No data/listening-history.json. Unzip your export into data/streaming-history-raw/ and run `npm run ingest-history`.');
const years = Object.keys(history.yearly).map(Number).sort((a, b) => a - b);
const [firstYear, lastYear] = [years[0], years.at(-1)];
console.log(`History: ${history.source.firstTs.slice(0, 10)} -> ${history.source.lastTs.slice(0, 10)}, ${history.source.musicEvents} music events\n`);

// --- the aggregates must reconcile with each other ---
const all = await topArtists({ limit: 100000 });
const yearlyPlays = Object.values(history.yearly).reduce((s, y) => s + y.plays, 0);
assert.equal(all.totalPlays, yearlyPlays, 'artist plays should sum to yearly plays');
ok(`${yearlyPlays} counted plays reconcile across artists and years`);

const first = await topArtists({ fromYear: firstYear, toYear: firstYear, limit: 1 });
assert.equal(first.totalPlays, history.yearly[firstYear].plays, 'first-year artist plays should equal the yearly total');
ok(`${firstYear} period total reconciles`);

// --- per-artist consistency, using your own #1 artist ---
const top = all.artists[0];
const detail = await artistHistory({ artist: top.artist.toUpperCase() });
assert.equal(detail.artist, top.artist, 'artist lookup is case-insensitive');
assert.equal(detail.totalPlays, top.plays);
assert.equal(detail.yearly.reduce((s, y) => s + y.plays, 0), detail.totalPlays, 'yearly plays should sum to the total');
ok(`${top.artist}: ${detail.totalPlays} plays reconcile year by year`);

const [status] = await checkArtists({ artists: [top.artist.toLowerCase()] });
assert.equal(status.status, 'favorite');
const [nobody] = await checkArtists({ artists: ['zzz no such artist 12345'] });
assert.equal(nobody.status, 'never_played');
ok('check_artists: your top artist is a "favorite", a made-up one is "never_played"');

// --- track pickers return playable URIs and honor their filters ---
const sel = await selectTracks({ artists: [top.artist], limit: 10 });
assert.ok(sel.tracks.length > 0);
for (const t of sel.tracks) assert.match(t.uri, /^spotify:track:[A-Za-z0-9]{22}$/);
assert.ok(sel.tracks.every((t, i, a) => i === 0 || a[i - 1].plays >= t.plays), 'sorted by plays');
const capped = await selectTracks({ limit: 200, maxPerArtist: 1 });
assert.equal(new Set(capped.tracks.map((t) => t.artist)).size, capped.tracks.length, 'maxPerArtist=1 gives distinct artists');
ok('select_tracks: valid URIs, sorted, per-artist cap respected');

const ff = await forgottenFavorites({ limit: 20 });
const cutoff = ff.criteria.match(/none since (\S+)/)[1];
for (const t of ff.tracks) assert.ok(t.lastPlayed < cutoff, 'forgotten favorites must be older than the cutoff');
ok(`forgotten_favorites: ${ff.totalMatches} matches, all older than ${cutoff}`);

const mf = await mostFinishedTracks({ minCompletions: 3, limit: 20 });
for (const t of mf.tracks) assert.ok(t.skipRatePct >= 0 && t.skipRatePct <= 100);
ok(`most_finished_tracks: ${mf.totalMatches} candidates in ${mf.period.from}-${mf.period.to}`);

// --- comparisons run and return sane shapes ---
if (years.length >= 2) {
  const mid = years[Math.floor(years.length / 2)];
  const drift = await tasteDrift({ fromYearA: firstYear, toYearA: mid, fromYearB: mid, toYearB: lastYear, minPlays: 5 });
  assert.ok(Array.isArray(drift.risers) && Array.isArray(drift.newInB));
  ok(`taste_drift ${firstYear}-${mid} vs ${mid}-${lastYear}`);
}
assert.equal((await yearlyTopArtists({ limit: 1 })).length, years.length);
const disc = await discoveries({ minPlays: 5, limit: 5 });
assert.ok(disc.note.includes(history.source.firstTs.slice(0, 10)), 'discoveries note should cite your data start date');
ok('yearly_top_artists and discoveries');

// --- bad input is rejected, not silently accepted ---
await assert.rejects(() => topArtists({ fromYear: lastYear, toYear: firstYear }), /after toYear/);
await assert.rejects(() => artistHistory({ artist: 'zzz no such artist 12345' }), /No artist named/);
ok('inverted year range and unknown artist are rejected');

// --- end to end through the real MCP protocol ---
const transport = new StdioClientTransport({ command: 'node', args: [path.join(root, 'src', 'mcpServer.js')], stderr: 'pipe' });
let serverErr = '';
transport.stderr?.on('data', (d) => { serverErr += d; });
const client = new Client({ name: 'self-check', version: '1.0.0' });
let tools;
try {
  await client.connect(transport);
  ({ tools } = await client.listTools());
} catch (err) {
  console.error('MCP server failed to start or respond:', err.message);
  console.error('Server output:\n' + serverErr);
  console.error('Tip: run `node src/mcpServer.js` directly to see the error.');
  process.exit(1);
}
const expected = ['search_songs', 'get_taste_profile', 'find_similar_tracks', 'compare_playlists', 'get_listening_trends', 'list_playlists', 'create_playlist',
  'top_artists', 'yearly_top_artists', 'artist_history', 'taste_drift', 'discoveries', 'select_tracks', 'forgotten_favorites',
  'check_artists', 'most_finished_tracks', 'spotify_search', 'discover_tracks'];
for (const name of expected) assert.ok(tools.some((t) => t.name === name), `MCP server is missing tool ${name}`);
assert.equal(tools.length, expected.length);
ok(`MCP server exposes all ${tools.length} tools`);

async function call(name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? '';
    return res.isError ? { error: text } : { data: JSON.parse(text) };
  } catch (err) {
    return { error: err.message };
  }
}
const viaMcp = await call('top_artists', { limit: 3 });
assert.equal(viaMcp.data.artists[0].artist, top.artist);
assert.ok((await call('select_tracks', { notPlayedSince: 'last tuesday' })).error, 'malformed date rejected by the tool schema');
assert.ok((await call('top_artists', { fromYear: 1850 })).error, 'implausible year rejected by the tool schema');
ok('tools work over MCP and the schemas reject bad input');
await client.close();

// --- live Spotify (optional) ---
if (fs.existsSync(path.join(root, 'data', 'tokens.json'))) {
  const { spotifySearch, discoverTracks } = await import('../src/discoverTools.js');
  const found = await spotifySearch({ query: `artist:"${top.artist}"`, limit: 50 });
  assert.ok(found.length > 0 && found.length <= 10, 'search results are clamped to 10');
  const rec = await discoverTracks({ artists: [top.artist, 'zzz no such artist 12345'] });
  assert.ok(rec.alreadyKnown.some((a) => a.artist === top.artist), 'your #1 artist should be dropped as already known');
  assert.ok(rec.noPlayableTracks.includes('zzz no such artist 12345'));
  ok('live Spotify: search works and discover_tracks drops artists you already know');
} else {
  console.log('SKIP: live Spotify checks (run `npm run auth` first to enable them)');
}

console.log(`\nAll ${passed} checks passed.`);
