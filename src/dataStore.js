import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

async function readJson(filename, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, filename), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function loadTopTracks() {
  return readJson('top-tracks.json', []);
}

export async function loadTopArtists() {
  return readJson('top-artists.json', []);
}

export async function loadSavedTracks() {
  return readJson('saved-tracks.json', []);
}

export async function loadPlaylists() {
  return readJson('playlists.json', []);
}

export async function loadPlaylistTracks() {
  return readJson('playlist-tracks.json', {});
}

let historyCache = { mtimeMs: 0, data: null };

/** Aggregated streaming history from `npm run ingest-history`, or null if it hasn't been ingested. */
export async function loadHistory() {
  const file = path.join(DATA_DIR, 'listening-history.json');
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (historyCache.data && historyCache.mtimeMs === stat.mtimeMs) return historyCache.data;
  const data = JSON.parse(await fs.readFile(file, 'utf-8'));
  historyCache = { mtimeMs: stat.mtimeMs, data };
  return data;
}

function normalizeTrack(track, source) {
  return {
    id: track.id,
    name: track.name,
    artists: track.artists.map((a) => (typeof a === 'string' ? a : a.name)),
    album: track.album?.name ?? track.album,
    release_date: track.album?.release_date ?? track.release_date,
    uri: track.uri,
    isrc: track.external_ids?.isrc ?? track.isrc,
    source,
  };
}

/** Merges top tracks, saved tracks, and all playlist tracks into one deduplicated library, keyed by track id. */
export async function loadLibrary() {
  const [topTracks, savedTracks, playlists, playlistTracks] = await Promise.all([
    loadTopTracks(),
    loadSavedTracks(),
    loadPlaylists(),
    loadPlaylistTracks(),
  ]);

  const byId = new Map();

  for (const track of topTracks) {
    byId.set(track.id, normalizeTrack(track, ['top_tracks']));
  }
  for (const entry of savedTracks) {
    const track = entry.track;
    if (!track?.id) continue;
    const existing = byId.get(track.id);
    if (existing) existing.source.push('saved_tracks');
    else byId.set(track.id, normalizeTrack(track, ['saved_tracks']));
  }

  const playlistNameById = new Map(playlists.map((p) => [p.id, p.name]));
  for (const [playlistId, tracks] of Object.entries(playlistTracks)) {
    const playlistName = playlistNameById.get(playlistId) || playlistId;
    for (const track of tracks) {
      const existing = byId.get(track.id);
      if (existing) {
        if (!existing.source.includes('playlist')) existing.source.push('playlist');
        existing.playlists = existing.playlists || [];
        existing.playlists.push(playlistName);
      } else {
        const normalized = normalizeTrack(track, ['playlist']);
        normalized.playlists = [playlistName];
        byId.set(track.id, normalized);
      }
    }
  }

  return [...byId.values()];
}
