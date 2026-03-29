
# Latest News Landing (Peter Fintl)

A lightweight landing page hosted on GitHub Pages that shows the **latest news articles featuring Peter Fintl**, pulled from **Google News RSS** across multiple languages/regions, **sorted by date**, and maintained via a scheduled **GitHub Action**.

## Recent Changes (March 2026)

- **Repository visibility**: Changed from private to public to avoid GitHub Actions minute limits.
- **Brave API key**: Securely stored as GitHub secret (`BRAVE_API_KEY`); script reads from environment.
- **RSS fetch robustness**: Replaced `rss‑parser` with `fetch` + `AbortController` (10 s timeout per feed) to prevent hangs on GitHub Actions.
- **Concurrency**: Feeds are fetched 3 at a time, speeding up multi‑locale collection.
- **RSS locales**: All 13 locales restored (US, GB, AU, DE/AT/CH, TW, CN, JP, KR, FR, IT, NL) with Korean support.
- **Timeouts**: Added per‑feed timeout (10 s) and global script timeout (3 min) to prevent hangs.
- **Schedule**: Reduced from hourly to daily (09:11 Vienna time) to reduce API calls.
- **GitHub Actions**: Upgraded `checkout` and `setup‑node` to v4.
- **Debugging**: Added debug step in workflow to verify environment variables.

## What’s included
- `index.html` + `assets/*`: responsive UI with filters (time window, sort order, keyword search).
- `scripts/fetch-news.js`: Node script that fetches multiple Google News RSS feeds → merges, dedupes, sorts.
- `.github/workflows/fetch-news.yml`: hourly scheduled Action that writes `data/news.json` and a 1-year rolling `data/archive.json`.
- `data/archive.json`: the archive that the page loads and renders.

## How it works
1. **Server-side fetch (GitHub Actions):** Pulls Google News RSS search feeds for `"Peter Fintl"` in multiple locales (e.g., en-US, de-AT, fr-FR...), merges and dedupes them, then writes JSON.
2. **Client-side rendering:** The page fetches `data/archive.json`, lets visitors filter and **sort by publication date**.
3. **No CORS issues:** Because the RSS is fetched server-side, the static page can load JSON safely.

## Setup
1. **Unzip** the archive into the root of your repository: `fintlp/latest-news`.
2. Commit on a feature branch and open a PR:
   ```bash
   git checkout -b feature/latest-news-landing
   git add .
   git commit -m "feat: latest-news landing (multi-locale; 1y archive; date-sorted UI)"
   git push -u origin feature/latest-news-landing
   ```
3. **Enable GitHub Pages:** Settings → Pages → *Deploy from a branch* → Branch: `main` → `/` (root).
4. **Verify the Action:** After merge, go to **Actions** → run the workflow (or wait for the hourly cron). It will generate `data/news.json` & update `data/archive.json`.
5. Share your public URL (e.g., `https://fintlp.github.io/latest-news/`) on **LinkedIn** (Featured section or Premium custom button).

## Configuration
- **Locales:** Edit the `RSS_LOCALES` array in `scripts/fetch-news.js` to add/remove language/region pairs.
- **Retention window:** Change `RETAIN_DAYS` in `scripts/fetch-news.js` (defaults to `365`).
- **Schedule:** Edit the cron line in the workflow (UTC). For every 3 hours: `"7 */3 * * *"`.
- **Analytics:** UTM parameters are appended to outbound links in the script; add your analytics if needed.

## Notes
- Google News RSS returns up to ~100 items per feed call; running hourly builds a robust 1-year archive.
- There’s no official "sort by date" parameter in Google News RSS search; we sort locally after fetch.

## License
MIT
