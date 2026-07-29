const { Pool } = require('pg');

// Render provides DATABASE_URL automatically when a Postgres DB is linked to the service.
// Falls back to individual PG* env vars for local dev.
const connectionString = process.env.DATABASE_URL;

const pool = new Pool(
  connectionString
    ? { connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } }
    : {
        host: process.env.PGHOST || 'localhost',
        port: process.env.PGPORT || 5432,
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'postgres',
        database: process.env.PGDATABASE || 'cabride',
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
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  await pool.query(SCHEMA);
}

if (require.main === module && process.argv.includes('--init')) {
  initSchema()
    .then(() => { console.log('Schema ready.'); process.exit(0); })
    .catch((err) => { console.error('Schema init failed:', err); process.exit(1); });
}

module.exports = { pool, initSchema };
