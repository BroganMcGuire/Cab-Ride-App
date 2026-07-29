const express = require('express');
const { pool } = require('../db');
const { buildRidePdf } = require('../pdf');

const router = express.Router();

function rideName(startedAt) {
  const d = new Date(startedAt);
  return `Ride ${d.toISOString().slice(0, 16).replace('T', ' ')}`;
}

// Create a new ride
router.post('/', async (req, res) => {
  try {
    const { name, defaultElr, defaultTrackId, riderName } = req.body || {};

    const finalName =
      name && name.trim()
        ? name.trim()
        : rideName(new Date());

    console.log('Creating ride:', {
      finalName,
      defaultElr: defaultElr || null,
      defaultTrackId: defaultTrackId || null,
      riderName: riderName || null
    });

    const { rows } = await pool.query(
      `INSERT INTO rides (
        name,
        default_elr,
        default_track_id,
        rider_name
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *`,
      [
        finalName,
        defaultElr || null,
        defaultTrackId || null,
        riderName || null
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('CREATE RIDE ERROR:', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      hint: err.hint,
      stack: err.stack
    });

    res.status(500).json({
      error: err.message || 'Failed to create ride',
      code: err.code || null,
      detail: err.detail || null,
      hint: err.hint || null
    });
  }
});

// List rides (history), most recent first
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*, COUNT(f.id)::int AS fault_count
      FROM rides r
      LEFT JOIN faults f ON f.ride_id = r.id
      GROUP BY r.id
      ORDER BY r.started_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list rides' });
  }
});

// Get one ride + its faults
router.get('/:id', async (req, res) => {
  try {
    const { rows: rideRows } = await pool.query('SELECT * FROM rides WHERE id=$1', [req.params.id]);
    if (!rideRows.length) return res.status(404).json({ error: 'Ride not found' });
    const { rows: faultRows } = await pool.query(
      'SELECT * FROM faults WHERE ride_id=$1 ORDER BY captured_at ASC',
      [req.params.id]
    );
    res.json({ ...rideRows[0], faults: faultRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load ride' });
  }
});

// Update ride (rename, end ride, notes, set default ELR/Track)
router.patch('/:id', async (req, res) => {
  try {
    const { name, notes, status, defaultElr, defaultTrackId, riderName } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE rides SET
         name = COALESCE($2, name),
         notes = COALESCE($3, notes),
         status = COALESCE($4, status),
         default_elr = COALESCE($5, default_elr),
         default_track_id = COALESCE($6, default_track_id),
         rider_name = COALESCE($7, rider_name),
         ended_at = CASE WHEN $4 = 'completed' AND ended_at IS NULL THEN now() ELSE ended_at END
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, notes, status, defaultElr, defaultTrackId, riderName]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ride not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update ride' });
  }
});

// Delete a ride
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM rides WHERE id=$1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete ride' });
  }
});

// Add a fault to a ride. client_id lets the offline queue safely retry without duplicating.
router.post('/:id/faults', async (req, res) => {
  try {
    const {
      clientId, faultType, severity, lat, lng, gpsAccuracyM,
      elr, trackId, mileageMiles, mileageYards, matchDistanceM,
      notes, capturedAt,
    } = req.body || {};

    if (!['top', 'alignment'].includes(faultType)) {
      return res.status(400).json({ error: 'faultType must be "top" or "alignment"' });
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat/lng required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO faults (
         ride_id, client_id, fault_type, severity, lat, lng, gps_accuracy_m,
         elr, track_id, mileage_miles, mileage_yards, match_distance_m, notes, captured_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14, now()))
       ON CONFLICT (ride_id, client_id) DO UPDATE SET
         fault_type = EXCLUDED.fault_type,
         severity = EXCLUDED.severity
       RETURNING *`,
      [
        req.params.id, clientId || null, faultType, severity || 'moderate', lat, lng, gpsAccuracyM || null,
        elr || null, trackId || null, mileageMiles ?? null, mileageYards ?? null, matchDistanceM ?? null,
        notes || null, capturedAt || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save fault' });
  }
});

// Edit a fault (e.g. correct ELR/mileage or severity after review)
router.patch('/:id/faults/:faultId', async (req, res) => {
  try {
    const { faultType, severity, elr, trackId, mileageMiles, mileageYards, notes } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE faults SET
         fault_type = COALESCE($3, fault_type),
         severity = COALESCE($4, severity),
         elr = COALESCE($5, elr),
         track_id = COALESCE($6, track_id),
         mileage_miles = COALESCE($7, mileage_miles),
         mileage_yards = COALESCE($8, mileage_yards),
         notes = COALESCE($9, notes)
       WHERE ride_id=$1 AND id=$2 RETURNING *`,
      [req.params.id, req.params.faultId, faultType, severity, elr, trackId, mileageMiles, mileageYards, notes]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fault not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update fault' });
  }
});

// Delete a fault (mis-tap correction)
router.delete('/:id/faults/:faultId', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM faults WHERE ride_id=$1 AND (id::text = $2 OR client_id = $2)`,
      [req.params.id, req.params.faultId]
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete fault' });
  }
});

// Export a ride's faults to PDF
router.get('/:id/export.pdf', async (req, res) => {
  try {
    const { rows: rideRows } = await pool.query('SELECT * FROM rides WHERE id=$1', [req.params.id]);
    if (!rideRows.length) return res.status(404).json({ error: 'Ride not found' });
    const { rows: faultRows } = await pool.query(
      'SELECT * FROM faults WHERE ride_id=$1 ORDER BY captured_at ASC',
      [req.params.id]
    );
    const pdfBytes = await buildRidePdf(rideRows[0], faultRows);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${rideRows[0].name.replace(/[^a-z0-9]+/gi, '_')}_faults.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to export PDF' });
  }
});

module.exports = router;
