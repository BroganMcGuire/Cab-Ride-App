const { Pool } = require('pg');

// Use Supabase DB URL if provided, otherwise fall back to DATABASE_URL
const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

// In production, fail fast if no connection string
if (!connectionString && process.env.NODE_ENV === 'production') {
  console.error('DATABASE_URL or SUPABASE_DB_URL is missing. Add your Supabase Postgres connection string to the environment.');
}

const isLocal = (str) =>
  !str ||
  str.includes('localhost') ||
  str.includes('127.0.0.1') ||
  str.startsWith('postgres://localhost') ||
  str.startsWith('postgres://127.0.0.1');

const pool = new Pool(
  connectionString
    ? {
        connectionString,
        // enable SSL for non-local hosts (Supabase requires SSL)
        ssl: isLocal(connectionString) ? false : { rejectUnauthorized: false }
      }
    : {
        host: process.env.PGHOST || 'localhost',
        port: process.env.PGPORT || 5432,
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'postgres',
        database: process.env.PGDATABASE || 'cabride'
      }
);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  default_elr TEXT,
  default_track_id TEXT,
  rider_name TEXT,
  notes TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS faults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  client_id TEXT,
  fault_type TEXT NOT NULL CHECK (fault_type IN ('top','alignment')),
  severity TEXT NOT NULL DEFAULT 'moderate' CHECK (severity IN ('slight','moderate','severe')),
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  gps_accuracy_m DOUBLE PRECISION,
  elr TEXT,
  track_id TEXT,
  mileage_miles INTEGER,
  mileage_yards INTEGER,
  match_distance_m DOUBLE PRECISION,
  notes TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ride_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_faults_ride ON faults(ride_id);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
`;

async function initSchema() {
  if (!connectionString && process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL or SUPABASE_DB_URL is missing on production. Add your Supabase Postgres connection string in the environment.');
  }

  console.log('Checking database connection...');
  const result = await pool.query('SELECT now() AS now');
  console.log('Database connected:', result.rows[0].now);

  console.log('Ensuring pgcrypto extension exists...');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  console.log('Ensuring database schema exists...');
  await pool.query(SCHEMA);

  console.log('Database schema ready.');
}

if (require.main === module && process.argv.includes('--init')) {
  initSchema()
    .then(() => {
      console.log('Schema ready.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Schema init failed:', {
        message: err.message,
        code: err.code,
        detail: err.detail,
        hint: err.hint,
        stack: err.stack
      });
      process.exit(1);
    });
}

module.exports = { pool, initSchema };
