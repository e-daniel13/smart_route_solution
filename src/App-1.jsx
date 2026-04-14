import { useState, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import axios from 'axios'
import L from 'leaflet'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

L.Icon.Default.mergeOptions({ iconUrl: markerIcon, shadowUrl: markerShadow })

const ORS_KEY = import.meta.env.VITE_ORS_API_KEY

const ALL_MODES = {
  drive:   { color: '#ef4444', label: '🚗 Drive',  defaultOn: true  },
  transit: { color: '#a855f7', label: '🚌 Transit', defaultOn: true  },
  uber:    { color: '#38bdf8', label: '🚕 Uber',    defaultOn: false },
  walk:    { color: '#22c55e', label: '🚶 Walk',    defaultOn: true  },
}

const CO2_PER_KM = { drive: 171, transit: 89, uber: 171, walk: 0 }

function driveCost(distKm, eff, price) { return (distKm / 100) * eff * price }
function transitFare(distKm) { return distKm < 30 ? 3.50 : 11.40 }
function uberFare(distKm) { return 2.50 + distKm * 1.80 }

function decodePolyline(encoded) {
  let index = 0, lat = 0, lng = 0
  const coords = []
  while (index < encoded.length) {
    let b, shift = 0, result = 0
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1
    shift = 0; result = 0
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lng += result & 1 ? ~(result >> 1) : result >> 1
    coords.push([lat / 1e5, lng / 1e5])
  }
  return coords
}

function MapFitter({ bounds }) {
  const map = useMap()
  if (bounds) map.fitBounds(bounds, { padding: [40, 40] })
  return null
}

function formatTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h > 0 ? (h + 'h ' + m + 'm') : (m + 'm')
}
function formatDist(m) {
  return m >= 1000 ? ((m / 1000).toFixed(1) + ' km') : (Math.round(m) + ' m')
}
function formatCost(d) { return d === 0 ? 'Free' : ('$' + d.toFixed(2)) }
function formatCO2(g) { return g >= 1000 ? ((g / 1000).toFixed(2) + ' kg') : (Math.round(g) + ' g') }

async function fetchORSRoute(profile, start, end) {
  const res = await axios.post(
    'https://api.openrouteservice.org/v2/directions/' + profile,
    { coordinates: [start, end], preference: 'fastest' },
    { headers: { Authorization: ORS_KEY, 'Content-Type': 'application/json' } }
  )
  const route = res.data.routes[0]
  return { coords: decodePolyline(route.geometry), distance: route.summary.distance, duration: route.summary.duration }
}

async function fetchTransitRoute(oLat, oLng, dLat, dLng) {
  const driving = await fetchORSRoute('driving-car', [oLng, oLat], [dLng, dLat])
  const distKm = driving.distance / 1000
  let multiplier, waitSeconds
  if (distKm < 5)       { multiplier = 2.0; waitSeconds = 300  }
  else if (distKm < 30) { multiplier = 1.7; waitSeconds = 480  }
  else                  { multiplier = 1.4; waitSeconds = 900 }
  return { coords: driving.coords, duration: driving.duration * multiplier + waitSeconds, distance: driving.distance * 1.1, isEstimate: true }
}

async function fetchUberRoute(oLat, oLng, dLat, dLng) {
  const driving = await fetchORSRoute('driving-car', [oLng, oLat], [dLng, dLat])
  return { coords: driving.coords, duration: driving.duration * 1.1, distance: driving.distance, isEstimate: true }
}

async function geocode(address) {
  const res = await axios.get('https://api.openrouteservice.org/geocode/search', {
    params: { api_key: ORS_KEY, text: address, size: 1 }
  })
  const feature = res.data.features[0]
  if (!feature) throw new Error('Could not find: "' + address + '"')
  return feature.geometry.coordinates
}

