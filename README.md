# Amazon Music Exporter

A userscript that adds an **Export** panel to the [Amazon Music web player](https://music.amazon.com)
so you can download **your own** data as JSON and CSV:

- every track in a playlist, with full metadata
- your **listening history**: every play with a timestamp, going back as far as Amazon keeps it (about a year in testing)
- all of your playlists in one go
- metadata for any list of track IDs (ASINs)

Amazon doesn't offer a play-by-play history export. This gets one from the same data the web player already loads.

> ⚠️ **Unofficial. Use only on your own account.** This uses Amazon Music's *internal* web API, the
> one the web player itself calls. Amazon doesn't document or support it, and it **may break at any
> time**. Not affiliated with or endorsed by Amazon. See [Responsible use](#️-responsible-use--disclaimer).

## ⚖️ Responsible use & disclaimer

**Read [DISCLAIMER.md](DISCLAIMER.md) before using this.** In short:

- **Unofficial.** Not affiliated with, endorsed by, or supported by Amazon. *Amazon Music* is a trademark of Amazon.com, Inc. or its affiliates.
- **Undocumented internal endpoints.** They may change or break at any time. Using them **may conflict with Amazon's Conditions of Use and the Amazon Music Terms of Use**. You alone are responsible for compliance and for any consequences to your account.
- **Your own account and your own data only**, for personal backup and analysis.
- **Do not** use it to access other people's accounts or data, share sessions, scrape or bulk-harvest the catalog, redistribute or sell data or content, bypass DRM, paywalls or rate limits, or obtain audio. **It downloads no audio**, only text metadata.
- **Read-only and rate-limited** by design. Don't modify it to hammer Amazon's servers.
- **Protect your tokens.** Never share exports, console output, HAR files or headers that might contain tokens. Redact them before filing issues.
- **Install only from sources you trust, and review the code.** A userscript runs with your signed-in session.
- **Exports are personal data.** Treat them as private.
- Provided **AS IS**, with no warranty and limited liability. See [LICENSE](LICENSE).
- Rights holders can [open an issue](https://github.com/Enazzzz/amazon-music-exporter/issues) for takedown or contact requests, and the author will respond. Security reports go through [SECURITY.md](SECURITY.md).
- None of this is legal advice.

The first time the panel opens, it shows a short notice that you need to acknowledge before any export buttons appear.

![Panel screenshot](docs/screenshot-panel.png)
<!-- TODO: add screenshots: docs/screenshot-panel.png, docs/screenshot-history.png -->

## Features

| Tab | Button | What you get |
| --- | --- | --- |
| **Playlist** | **Export playlist** | The playlist you're viewing, or any pasted playlist URL or ID. JSON + CSV with `position, asin, title, artist, featured_artists, album, album_asin, duration, track_number, explicit, lyrics, hd, ultra_hd, dolby_atmos, sony_360, liked, art_url, track_url`. The JSON summary lists duplicate entries along with their positions. |
| **History** | **Export listening history** | Every play in the range you pick: last 7 / 30 / 90 days, last year, everything, or since a date you choose. CSV columns: `played_at_utc, played_at_local, asin, title, artist, featured_artists, album, album_asin, duration_sec`. The JSON adds stats (total plays, estimated listening hours, top artists and tracks, plays per month), and the panel shows them too. |
| | *Only new plays since my last export* | Fetches only the plays newer than your last completed export, so you can build up a full archive over time. |
| | *Resume interrupted export* | Long runs save a checkpoint every 10 pages. If the tab crashes or you cancel, you can pick up where it stopped. |
| **More** | **Load my playlists → Export selected** | Lists your library playlists with checkboxes and exports the ones you pick into a single JSON plus one CSV that has a `playlist_title` column. |
| | **Look up track IDs** | Paste ASINs or track URLs in any format and get back title, artist, album, duration and audio-quality flags. |

You also get:
- A progress bar with live text, e.g. *"Page 42 · 4,200 plays · reached 9/14/2026"*
- A **Cancel** button, plus **Download what I have so far** if you cancel or something goes wrong
- Built-in rate limiting: about 1.5 s between requests, and an automatic 30 s back-off on HTTP 429 or 5xx
- CSVs saved as UTF-8 with a BOM, so Excel shows non-English and odd characters correctly. Titles are written exactly as Amazon has them, including glitchy-looking ones that are real song names.
- Timestamped filenames, e.g. `amazon-music-history_2026-11-17_18-22-05.csv`
- A panel you can drag, collapse (–/+), and reset to the bottom-right corner by double-clicking its header

## Install

1. Install a userscript manager:
   - [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Safari), or
   - [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Edge, Firefox)
2. **Chrome / Edge only:** userscript managers need permission to run scripts.
   - Chrome 138+: go to `chrome://extensions`, open the extension's **Details**, and turn on **Allow User Scripts**.
   - Older versions: turn on **Developer mode** at the top right of `chrome://extensions`.
3. Open **[the raw script](https://raw.githubusercontent.com/Enazzzz/amazon-music-exporter/main/amazon-music-exporter.user.js)**. Your manager will show an install page. **Read the code**, then click **Install**. Your manager can update it automatically later from the same URL.
   (Or create a new script in the manager's dashboard and paste in the whole file.)
4. Go to https://music.amazon.com, sign in, and **reload the page once**.
5. The **Amazon Music Exporter** panel appears at the bottom right. Read the one-time notice and acknowledge it. The dot in its header turns
   **cyan** once it's connected. If it stays orange, click around (Library, open a playlist) or reload.

## Usage tips

- **Playlist:** open the playlist and click **Export playlist**. You can also paste a link such as
  `https://music.amazon.com/my/playlists/<id>` or `/user-playlists/<id>`.
- **History:** a full year of heavy listening is roughly 300 pages and takes about 8 to 10 minutes because of the
  polite rate limit. Keep the tab open; it can be in the background.
- **Listening time is an estimate.** Amazon reports when each play started but not how long you
  listened, so the hours figure adds up full track lengths and counts skipped tracks as fully played.
- Your browser may ask once whether music.amazon.com may download **multiple files** (JSON + CSV). Allow it.

## How it works

1. The script runs at `document-start`, before Amazon's own code. It wraps `window.fetch` and
   `XMLHttpRequest` and, when the page calls `gql.music.amazon.com`, **keeps a copy of the request
   headers in memory** (the page's session/CSRF headers). Doing this at document-start matters because the
   web player saves its own reference to `fetch` when it loads, so a hook added later never sees
   anything.
2. When you click an export button, it sends read-only GraphQL **queries** to that same endpoint
   with the same headers and with your browser's normal cookies, exactly as the web player does.
3. It pages through the results, builds JSON and CSV in memory, and saves them through a Blob download link.

## Privacy & safety

- **Read-only.** It only sends queries and never sends mutations, so it can't change playlists, likes or settings.
- **Your session headers are never saved.** They exist only in memory for the open tab. They are never
  written to userscript storage or localStorage, never logged, and never included in any export file.
- **Nothing leaves your browser** except requests to Amazon's own API. There's no server, analytics,
  or third party involved.
- Userscript storage holds only harmless items: the newest play time from your last export (for
  "only new plays"), the panel's position and collapsed state, and a temporary checkpoint of listening-history
  rows during long exports, which is deleted when the export finishes.
- Because it runs while you're signed in, install it only from a source you trust and read the
  code first. It's a single file with no dependencies.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The dot stays orange or you see "Not connected yet" | Reload music.amazon.com. Check that the script is enabled and (Chrome) that *Allow User Scripts* / Developer mode is on. |
| "GraphQL error: …" | Amazon probably changed its API. Please open an issue and include the error text, but **remove anything that looks like a token**. |
| HTTP 401/403 | Your session expired. Reload the page and try again. |
| Very slow / "Amazon said slow down" | That's the automatic 30 s back-off. It retries on its own. |
| History stops after about a year | That's how far back Amazon keeps it. Use *Only new plays since my last export* regularly to build a longer archive. |
| Only the first page of playlists loads | The paging argument for the playlist list is a best guess. Export playlists one at a time from their pages. |

## Development

```bash
npm test                                  # syntax check + unit tests (Node 18+)
npm i && CHROME=/path/to/chrome npm run smoke   # optional headless browser smoke test (mocked API)
```

The file has two parts. `Core` is pure logic (query builders, response parsers, CSV, stats, and the paging
runners with an injectable fetch), and it's exported to Node for tests. The browser part
holds the hooks and the UI. Tests that use real exported data run only when you point
`AMEXP_HISTORY`, `AMEXP_LOOKUP`, and `AMEXP_CAPTURE` at your own files (see `test/core.test.js`). Don't
commit personal exports.

## Contributing

Bug reports and PRs are welcome. Please use the issue template and **redact all tokens**. PRs must keep
the script read-only and keep the rate limits. Features that would make it easier to touch other people's
accounts, scrape the catalog, or fetch audio won't be accepted.

## License

[MIT](LICENSE) © 2026 Zane Davis ([Enazzzz](https://github.com/Enazzzz)). See also [DISCLAIMER.md](DISCLAIMER.md) and [SECURITY.md](SECURITY.md).
