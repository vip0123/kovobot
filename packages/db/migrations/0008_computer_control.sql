-- Since when the Customer has had the mouse and keyboard of their Bot's Computer; null while
-- the Bot may use it. A Bot at work on its Computer waits until this is null again.
ALTER TABLE bots ADD COLUMN computer_controlled_at timestamptz;
