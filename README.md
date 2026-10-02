# 🧭 Smart Route Planner

A route comparison app that helps you pick the best way to get from A to B. Enter a start and a destination, and it compares driving, transit, Uber, and walking side by side, then ranks them with a "smart score" based on what you care about most: speed, cost, or environmental impact.

**[Live demo](#)** <!-- replace # with your deployed URL -->

## Highlights

- Compares multiple transport modes on time, cost, and CO₂ emissions
- Adjustable priority sliders re-rank the results instantly
- Routes are drawn on an interactive map, with hover highlighting
- Driving cost is calculated from your own fuel price and efficiency
- One click from the top-ranked option to turn-by-turn navigation in Google Maps

**Built with:** React, Vite, Leaflet, OpenRouteService API

## Author / Contact

**Eliana Daniel** · [GitHub](https://github.com/e-daniel13)

## Bug Tracker

Found a bug or have an idea? Open an issue on [GitHub Issues](https://github.com/e-daniel13/smart_route_solution/issues).

## Known Issues

- Transit and Uber results are estimates derived from the driving route, not live data.
- The map can re-fit its view while hovering over result cards.
- If the walking request fails on a very long trip, the whole search fails.
- The API key is bundled into the client code, so a free-tier key is recommended.
- There is no automated test suite yet.

## Build

Requires Node.js and a free [OpenRouteService](https://openrouteservice.org/dev/#/signup) API key.

```bash
git clone https://github.com/e-daniel13/smart_route_solution.git
cd smart_route_solution
npm install
echo "VITE_ORS_API_KEY=your_key_here" > .env
npm run build
```

## Run

```bash
npm run dev
```

Then open the local URL shown in the terminal (usually http://localhost:5173).

## Tests

No test suite yet. Code style can be checked with `npm run lint`.