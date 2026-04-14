// --- ONLY SHOWING MODIFIED / NEW PARTS ---

const ALL_MODES = {
  drive:   { color: '#ef4444', label: '🚗 Drive',  defaultOn: true  },
  transit: { color: '#a855f7', label: '🚌 Transit', defaultOn: true  },
  uber:    { color: '#38bdf8', label: '🚕 Uber',    defaultOn: false },
  walk:    { color: '#22c55e', label: '🚶 Walk',    defaultOn: true  },
  cycle:   { color: '#f59e0b', label: '🚴 Cycle',   defaultOn: true  }, // NEW
}

const CO2_PER_KM = { drive: 171, transit: 89, uber: 171, walk: 0, cycle: 0 }

// UPDATED LIMITS
const MAX_WALK_SECONDS = 3 * 60 * 60
const MAX_CYCLE_SECONDS = 5 * 60 * 60

// ---------------- FETCH ----------------

async function handleSearch() {
  setError(''); setRoutes({}); setLoading(true)
  try {
    const [oLng, oLat] = await geocode(origin)
    const [dLng, dLat] = await geocode(destination)

    setMarkers([
      { lat: oLat, lng: oLng, label: 'Start: ' + origin },
      { lat: dLat, lng: dLng, label: 'End: ' + destination }
    ])

    const [drive, walk, cycle, transit, uber] = await Promise.all([
      fetchORSRoute('driving-car',  [oLng, oLat], [dLng, dLat]),
      fetchORSRoute('foot-walking', [oLng, oLat], [dLng, dLat]),
      fetchORSRoute('cycling-road', [oLng, oLat], [dLng, dLat]), // NEW
      fetchTransitRoute(oLat, oLng, dLat, dLng).catch(() => null),
      fetchUberRoute(oLat, oLng, dLat, dLng).catch(() => null),
    ])

    const newRoutes = { drive, walk, cycle }

    if (transit) newRoutes.transit = transit
    if (uber) newRoutes.uber = uber

    setRoutes(newRoutes)
    setBounds(L.latLngBounds(Object.values(newRoutes).flatMap(r => r.coords)))

  } catch (e) {
    setError(e.response?.data?.error?.message || e.message)
  } finally {
    setLoading(false)
  }
}

// ---------------- BEST MODE FIX ----------------

const bestModes = useMemo(() => {
  if (Object.keys(scored).length === 0) return []

  // filter OUT invalid ones ONLY for best calculation
  const validEntries = Object.entries(scored).filter(([key, r]) => {
    if (key === 'walk' && r.duration > MAX_WALK_SECONDS) return false
    if (key === 'cycle' && r.duration > MAX_CYCLE_SECONDS) return false
    return true
  })

  if (validEntries.length === 0) return []

  const top = Math.max(...validEntries.map(([, r]) => r.smartScore))

  return validEntries
    .filter(([, r]) => top - r.smartScore <= 5)
    .map(([k]) => k)

}, [scored])

// ---------------- OPTIONAL (nice UX improvement) ----------------

// Add this inside your result card rendering (under "* estimated")
{(key === 'walk' && r.duration > MAX_WALK_SECONDS) && (
  <div style={{ color: '#f87171', fontSize: 9, marginTop: 4 }}>
    {'Too long to recommend'}
  </div>
)}

{(key === 'cycle' && r.duration > MAX_CYCLE_SECONDS) && (
  <div style={{ color: '#f87171', fontSize: 9, marginTop: 4 }}>
    {'Too long to recommend'}
  </div>
)}