import { loadHistory } from './dataStore.js';

const MS_PER_HOUR = 3_600_000;

async function requireHistory() {
  const history = await loadHistory();
  if (!history) {
    throw new Error('No listening history found. Unzip the Spotify extended streaming history export into data/streaming-history-raw/ and run `npm run ingest-history`.');
  }
  return history;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function dataYears(history) {
  return Object.keys(history.yearly).map(Number).sort((a, b) => a - b);
}

function resolveRange(history, fromYear, toYear) {
  const years = dataYears(history);
  const from = fromYear ?? years[0];
  const to = toYear ?? years[years.length - 1];
  if (from > to) throw new Error(`fromYear (${from}) is after toYear (${to}).`);
  return { from, to };
}

/** Sums a { "2013": n } map over an inclusive year range. */
function sumYears(byYear, from, to) {
  let total = 0;
  for (const [year, value] of Object.entries(byYear || {})) {
    const y = Number(year);
    if (y >= from && y <= to) total += value;
  }
  return total;
}

function periodArtistPlays(history, from, to) {
  const plays = new Map();
  let total = 0;
  for (const [artist, a] of Object.entries(history.artists)) {
    const p = sumYears(a.yearlyPlays, from, to);
    if (p > 0) {
      plays.set(artist, p);
      total += p;
    }
  }
  return { plays, total };
}

export async function topArtists({ fromYear, toYear, limit = 20, sortBy = 'plays' } = {}) {
  const history = await requireHistory();
  const { from, to } = resolveRange(history, fromYear, toYear);

  const rows = [];
  let totalPlays = 0;
  for (const [artist, a] of Object.entries(history.artists)) {
    const plays = sumYears(a.yearlyPlays, from, to);
    if (plays === 0) continue;
    totalPlays += plays;
    rows.push({ artist, plays, hours: round1(sumYears(a.yearlyMs, from, to) / MS_PER_HOUR) });
  }
  rows.sort((a, b) => (sortBy === 'hours' ? b.hours - a.hours : b.plays - a.plays));

  return {
    period: { from, to },
    totalPlays,
    artists: rows.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      ...r,
      sharePct: round1((100 * r.plays) / totalPlays),
    })),
  };
}

export async function yearlyTopArtists({ fromYear, toYear, limit = 3 } = {}) {
  const history = await requireHistory();
  const { from, to } = resolveRange(history, fromYear, toYear);

  const result = [];
  for (let year = from; year <= to; year++) {
    const summary = history.yearly[year];
    if (!summary) continue;
    const { artists } = await topArtists({ fromYear: year, toYear: year, limit });
    result.push({
      year,
      plays: summary.plays,
      hours: round1(summary.msPlayed / MS_PER_HOUR),
      topArtists: artists.map((a) => `${a.artist} (${a.plays})`),
    });
  }
  return result;
}

function findArtistName(history, query) {
  const q = query.toLowerCase();
  const names = Object.keys(history.artists);
  const exact = names.find((n) => n.toLowerCase() === q);
  if (exact) return { name: exact };
  const candidates = names
    .filter((n) => n.toLowerCase().includes(q))
    .sort((a, b) => history.artists[b].plays - history.artists[a].plays)
    .slice(0, 8);
  return { candidates };
}

export async function artistHistory({ artist, trackLimit = 10 }) {
  const history = await requireHistory();
  const found = findArtistName(history, artist);
  if (!found.name) {
    const hint = found.candidates.length > 0 ? ` Did you mean: ${found.candidates.join(', ')}?` : '';
    throw new Error(`No artist named "${artist}" in listening history.${hint}`);
  }

  const a = history.artists[found.name];
  const yearly = Object.keys(a.yearlyPlays)
    .sort()
    .map((year) => ({
      year: Number(year),
      plays: a.yearlyPlays[year],
      hours: round1((a.yearlyMs[year] || 0) / MS_PER_HOUR),
    }));

  const tracks = Object.entries(history.tracks)
    .filter(([, t]) => t.artist === found.name)
    .sort((x, y) => y[1].plays - x[1].plays)
    .slice(0, trackLimit)
    .map(([uri, t]) => ({ name: t.name, plays: t.plays, lastPlayed: t.lastPlayed.slice(0, 10), uri }));

  return {
    artist: found.name,
    totalPlays: a.plays,
    totalHours: round1(a.msPlayed / MS_PER_HOUR),
    uniqueTracks: a.uniqueTracks,
    firstPlayed: a.firstPlayed.slice(0, 10),
    lastPlayed: a.lastPlayed.slice(0, 10),
    yearly,
    topTracks: tracks,
  };
}

