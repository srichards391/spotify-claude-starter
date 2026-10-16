import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  searchSongs,
  getTasteProfile,
  findSimilarTracks,
  comparePlaylists,
  getListeningTrends,
  listPlaylists,
  createPlaylist,
} from './tools.js';
import {
  topArtists,
  yearlyTopArtists,
  artistHistory,
  tasteDrift,
  discoveries,
  selectTracks,
  forgottenFavorites,
  checkArtists,
  mostFinishedTracks,
} from './historyTools.js';
import { spotifySearch, discoverTracks } from './discoverTools.js';

const yearSchema = z.number().int().min(2000).max(2100);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const server = new McpServer({
  name: 'spotify-playlist-builder',
  version: '0.1.0',
});

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}

function registerJsonTool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return jsonResult(await handler(args));
    } catch (err) {
      return errorResult(err);
    }
  });
}

registerJsonTool(
  'search_songs',
  {
    title: 'Search songs',
    description: 'Search the user\'s local Spotify library (top tracks, saved tracks, and playlist contents) by track name, artist, or album substring.',
    inputSchema: {
      query: z.string().describe('Text to search for in track name, artist name, or album name'),
      limit: z.number().int().positive().max(100).optional().describe('Max results to return, default 20'),
    },
  },
  ({ query, limit }) => searchSongs({ query, limit })
);

registerJsonTool(
  'get_taste_profile',
  {
    title: 'Get taste profile',
    description: 'Aggregate stats on the user\'s music taste: most frequent artists (by Spotify ranking and by local library frequency) and release-era distribution. No genre/audio-feature data is available from Spotify for this app — infer style from artist/track names using your own knowledge.',
    inputSchema: {},
  },
  () => getTasteProfile()
);

registerJsonTool(
  'find_similar_tracks',
  {
    title: 'Find similar tracks',
    description: 'Find tracks similar to a given track id, using shared artist, playlist co-occurrence, and release-era proximity as signals (no audio-feature similarity is available).',
    inputSchema: {
      trackId: z.string().describe('Spotify track id, from a prior search_songs or get_taste_profile result'),
      limit: z.number().int().positive().max(50).optional().describe('Max results to return, default 10'),
    },
  },
  ({ trackId, limit }) => findSimilarTracks({ trackId, limit })
);

registerJsonTool(
  'compare_playlists',
  {
    title: 'Compare playlists',
    description: 'Compare two playlists by shared tracks and shared artists.',
    inputSchema: {
      playlistId1: z.string().describe('Spotify playlist id, from list_playlists'),
      playlistId2: z.string().describe('Spotify playlist id, from list_playlists'),
    },
  },
  ({ playlistId1, playlistId2 }) => comparePlaylists({ playlistId1, playlistId2 })
);

registerJsonTool(
  'get_listening_trends',
  {
    title: 'Get listening trends',
    description: 'Compare release-era distribution across current top tracks, full saved library, and playlist contents to show how taste has shifted over time.',
    inputSchema: {},
  },
  () => getListeningTrends()
);

registerJsonTool(
  'list_playlists',
  {
    title: 'List playlists',
    description: 'List all of the user\'s playlists with track counts. Some playlists owned by labels/artists/editorial accounts have no track data available (tracksAvailable: false).',
    inputSchema: {},
  },
  () => listPlaylists()
);

registerJsonTool(
  'create_playlist',
  {
    title: 'Create playlist on Spotify',
    description: 'Creates a new playlist on the user\'s actual Spotify account and adds the given tracks to it. This writes to Spotify — only call it once the user has confirmed the track list.',
    inputSchema: {
      name: z.string().describe('Playlist name'),
      description: z.string().optional().describe('Playlist description'),
      trackUris: z.array(z.string()).describe('Spotify track URIs (e.g. spotify:track:...) to add, in order'),
      isPublic: z.boolean().optional().describe('Requested visibility, default false. NOTE: in Spotify Dev Mode this is currently ignored and playlists come out public — check the result for privacyWarning and relay it to the user.'),
    },
  },
  ({ name, description, trackUris, isPublic }) => createPlaylist({ name, description, trackUris, isPublic })
);

// ---- Listening-history tools (the user's full Spotify extended streaming history) ----
// "Plays" are streams of 30s or more. Periods are whole calendar years (inclusive); to look at a single year
// set fromYear and toYear to the same value.

