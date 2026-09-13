// api/latest-data.js
// Dashboard fetches this instead of having data embedded in the HTML.
// Simply redirects to whatever the cron job last wrote to Blob storage.

const { getLatestDatasetUrl } = require("../lib/storage");

module.exports = async function handler(req, res) {
  const url = await getLatestDatasetUrl();
  if (!url) {
    return res.status(404).json({ error: "no dataset yet — cron job hasn't run" });
  }
  res.setHeader("Cache-Control", "public, max-age=300"); // 5 min edge cache
  return res.redirect(302, url);
};
