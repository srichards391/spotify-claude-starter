import 'dotenv/config';
import express from 'express';
import open from 'open';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, '..', 'data', 'tokens.json');

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI } = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REDIRECT_URI) {
  console.error(
    'Missing Spotify credentials. Copy .env.example to .env and fill in SPOTIFY_CLIENT_ID, ' +
    'SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI from your Spotify Developer Dashboard app.'
  );
  process.exit(1);
}

const SCOPES = [
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-top-read',
  'playlist-modify-public',
  'playlist-modify-private',
].join(' ');

const redirectUrl = new URL(SPOTIFY_REDIRECT_URI);
const port = redirectUrl.port || 8888;

const state = crypto.randomBytes(16).toString('hex');

const authorizeUrl = new URL('https://accounts.spotify.com/authorize');
authorizeUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: SPOTIFY_CLIENT_ID,
  scope: SCOPES,
  redirect_uri: SPOTIFY_REDIRECT_URI,
  state,
}).toString();

const app = express();

app.get(redirectUrl.pathname, async (req, res) => {
  const { code, state: returnedState, error } = req.query;

  if (error) {
    res.status(400).send(`Spotify authorization failed: ${error}`);
    console.error('Authorization failed:', error);
    server.close(() => process.exit(1));
    return;
  }

  if (returnedState !== state) {
    res.status(400).send('State mismatch — possible CSRF, aborting.');
    console.error('State mismatch on callback.');
    server.close(() => process.exit(1));
    return;
  }

  try {
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text();
      throw new Error(`Token exchange failed (${tokenResponse.status}): ${body}`);
    }

    const tokens = await tokenResponse.json();
    await fs.mkdir(path.dirname(TOKENS_PATH), { recursive: true });
    await fs.writeFile(
      TOKENS_PATH,
      JSON.stringify({ ...tokens, obtained_at: Date.now() }, null, 2)
    );

    res.send('Spotify authorization successful. You can close this window and return to the terminal.');
    console.log(`Tokens saved to ${TOKENS_PATH}`);
    server.close(() => process.exit(0));
  } catch (err) {
    res.status(500).send('Token exchange failed. Check the terminal for details.');
    console.error(err);
    server.close(() => process.exit(1));
  }
});

const server = app.listen(port, async () => {
  console.log(`Local auth server listening on ${SPOTIFY_REDIRECT_URI}`);
  console.log('Opening Spotify authorization page in your browser...');
  await open(authorizeUrl.toString());
});
