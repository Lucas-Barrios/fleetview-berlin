# FleetView Berlin

**An interactive research map of fleet‑oriented businesses across Berlin, built on live OpenStreetMap data.**

🔗 **Live tool:** https://lucas-barrios.github.io/fleetview-berlin/

> Built for the CODE University **M_10 – Digital Product Development** module (Mobility Data Space challenge). This is a **team research instrument**, not the graded MDS deliverable — see [What this is (and isn't)](#what-this-is-and-isnt).

---

## What it does

FleetView helps us answer, quickly and visually:

- **Where** are fleet‑operating businesses concentrated in Berlin?
- **Which** industries and areas have the most fleet potential?
- **Where** should we focus interviews and field research?

It pulls real businesses from OpenStreetMap, classifies each one's likely fleet involvement from a transparent rule set, and lets you explore the result on a map with filters, density views, clustering, and side‑by‑side area comparison.

## What this is (and isn't)

**This is our discovery instrument.** It helps the team find where Berlin fleet businesses cluster so we know who to interview and where demand concentrates. The chain it models is *company → industry → fleet likelihood → geographic concentration → research opportunity*.

**It is NOT the MDS challenge answer.** The challenge asks for a data‑discovery/translation layer over the **MDS mobility‑data catalogue** for a non‑technical decision‑maker. FleetView does not use the MDS catalogue. Treat it as an input to the Double‑Diamond **Discover** phase — a way to understand the market before we design the actual product. Keep the two clearly separated when we present.

---

## Quick start

1. Open the **[live tool](https://lucas-barrios.github.io/fleetview-berlin/)** in Chrome or Firefox.
2. Wait ~10–40s on first load — it's querying all of Berlin live from OpenStreetMap. A "Xs elapsed" counter shows it's working.
3. The map fills with businesses, coloured by **fleet likelihood** (red = high, amber = medium, teal = low, grey = unknown).
4. Use the left panel to filter, switch views, and explore. Click any business or district for detail.

If it ever shows an error instead of loading, the public OpenStreetMap server was probably busy — click **Retry**, or **Load snapshot** (see below).

---

## How to use it

### View modes (top of the left panel)
| Mode | Shows |
|---|---|
| **Companies** | Every matching business as a point; clusters into circles when zoomed out. |
| **Density** | Heatmap of where businesses concentrate, regardless of likelihood. |
| **Fleet potential** | The same points weighted by likelihood (High 1.0, Medium 0.6, Low 0.25). |
| **Industry** | Points coloured by sector. |
| **Company size** | By employee class — *note: OSM has no employee data, so all records are "Unknown" here* (the layer is wired for a future data source). |
| **Clusters** | Exploratory **DBSCAN** groupings of nearby businesses. Statistical only — not verified "ecosystems". Adjust radius/min‑size under **Cluster settings**. |

### Filters
Filter by **industry**, **fleet likelihood**, **ecosystem scope** (core fleet operators vs adjacent context markets like repair shops), **Bezirk**, **fleet type**, **operational profile**, and **record confidence**. Everything updates instantly, and the dashboard counters at the top‑left reflect the current filter. **Reset all filters** clears them.

### Ask in plain language
Type things like *"logistics companies in the east with high fleet potential"* into the search bar. A **deterministic parser** (not an AI — it can't invent data) translates your words into filters, shows you the interpretation, and applies it only when you confirm.

### Inspect
- **Click a business** → side panel with its location, industry, fleet likelihood, evidence for the classification, record confidence, and a link to the original OpenStreetMap object.
- **Click a district** → its company count, fleet‑likelihood mix, and top industries; select two districts to **compare** them side by side.
- **Dashboard stats** (top‑left) → click any number to see exactly how it was calculated.

### Research opportunities
Under **Research opportunities**, a transparent, adjustable formula scores Bezirke by `fleet potential × data confidence × coverage gap`. Move the sliders to reweight it. It deliberately does **not** pick a single "best" area — it surfaces evidence and leaves the judgement to you.

### Export & share the exact same data
- **Export CSV** — the current filtered set, for Excel/Sheets/analysis.
- **Save snapshot** — freezes the whole fetched dataset (with the fetch date) to a JSON file. Share that file and everyone can **Load snapshot** to look at the *identical* data — useful for a presentation, or to cite a dataset with an access date. The live tool re‑queries OSM per visitor, so without a snapshot two people may load slightly different data.

---

## Data & methodology (read before drawing conclusions)

- **Businesses:** [OpenStreetMap](https://www.openstreetmap.org) via the [Overpass API](https://overpass-api.de), queried live in your browser. Every record links back to its OSM object.
- **District boundaries:** Berlin's 12 *Bezirke* (real GeoJSON). Each business is assigned to a district by point‑in‑polygon.
- **Fleet likelihood is an inference, not a measurement.** A business's *location* and *industry* are **Verified** from OSM tags. Its *fleet likelihood* is **Inferred** from that industry via a rule set. *Fleet size* and *company size* are **Unknown** — OSM doesn't carry them, and the tool never invents them.
- **The classification rules** (which OSM tag → which industry → which likelihood) are all visible in the app's **Methodology** panel, and live in one editable array at the top of [`app.js`](app.js).
- **Coverage is uneven.** OSM tags trades and workshops densely in Germany, but larger depots and some firms may be missing or untagged. Use FleetView to find *patterns and places to investigate*, not as a complete business registry.

There's a fuller write‑up of the design decisions and methodology in the shared MDS Challenge project notes.

---

## For whoever wants to edit it

It's a plain static site — three files, no build step:

| File | What it is |
|---|---|
| `index.html` | Page shell; loads Leaflet + our code. |
| `app.css` | All styling. |
| `app.js` | Everything else — organised into clear sections: config, **taxonomy** (the classification rules), geo helpers, data layer, analytics (DBSCAN, scoring), the plain‑language parser, map, and UI. |

**To change the classification** (add an industry, retag a likelihood): edit the `TAXONOMY` array at the top of `app.js`. It drives both the OSM query *and* the map — one place.

**To deploy a change:** commit to `main`. GitHub Pages redeploys automatically in ~1 minute. (Hard‑refresh with Ctrl/Cmd+Shift+R to bypass the browser cache.)

**Tech:** vanilla JS + [Leaflet](https://leafletjs.com) + Leaflet.markercluster. Basemap: Esri Light Gray (with an OpenStreetMap fallback). No backend, no API keys, no tracking.

---

## Roadmap ideas

- Plug in an employee‑size source to activate the **Company size** layer.
- Add Ortsteil / LOR boundaries for finer‑grained areas.
- Cache a nightly snapshot so first load is instant.
- Port to the briefed Next.js/TypeScript stack if it graduates beyond a research tool.

---

*Data © OpenStreetMap contributors (ODbL). Boundaries: Geoportal Berlin / OSM. Basemap tiles © Esri. Built for CODE University M_10.*
