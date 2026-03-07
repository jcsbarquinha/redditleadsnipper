/**
 * Shared types for Reddit extraction (JSON workaround).
 */

export interface RedditPost {
  id: string | null;
  title: string | null;
  selftext: string;
  score: number | null;
  num_comments: number | null;
  permalink: string;
  full_link: string;
  subreddit: string | null;
  subreddit_id: string | null;
  author: string | null;
  created_utc: number | null;
  url: string | null;
  is_self: boolean | null;
  over_18: boolean | null;
  link_flair_text: string | null;
  comments: RedditComment[];
}

export interface RedditComment {
  id: string | null;
  body: string;
  author: string | null;
  score: number | null;
  created_utc: number | null;
}

export interface SearchResultPayload {
  query: string;
  fetched_at: string;
  posts: RedditPost[];
}