function scoreRoutes(routes, weights, fuelPrice, fuelEfficiency) {
  const keys = Object.keys(routes)
  const raw = {}
  keys.forEach(key => {
    const distKm = routes[key].distance / 1000
    let cost = 0
    if (key === 'drive') cost = driveCost(distKm, fuelEfficiency, fuelPrice)
    else if (key === 'transit') cost = transitFare(distKm)
    else if (key === 'uber') cost = uberFare(distKm)
    raw[key] = { time: routes[key].duration, cost, co2: (CO2_PER_KM[key] ?? 0) * distKm }
  })
  const vals = metric => keys.map(k => raw[k][metric])
  const mmTime = { min: Math.min(...vals('time')), max: Math.max(...vals('time')) }
  const mmCost = { min: Math.min(...vals('cost')), max: Math.max(...vals('cost')) }
  const mmCo2  = { min: Math.min(...vals('co2')),  max: Math.max(...vals('co2'))  }
  const norm = (v, mm) => mm.max === mm.min ? 100 : 100 - ((v - mm.min) / (mm.max - mm.min)) * 100
  const scored = {}
  keys.forEach(key => {
    const { time, cost, co2 } = raw[key]
    const tS = norm(time, mmTime), cS = norm(cost, mmCost), eS = norm(co2, mmCo2)
    const { timeW, costW, co2W } = weights
    const total = timeW + costW + co2W || 1
    scored[key] = { ...routes[key], cost, co2: raw[key].co2, timeScore: Math.round(tS), costScore: Math.round(cS), co2Score: Math.round(eS), smartScore: Math.round((tS * timeW + cS * costW + eS * co2W) / total) }
  })
  return scored
}

function getMapsUrl(key, markers) {
  const travelmode = (key === 'drive' || key === 'uber') ? 'driving' : key === 'transit' ? 'transit' : 'walking'
  return 'https://www.google.com/maps/dir/?api=1&origin=' + markers[0].lat + ',' + markers[0].lng + '&destination=' + markers[1].lat + ',' + markers[1].lng + '&travelmode=' + travelmode
}

