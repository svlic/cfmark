CREATE TABLE platforms (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  default_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  platform_id INTEGER NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
  username TEXT, login_url TEXT, email TEXT, phone TEXT, notes TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  tags TEXT NOT NULL DEFAULT '[]' CHECK(CASE WHEN json_valid(tags) THEN json_type(tags) = 'array' ELSE 0 END),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(COALESCE(TRIM(username),'') <> '' OR COALESCE(TRIM(email),'') <> '' OR COALESCE(TRIM(phone),'') <> '')
);
CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX accounts_platform ON accounts(platform_id);
CREATE INDEX accounts_category ON accounts(category_id);
CREATE INDEX accounts_email ON accounts(email);
CREATE INDEX accounts_username ON accounts(username);
CREATE INDEX sessions_expiry ON sessions(expires_at);
INSERT INTO categories(name,sort_order) VALUES ('邮箱服务',0),('AI 工具',1),('云服务',2),('开发工具',3),('社交平台',4),('效率工具',5),('社区论坛',6),('其他',7);
