
# scripts/fetch-news.js

Node.js script that fetches news mentioning Peter Fintl, normalises the results, and writes `data/news.json` and `data/archive.json`. Run daily by GitHub Actions.

## Data sources

### 1. Google News RSS (primary)
Queries `"Peter Fintl"` across 13 locale/region combinations:

| Locale | Region |
|---|---|
| en-US | US |
| en-GB | GB |
| en-AU | AU |
| de | AT, DE, CH |
| zh-TW | TW |
| zh-CN | CN |
| ja | JP |
| ko | KR |
| fr-FR | FR |
| it-IT | IT |
| nl-NL | NL |

Google News returns redirect URLs (`news.google.com/rss/articles/…`) — page meta scraping is skipped for these to avoid bot blocks.

### 2. Brave Search News API (optional)

Requires a `BRAVE_API_KEY` environment variable (or a local `secrets/brave_search.json`). Two kinds of query run:

- **Paginated name search** — `BRAVE_NAME_QUERY` (`"Peter Fintl"`) fetched once per page in `BRAVE_NAME_OFFSETS`. These results skip the keyword filter, since the query itself already scopes them.
- **Topic queries** — `BRAVE_TOPIC_QUERIES`. Filtered to results mentioning "fintl", unless the query appears in the `TOPIC_ONLY` list.

> ⚠️ **`offset` is a page number, not an item index.** Brave skips `offset × count` results, so with `count=20` the valid values are small integers — `[0, 1, 2]`, **not** `[0, 20, 40]`. Passing item indices makes every request past the first return HTTP 422. Because `fetchBraveNews()` swallows failures with a `console.warn` and returns `[]`, this fails silently and simply caps the name search at its first 20 results. It went unnoticed from `857aebf` until `18e480d`; check the run log for `Brave failed [… offset=N]: 422` if recall looks unexpectedly low.

### 3. Coverage gap: paywalled outlets

Some outlets that quote Peter Fintl regularly — Handelsblatt, Süddeutsche Zeitung, Stern — appear in Google **web** search but not in Google News RSS, Bing News, or Brave News. Their dedicated news verticals apply stricter publisher-inclusion rules than the flagship web index, and paywalled sources are often excluded.

This is a source limitation, not a bug in this script. It was verified by querying all three news APIs with the identical `"Peter Fintl"` query and getting the same gap from each. There is no free programmatic route to Google's web index — the Custom Search JSON API is closed to new customers and its whole-web search option shuts down 2027-01-01.

## Image pipeline

For each item, `normalizeItem()` resolves an `imageUrl` using this priority chain:

1. `og:image` / `og:image:secure_url` / `twitter:image` scraped from the article page (Brave results only)
2. RSS `<media:content>`, `<media:thumbnail>`, `<enclosure>` tags
3. Outlet logo: domain or normalised source name matched against `data/as-seen-in.json` (supports `aliases` array) → `google.com/s2/favicons?domain={host}&sz=256`
4. `EXTRA_SOURCE_DOMAINS` map: hardcoded source-name → domain for frequent outlets not in `as-seen-in.json`
5. Domain extracted from source name via `extractSourceDomain()` — handles plain TLDs and second-level ccTLDs (`.co.kr`, `.org.tw`)
6. Final fallback: `google.com/s2/favicons?domain={url.hostname}&sz=256`

Every item will have a non-null `imageUrl`. Cards with a favicon URL get `object-fit: contain` styling in the frontend.

## Output files

| File | Description |
|---|---|
| `data/news.json` | Results from the latest single run |
| `data/archive.json` | Rolling 1-year merged archive (latest run + previous archive + manual overrides) |
| `sitemap.xml` | `<lastmod>` bumped to today |

`data/archive.json` is what the frontend and `scripts/prerender.js` actually read; `news.json` is a single-run snapshot. After this script runs, CI also runs `npm run prerender` so the new articles land in the static HTML — see [Pre-rendering in the main README](../README.md#pre-rendering-seo).

## Configuration

| Constant | Default | Description |
|---|---|---|
| `RETAIN_DAYS` | 365 | How many days to keep items in the archive |
| `RSS_LOCALES` | 13 entries | Google News locale/region pairs |
| `BRAVE_NAME_QUERY` | `"Peter Fintl"` | Direct name search run via Brave API |
| `BRAVE_NAME_OFFSETS` | `[0, 1, 2]` | Brave result **pages** for the name search (see warning above) |
| `BRAVE_TOPIC_QUERIES` | 4 queries | Topic searches run via Brave API |
| `BLOCKED_DOMAINS` | see code | Domains always excluded from results |
| `EXTRA_SOURCE_DOMAINS` | see code | Source-name → domain overrides for favicon lookup |

## Running locally

```bash
npm install
node scripts/fetch-news.js
```

Brave API key is optional — Google News RSS runs without it.
