const { Pool } = require('pg');

// Require the Supabase connection string explicitly.
// Set SUPABASE_DB_URL to your Supabase Postgres connection string (postgres://...)
// This file will fail fast in production if the value is missing to avoid silent localhost fallbacks.
const connectionString = process.env.SUPABASE_DB_URL;

if (!connectionString) {
  const msg = 'SUPABASE_DB_URL is not set. Set SUPABASE_DB_URL to your Supabase Postgres connection string.';
  if (process.env.NODE_ENV === 'production') {
    console.error(msg);
    throw new Error(msg);
  } else {
    // During local development we still throw so you notice the missing config.
    // If you want to run locally without Supabase, set SUPABASE_DB_URL to a local Postgres URI.
    console.warn(msg, ' Falling back will NOT be attempted.');
    // Optionally: process.exit(1); // uncomment to stop startup in dev too
  }
}

console.log('Using DB connection from SUPABASE_DB_URL');
if (connectionString) {
  console.log('DB connection prefix:', connectionString.slice(0, 40) + (connectionString.length > 40 ? '...' : ''));
}

const pool = new Pool({
  connectionString,
  // Supabase requires TLS — disable strict cert verification for convenience.
  // If you want stricter TLS verification, remove rejectUnauthorized:false and configure CA.
  ssl: { rejectUnauthorized: false }
});

// Surface unexpected client errors to logs so connection problems are visible.
pool.on && pool.on('error', (err) => {
  console.error('Unexpected Postgres client error', err);
});

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
  if (!connectionString) {
    throw new Error('SUPABASE_DB_URL is not set. Cannot initialize schema.');
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
