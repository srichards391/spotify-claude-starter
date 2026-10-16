# Your Spotify history + Claude: a how-to

Turn your own Spotify listening history into something Claude can reason about, then have it build playlists
from what it finds. You request your data from Spotify, run a small local server, and connect it to Claude. Nothing
is hosted anywhere, and **everything runs on your machine with your own data and your own Spotify developer app**.
Nothing in this package belongs to anyone else: no history, no keys, no tokens.

**What you end up with:** an MCP server (a local tool server Claude can call) with 18 tools over your full listening
history, plus a recommender, plus the ability to create playlists on your account.

**Time:** about 45 minutes of hands-on setup, plus however long Spotify takes to prepare your export (they say up to
30 days, so request it first).

## Things you can ask once it's running

- "What was I listening to in 2014? Who ruled each year?"
- "How has my taste changed between my first three years and my last three?"
- "Which songs did I play 25+ times and then abandon for two years? Build me a playlist of 40 of them."
- "Recommend artists I've never played, based on my last two years. Show me the list before you make anything."
- "Make a playlist for each era of my listening, with a short written journal entry for each."
- "Which songs do I reliably let finish instead of skipping?"
- "Which artists did I sample once or twice and never go back to?"

Tip: open this folder in Claude Code and say *"walk me through the README setup"*. It can run most of the commands
for you and explain errors as they come up.

## What you need

- **Spotify Premium.** Since Spotify's February 2026 API changes, the owner of a developer app must have Premium,
  or the app stops working.
- **Node.js 18+** (this was built and tested on Node 24, on macOS. Windows and Linux are untested).
- **Claude Desktop** or **Claude Code**, which can connect to local MCP servers.

---

## Setup

### 1. Request your extended streaming history (do this first)

In your Spotify account: Privacy settings, then "Download your data". Choose **Extended streaming history**. (This is
a different, much bigger export than the basic "account data" one. Menu names move around, so search the Privacy
page for "extended".) Confirm via the email Spotify sends. When it's ready you'll get a download link.

The export is a zip containing `Spotify Extended Streaming History/Streaming_History_Audio_*.json`, one row per play:
timestamp, track, artist, album, milliseconds played, why it started and ended, and whether it was skipped. It goes
back to the day you joined. It also contains **IP addresses**, so don't share the raw files (see Privacy).

### 2. Create a Spotify developer app

1. Go to <https://developer.spotify.com/dashboard> and click **Create app**.
2. **App name:** anything that does *not* start with "Spot" (Spotify rejects those).
3. **Redirect URI:** exactly `http://127.0.0.1:8888/callback`, then click **Add**. Use `127.0.0.1`, not `localhost`.
4. Tick **Web API**, accept the terms, and save.
5. Open the app, copy the **Client ID**, and click **View client secret** to copy the secret.

You don't need to add yourself under "User Management". The app owner can authorize. Treat the client secret like a
password.

### 3. Install, authorize, pull your API data

```bash
npm install
cp .env.example .env       # then paste your Client ID and Client Secret into .env
npm run auth               # opens a browser; approve access; saves tokens to data/tokens.json
npm run fetch-data         # a minute or two
```

`fetch-data` pulls your top 50 tracks and artists, up to 200 liked songs, and all your playlists with their tracks.
**Expect some "Skipping tracks for playlist ..." 403 messages.** That's normal: Spotify only returns a playlist's
contents if you own it or collaborate on it, and the script skips the rest.

### 4. Ingest your history

Unzip the export so the folder lands at `data/streaming-history-raw/Spotify Extended Streaming History/`, then:

```bash
npm run ingest-history
```

Or point it anywhere: `npm run ingest-history -- "/path/to/Spotify Extended Streaming History"`.

This boils a few hundred MB of raw rows down to one file, `data/listening-history.json` (about 5-10 MB): per-track and
per-artist plays, hours, completions, skips and first/last played, all broken out by year. IP addresses and raw
events are not kept. You can delete the raw folder afterward if you like.

### 5. Check that it all works

```bash
npm run check
```

It reconciles the aggregates against each other, exercises every tool over the real MCP protocol, and (if you've
run `npm run auth`) tests live Spotify search and the recommender. It derives its test inputs from *your* data, so a
pass means the pipeline is sound for you. If the MCP step fails it prints the server's error.

