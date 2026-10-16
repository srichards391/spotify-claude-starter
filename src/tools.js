import { loadLibrary, loadTopArtists, loadPlaylists, loadPlaylistTracks, loadHistory } from './dataStore.js';
import { topArtists as historyTopArtists } from './historyTools.js';
import { spotifyFetch } from './spotifyClient.js';

function releaseYear(releaseDate) {
  const year = parseInt(String(releaseDate).slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

export async function searchSongs({ query, limit = 20 }) {
  const library = await loadLibrary();
  const q = query.toLowerCase();
  const matches = library.filter((track) =>
    track.name.toLowerCase().includes(q) ||
    track.artists.some((a) => a.toLowerCase().includes(q)) ||
    (track.album && track.album.toLowerCase().includes(q))
  );
  return matches.slice(0, limit);
}

export async function getTasteProfile() {
  const [library, topArtists] = await Promise.all([loadLibrary(), loadTopArtists()]);

  const artistCounts = new Map();
  const eraCounts = new Map();
  for (const track of library) {
    for (const artist of track.artists) {
      artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
    }
    const year = releaseYear(track.release_date);
    if (year) {
      const decade = `${Math.floor(year / 10) * 10}s`;
      eraCounts.set(decade, (eraCounts.get(decade) || 0) + 1);
    }
  }

  const topArtistsByLibraryFrequency = [...artistCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([artist, count]) => ({ artist, trackCount: count }));

  const eraDistribution = [...eraCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const profile = {
    librarySize: library.length,
    topArtistsBySpotifyRanking: topArtists.slice(0, 20).map((a) => a.name),
    topArtistsByLibraryFrequency,
    eraDistribution,
    note: 'No genre/audio-feature data is available from Spotify for this app — infer style/genre from artist and track names using your own knowledge. topArtistsByLibraryFrequency counts tracks sitting in saved lists and playlists (it is inflated by shared/family playlists), not listening.',
  };

  const history = await loadHistory();
  if (history) {
    const lastYear = Math.max(...Object.keys(history.yearly).map(Number));
    const [allTime, recent] = await Promise.all([
      historyTopArtists({ limit: 20 }),
      historyTopArtists({ fromYear: lastYear - 1, toYear: lastYear, limit: 15 }),
    ]);
    profile.listeningHistory = {
      span: { firstPlay: history.source.firstTs.slice(0, 10), lastPlay: history.source.lastTs.slice(0, 10) },
      totalCountedPlays: allTime.totalPlays,
      allTimeTopArtists: allTime.artists,
      recentTopArtists: { period: recent.period, artists: recent.artists },
      note: 'Based on actual play counts (streams of 30s+) over the full history — a far more reliable taste signal than the library-frequency list above. Use top_artists, yearly_top_artists, taste_drift, discoveries, artist_history, select_tracks and forgotten_favorites to dig deeper.',
    };
  }

  return profile;
}

export async function findSimilarTracks({ trackId, limit = 10 }) {
  const library = await loadLibrary();
  const reference = library.find((t) => t.id === trackId);
  if (!reference) {
    throw new Error(`Track ${trackId} not found in local library. Run search_songs first to find a valid track id.`);
  }

  const scored = library
    .filter((t) => t.id !== trackId)
    .map((t) => {
      let score = 0;
      if (t.artists.some((a) => reference.artists.includes(a))) score += 3;
      const sharedPlaylists = (t.playlists || []).filter((p) => (reference.playlists || []).includes(p));
      score += sharedPlaylists.length;
      const yearRef = releaseYear(reference.release_date);
      const yearT = releaseYear(t.release_date);
      if (yearRef && yearT && Math.abs(yearRef - yearT) <= 2) score += 1;
      return { track: t, score, sharedPlaylists };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    reference: { id: reference.id, name: reference.name, artists: reference.artists },
    similar: scored.map((s) => ({
      id: s.track.id,
      name: s.track.name,
      artists: s.track.artists,
      score: s.score,
      reason: s.score >= 3 ? 'same artist' : s.sharedPlaylists.length > 0 ? `co-occurs in: ${s.sharedPlaylists.join(', ')}` : 'similar era',
    })),
  };
}

export async function comparePlaylists({ playlistId1, playlistId2 }) {
  const [playlists, playlistTracks] = await Promise.all([loadPlaylists(), loadPlaylistTracks()]);
  const nameById = new Map(playlists.map((p) => [p.id, p.name]));
  const tracks1 = playlistTracks[playlistId1] || [];
  const tracks2 = playlistTracks[playlistId2] || [];

  const ids1 = new Set(tracks1.map((t) => t.id));
  const ids2 = new Set(tracks2.map((t) => t.id));
  const sharedTracks = tracks1.filter((t) => ids2.has(t.id));

  const artists1 = new Set(tracks1.flatMap((t) => t.artists));
  const artists2 = new Set(tracks2.flatMap((t) => t.artists));
  const sharedArtists = [...artists1].filter((a) => artists2.has(a));

  return {
    playlist1: { id: playlistId1, name: nameById.get(playlistId1) || playlistId1, trackCount: tracks1.length },
    playlist2: { id: playlistId2, name: nameById.get(playlistId2) || playlistId2, trackCount: tracks2.length },
    sharedTrackCount: sharedTracks.length,
    sharedTracks: sharedTracks.map((t) => ({ id: t.id, name: t.name, artists: t.artists })),
    sharedArtists,
  };
}

export async function getListeningTrends() {
  const library = await loadLibrary();

  const bySource = { top_tracks: [], saved_tracks: [], playlist: [] };
  for (const track of library) {
    for (const source of track.source) {
      if (bySource[source]) bySource[source].push(track);
    }
  }

  function eraHistogram(tracks) {
    const counts = new Map();
    for (const t of tracks) {
      const year = releaseYear(t.release_date);
      if (!year) continue;
      const decade = `${Math.floor(year / 10) * 10}s`;
      counts.set(decade, (counts.get(decade) || 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }

  return {
    currentTopTracksEra: eraHistogram(bySource.top_tracks),
    savedTracksEra: eraHistogram(bySource.saved_tracks),
    playlistTracksEra: eraHistogram(bySource.playlist),
    note: 'Compares release-era distribution across your current top tracks (recent affinity) vs your full saved library (broader history) vs playlist contents.',
  };
}

export async function listPlaylists() {
  const [playlists, playlistTracks] = await Promise.all([loadPlaylists(), loadPlaylistTracks()]);
  return playlists.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    owner: p.owner?.display_name || p.owner?.id,
    collaborative: p.collaborative,
    trackCount: (playlistTracks[p.id] || []).length,
    tracksAvailable: (playlistTracks[p.id] || []).length > 0,
  }));
}

export async function createPlaylist({ name, description = '', trackUris, isPublic = false }) {
  // Feb 2026 Web API changes: /users/{id}/playlists was removed in favor of /me/playlists,
  // and /playlists/{id}/tracks was renamed to /playlists/{id}/items.
  const playlist = await spotifyFetch('/me/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, public: isPublic }),
  });

  if (trackUris?.length > 0) {
    for (let i = 0; i < trackUris.length; i += 100) {
      const chunk = trackUris.slice(i, i + 100);
      await spotifyFetch(`/playlists/${playlist.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: chunk }),
      });
    }
  }

  const result = {
    id: playlist.id,
    name: playlist.name,
    url: playlist.external_urls.spotify,
    trackCount: trackUris?.length || 0,
    public: playlist.public,
  };
  // Dev Mode ignores the requested privacy (and a follow-up PUT {public:false} is accepted but has no effect),
  // so never let the caller believe a playlist is private when Spotify says otherwise.
  if (!isPublic && playlist.public !== false) {
    result.privacyWarning = 'Private was requested but Spotify created this playlist as PUBLIC. Tell the user and ask them to switch it to private in the Spotify app (… menu > Make private).';
  }
  return result;
}
