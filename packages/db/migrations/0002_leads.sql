-- People who left their email on the landing page before sign-up opened.
-- Each gets one email when sign-up opens: told_sign_up_open_at records it.
CREATE TABLE leads (
  email text PRIMARY KEY CHECK (email = lower(email)),
  first_use text,
  created_at timestamptz NOT NULL,
  told_sign_up_open_at timestamptz
);