registerJsonTool(
  'top_artists',
  {
    title: 'Top artists (listening history)',
    description: 'The user\'s most-played artists from their full Spotify streaming history, for all time or any range of years. Use fromYear = toYear for a single year, e.g. "what was I into in 2013".',
    inputSchema: {
      fromYear: yearSchema.optional().describe('First year of the period (default: first year of the data)'),
      toYear: yearSchema.optional().describe('Last year of the period, inclusive (default: latest year of data)'),
      limit: z.number().int().positive().max(200).optional().describe('How many artists, default 20'),
      sortBy: z.enum(['plays', 'hours']).optional().describe('Rank by play count (default) or listening hours'),
    },
  },
  (args) => topArtists(args)
);

registerJsonTool(
  'yearly_top_artists',
  {
    title: 'Top artists for every year',
    description: 'The top artists of each year side by side — a quick overview of how the user\'s taste has moved over the years, with plays and hours per year.',
    inputSchema: {
      fromYear: yearSchema.optional().describe('First year, default: first year of the data'),
      toYear: yearSchema.optional().describe('Last year, default latest'),
      limit: z.number().int().positive().max(10).optional().describe('Artists per year, default 3'),
    },
  },
  (args) => yearlyTopArtists(args)
);

registerJsonTool(
  'artist_history',
  {
    title: 'Artist history',
    description: 'Everything about one artist in the user\'s history: first and last play, total plays and hours, plays per year, and most-played tracks (with URIs). If the name doesn\'t match exactly it suggests close matches.',
    inputSchema: {
      artist: z.string().describe('Artist name (case-insensitive, exact)'),
      trackLimit: z.number().int().positive().max(50).optional().describe('How many top tracks to include, default 10'),
    },
  },
  (args) => artistHistory(args)
);

registerJsonTool(
  'taste_drift',
  {
    title: 'Taste drift between two periods',
    description: 'Compare two periods of the user\'s listening: artists gaining or losing share of their listening (risers/fallers), artists that are new in the second period, and artists that disappeared from it. Compares share of listening, so periods of different volume are comparable.',
    inputSchema: {
      fromYearA: yearSchema.describe('Start year of the earlier (baseline) period'),
      toYearA: yearSchema.describe('End year of the baseline period, inclusive'),
      fromYearB: yearSchema.describe('Start year of the period to compare against'),
      toYearB: yearSchema.describe('End year of the comparison period, inclusive'),
      limit: z.number().int().positive().max(50).optional().describe('Entries per list, default 10'),
      minPlays: z.number().int().positive().optional().describe('Ignore artists with fewer plays than this in the relevant period, default 15'),
    },
  },
  (args) => tasteDrift(args)
);

registerJsonTool(
  'discoveries',
  {
    title: 'Artist discoveries',
    description: 'Artists the user first played in a given period, ranked by all-time plays — i.e. which discoveries stuck. Note the first year of the data means "already in rotation when the record begins".',
    inputSchema: {
      fromYear: yearSchema.optional().describe('First year of discovery period, default: first year of the data'),
      toYear: yearSchema.optional().describe('Last year of discovery period, inclusive'),
      minPlays: z.number().int().positive().optional().describe('Minimum all-time plays, default 50'),
      limit: z.number().int().positive().max(100).optional().describe('Max artists, default 25'),
    },
  },
  (args) => discoveries(args)
);

registerJsonTool(
  'select_tracks',
  {
    title: 'Select tracks from listening history',
    description: 'The general track picker for building playlists: filter the user\'s history by artists, period, minimum plays, and recency, sort, and cap per artist. Returns real Spotify track URIs ready for create_playlist. Examples: "my top 30 tracks of 2016" (fromYear=toYear=2016), "everything I loved by these artists" (artists=[...]), "songs I played a lot but not since 2022" (notPlayedSince).',
    inputSchema: {
      artists: z.array(z.string()).optional().describe('Only tracks by these artists (case-insensitive exact names). Unmatched names are reported back.'),
      fromYear: yearSchema.optional().describe('Count plays only within this period (start year). Omit both years for all-time plays.'),
      toYear: yearSchema.optional().describe('End year of the period, inclusive'),
      minPlays: z.number().int().positive().optional().describe('Minimum plays (within the period if one is given), default 1'),
      sortBy: z.enum(['plays', 'recent', 'least_recent']).optional().describe('plays = most played first (default); recent = last played most recently; least_recent = longest since last played'),
      playedSince: dateSchema.optional().describe('Only tracks last played on or after this date'),
      notPlayedSince: dateSchema.optional().describe('Only tracks NOT played on or after this date (last play before it)'),
      maxPerArtist: z.number().int().positive().optional().describe('Cap tracks per artist for variety'),
      limit: z.number().int().positive().max(200).optional().describe('Max tracks, default 25'),
    },
  },
  (args) => selectTracks(args)
);

