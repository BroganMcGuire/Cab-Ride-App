const express = require('express');
const path = require('path');
const compression = require('compression');
const { initSchema } = require('./db');
const ridesRouter = require('./routes/rides');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(express.json({ limit: '1mb' }));

app.use('/api/rides', ridesRouter);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Static frontend (PWA). Cache-bust the big geospatial data file gently; let the
// service worker own long-term offline caching.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('track-links.json')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function start() {
  try {
    await initSchema();
    console.log('Database schema ready.');
  } catch (err) {
    console.error('WARNING: could not initialize database schema on startup:', err.message);
    console.error('The app will keep running, but ride/fault storage will fail until DATABASE_URL is set correctly.');
  }
  app.listen(PORT, () => console.log(`Cab ride fault logger listening on port ${PORT}`));
}

start();
