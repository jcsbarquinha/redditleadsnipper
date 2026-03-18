# Why the r/ScamChecker "is laroza.boats legit or scam?" Post Appears as #1 (and how to fix it)

**Saved as requested. No code has been changed.**

---

## Why this post can appear as #1

1. **Ranking is purely by AI intent score**  
   Leads are ordered by `post_intent.score` (then recency, then Reddit score). So whatever the model returns (e.g. 94 or 100) becomes the rank. If the model scores this post high, it will show first.

2. **Wrong product category is not being enforced**  
   The post is: “is laroza.boats legit or scam?” in r/ScamChecker — someone asking for a **scam check**, not for a product like Postiz (scheduling/social).  
   The intent prompt already has a rule: **“WRONG PRODUCT CATEGORY / STAGE MISMATCH (SCORE 0-39)”** — the author must be in the market for *this specific category* of solution. So either:
   - The model is not applying that rule to “legit or scam?”-style posts, or
   - The **product context** (what Postiz does) is too short/vague when the input is just a URL, so the model doesn’t see a clear category mismatch.

3. **Keyword overlap can mislead the model**  
   If search keywords for postiz.com include things like “social media”, “scheduling”, “posts”, the post body or the model’s own explanation might mention similar words (e.g. “automate posts”, “scheduling”). The model might then treat it as “related” and score it too high instead of treating it as “asking about a different product (scam check)”.

4. **Promoted posts are not filtered**  
   Reddit marks this post as “Promoted”. We don’t have `is_promoted` (or similar) in our data, so we never exclude ads. Promoted posts can rank high if the model still gives them a high intent score.

5. **Subreddit intent is ignored**  
   r/ScamChecker is about “is X legit or scam?” — not “I want to buy a scheduling tool”. We don’t use subreddit name or purpose in scoring, so the model may not down-rank purely “scam check” posts.

---

## Suggested fixes (implement only with your permission)

- **1. Tighten the intent prompt (ai-intent.ts)**  
  Add an explicit auto-fail rule, e.g.:  
  “**SCAM/LEGIT CHECK (SCORE 0-20):** The post is only asking whether a site/product is legit, a scam, or safe (e.g. ‘is X legit or scam?’, ‘is Y safe?’). The author is not asking for a recommendation to buy or use a product in the Product Context category. Auto-fail.”  
  That way “is laroza.boats legit or scam?” is forced into 0–20.

- **2. Richer product context for URL-only input (ai-keywords.ts / pipeline)**  
  When the user input is only a URL (e.g. postiz.com), ensure the keyword step returns a clear “what the product does” and “what problem it solves” (and that this is what we send as intent context). So the model sees “scheduling / social media tool” and can clearly treat “is X legit or scam?” as wrong category.

- **3. Optional: subreddit blocklist**  
  Add a small blocklist of subreddits where the primary intent is never “buy this kind of product” (e.g. r/ScamChecker, r/IsItAScam). Filter these out in the pipeline before or after scoring (e.g. set score to 0 or exclude from high-intent list). Only if you’re comfortable maintaining a list.

- **4. Optional: use Reddit’s “promoted” flag if we ever have it**  
  If we later get `is_promoted` (or equivalent) from the Reddit response, add a filter to exclude (or heavily down-rank) promoted posts so they don’t dominate #1.

- **5. Secondary ranking tie-break**  
  When intent scores are equal (or very close), consider tie-breaking by Reddit engagement (e.g. votes + comments) so low-engagement promoted posts don’t sit above organic, engaged posts. We already have `post_score` in the ORDER BY; we could add a small penalty for very low engagement if desired.

---

## Summary

The post appears #1 because the **AI gave it a high intent score** and we rank only by that. It shouldn’t be a “hot match” for Postiz because it’s a scam-check question, not a buyer for a scheduling tool. The most direct fix is **adding an explicit “scam/legit check = auto-fail” rule in the intent prompt** and ensuring **product context for URL-only searches is clear**. No code has been changed; apply any of the above only with your permission.
