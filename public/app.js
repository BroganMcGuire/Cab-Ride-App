(() => {
  const $ = (sel) => document.querySelector(sel);

  const screens = { home: $('#screen-home'), ride: $('#screen-ride') };
  const el = {
    netPill: $('#status-net'),
    gpsPill: $('#status-gps'),
    ridePill: $('#status-ride'),
    newRideBtn: $('#btn-new-ride'),
    historyList: $('#ride-history-list'),
    backBtn: $('#btn-back'),
    exportBtn: $('#btn-export'),
    rideNameInput: $('#ride-name-input'),
    rideMeta: $('#ride-meta'),
    roElr: $('#ro-elr'),
    roTrack: $('#ro-track'),
    roMileage: $('#ro-mileage'),
    roConfidence: $('#ro-confidence'),
    faultButtons: $('#fault-buttons'),
    endRideBtn: $('#btn-end-ride'),
    faultCount: $('#fault-count'),
    faultList: $('#fault-list'),
    sevOverlay: $('#severity-overlay'),
    sevTitle: $('#severity-title'),
    sevCancel: $('#severity-cancel'),
    toast: $('#toast'),
  };

  let state = {
    ride: null,          // currently open ride record
    faults: [],          // local faults for current ride (merged local+server)
    watchId: null,
    lastFix: null,        // { lat, lng, accuracy }
    lastLocate: null,     // TrackLookup result
    pendingType: null,    // fault type awaiting severity pick
    map: null,
    posMarker: null,
    faultMarkers: [],
  };

  // ---------- utils ----------
  function toast(msg, ms = 2600) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  function uuid() {
    return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }

  function fmtMileage(miles, yards) {
    if (miles === null || miles === undefined) return '—';
    return `${miles}m ${String(yards).padStart(4, '0')}yd`;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return res.status === 204 ? null : res.json();
  }

  // ---------- network / gps status ----------
  function updateNetPill() {
    const online = navigator.onLine;
    el.netPill.textContent = online ? 'ONLINE' : 'OFFLINE';
    el.netPill.className = 'pill ' + (online ? 'ok' : 'warn');
    if (online) syncPending();
  }
  window.addEventListener('online', updateNetPill);
  window.addEventListener('offline', updateNetPill);

  function updateGpsPill(accuracy) {
    if (accuracy == null) { el.gpsPill.textContent = 'GPS —'; el.gpsPill.className = 'pill'; return; }
    el.gpsPill.textContent = `GPS ±${Math.round(accuracy)}m`;
    el.gpsPill.className = 'pill ' + (accuracy <= 15 ? 'ok' : accuracy <= 40 ? 'warn' : 'bad');
  }

  // ---------- screens ----------
  function showScreen(name) {
    Object.entries(screens).forEach(([k, node]) => { node.hidden = k !== name; });
    el.ridePill.hidden = !(name === 'ride' && state.ride && state.ride.status === 'active');
  }

  async function showHome() {
    stopGpsWatch();
    state.ride = null;
    showScreen('home');
    await loadHistory();
  }

  async function loadHistory() {
    el.historyList.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
      const rides = await api('/api/rides');
      if (!rides.length) {
        el.historyList.innerHTML = '<p class="empty-hint">No rides yet — start one above.</p>';
        return;
      }
      el.historyList.innerHTML = '';
      rides.forEach((r) => {
        const card = document.createElement('div');
        card.className = 'ride-card';
        const started = new Date(r.started_at);
        card.innerHTML = `
          <div>
            <div class="ride-card-name">${escapeHtml(r.name)}</div>
            <div class="ride-card-meta">${started.toLocaleDateString()} ${started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${r.fault_count} fault${r.fault_count === 1 ? '' : 's'}</div>
          </div>
          <span class="ride-card-badge ${r.status === 'completed' ? 'completed' : ''}">${r.status === 'active' ? 'ACTIVE' : 'DONE'}</span>
        `;
        card.addEventListener('click', () => openRide(r.id));
        el.historyList.appendChild(card);
      });
    } catch (err) {
      el.historyList.innerHTML = `<p class="empty-hint">Couldn't load ride history (${err.message}). Are you online?</p>`;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function startNewRide() {
    try {
      const ride = await api('/api/rides', { method: 'POST', body: {} });
      await openRide(ride.id, ride);
    } catch (err) {
      toast(`Couldn't start ride — ${err.message}`);
    }
  }

  async function openRide(rideId, prefetched) {
    try {
      let ride = prefetched;
      let serverFaults = [];
      try {
        const full = await api(`/api/rides/${rideId}`);
        ride = full;
        serverFaults = full.faults || [];
      } catch (e) {
        if (!prefetched) throw e; // no cache and no network — can't open
      }
      state.ride = ride;
      const localFaults = await IDB.getFaultsForRide(rideId);
      state.faults = mergeFaults(serverFaults, localFaults);

      el.rideNameInput.value = ride.name;
      el.rideNameInput.disabled = ride.status !== 'active';
      el.rideMeta.textContent = `${ride.status === 'active' ? 'Recording' : 'Completed'} · ${new Date(ride.started_at).toLocaleString()}`;
      el.faultButtons.style.display = ride.status === 'active' ? 'flex' : 'none';
      el.endRideBtn.style.display = ride.status === 'active' ? 'block' : 'none';

      showScreen('ride');
      initMap();
      renderFaultList();
      renderFaultMarkers();

      if (ride.status === 'active') {
        startGpsWatch();
      } else {
        stopGpsWatch();
        el.roConfidence.textContent = 'Ride completed';
      }
    } catch (err) {
      toast(`Couldn't open ride — ${err.message}`);
    }
  }

  function mergeFaults(serverFaults, localFaults) {
    const byClientId = new Map();
    serverFaults.forEach((f) => byClientId.set(f.client_id || f.id, normalizeServerFault(f)));
    localFaults.forEach((f) => {
      if (!byClientId.has(f.clientId)) byClientId.set(f.clientId, normalizeLocalFault(f));
    });
    return [...byClientId.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  function normalizeServerFault(f) {
    return {
      clientId: f.client_id || f.id, id: f.id, faultType: f.fault_type, severity: f.severity,
      lat: f.lat, lng: f.lng, gpsAccuracyM: f.gps_accuracy_m, elr: f.elr, trackId: f.track_id,
      mileageMiles: f.mileage_miles, mileageYards: f.mileage_yards, matchDistanceM: f.match_distance_m,
      capturedAt: f.captured_at, synced: true,
    };
  }
  function normalizeLocalFault(f) { return { ...f, synced: !!f.synced }; }

  // ---------- ride name editing ----------
  el.rideNameInput.addEventListener('change', async () => {
    if (!state.ride) return;
    try {
      await api(`/api/rides/${state.ride.id}`, { method: 'PATCH', body: { name: el.rideNameInput.value } });
    } catch (err) { toast('Rename failed (offline?) — will not persist'); }
  });

  // ---------- map ----------
  function initMap() {
    if (state.map) { setTimeout(() => state.map.invalidateSize(), 50); return; }
    state.map = L.map('map', { zoomControl: true, attributionControl: false });
    state.map.setView([54.0, -2.5], 6); // UK-ish default until we get a fix
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(state.map);
  }

  function renderFaultMarkers() {
    state.faultMarkers.forEach((m) => state.map.removeLayer(m));
    state.faultMarkers = [];
    state.faults.forEach((f) => {
      const color = f.faultType === 'top' ? '#d9720f' : '#2f8fc4';
      const marker = L.circleMarker([f.lat, f.lng], {
        radius: 7, color: '#0d1011', weight: 1.5, fillColor: color, fillOpacity: 0.95,
      }).bindPopup(`<b>${f.faultType.toUpperCase()}</b> (${f.severity})<br>${f.elr || '—'} ${f.trackId || ''}<br>${fmtMileage(f.mileageMiles, f.mileageYards)}`);
      marker.addTo(state.map);
      state.faultMarkers.push(marker);
    });
  }

  // ---------- GPS ----------
  function startGpsWatch() {
    if (!('geolocation' in navigator)) { toast('No GPS available on this device/browser'); return; }
    stopGpsWatch();
    state.watchId = navigator.geolocation.watchPosition(onFix, onGpsError, {
      enableHighAccuracy: true, maximumAge: 1000, timeout: 15000,
    });
  }
  function stopGpsWatch() {
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  function onGpsError(err) {
    updateGpsPill(null);
    el.roConfidence.textContent = `GPS error: ${err.message}`;
  }
  function onFix(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    state.lastFix = { lat, lng, accuracy };
    updateGpsPill(accuracy);

    if (state.map) {
      if (!state.posMarker) {
        state.posMarker = L.circleMarker([lat, lng], {
          radius: 8, color: '#fff', weight: 2, fillColor: '#e8930c', fillOpacity: 1,
        }).addTo(state.map);
        state.map.setView([lat, lng], 15);
      } else {
        state.posMarker.setLatLng([lat, lng]);
        state.map.panTo([lat, lng], { animate: true });
      }
    }

    if (TrackLookup.isReady()) {
      const result = TrackLookup.locate(lat, lng);
      state.lastLocate = result;
      updateReadout(result, accuracy);
    } else {
      el.roConfidence.textContent = 'Loading track reference data…';
    }
  }

  function updateReadout(result, accuracy) {
    if (!result) {
      el.roElr.textContent = '—';
      el.roTrack.textContent = '—';
      el.roMileage.textContent = '—';
      el.roConfidence.textContent = 'No track line matched nearby (off-network or data gap)';
      return;
    }
    el.roElr.textContent = result.elr;
    el.roTrack.textContent = result.trackId;
    el.roMileage.textContent = fmtMileage(result.mileageMiles, result.mileageYards);
    const precision = result.refined ? 'milepost-calibrated' : 'approximate';
    el.roConfidence.textContent = `± ${accuracy ? Math.round(accuracy) : '?'}m GPS · ${result.distanceM}m from centreline · ${precision}`;
  }

  // ---------- fault capture ----------
  el.faultButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('.fault-btn');
    if (!btn) return;
    if (!state.lastFix) { toast('Waiting for GPS fix before logging a fault…'); return; }
    state.pendingType = btn.dataset.type;
    el.sevTitle.textContent = `${state.pendingType.toUpperCase()} fault — severity?`;
    el.sevOverlay.hidden = false;
  });

  el.sevOverlay.addEventListener('click', async (e) => {
    if (e.target === el.sevOverlay || e.target === el.sevCancel) {
      el.sevOverlay.hidden = true;
      state.pendingType = null;
      return;
    }
    const btn = e.target.closest('.sev-btn');
    if (!btn) return;
    await captureFault(state.pendingType, btn.dataset.sev);
    el.sevOverlay.hidden = true;
    state.pendingType = null;
  });

  async function captureFault(faultType, severity) {
    const fix = state.lastFix;
    const locate = state.lastLocate;
    const fault = {
      clientId: uuid(),
      rideId: state.ride.id,
      faultType, severity,
      lat: fix.lat, lng: fix.lng, gpsAccuracyM: fix.accuracy,
      elr: locate ? locate.elr : null,
      trackId: locate ? locate.trackId : null,
      mileageMiles: locate ? locate.mileageMiles : null,
      mileageYards: locate ? locate.mileageYards : null,
      matchDistanceM: locate ? locate.distanceM : null,
      capturedAt: new Date().toISOString(),
      synced: false,
    };
    await IDB.saveFault(fault);
    state.faults.push(fault);
    renderFaultList();
    renderFaultMarkers();
    toast(`${faultType.toUpperCase()} logged — ${fault.elr || 'location pending'} ${fmtMileage(fault.mileageMiles, fault.mileageYards)}`);
    if (navigator.vibrate) navigator.vibrate(40);
    syncFault(fault);
  }

  async function deleteFaultRow(clientId) {
    const target = state.faults.find((f) => f.clientId === clientId);
    state.faults = state.faults.filter((f) => f.clientId !== clientId);
    renderFaultList();
    renderFaultMarkers();
    await IDB.deleteFault(clientId);
    if (state.ride && target && target.synced && navigator.onLine) {
      try {
        await api(`/api/rides/${state.ride.id}/faults/${clientId}`, { method: 'DELETE' });
      } catch (e) { /* fault may already be gone server-side; safe to ignore */ }
    }
  }

  function renderFaultList() {
    el.faultCount.textContent = state.faults.length;
    el.faultList.innerHTML = '';
    [...state.faults].reverse().forEach((f) => {
      const row = document.createElement('div');
      row.className = 'fault-row' + (f.synced ? '' : ' pending');
      const t = new Date(f.capturedAt);
      row.innerHTML = `
        <span class="fault-tag ${f.faultType}">${f.faultType === 'top' ? 'TOP' : 'ALIGN'}</span>
        <span class="fault-sev-dot ${f.severity}"></span>
        <div class="fault-row-main">
          <div class="fault-row-loc">${f.elr || '—'} ${f.trackId || ''} · ${fmtMileage(f.mileageMiles, f.mileageYards)}</div>
          <div class="fault-row-time">${t.toLocaleTimeString()} ${f.synced ? '' : '· <span class="fault-row-pending-badge">SYNCING…</span>'}</div>
        </div>
        <button class="fault-row-del" aria-label="Delete" data-id="${f.clientId}">✕</button>
      `;
      row.querySelector('.fault-row-del').addEventListener('click', () => deleteFaultRow(f.clientId));
      el.faultList.appendChild(row);
    });
  }

  // ---------- sync ----------
  async function syncFault(fault) {
    if (!navigator.onLine) return;
    try {
      const saved = await api(`/api/rides/${fault.rideId}/faults`, {
        method: 'POST',
        body: {
          clientId: fault.clientId, faultType: fault.faultType, severity: fault.severity,
          lat: fault.lat, lng: fault.lng, gpsAccuracyM: fault.gpsAccuracyM,
          elr: fault.elr, trackId: fault.trackId, mileageMiles: fault.mileageMiles,
          mileageYards: fault.mileageYards, matchDistanceM: fault.matchDistanceM,
          capturedAt: fault.capturedAt,
        },
      });
      await IDB.markSynced(fault.clientId, { id: saved.id });
      const local = state.faults.find((f) => f.clientId === fault.clientId);
      if (local) local.synced = true;
      renderFaultList();
    } catch (err) {
      // stays queued; will retry on next sync pass
    }
  }

  async function syncPending() {
    const pending = await IDB.getUnsynced();
    for (const f of pending) await syncFault(f);
  }
  setInterval(syncPending, 20000);

  // ---------- end ride / export ----------
  el.endRideBtn.addEventListener('click', async () => {
    if (!confirm('End this ride? You can still export or review it afterward.')) return;
    try {
      await syncPending();
      const updated = await api(`/api/rides/${state.ride.id}`, { method: 'PATCH', body: { status: 'completed' } });
      state.ride = updated;
      stopGpsWatch();
      toast('Ride ended.');
      openRide(updated.id, updated);
    } catch (err) {
      toast(`Couldn't end ride (offline?) — will keep recording. ${err.message}`);
    }
  });

  el.exportBtn.addEventListener('click', async () => {
    if (!state.ride) return;
    if (!navigator.onLine) { toast('Connect to the internet to export a PDF'); return; }
    await syncPending();
    window.open(`/api/rides/${state.ride.id}/export.pdf`, '_blank');
  });

  el.backBtn.addEventListener('click', showHome);
  el.newRideBtn.addEventListener('click', startNewRide);

  // ---------- boot ----------
  async function boot() {
    updateNetPill();
    updateGpsPill(null);
    TrackLookup.load().then(() => {
      if (state.lastFix) onFix({ coords: { latitude: state.lastFix.lat, longitude: state.lastFix.lng, accuracy: state.lastFix.accuracy } });
    }).catch(() => toast('Could not load offline track reference data'));

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    await showHome();
    syncPending();
  }
  boot();
})();
