import { loadHistory } from './dataStore.js';
import { checkArtists, normalizeName } from './historyTools.js';
import { spotifyFetch } from './spotifyClient.js';

// Spotify Dev Mode caps search at 10 results per request.
const SEARCH_MAX = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTrack(t) {
  return {
    name: t.name,
    artists: t.artists.map((a) => a.name),
    album: t.album?.name,
    releaseDate: t.album?.release_date,
    uri: t.uri,
  };
}

export async function spotifySearch({ query, type = 'track', limit = SEARCH_MAX }) {
  const n = Math.min(limit, SEARCH_MAX);
  const data = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=${n}`);
  if (type === 'artist') {
    return (data.artists?.items ?? []).filter(Boolean).map((a) => ({ name: a.name, uri: a.uri, url: a.external_urls?.spotify }));
  }
  return (data.tracks?.items ?? []).filter(Boolean).map(formatTrack);
}

/**
 * Turns a list of artist names (brainstormed by Claude) into playable tracks, dropping artists the user already knows.
 * "Knows" = at least `excludeIfPlaysAtLeast` plays in their history; lighter-touch artists are kept (and flagged as
 * sampled), and for them only tracks they have never played are offered.
 */
export async function discoverTracks({ artists, tracksPerArtist = 2, excludeIfPlaysAtLeast = 25 }) {
  const history = await loadHistory();
  if (!history) throw new Error('No listening history found. Run `npm run ingest-history` first.');

  const statuses = await checkArtists({ artists });
  const playedUris = new Set(Object.keys(history.tracks));

  const candidates = [];
  const alreadyKnown = [];
  const noPlayableTracks = [];

  for (const s of statuses) {
    if (s.plays >= excludeIfPlaysAtLeast) {
      alreadyKnown.push({ artist: s.artist, plays: s.plays, status: s.status, lastPlayed: s.lastPlayed });
      continue;
    }

    const wanted = normalizeName(s.artist);
    const results = await spotifySearch({ query: `artist:"${s.artist}"`, type: 'track', limit: SEARCH_MAX });
    await sleep(150);

    const seenNames = new Set();
    const tracks = results
      .filter((t) => t.artists.some((a) => normalizeName(a) === wanted))
      .filter((t) => !playedUris.has(t.uri))
      .filter((t) => {
        const key = t.name.toLowerCase();
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      })
      // Lead-artist tracks first; guest appearances only fill in if there aren't enough.
      .sort((a, b) => Number(normalizeName(b.artists[0]) === wanted) - Number(normalizeName(a.artists[0]) === wanted))
      .slice(0, tracksPerArtist);

    if (tracks.length === 0) {
      noPlayableTracks.push(s.artist);
      continue;
    }
    candidates.push({
      artist: s.artist,
      historyStatus: s.status,
      priorPlays: s.plays,
      tracks,
    });
  }

  return {
    note: 'candidates are artists below the play threshold with tracks the user has never played. alreadyKnown were dropped. Only album-artist credits are tracked in history, so an artist heard solely as a featured guest can look new.',
    excludeIfPlaysAtLeast,
    candidates,
    alreadyKnown,
    noPlayableTracks,
  };
}
