-- Skills: named instructions a Customer writes once and grants to their Bots. The model
-- sees each granted Skill's name and description, and reads its instructions when it applies.
CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1024),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 30000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
-- A Bot asks for a Skill by name, so each name is one Skill's only, whatever its case.
CREATE UNIQUE INDEX skills_one_name_per_customer ON skills (customer_id, lower(name));

-- Which Bots have which Skills.
CREATE TABLE bot_skills (
  bot_id uuid NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  PRIMARY KEY (bot_id, skill_id)
);
CREATE INDEX bot_skills_skill_id ON bot_skills (skill_id);
