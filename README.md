# Reddit Search Scraper (JSON workaround)

Scrape Reddit search results—posts, links, scores, comment counts, and full comment content—using Reddit’s free `.json` URL workaround. **No API keys required** (for Reddit; OpenAI optional for MVP).

---

## Setup

```bash
cd redditleadsnipper
npm install
```

Requires **Node.js 18+** (for native `fetch`).

### Configuration (for MVP: AI + database)

- **OpenAI API key** (needed for keyword expansion and intent classification):  
  1. Get a key at [OpenAI API keys](https://platform.openai.com/api-keys).  
  2. Create a `.env` file in the project root and add: `OPENAI_API_KEY=sk-your-key-here`.  
  Do not commit `.env`; it is gitignored.

- **Database** (no setup): The app uses **SQLite**—a single file, no server or install. On first run of the MVP pipeline, it creates `data/reddit-leads.db` (or the path in `DATABASE_URL` if you set it). You don’t need to create anything; just run the app. **Everything is stored locally** in that file (runs, posts, comments, intent scores). **SQLite is free**—no cloud DB or cost.

### Pipeline (MVP: validate → conversational queries → search → shortlist → intent)

```bash
# Full run: validate input → AI keywords → Reddit search → shortlist → one intent score (0-100) per ranked post
npm run pipeline -- "social media scheduler"
```

Results are stored in `data/reddit-leads.db`: table `runs` (user input, keywords, status), `posts`, `comments`, and `post_intent` (one row per post with `label` high/medium/low and `score` 0-100). The database is **created automatically** on first use; **all data is stored locally** in that file; **SQLite is free** (no server, no subscription).

Inspect results (posts ranked by buying intent, with Reddit links):

```bash
npm run report                 # all posts, all runs, ranked by intent
npm run report -- --run <id>   # only posts from one run
npm run report -- --limit 50   # limit number of rows
```

### API (Leadsnipe MVP – landing "wow" search)

HTTP API for the landing-page search bar (one-off search; paid users later get saved keywords + hourly runs).

```bash
npm run api
```

- **GET /api/health** — `{ "ok": true }`
- **POST /api/search** — Body: `{ "query": "SEO content automation", "maxPages": 1 }`
  Runs the full pipeline, then returns `{ runId, query, keywords, totalPosts, totalComments, leads }`.  
  Each lead has `title`, `full_link`, `subreddit`, `author`, `created_utc`, `score`, `label`, `is_high_intent`, `explanation`, `suggested_reply`.

Set `PORT` (default 3001) and optionally `CORS_ORIGIN` in `.env`.

### Usage

```bash
# Search and save results (posts + comments; comments are fetched by default)
npm run search -- "social media scheduler"

# Posts only, no comments
npm run search -- "social media scheduler" --no-comments

# Or with npx
npx tsx src/run.ts "social media scheduler"

# Limit to 2 pages of search results
npm run search -- "social media scheduler" --max-pages 2

# Broad match (any word) instead of exact phrase
npm run search -- "social media scheduler" --broad

# Custom delay between requests (seconds, default 1.5)
npm run search -- "social media scheduler" --delay 2

# Custom output directory
npm run search -- "social media scheduler" --output-dir ./my-output
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--no-comments` | off | Skip fetching comments (posts only) |
| `--broad` | off | Match any word in the query instead of exact phrase (more results, less relevant) |
| `--max-pages` | 4 | Max search result pages per keyword (25 posts per page). Default 4 = 100 posts per keyword. Use 2 for faster runs (50 posts). |
| `--delay` | 1 | Seconds between requests (min 0.5). Lower = faster but higher risk of rate limits (429). |
| `--output-dir` | `./output` | Directory for JSON output files |

### Programmatic use

```ts
import { search } from "./src/reddit-search.js";
import { fetchComments } from "./src/reddit-comments.js";

const posts = await search("social media scheduler", { maxPages: 1 });
// Optional: fetch comments for each post
for (const post of posts) {
  if (post.subreddit && post.id) {
    post.comments = await fetchComments(post.subreddit, post.id, { delayMs: 1500 });
  }
}
```

---

## How it works

Appending `.json` to Reddit URLs returns JSON instead of HTML. This tool:

1. Fetches search results from `www.reddit.com/search.json?q=QUERY` (with phrase search and `sort=relevance&type=link` for better relevance).
2. Fetches comments for each post from `www.reddit.com/r/{subreddit}/comments/{id}/_.json` (one request per post; all comments returned in that response are included). No official API or API keys—only these public .json URLs. For very deep threads, Reddit’s response may omit some nested “load more” branches; we include everything that response contains.
3. Writes everything to a timestamped JSON file in `output/`.

For the current **warm-lead flow**: we validate the search input, ask the LLM for conversational Reddit-style queries, expand them into a broader 30-query search set with intent modifiers, search Reddit with broad matching and `sort=new`, dedupe by post, keep only the last 30 days, shortlist the strongest candidates, rank posts primarily from the original post + engagement + recency, then fetch comments only for the top ranked posts to enrich the explanation.

---

## Output

Each run creates a file: `output/results_<query_sanitized>_<timestamp>.json`

Structure:

```json
{
  "query": "social media scheduler",
  "fetched_at": "2026-03-06T17:20:13.123Z",
  "posts": [
    {
      "id": "abc123",
      "title": "Best social media scheduler?",
      "selftext": "Full post body...",
      "score": 42,
      "num_comments": 108,
      "permalink": "/r/SocialMediaManagers/comments/...",
      "full_link": "https://www.reddit.com/r/...",
      "subreddit": "SocialMediaManagers",
      "author": "username",
      "created_utc": 1709740800,
      "url": "https://...",
      "is_self": true,
      "over_18": false,
      "link_flair_text": null,
      "comments": [
        { "id": "c1", "body": "Comment text...", "author": "user", "score": 5, "created_utc": 1709741000 }
      ]
    }
  ]
}
```

---

## Ethics and terms of service

- Use a **reasonable delay** between requests (`--delay`); do not scrape at high frequency.
- This tool is for **personal or legitimate research** use. Comply with [Reddit’s Terms of Service](https://www.redditinc.com/policies/user-agreement) and [API terms](https://www.redditinc.com/policies/content-api-terms).
- Reddit may rate-limit or block abusive traffic. The scraper uses a browser-like User-Agent and configurable delays to reduce the risk of 429 responses.
