import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_INPUT_DIR = path.join(DATA_DIR, 'streaming-history-raw', 'Spotify Extended Streaming History');

// Spotify counts a stream after 30s; anything shorter is treated as a skip/sample, not a play.
const PLAY_THRESHOLD_MS = 30_000;

function isSkip(row) {
  if (row.skipped === true) return true;
  return row.reason_end === 'fwdbtn' && row.ms_played < PLAY_THRESHOLD_MS;
}

function bump(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

async function main() {
  const inputDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_INPUT_DIR;
  const files = (await fs.readdir(inputDir))
    .filter((f) => f.startsWith('Streaming_History_Audio_') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`No Streaming_History_Audio_*.json files found in ${inputDir}`);

  const tracks = {};
  const artists = {};
  const yearly = {};
  let totalEvents = 0;
  let musicEvents = 0;
  let nonMusicEvents = 0;
  let firstTs = null;
  let lastTs = null;

  for (const file of files) {
    const rows = JSON.parse(await fs.readFile(path.join(inputDir, file), 'utf-8'));
    for (const row of rows) {
      totalEvents++;
      if (row.ts && (!firstTs || row.ts < firstTs)) firstTs = row.ts;
      if (row.ts && (!lastTs || row.ts > lastTs)) lastTs = row.ts;

      const uri = row.spotify_track_uri;
      if (!uri || !row.master_metadata_track_name) {
        nonMusicEvents++; // podcasts, audiobooks, unmatched
        continue;
      }
      musicEvents++;

      const year = row.ts.slice(0, 4);
      const artist = row.master_metadata_album_artist_name || 'Unknown Artist';
      const counted = row.ms_played >= PLAY_THRESHOLD_MS;
      const skipped = isSkip(row);

      const t = (tracks[uri] ||= {
        name: row.master_metadata_track_name,
        artist,
        album: row.master_metadata_album_album_name,
        plays: 0,
        skips: 0,
        msPlayed: 0,
        firstPlayed: row.ts,
        lastPlayed: row.ts,
        yearlyPlays: {},
        yearlyMs: {},
        yearlyDone: {}, // events that played to the end (reason_end = trackdone)
        yearlySkipEvents: {}, // deliberate moves-on: skipped flag or forward button
      });
      t.msPlayed += row.ms_played;
      if (row.reason_end === 'trackdone') bump(t.yearlyDone, year);
      if (row.skipped === true || row.reason_end === 'fwdbtn') bump(t.yearlySkipEvents, year);
      bump(t.yearlyMs, year, row.ms_played);
      if (counted) {
        t.plays++;
        bump(t.yearlyPlays, year);
      }
      if (skipped) t.skips++;
      if (row.ts < t.firstPlayed) t.firstPlayed = row.ts;
      if (row.ts > t.lastPlayed) t.lastPlayed = row.ts;

      const a = (artists[artist] ||= {
        plays: 0,
        skips: 0,
        msPlayed: 0,
        trackUris: new Set(),
        firstPlayed: row.ts,
        lastPlayed: row.ts,
        yearlyPlays: {},
        yearlyMs: {},
      });
      a.msPlayed += row.ms_played;
      bump(a.yearlyMs, year, row.ms_played);
      if (counted) {
        a.plays++;
        bump(a.yearlyPlays, year);
      }
      if (skipped) a.skips++;
      a.trackUris.add(uri);
      if (row.ts < a.firstPlayed) a.firstPlayed = row.ts;
      if (row.ts > a.lastPlayed) a.lastPlayed = row.ts;

      const y = (yearly[year] ||= { events: 0, plays: 0, skips: 0, msPlayed: 0 });
      y.events++;
      if (counted) y.plays++;
      if (skipped) y.skips++;
      y.msPlayed += row.ms_played;
    }
    console.log(`Processed ${file}`);
  }

  const artistsOut = {};
  for (const [name, a] of Object.entries(artists)) {
    artistsOut[name] = { ...a, uniqueTracks: a.trackUris.size, trackUris: undefined };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    playThresholdMs: PLAY_THRESHOLD_MS,
    source: { files: files.length, totalEvents, musicEvents, nonMusicEvents, firstTs, lastTs },
    yearly,
    artists: artistsOut,
    tracks,
  };

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'listening-history.json'), JSON.stringify(output));
  console.log(
    `\nWrote data/listening-history.json: ${Object.keys(tracks).length} unique tracks, ` +
    `${Object.keys(artists).length} artists, ${musicEvents} music events (${nonMusicEvents} non-music skipped).`
  );
}

main().catch((err) => {
  console.error('ingestHistory failed:', err.message);
  process.exit(1);
});
