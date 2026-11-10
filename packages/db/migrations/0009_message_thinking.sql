-- What the model thought before a Bot's reply, as its Model provider showed it; null when it showed none.
ALTER TABLE messages ADD COLUMN thinking text;
