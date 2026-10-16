import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spotifyFetch } from './spotifyClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

async function fetchTopTracks(limit = 50) {
  const data = await spotifyFetch(`/me/top/tracks?limit=${limit}&time_range=medium_term`);
  return data.items;
}

async function fetchTopArtists(limit = 50) {
  const data = await spotifyFetch(`/me/top/artists?limit=${limit}&time_range=medium_term`);
  return data.items;
}

async function fetchSavedTracks(cap = 200) {
  const items = [];
  let offset = 0;
  const pageSize = 50;
  while (items.length < cap) {
    const data = await spotifyFetch(`/me/tracks?limit=${pageSize}&offset=${offset}`);
    items.push(...data.items);
    if (!data.next || data.items.length === 0) break;
    offset += pageSize;
  }
  return items.slice(0, cap);
}

async function fetchAllPlaylists() {
  const items = [];
  let offset = 0;
  const pageSize = 50;
  while (true) {
    const data = await spotifyFetch(`/me/playlists?limit=${pageSize}&offset=${offset}`);
    items.push(...data.items);
    if (!data.next || data.items.length === 0) break;
    offset += pageSize;
  }
  return items;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimPlaylistTrack(item) {
  const track = item.item;
  if (!track || !track.id || track.type !== 'track') return null;
  return {
    id: track.id,
    name: track.name,
    artists: track.artists.map((a) => a.name),
    album: track.album?.name,
    release_date: track.album?.release_date,
    added_at: item.added_at,
    uri: track.uri,
    isrc: track.external_ids?.isrc,
  };
}

async function spotifyFetchWithRetry(endpoint, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await spotifyFetch(endpoint);
    } catch (err) {
      if (attempt === attempts) throw err;
      const backoffMs = 500 * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }
}

async function fetchPlaylistTracks(playlistId) {
  const items = [];
  let offset = 0;
  const pageSize = 100;
  while (true) {
    const data = await spotifyFetchWithRetry(`/playlists/${playlistId}/items?limit=${pageSize}&offset=${offset}`);
    items.push(...data.items.map(trimPlaylistTrack).filter(Boolean));
    if (!data.next || data.items.length === 0) break;
    offset += pageSize;
  }
  return items;
}

async function fetchAllPlaylistTracks(playlists) {
  const result = {};
  for (const playlist of playlists) {
    try {
      result[playlist.id] = await fetchPlaylistTracks(playlist.id);
    } catch (err) {
      console.warn(`Skipping tracks for playlist "${playlist.name}" (${playlist.id}): ${err.message}`);
      result[playlist.id] = [];
    }
    await sleep(250);
  }
  return result;
}

async function writeJson(filename, data) {
  await fs.writeFile(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
  console.log(`Saved to ${DATA_DIR}/${filename}`);
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  console.log('Pulling top tracks...');
  const topTracks = await fetchTopTracks(50);
  console.log(`Fetched ${topTracks.length} top tracks.`);
  await writeJson('top-tracks.json', topTracks);

  console.log('Pulling top artists...');
  const topArtists = await fetchTopArtists(50);
  console.log(`Fetched ${topArtists.length} top artists (Spotify's own genres/popularity fields are stripped for this app).`);
  await writeJson('top-artists.json', topArtists);

  console.log('Pulling saved (liked) tracks...');
  const savedTracks = await fetchSavedTracks(200);
  console.log(`Fetched ${savedTracks.length} saved tracks.`);
  await writeJson('saved-tracks.json', savedTracks);

  console.log('Pulling playlists...');
  const playlists = await fetchAllPlaylists();
  console.log(`Fetched ${playlists.length} playlists.`);
  await writeJson('playlists.json', playlists);

  console.log('Pulling track listings for each playlist...');
  const playlistTracks = await fetchAllPlaylistTracks(playlists);
  const totalPlaylistTracks = Object.values(playlistTracks).reduce((sum, t) => sum + t.length, 0);
  console.log(`Fetched ${totalPlaylistTracks} playlist-track entries across ${playlists.length} playlists.`);
  await writeJson('playlist-tracks.json', playlistTracks);

  console.log('\n--- Data shape summary ---');
  console.log(`Top tracks: ${topTracks.length} (fields: ${Object.keys(topTracks[0] || {}).join(', ')})`);
  console.log(`Top artists: ${topArtists.length} (fields: ${Object.keys(topArtists[0] || {}).join(', ')})`);
  console.log(`Saved tracks: ${savedTracks.length} (fields: ${Object.keys(savedTracks[0]?.track || {}).join(', ')})`);
  console.log(`Playlists: ${playlists.length} (fields: ${Object.keys(playlists[0] || {}).join(', ')})`);

  const missingIds = topTracks.filter((t) => !t.id).length;
  if (missingIds > 0) {
    console.warn(`Warning: ${missingIds} top tracks are missing an id.`);
  }
}

main().catch((err) => {
  console.error('fetchData failed:', err.message);
  process.exit(1);
});