export async function tasteDrift({ fromYearA, toYearA, fromYearB, toYearB, limit = 10, minPlays = 15 }) {
  const history = await requireHistory();
  const rangeA = resolveRange(history, fromYearA, toYearA);
  const rangeB = resolveRange(history, fromYearB, toYearB);
  const A = periodArtistPlays(history, rangeA.from, rangeA.to);
  const B = periodArtistPlays(history, rangeB.from, rangeB.to);

  // Compare share of listening rather than raw plays, since the two periods can differ in volume.
  const names = new Set([...A.plays.keys(), ...B.plays.keys()]);
  const rows = [...names].map((artist) => {
    const playsA = A.plays.get(artist) || 0;
    const playsB = B.plays.get(artist) || 0;
    return {
      artist,
      playsA,
      playsB,
      shareA: (100 * playsA) / A.total,
      shareB: (100 * playsB) / B.total,
    };
  });

  const fmt = (r) => ({
    artist: r.artist,
    playsA: r.playsA,
    playsB: r.playsB,
    sharePctA: round1(r.shareA),
    sharePctB: round1(r.shareB),
  });

  return {
    periodA: { ...rangeA, totalPlays: A.total },
    periodB: { ...rangeB, totalPlays: B.total },
    minPlays,
    risers: rows.filter((r) => r.playsB >= minPlays && r.playsA > 0).sort((a, b) => b.shareB - b.shareA - (a.shareB - a.shareA)).slice(0, limit).map(fmt),
    fallers: rows.filter((r) => r.playsA >= minPlays && r.playsB > 0).sort((a, b) => b.shareA - b.shareB - (a.shareA - a.shareB)).slice(0, limit).map(fmt),
    newInB: rows.filter((r) => r.playsA === 0 && r.playsB >= minPlays).sort((a, b) => b.playsB - a.playsB).slice(0, limit).map(fmt),
    goneFromB: rows.filter((r) => r.playsB === 0 && r.playsA >= minPlays).sort((a, b) => b.playsA - a.playsA).slice(0, limit).map(fmt),
  };
}

export async function discoveries({ fromYear, toYear, minPlays = 50, limit = 25 } = {}) {
  const history = await requireHistory();
  const { from, to } = resolveRange(history, fromYear, toYear);

  const rows = [];
  for (const [artist, a] of Object.entries(history.artists)) {
    const playYears = Object.keys(a.yearlyPlays).map(Number);
    if (playYears.length === 0) continue;
    const discoveredYear = Math.min(...playYears);
    if (discoveredYear < from || discoveredYear > to || a.plays < minPlays) continue;
    rows.push({
      artist,
      discoveredYear,
      firstPlayed: a.firstPlayed.slice(0, 10),
      lastPlayed: a.lastPlayed.slice(0, 10),
      totalPlays: a.plays,
      totalHours: round1(a.msPlayed / MS_PER_HOUR),
    });
  }
  rows.sort((a, b) => b.totalPlays - a.totalPlays);

  return {
    period: { from, to },
    note: `Artists first played in this period, ranked by all-time plays (i.e. which discoveries stuck). The data begins ${history.source.firstTs.slice(0, 10)}, so the first year means "already in rotation when the data starts".`,
    totalMatches: rows.length,
    artists: rows.slice(0, limit),
  };
}

export async function selectTracks({
  artists,
  fromYear,
  toYear,
  minPlays = 1,
  sortBy = 'plays',
  playedSince,
  notPlayedSince,
  maxPerArtist,
  limit = 25,
} = {}) {
  const history = await requireHistory();
  const periodGiven = fromYear !== undefined || toYear !== undefined;
  const { from, to } = resolveRange(history, fromYear, toYear);

  let artistFilter = null;
  const unmatchedArtists = [];
  if (artists?.length > 0) {
    const lowerToCanonical = new Map(Object.keys(history.artists).map((n) => [n.toLowerCase(), n]));
    artistFilter = new Set();
    for (const requested of artists) {
      const canonical = lowerToCanonical.get(requested.toLowerCase());
      if (canonical) artistFilter.add(canonical);
      else unmatchedArtists.push(requested);
    }
  }

  let matches = [];
  for (const [uri, t] of Object.entries(history.tracks)) {
    if (artistFilter && !artistFilter.has(t.artist)) continue;
    const plays = periodGiven ? sumYears(t.yearlyPlays, from, to) : t.plays;
    if (plays < minPlays || plays === 0) continue;
    if (playedSince && t.lastPlayed.slice(0, 10) < playedSince) continue;
    if (notPlayedSince && t.lastPlayed.slice(0, 10) >= notPlayedSince) continue;
    matches.push({ uri, t, plays });
  }

  const sorters = {
    plays: (a, b) => b.plays - a.plays,
    recent: (a, b) => b.t.lastPlayed.localeCompare(a.t.lastPlayed),
    least_recent: (a, b) => a.t.lastPlayed.localeCompare(b.t.lastPlayed),
  };
  matches.sort(sorters[sortBy] || sorters.plays);

  const totalMatches = matches.length;
  if (maxPerArtist) {
    const perArtist = new Map();
    matches = matches.filter(({ t }) => {
      const n = perArtist.get(t.artist) || 0;
      perArtist.set(t.artist, n + 1);
      return n < maxPerArtist;
    });
  }

  return {
    period: periodGiven ? { from, to } : 'all time',
    totalMatches,
    unmatchedArtists,
    tracks: matches.slice(0, limit).map(({ uri, t, plays }) => ({
      name: t.name,
      artist: t.artist,
      album: t.album,
      uri,
      plays,
      totalPlays: t.plays,
      firstPlayed: t.firstPlayed.slice(0, 10),
      lastPlayed: t.lastPlayed.slice(0, 10),
    })),
  };
}

