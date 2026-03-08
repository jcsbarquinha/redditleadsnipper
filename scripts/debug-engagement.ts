/**
 * One-off script to verify Reddit returns score/num_comments and we parse them.
 * Run: npx tsx scripts/debug-engagement.ts
 */
import { search } from "../src/reddit-search.js";
import { fetchComments } from "../src/reddit-comments.js";

async function main() {
  const posts = await search("AI headshot generator", {
    maxPages: 1,
    limit: 3,
    delayMs: 800,
  });
  console.log("Search returned", posts.length, "posts\n");
  for (const p of posts.slice(0, 2)) {
    console.log("Post id=%s sub=%s", p.id, p.subreddit);
    console.log("  From search: score=%s num_comments=%s", p.score, p.num_comments);
    try {
      const out = await fetchComments(p.subreddit!, p.id!, { delayMs: 600 });
      console.log("  From fetchComments: postScore=%s numComments=%s", out.postScore, out.numComments);
    } catch (e) {
      console.log("  fetchComments threw:", (e as Error).message);
    }
    console.log("");
  }
}

main();
