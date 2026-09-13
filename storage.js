// lib/storage.js
// Persists the refreshed universe JSON so the dashboard can fetch it live
// instead of having data baked into the HTML.
//
// Uses Vercel Blob (simplest option, no separate account needed beyond
// Vercel). Swap for Upstash Redis (as used in nexus-eod-scanner) if you'd
// rather keep everything on that stack — the put/get shape is the same idea.

const { put, list } = require("@vercel/blob");

const BLOB_PATH = "india-equity-screener/latest.json";

async function saveDataset(payload) {
  const { url } = await put(BLOB_PATH, JSON.stringify(payload), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return url;
}

async function getLatestDatasetUrl() {
  const { blobs } = await list({ prefix: BLOB_PATH, token: process.env.BLOB_READ_WRITE_TOKEN });
  return blobs[0]?.url ?? null;
}

// Each cron stage runs as its own small function (see note in vercel.json
// about the 300s function duration cap) and needs to read whatever the
// previous stage last wrote, apply its own update, and save it back.
async function loadCurrentDataset(fallbackSeed) {
  const url = await getLatestDatasetUrl();
  if (!url) return fallbackSeed; // first-ever run, nothing saved yet
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return fallbackSeed;
  return res.json();
}

module.exports = { saveDataset, getLatestDatasetUrl, loadCurrentDataset };