registerJsonTool(
  'forgotten_favorites',
  {
    title: 'Forgotten favorites',
    description: 'Tracks the user played a lot but hasn\'t played in a long time, most-played first — good raw material for a "blast from the past" playlist. Returns Spotify track URIs. Measured relative to the end of the history export.',
    inputSchema: {
      minPlays: z.number().int().positive().optional().describe('Minimum all-time plays, default 25'),
      silentForMonths: z.number().int().positive().optional().describe('Months without a play, default 24'),
      artists: z.array(z.string()).optional().describe('Limit to these artists'),
      maxPerArtist: z.number().int().positive().optional().describe('Cap tracks per artist for variety'),
      limit: z.number().int().positive().max(200).optional().describe('Max tracks, default 50'),
    },
  },
  (args) => forgottenFavorites(args)
);

registerJsonTool(
  'check_artists',
  {
    title: 'Check artists against listening history',
    description: 'For each artist name, report whether the user has ever played them and how much (never_played / sampled <10 plays / listened <100 / favorite), with plays, hours, and first/last played. Use this before recommending anyone, so you never suggest what he already knows. Names are matched ignoring case, accents, "The", and punctuation. Only album-artist credits are tracked, so an artist heard only as a featured guest can read as never_played.',
    inputSchema: {
      artists: z.array(z.string()).min(1).max(100).describe('Artist names to look up'),
    },
  },
  (args) => checkArtists(args)
);

registerJsonTool(
  'most_finished_tracks',
  {
    title: 'Tracks the user most reliably lets finish',
    description: 'Tracks with the lowest skip rate among those completed at least minCompletions times in the period (default: the last four calendar years of data, because Spotify\'s skipped flag is not reliably recorded in older years — check your own data). Heavy skippers will find literal never-skipped tracks very rare — expect to allow skip rates up to ~40% for a usable list; pass maxSkipRate: 0 for true zero-skip tracks. Returns URIs.',
    inputSchema: {
      fromYear: yearSchema.optional().describe('Start year, default: three years before the latest data year'),
      toYear: yearSchema.optional().describe('End year, inclusive, default latest'),
      minCompletions: z.number().int().positive().optional().describe('Minimum times played to the end, default 8'),
      maxSkipRate: z.number().min(0).max(1).optional().describe('Only tracks with skip rate at or below this fraction, e.g. 0.4'),
      maxPerArtist: z.number().int().positive().optional().describe('Cap tracks per artist'),
      limit: z.number().int().positive().max(200).optional().describe('Max tracks, default 50'),
    },
  },
  (args) => mostFinishedTracks(args)
);

registerJsonTool(
  'spotify_search',
  {
    title: 'Search Spotify',
    description: 'Live Spotify catalog search for tracks or artists. Dev Mode caps results at 10 per call and no longer returns popularity, genres or followers. Tip: query artist:"Name" to find one artist\'s tracks.',
    inputSchema: {
      query: z.string().describe('Search text, e.g. "Tycho Awake" or artist:"Tycho"'),
      type: z.enum(['track', 'artist']).optional().describe('What to search for, default track'),
      limit: z.number().int().positive().max(10).optional().describe('Results, max 10'),
    },
  },
  (args) => spotifySearch(args)
);

registerJsonTool(
  'discover_tracks',
  {
    title: 'Discover new tracks from a list of artists',
    description: 'Recommendation pipeline. YOU supply artist names (brainstormed from the user\'s taste using your own music knowledge — Spotify\'s recommendation API is gone). This drops artists they already know (>= excludeIfPlaysAtLeast plays in his history), looks up the rest on Spotify, and returns tracks they have never played with URIs ready for create_playlist. Artists he has only sampled are kept and flagged. Typical flow: get_taste_profile / taste_drift / discoveries for context -> brainstorm 30-60 artists -> discover_tracks -> pick -> confirm with the user -> create_playlist.',
    inputSchema: {
      artists: z.array(z.string()).min(1).max(60).describe('Candidate artist names to evaluate'),
      tracksPerArtist: z.number().int().positive().max(5).optional().describe('Tracks per artist, default 2'),
      excludeIfPlaysAtLeast: z.number().int().positive().optional().describe('Plays at or above which an artist counts as already known, default 25'),
    },
  },
  (args) => discoverTracks(args)
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Spotify Playlist Builder MCP server running on stdio.');
