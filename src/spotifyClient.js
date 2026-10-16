import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, '..', 'data', 'tokens.json');

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;

async function readTokens() {
  try {
    return JSON.parse(await fs.readFile(TOKENS_PATH, 'utf-8'));
  } catch {
    throw new Error('No tokens found. Run `npm run auth` first to authorize with Spotify.');
  }
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  return response.json();
}

export async function getValidAccessToken() {
  const tokens = await readTokens();
  const expiresAt = tokens.obtained_at + tokens.expires_in * 1000;
  const isExpiringSoon = Date.now() > expiresAt - 60_000;

  if (!isExpiringSoon) {
    return tokens.access_token;
  }

  const refreshed = await refreshAccessToken(tokens.refresh_token);
  const merged = {
    ...tokens,
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
    obtained_at: Date.now(),
  };
  await fs.writeFile(TOKENS_PATH, JSON.stringify(merged, null, 2));
  return merged.access_token;
}

export async function spotifyFetch(endpoint, options = {}) {
  const accessToken = await getValidAccessToken();
  const response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Spotify API error ${response.status} on ${endpoint}: ${body}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null; // some endpoints (e.g. change playlist details) return 200 with an empty body
}
