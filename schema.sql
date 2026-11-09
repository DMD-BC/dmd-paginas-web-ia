-- schema.sql — Tablas de cuentas, cuota y proyectos del builder DMD.
-- Ejecutar UNA vez en el editor SQL de Supabase (free) o Neon (free).
-- El código también crea estas tablas solo al primer uso (api/_db.js),
-- así que este archivo es sobre todo documentación / respaldo manual.
-- NUNCA pongas credenciales aquí: la conexión vive en DATABASE_URL
-- (variable de entorno de Vercel, Production + Preview).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  pass_hash TEXT NOT NULL,          -- scrypt, nunca en claro
  promo BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE = código DMDMX, límite 50
  used_count INTEGER NOT NULL DEFAULT 0, -- cambios consumidos (límite 25 / 50)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,  -- SHA-256 del token; el token real solo vive en la cookie httpOnly
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  html TEXT NOT NULL DEFAULT '',
  files JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, slug)
);
CREATE INDEX IF NOT EXISTS projects_user_idx ON projects (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS anon_usage (
  ip_hash TEXT PRIMARY KEY,         -- SHA-256 de la IP, nunca la IP en claro
  count INTEGER NOT NULL DEFAULT 0, -- cambios anónimos (límite 3 en total)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
