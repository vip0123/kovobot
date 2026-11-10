-- The web pages a Bot's reply drew on, from its Model provider's web search: [{ "url", "title" }].
ALTER TABLE messages ADD COLUMN sources jsonb;
-- Google's search suggestions for a reply grounded with Google Search, as the HTML Google sent.
ALTER TABLE messages ADD COLUMN search_suggestions text;
