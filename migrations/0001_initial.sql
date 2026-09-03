PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  restaurant TEXT NOT NULL DEFAULT '',
  image_mime TEXT,
  image_blob BLOB,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS food_categories (
  food_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  PRIMARY KEY (food_id, category),
  FOREIGN KEY (food_id) REFERENCES foods(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  food_id INTEGER NOT NULL,
  reaction TEXT NOT NULL CHECK (reaction IN ('want', 'maybe', 'no')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (food_id) REFERENCES foods(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_food_categories_category ON food_categories(category, food_id);
CREATE INDEX IF NOT EXISTS idx_reactions_food_id_id ON reactions(food_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_foods_id_desc ON foods(id DESC);
