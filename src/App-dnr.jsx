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
  cycle:   { color: '#f59e0b', label: '🚴 Cycle',   defaultOn: true  },
}

const CO2_PER_KM = { drive: 171, transit: 89, uber: 171, walk: 0, cycle: 0 }

const MAX_WALK_SECONDS = 3 * 60 * 60
const MAX_CYCLE_SECONDS = 5 * 60 * 60

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
  if (distKm < 5)       { multiplier = 2.0; waitSeconds = 300 }
  else if (distKm < 30) { multiplier = 1.7; waitSeconds = 480 }
  else                  { multiplier = 1.4; waitSeconds = 900 }
  const duration = driving.duration * multiplier + waitSeconds
  return { coords: driving.coords, duration, distance: driving.distance * 1.1, isEstimate: true }
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
    scored[key] = { ...routes[key], cost, co2: raw[key].co2, smartScore: Math.round((tS * timeW + cS * costW + eS * co2W) / total) }
  })
  return scored
}

function getMapsUrl(key, markers) {
  const travelmode = (key === 'drive' || key === 'uber') ? 'driving' : key === 'transit' ? 'transit' : key === 'cycle' ? 'bicycling' : 'walking'
  return 'https://www.google.com/maps/dir/?api=1&origin=' + markers[0].lat + ',' + markers[0].lng + '&destination=' + markers[1].lat + ',' + markers[1].lng + '&travelmode=' + travelmode
}

export default function App() {
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [markers, setMarkers] = useState([])
  const [routes, setRoutes] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [bounds, setBounds] = useState(null)
  const [activeMode, setActiveMode] = useState(null)

  const scored = useMemo(() => scoreRoutes(routes, { timeW:33, costW:33, co2W:34 }, 1.65, 9.0), [routes])

  const bestModes = useMemo(() => {
    const valid = Object.entries(scored).filter(([k,r]) => {
      if (k === 'walk' && r.duration > MAX_WALK_SECONDS) return false
      if (k === 'cycle' && r.duration > MAX_CYCLE_SECONDS) return false
      return true
    })
    if (valid.length === 0) return []
    const top = Math.max(...valid.map(([,r]) => r.smartScore))
    return valid.filter(([,r]) => top - r.smartScore <= 5).map(([k]) => k)
  }, [scored])

  async function handleSearch() {
    setLoading(true)
    try {
      const [oLng, oLat] = await geocode(origin)
      const [dLng, dLat] = await geocode(destination)

      const [drive, walk, cycle] = await Promise.all([
        fetchORSRoute('driving-car', [oLng, oLat], [dLng, dLat]),
        fetchORSRoute('foot-walking', [oLng, oLat], [dLng, dLat]),
        fetchORSRoute('cycling-road', [oLng, oLat], [dLng, dLat])
      ])

      const newRoutes = { drive, walk, cycle }
      setRoutes(newRoutes)
      setBounds(L.latLngBounds(Object.values(newRoutes).flatMap(r => r.coords)))

    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return <div>App Ready</div>
}