export default function App() {
  const [origin, setOrigin]                 = useState('')
  const [destination, setDestination]       = useState('')
  const [markers, setMarkers]               = useState([])
  const [routes, setRoutes]                 = useState({})
  const [loading, setLoading]               = useState(false)
  const [error, setError]                   = useState('')
  const [bounds, setBounds]                 = useState(null)
  const [activeMode, setActiveMode]         = useState(null)
  const [enabledModes, setEnabledModes]     = useState(Object.fromEntries(Object.entries(ALL_MODES).map(([k, v]) => [k, v.defaultOn])))
  const [fuelPrice, setFuelPrice]           = useState(1.65)
  const [fuelEfficiency, setFuelEfficiency] = useState(9.0)
  const [fuelPriceRaw, setFuelPriceRaw]     = useState('1.65')
  const [fuelEffRaw, setFuelEffRaw]         = useState('9.0')
  const [weights, setWeights]               = useState({ timeW: 33, costW: 33, co2W: 34 })

  const scored = useMemo(() => {
    const active = Object.fromEntries(Object.entries(routes).filter(([k]) => enabledModes[k]))
    if (Object.keys(active).length === 0) return {}
    return scoreRoutes(active, weights, fuelPrice, fuelEfficiency)
  }, [routes, weights, fuelPrice, fuelEfficiency, enabledModes])

  const bestModes = useMemo(() => {
    if (Object.keys(scored).length === 0) return []
    const top = Math.max(...Object.values(scored).map(r => r.smartScore))
    return Object.entries(scored).filter(([, r]) => top - r.smartScore <= 5).map(([k]) => k)
  }, [scored])

  async function handleSearch() {
    setError(''); setRoutes({}); setLoading(true)
    try {
      const [oLng, oLat] = await geocode(origin)
      const [dLng, dLat] = await geocode(destination)
      setMarkers([{ lat: oLat, lng: oLng, label: 'Start: ' + origin }, { lat: dLat, lng: dLng, label: 'End: ' + destination }])
      const [drive, walk, transit, uber] = await Promise.all([
        fetchORSRoute('driving-car',  [oLng, oLat], [dLng, dLat]),
        fetchORSRoute('foot-walking', [oLng, oLat], [dLng, dLat]),
        fetchTransitRoute(oLat, oLng, dLat, dLng).catch(() => null),
        fetchUberRoute(oLat, oLng, dLat, dLng).catch(() => null),
      ])
      const newRoutes = { drive, walk }
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

  function handleFuelPrice(val) {
    setFuelPriceRaw(val)
    const n = parseFloat(val)
    if (!isNaN(n) && n >= 0) setFuelPrice(n)
  }
  function handleFuelEff(val) {
    setFuelEffRaw(val)
    const n = parseFloat(val)
    if (!isNaN(n) && n >= 0) setFuelEfficiency(n)
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif', background: '#0f172a' }}>

      <div style={{ width: 300, minWidth: 300, background: '#0f172a', color: 'white', display: 'flex', flexDirection: 'column', overflowY: 'auto', borderRight: '1px solid #1e293b' }}>

        <div style={{ padding: '16px 16px 10px', borderBottom: '1px solid #1e293b' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'white', letterSpacing: '-0.3px' }}>🧭 Smart Route Planner</div>
          <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>Compare transport options intelligently</div>
        </div>

        <div style={{ padding: '14px 16px', borderBottom: '1px solid #1e293b', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input placeholder="📍 Origin" value={origin} onChange={e => setOrigin(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} style={sideInputStyle} />
          <div style={{ width: 2, height: 8, background: '#334155', margin: '0 auto' }} />
          <input placeholder="🏁 Destination" value={destination} onChange={e => setDestination(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} style={sideInputStyle} />
          <button onClick={handleSearch} disabled={loading} style={searchBtnStyle}>{loading ? 'Fetching routes…' : 'Find Best Route'}</button>
          {error && <div style={{ color: '#f87171', fontSize: 12 }}>{'⚠ ' + error}</div>}
        </div>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
          <div style={sectionLabel}>TRANSPORT MODES</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.entries(ALL_MODES).map(([key, mode]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '6px 10px', borderRadius: 6, background: enabledModes[key] ? mode.color + '18' : '#1e293b', border: '1px solid ' + (enabledModes[key] ? mode.color + '55' : '#334155'), transition: 'all 0.15s' }}>
                <input type="checkbox" checked={enabledModes[key]} onChange={e => setEnabledModes(m => ({ ...m, [key]: e.target.checked }))} style={{ accentColor: mode.color, width: 14, height: 14 }} />
                <span style={{ color: enabledModes[key] ? 'white' : '#64748b', fontSize: 13, fontWeight: 500 }}>{mode.label}</span>
                {key === 'uber' && <span style={{ color: '#475569', fontSize: 10, marginLeft: 'auto' }}>estimated</span>}
              </label>
            ))}
          </div>
        </div>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
          <div style={sectionLabel}>VEHICLE</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={labelStyle}>
              <span>Fuel price ($/L)</span>
              <input type="number" step="0.01" min="0" value={fuelPriceRaw} onChange={e => handleFuelPrice(e.target.value)} style={numInputStyle} />
            </label>
            <label style={labelStyle}>
              <span>Fuel efficiency (L/100km)</span>
              <input type="number" step="0.1" min="0" value={fuelEffRaw} onChange={e => handleFuelEff(e.target.value)} style={numInputStyle} />
            </label>
          </div>
        </div>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
          <div style={sectionLabel}>WHAT MATTERS TO YOU</div>
          {[
            { key: 'timeW', label: '⏱ Speed',       color: '#38bdf8' },
            { key: 'costW', label: '💰 Cost',        color: '#4ade80' },
            { key: 'co2W',  label: '🌿 Environment', color: '#a3e635' },
          ].map(({ key, label, color }) => (
            <div key={key} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: 'white', fontSize: 12 }}>{label}</span>
                <span style={{ color: color, fontSize: 12, fontWeight: 700 }}>{weights[key]}</span>
              </div>
              <input type="range" min="0" max="100" value={weights[key]} onChange={e => setWeights(w => ({ ...w, [key]: Number(e.target.value) }))} style={{ width: '100%', accentColor: color }} />
            </div>
          ))}
          <div style={{ color: '#334155', fontSize: 10, marginTop: 2 }}>Weights are relative — they don't need to add up to 100.</div>
        </div>

        {Object.keys(scored).length > 0 && (
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={sectionLabel}>RESULTS</div>
            {Object.entries(ALL_MODES).map(([key, mode]) => {
              const r = scored[key]
              if (!r) return null
              const isBest = bestModes.includes(key)
              const isActive = activeMode === key
              return (
                <div key={key} onMouseEnter={() => setActiveMode(key)} onMouseLeave={() => setActiveMode(null)}
                  style={{ padding: '10px 12px', borderRadius: 8, background: isActive ? mode.color + '18' : '#1e293b', border: '2px solid ' + (isBest ? mode.color : isActive ? mode.color + '88' : '#334155'), cursor: 'pointer', transition: 'all 0.15s', position: 'relative' }}>

                  {isBest && (
                    <div style={{ position: 'absolute', top: -9, right: 8, background: mode.color, color: '#0f172a', fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 99, letterSpacing: 0.5 }}>
                      {'★ BEST'}
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ color: mode.color, fontWeight: 700, fontSize: 13 }}>{mode.label}</span>
                    <span style={{ color: 'white', fontWeight: 800, fontSize: 15 }}>{r.smartScore}</span>
                  </div>

                  <div style={{ background: '#0f172a', borderRadius: 4, height: 4, marginBottom: 8 }}>
                    <div style={{ background: mode.color, borderRadius: 4, height: 4, width: r.smartScore + '%', transition: 'width 0.4s' }} />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 8px' }}>
                    <div style={statStyle}>{'⏱ ' + formatTime(r.duration)}</div>
                    <div style={{ ...statStyle, color: '#475569' }}>{'score ' + r.timeScore}</div>
                    <div style={statStyle}>{'💰 ' + formatCost(r.cost)}</div>
                    <div style={{ ...statStyle, color: '#475569' }}>{'score ' + r.costScore}</div>
                    <div style={statStyle}>{'🌿 ' + formatCO2(r.co2)}</div>
                    <div style={{ ...statStyle, color: '#475569' }}>{'score ' + r.co2Score}</div>
                    <div style={{ ...statStyle, color: '#475569', gridColumn: '1/-1' }}>{'📍 ' + formatDist(r.distance)}</div>
                  </div>

                  {r.isEstimate && (
                    <div style={{ color: '#334155', fontSize: 9, marginTop: 6, fontStyle: 'italic' }}>{'* estimated'}</div>
                  )}

                  {isBest && markers.length === 2 && (
                    <a href={getMapsUrl(key, markers)} target="_blank" rel="noreferrer"
                      style={{ display: 'block', marginTop: 8, textAlign: 'center', padding: '5px 0', borderRadius: 5, fontSize: 11, background: mode.color, color: '#0f172a', fontWeight: 700, textDecoration: 'none' }}>
                      {'Navigate'}
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <MapContainer center={[43.2557, -79.8711]} zoom={12} style={{ height: '100%', width: '100%' }}>
          <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <MapFitter bounds={bounds} />
          {Object.entries(ALL_MODES).map(([key, mode]) => {
            const r = routes[key]
            if (!r || !enabledModes[key]) return null
            const isActive = activeMode === key
            return <Polyline key={key} positions={r.coords} pathOptions={{ color: mode.color, weight: isActive ? 6 : 3, opacity: activeMode && !isActive ? 0.2 : 0.85 }} />
          })}
          {markers.map((m, i) => (
            <Marker key={i} position={[m.lat, m.lng]}>
              <Popup>{m.label}</Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

    </div>
  )
}

const sideInputStyle = { padding: '9px 12px', borderRadius: 7, border: '1px solid #334155', background: '#1e293b', color: 'white', fontSize: 13, width: '100%', outline: 'none', boxSizing: 'border-box' }
const searchBtnStyle = { padding: '10px', borderRadius: 7, background: '#22c55e', border: 'none', fontWeight: 800, cursor: 'pointer', fontSize: 13, color: '#0f172a', width: '100%', marginTop: 2 }
const sectionLabel   = { color: '#475569', fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 8 }
const labelStyle     = { display: 'flex', flexDirection: 'column', gap: 5, color: '#94a3b8', fontSize: 12 }
const numInputStyle  = { padding: '7px 10px', borderRadius: 6, border: '1px solid #334155', background: '#1e293b', color: 'white', fontSize: 13, width: '100%', outline: 'none', boxSizing: 'border-box' }
const statStyle      = { color: '#e2e8f0', fontSize: 12 }