### 6. Connect it to Claude

**Claude Desktop:** edit the config file (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`)
and add, using the **absolute** path to this folder:

```json
{
  "mcpServers": {
    "spotify-history": {
      "command": "node",
      "args": ["/absolute/path/to/spotify-claude-starter/src/mcpServer.js"]
    }
  }
}
```

If the file already has other settings, just add the `mcpServers` block alongside them. Then **fully quit and reopen**
Claude Desktop (closing the window isn't enough). Do the same after any change to the server code.

**Claude Code:** `claude mcp add spotify-history -- node /absolute/path/to/spotify-claude-starter/src/mcpServer.js`

Config details vary a little between client versions. If the tools don't show up, see Troubleshooting.

### 7. Try it

Ask: *"Using my Spotify tools, who were my top 5 artists in each year?"* Then try the prompts at the top.

---

## How it works

```
 Spotify export (JSON, 100s of MB)            Spotify Web API (live)
        │  npm run ingest-history                    │  npm run fetch-data / on demand
        ▼                                            ▼
 data/listening-history.json              data/{top-tracks,saved-tracks,playlists,...}.json
        └──────────────┬─────────────────────────────┘
                       ▼
        src/historyTools.js · tools.js · discoverTools.js     ← plain functions, no MCP in them
                       ▼
                src/mcpServer.js  (stdio MCP server, zod input schemas)
                       ▼
                 Claude Desktop / Claude Code  →  Spotify (create_playlist, search)
```

### The tools

| Group | Tools | Reads from |
|---|---|---|
| History | `top_artists`, `yearly_top_artists`, `artist_history`, `taste_drift`, `discoveries`, `select_tracks`, `forgotten_favorites`, `most_finished_tracks` | `listening-history.json` |
| Recommending | `check_artists`, `discover_tracks`, `spotify_search` | history + live Spotify |
| API cache | `search_songs`, `get_taste_profile`, `find_similar_tracks`, `compare_playlists`, `get_listening_trends`, `list_playlists` | the `fetch-data` files (`get_taste_profile` also uses history) |
| Writing | `create_playlist` | writes to your Spotify account |

Every track-returning tool gives real `spotify:track:` URIs, so any result can go straight into `create_playlist`.

### Design decisions worth knowing

- **Claude is the recommender.** Spotify removed its recommendation and audio-feature endpoints, and stripped genres
  and popularity. So Claude proposes artists from its own music knowledge, `check_artists` and `discover_tracks`
  filter out anything your history says you already know, and the rest come back as playable tracks. Your history
  works as the exclusion set, and Claude does the reasoning about taste and genre.
- **Aggregate once, query many.** Parsing the raw export on every question would be slow, so `ingest-history` makes one
  compact cache that the server loads into memory (and reloads when the file changes).
- **Tools are plain functions; the MCP layer is thin.** All logic lives in `src/*Tools.js` and is tested without MCP.
  `mcpServer.js` only declares schemas and descriptions. Those descriptions are effectively prompts for Claude, so
  they carry the caveats it needs ("skip data is unreliable before X", "confirm with the user before writing").
- **A "play" is a stream of 30 s or more**, matching Spotify's own threshold. Time is bucketed by whole calendar year,
  and `taste_drift` compares *share of listening* (not raw plays), so periods of different volume stay comparable.
- **Writes are explicit.** `create_playlist` is the only tool that changes your account, and its description tells
  Claude to show you the track list and get a yes first. It also returns the playlist's real visibility (see below).

### What changed in Spotify's API (as of October 2026)

If you hit a bare `403 Forbidden`, it is almost certainly a **removed endpoint**, not a permissions or rate-limit
problem. Spotify's [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
covers it. What mattered here:

| Old assumption | Reality |
|---|---|
| `/audio-features`, `/recommendations` | removed (earlier, in late 2024) |
| genres, popularity, followers on artists/tracks | stripped from responses |
| batch lookups (`/artists?ids=...`, same for tracks/albums) | removed; fetch one at a time |
| `POST /users/{id}/playlists` | removed; use `POST /me/playlists` |
| `/playlists/{id}/tracks` (and the `tracks` / `track` fields) | renamed `/items` (`items` / `item`) |
| playlist contents for any playlist you follow | only for playlists you own or collaborate on |
| search `limit` up to 50 | max 10 |
| creating a private playlist | the `public` flag is ignored; playlists come out public (see Privacy) |

---

## Privacy and security

- **Stays on your machine:** the raw export, `data/listening-history.json`, your tokens, and `.env`. `.gitignore`
  already excludes `.env` and everything under `data/`. Don't commit any of it.
- **Leaves your machine:** calls to Spotify's API, and **whatever the tools return to Claude**. Results become part of
  your conversation, so they go to Anthropic like any other message. If that matters to you, keep in mind that
  asking "what are my top artists" puts those names in the conversation.
- **The raw export contains IP addresses** and a connection country for every play. The ingest step discards them,
  but the raw files stay on disk until you delete them. Never share them.
- **The separate "account data" package** (not the extended history) includes identity and payment details. You
  don't need it for this, so don't hand it to anyone or point this tool at it.
- **Playlists are created public.** Spotify's developer API currently ignores a request for private. Anyone with the
  link can see them. To make one private: open it in the Spotify app, "..." menu, "Make private". Keep titles and
  descriptions free of anything personal.
- **Your client secret is a credential.** If it leaks, rotate it in the developer dashboard.
- **Spotify's developer rules.** Spotify's [Developer Policy](https://developer.spotify.com/policy) says not to use the
  Spotify Platform or any Spotify Content to train a machine learning or AI model "or otherwise ingest Spotify Content
  into" one. This project builds on your own personal data export and passes tool results to Claude at question time
  (it does not train anything), but Spotify's wording doesn't clearly say whether that counts. Keep use personal and
  non-commercial, and read the terms yourself before building on this.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Missing Spotify credentials` | `.env` not created or not filled in |
| `INVALID_CLIENT: Invalid redirect URI` | the dashboard URI must be exactly `http://127.0.0.1:8888/callback` |
| `No tokens found` / token errors | run `npm run auth` again |
| Everything starts returning 403 | is the app owner's Premium still active? Otherwise check the table above for a removed endpoint |
| `No listening history found` | unzip into `data/streaming-history-raw/` and run `npm run ingest-history` |
| Tools missing in Claude | use an absolute path; fully quit and reopen the app; make sure the JSON config is valid; run `node src/mcpServer.js` yourself to see any startup error; run `npm run check` |
| Some playlists show no tracks | expected, see step 3 |

## Known limitations

- The history only credits an album's **main artist**, so someone you only heard as a featured guest can look
  "never played."
- The same song often exists under several URIs (album, deluxe, and single versions), and counts are per URI. For
  "my favorite songs by X," ask Claude to merge versions by title.
- Granularity is whole years. Month-level questions ("summer 2013") would need a per-month rollup in `ingestHistory.js`.
- The `skipped` field is only populated reliably in some periods (in the author's export it was never set for
  2017-2021). Check yours before trusting skip-based tools, and note that `most_finished_tracks` defaults to the last
  four years for this reason.
- There are no genres or audio features. Claude infers style from names and its own knowledge.
- Not tested outside macOS or on Node versions other than 24.
- **This is a personal tool, not a path to a public app.** Development Mode allows 5 users and requires the owner to
  have Premium. Spotify only grants unlimited ("extended") access to registered organizations, and its
  [quota-modes page](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) lists a 250k-user
  threshold (check the current criteria).

## Ideas to extend it

- A day-level rollup, so Claude can answer "what was I playing the week of X?" (great for journaling or a memoir).
- Ingest the separate account-data package's `YourLibrary.json` for liked-song dates and followed artists
  ("liked but never played"), and its search history as a taste signal.
- Version-merging inside `select_tracks`; genre enrichment from an outside source such as MusicBrainz.
- A scheduled monthly "wrapped" that writes a playlist and a short summary.

Built with Claude Code. Everything here is plain JavaScript (ES modules), about 1,700 lines, including the self-check. Reading `src/historyTools.js`
first is the fastest way to see how it works.

## License

MIT. See [LICENSE](LICENSE). This is an unofficial personal project and is not affiliated with Spotify.