export async function forgottenFavorites({ minPlays = 25, silentForMonths = 24, artists, maxPerArtist, limit = 50 } = {}) {
  const history = await requireHistory();
  // Measured from the end of the export, since plays after the export aren't visible.
  const asOf = new Date(history.source.lastTs);
  const cutoff = new Date(asOf);
  cutoff.setMonth(cutoff.getMonth() - silentForMonths);
  const notPlayedSince = cutoff.toISOString().slice(0, 10);

  const result = await selectTracks({ artists, minPlays, notPlayedSince, sortBy: 'plays', maxPerArtist, limit });
  return {
    asOf: asOf.toISOString().slice(0, 10),
    criteria: `at least ${minPlays} plays, none since ${notPlayedSince} (${silentForMonths} months before the export ends)`,
    totalMatches: result.totalMatches,
    unmatchedArtists: result.unmatchedArtists,
    tracks: result.tracks,
  };
}

/** Normalizes an artist name for matching: case, accents, "The ", "&", punctuation. */
export function normalizeName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

function listeningStatus(plays) {
  if (plays === 0) return 'never_played';
  if (plays < 10) return 'sampled';
  if (plays < 100) return 'listened';
  return 'favorite';
}

/**
 * Looks artists up in the history. Only album-artist credits are recorded, so an artist who has only ever appeared
 * as a featured guest can show up as never_played even though they were heard.
 */
export async function checkArtists({ artists }) {
  const history = await requireHistory();
  const index = new Map();
  for (const name of Object.keys(history.artists)) index.set(normalizeName(name), name);

  return artists.map((requested) => {
    const canonical = index.get(normalizeName(requested));
    if (!canonical) return { artist: requested, status: 'never_played', plays: 0 };
    const a = history.artists[canonical];
    return {
      artist: requested,
      matchedAs: canonical,
      status: listeningStatus(a.plays),
      plays: a.plays,
      hours: round1(a.msPlayed / MS_PER_HOUR),
      uniqueTracks: a.uniqueTracks,
      firstPlayed: a.firstPlayed.slice(0, 10),
      lastPlayed: a.lastPlayed.slice(0, 10),
    };
  });
}

/**
 * Tracks the user most reliably lets play to the end: lowest skip rate among tracks completed at least minCompletions
 * times in the period. "Skip" = the skipped flag or the forward button; "completion" = reason_end trackdone.
 * The skipped flag is not reliably recorded before 2022 (it was never set for 2017-2021 in the original author's export), so the period defaults to the last four calendar years of data.
 * Heavy skippers will find literally zero-skip tracks very rare;
 * pass maxSkipRate: 0 to see just those.
 */
export async function mostFinishedTracks({ fromYear, toYear, minCompletions = 8, maxSkipRate, maxPerArtist, limit = 50 } = {}) {
  const history = await requireHistory();
  const { from, to } = resolveRange(history, fromYear ?? dataYears(history).at(-1) - 3, toYear);

  let matches = [];
  for (const [uri, t] of Object.entries(history.tracks)) {
    const completions = sumYears(t.yearlyDone, from, to);
    if (completions < minCompletions) continue;
    const skipEvents = sumYears(t.yearlySkipEvents, from, to);
    const skipRate = skipEvents / (completions + skipEvents);
    if (maxSkipRate !== undefined && skipRate > maxSkipRate) continue;
    matches.push({ uri, t, completions, skipEvents, skipRate, plays: sumYears(t.yearlyPlays, from, to) });
  }
  matches.sort((a, b) => a.skipRate - b.skipRate || b.completions - a.completions);

  const totalMatches = matches.length;
  if (maxPerArtist) {
    const perArtist = new Map();
    matches = matches.filter(({ t }) => {
      const n = perArtist.get(t.artist) || 0;
      perArtist.set(t.artist, n + 1);
      return n < maxPerArtist;
    });
  }

  return {
    period: { from, to },
    reliabilityNote: from < 2022 ? 'The skipped flag is missing or partial before 2022, so results before then under-count skips.' : undefined,
    criteria: `completed at least ${minCompletions} times in ${from}-${to}, ranked by lowest skip rate${maxSkipRate !== undefined ? `, skip rate <= ${Math.round(maxSkipRate * 100)}%` : ''}`,
    totalMatches,
    tracks: matches.slice(0, limit).map(({ uri, t, completions, skipEvents, skipRate, plays }) => ({
      name: t.name,
      artist: t.artist,
      album: t.album,
      uri,
      completions,
      skipEvents,
      skipRatePct: Math.round(skipRate * 100),
      plays,
      lastPlayed: t.lastPlayed.slice(0, 10),
    })),
  };
}
