/* ============================================================================
   FleetView Berlin — internal fleet-ecosystem research tool
   ----------------------------------------------------------------------------
   Data layer / map / analytics / NL parser / provenance are separated below so
   the tool can later be lifted into a Next.js/React app (each block ~ a module).

   Data sources (real):
     - Businesses: OpenStreetMap via the Overpass API, queried live IN THE
       BROWSER (the sandbox that generated this file cannot reach Overpass;
       your browser can). Nothing is fabricated. Unknown stays "Unknown".
     - Boundaries: Berlin Bezirke, © GeoportalBerlin / OSM contributors,
       simplified for display (window.BEZIRKE, injected above).
   ============================================================================ */
'use strict';

/* ===== 0. CONFIG =========================================================== */
const CONFIG = {
  overpassEndpoints: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ],
  berlinCenter: [52.5155, 13.4050],
  berlinBBox: [52.338, 13.088, 52.675, 13.761], // S,W,N,E
  timeoutMs: 90000,
  // Used only by the hosted build; the offline build injects window.BEZIRKE directly.
  boundaryUrl: 'https://raw.githubusercontent.com/m-hoerz/berlin-shapes/master/berliner-bezirke.geojson',
};

// Ensure window.BEZIRKE exists. Offline build: already injected. Hosted build: fetch + normalise.
async function loadBoundaries(){
  if(typeof window.BEZIRKE!=='undefined' && window.BEZIRKE?.features?.length) return;
  const res=await fetch(CONFIG.boundaryUrl);
  if(!res.ok) throw new Error('boundaries HTTP '+res.status);
  const raw=await res.json();
  window.BEZIRKE={ type:'FeatureCollection', features:(raw.features||[]).map(f=>({
    type:'Feature',
    properties:{ name: f.properties?.name || f.properties?.spatial_alias || f.properties?.Gemeinde_name || '?' },
    geometry: f.geometry,
  }))};
}

/* ===== 1. TAXONOMY (drives BOTH the Overpass query AND classification) =====
   Editable in one place → the methodology panel renders straight from this.
   like: fleet likelihood (High/Medium/Low). adjacent: context market, unlikely
   to operate its own fleet but part of the ecosystem. Each `sel` [k,v] pair is
   an OSM tag used as the evidence for the classification.                     */
const TAXONOMY = [
  { cat:'Logistics', like:'High', prof:'Logistics', ftype:'Trucks / Vans',
    sel:[['office','logistics'],['industrial','logistics']],
    ev:'Tagged as a logistics operation in OSM; fleet operation is intrinsic to the activity.' },
  { cat:'Courier / Last-mile', like:'High', prof:'Delivery', ftype:'Vans / Cargo bikes',
    sel:[['office','courier'],['amenity','post_depot']],
    ev:'Tagged as a courier / parcel operation; last-mile delivery implies an active vehicle fleet.' },
  { cat:'Moving / Relocation', like:'High', prof:'Delivery', ftype:'Trucks / Vans',
    sel:[['office','moving_company']],
    ev:'Tagged as a moving company; relocation services operate trucks/vans by definition.' },
  { cat:'Car Rental / Leasing', like:'High', prof:'Passenger transport', ftype:'Cars',
    sel:[['shop','car_rental'],['amenity','car_rental']],
    ev:'Rental / leasing depot; the vehicle fleet is the core asset of the business.' },
  { cat:'Waste Management', like:'High', prof:'Maintenance', ftype:'Trucks',
    sel:[['amenity','waste_transfer_station']],
    ev:'Waste transfer / collection site; collection is performed with heavy vehicle fleets.' },
  { cat:'Construction', like:'Medium', prof:'Construction', ftype:'Vans / Trucks',
    sel:[['office','construction_company'],['craft','builder'],['craft','bricklayer'],
         ['craft','carpenter'],['craft','roofer'],['craft','scaffolder'],
         ['craft','plasterer'],['craft','stonemason']],
    ev:'Construction trade; most operate site vehicles, though fleet size varies with firm size.' },
  { cat:'Trades / Field Services', like:'Medium', prof:'Field service', ftype:'Vans',
    sel:[['craft','plumber'],['craft','electrician'],['craft','hvac'],['craft','painter'],
         ['craft','metal_construction'],['craft','locksmith'],['craft','tiler'],
         ['craft','insulation'],['craft','glaziery'],['craft','sun_protection']],
    ev:'Field-service trade; typically operates one or more service vans. Fleet size not verified.' },
  { cat:'Agriculture / Landscaping', like:'Medium', prof:'Field service', ftype:'Vans / Trucks',
    sel:[['craft','gardener']],
    ev:'Landscaping / grounds services; commonly operates vans and light trucks with equipment.' },
  { cat:'Care Services', like:'Low', prof:'Field service', ftype:'Cars / Vans',
    sel:[['amenity','nursing_home'],['social_facility','nursing_home'],['social_facility','assisted_living']],
    ev:'Care facility; may run mobile-care vehicles, but a fleet is not implied by the tag alone.' },
  { cat:'Automotive Services', like:'Low', prof:'Other', ftype:'n/a (adjacent)', adjacent:true,
    sel:[['shop','car_repair'],['shop','tyres'],['shop','car_parts']],
    ev:'Adjacent market: services other operators’ vehicles. Unlikely to run its own fleet; shown as ecosystem context.' },
  { cat:'Building Materials / Trade Retail', like:'Low', prof:'Other', ftype:'n/a (adjacent)', adjacent:true,
    sel:[['shop','doityourself'],['shop','hardware'],['shop','trade'],['shop','building_materials']],
    ev:'Adjacent market: supplies the trades. Some run delivery vehicles; treated as context, not a fleet operator.' },
];

const LIKELIHOODS = ['High','Medium','Low','Unknown'];
const LIKE_WEIGHT = { High:1.0, Medium:0.6, Low:0.25, Unknown:0.0 };
const LIKE_CLASS  = { High:'hi', Medium:'med', Low:'lo', Unknown:'unk' };
const LIKE_COLOR  = { High:'#e5484d', Medium:'#f59e0b', Low:'#12a594', Unknown:'#8b97a7' };
const CAT_COLORS = ['#2563eb','#e5484d','#12a594','#8b5cf6','#f59e0b','#0891b2',
                    '#db2777','#65a30d','#b45309','#0d9488','#dc2626'];
const SIZE_CLASSES = ['1–9','10–49','50–249','250–999','1,000+','Unknown'];

/* ===== 2. GEO HELPERS ====================================================== */
function haversine(a,b){ // [lat,lng]
  const R=6371000,toR=Math.PI/180;
  const dLat=(b[0]-a[0])*toR, dLng=(b[1]-a[1])*toR;
  const s=Math.sin(dLat/2)**2+Math.cos(a[0]*toR)*Math.cos(b[0]*toR)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function pointInRing(pt, ring){ // pt=[lng,lat], ring=[[lng,lat]...]
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];
    const hit=((yi>pt[1])!==(yj>pt[1]))&&(pt[0]<(xj-xi)*(pt[1]-yi)/((yj-yi)||1e-12)+xi);
    if(hit) inside=!inside;
  }
  return inside;
}
function pointInFeature(lng,lat,geom){
  const test=(poly)=>{ // poly=[outer, hole, hole...]
    if(!pointInRing([lng,lat],poly[0])) return false;
    for(let k=1;k<poly.length;k++) if(pointInRing([lng,lat],poly[k])) return false;
    return true;
  };
  if(geom.type==='Polygon') return test(geom.coordinates);
  if(geom.type==='MultiPolygon') return geom.coordinates.some(test);
  return false;
}
function bezirkOf(lat,lng){
  for(const f of BEZIRKE.features){ if(pointInFeature(lng,lat,f.geometry)) return f.properties.name; }
  return 'Unknown';
}
function convexHull(pts){ // pts=[[lng,lat]...] → hull ring
  if(pts.length<3) return pts.slice();
  const p=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lo=[],up=[];
  for(const q of p){ while(lo.length>=2&&cross(lo[lo.length-2],lo[lo.length-1],q)<=0)lo.pop(); lo.push(q); }
  for(let i=p.length-1;i>=0;i--){ const q=p[i]; while(up.length>=2&&cross(up[up.length-2],up[up.length-1],q)<=0)up.pop(); up.push(q); }
  lo.pop();up.pop(); return lo.concat(up);
}
const bezirkNames = () => BEZIRKE.features.map(f=>f.properties.name).sort();

/* ===== 3. DATA LAYER: query build, fetch, parse, classify ================== */
function buildOverpassQuery(){
  const [s,w,n,e]=CONFIG.berlinBBox;
  const lines=[];
  const seen=new Set();
  for(const t of TAXONOMY) for(const [k,v] of t.sel){
    const key=k+'='+v; if(seen.has(key)) continue; seen.add(key);
    lines.push(`  nw["${k}"="${v}"](${s},${w},${n},${e});`); // nodes+ways only (relations are rare here and slow)
  }
  return `[out:json][timeout:90];\n(\n${lines.join('\n')}\n);\nout center tags;`;
}
function classify(tags){
  for(const t of TAXONOMY) for(const [k,v] of t.sel){
    if(tags[k]===v) return { category:t.cat, likelihood:t.like, profile:t.prof,
      fleetType:t.ftype, adjacent:!!t.adjacent, evidence:t.ev, matchTag:`${k}=${v}` };
  }
  return null;
}
function confidenceOf(tags){
  // Transparent: location+category always verified; richness raises confidence.
  let c=0.4; const add=(cond,w)=>{ if(cond) c+=w; };
  add(tags.name, 0.20);
  add(tags.operator, 0.12);
  add(tags.website||tags['contact:website'], 0.10);
  add(tags['addr:street']&&tags['addr:housenumber'], 0.10);
  add(tags.opening_hours, 0.05);
  add(tags.phone||tags['contact:phone'], 0.03);
  c=Math.min(1,c);
  const bucket = c>=0.7?'High':c>=0.52?'Medium':'Low';
  return { score:c, bucket };
}
function parseElements(elements){
  const out=[];
  for(const el of elements){
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if(lat==null||lng==null) continue;
    const tags=el.tags||{};
    const cls=classify(tags); if(!cls) continue;
    const conf=confidenceOf(tags);
    out.push({
      id: el.type+'/'+el.id,
      osmType: el.type, osmId: el.id,
      name: tags.name || tags.operator || `(unnamed ${el.type})`,
      named: !!tags.name,
      lat, lng,
      category: cls.category, likelihood: cls.likelihood, profile: cls.profile,
      fleetType: cls.fleetType, adjacent: cls.adjacent, evidence: cls.evidence, matchTag: cls.matchTag,
      operator: tags.operator || null,
      website: tags.website || tags['contact:website'] || null,
      address: [tags['addr:street'],tags['addr:housenumber']].filter(Boolean).join(' ')
               + (tags['addr:postcode']?(', '+tags['addr:postcode']):'') || null,
      sizeClass: 'Unknown',                 // OSM carries no employee count
      estFleetSize: 'Unknown',              // no evidence → never invented
      confidence: conf.score, confidenceBucket: conf.bucket,
      bezirk: bezirkOf(lat,lng),
      sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      rawTags: tags,
    });
  }
  return out;
}
async function fetchOverpass(onStatus){
  const q=buildOverpassQuery();
  let lastErr;
  for(let i=0;i<CONFIG.overpassEndpoints.length;i++){
    const ep=CONFIG.overpassEndpoints[i];
    onStatus(`Querying OpenStreetMap (endpoint ${i+1}/${CONFIG.overpassEndpoints.length})…`);
    try{
      const ctrl=new AbortController();
      const to=setTimeout(()=>ctrl.abort(), CONFIG.timeoutMs);
      const res=await fetch(ep,{method:'POST',body:'data='+encodeURIComponent(q),
        headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:ctrl.signal});
      clearTimeout(to);
      if(!res.ok) throw new Error('HTTP '+res.status);
      const json=await res.json();
      const rows=parseElements(json.elements||[]);
      return { rows, fetchedAt:new Date().toISOString(), endpoint:ep, query:q, rawCount:(json.elements||[]).length };
    }catch(err){ lastErr=err; }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
}

/* ===== 4. STATE ============================================================ */
const STATE = {
  all: [],                 // classified companies
  meta: null,              // {fetchedAt, endpoint, rawCount, source}
  filtered: [],
  mode: 'companies',
  filters: {
    categories: new Set(),        // empty = all
    likelihoods: new Set(),
    sizes: new Set(),
    bezirke: new Set(),
    fleetTypes: new Set(),
    profiles: new Set(),
    confidence: new Set(),
    adjacency: 'all',             // all | core | context
    q: '',
  },
  weights: { potential:0.5, confidence:0.2, gap:0.3 },
  compare: [null,null],
  dbscan: { eps:500, minPts:5, result:null },
};

function applyFilters(){
  const f=STATE.filters;
  STATE.filtered = STATE.all.filter(c=>{
    if(f.categories.size && !f.categories.has(c.category)) return false;
    if(f.likelihoods.size && !f.likelihoods.has(c.likelihood)) return false;
    if(f.sizes.size && !f.sizes.has(c.sizeClass)) return false;
    if(f.bezirke.size && !f.bezirke.has(c.bezirk)) return false;
    if(f.fleetTypes.size && !f.fleetTypes.has(c.fleetType)) return false;
    if(f.profiles.size && !f.profiles.has(c.profile)) return false;
    if(f.confidence.size && !f.confidence.has(c.confidenceBucket)) return false;
    if(f.adjacency==='core' && c.adjacent) return false;
    if(f.adjacency==='context' && !c.adjacent) return false;
    if(f.q){ const q=f.q.toLowerCase();
      if(!(c.name.toLowerCase().includes(q)||c.category.toLowerCase().includes(q)
         ||(c.address||'').toLowerCase().includes(q)||c.bezirk.toLowerCase().includes(q))) return false; }
    return true;
  });
  return STATE.filtered;
}

/* ===== 5. ANALYTICS ======================================================== */
function distribution(rows, keyFn){
  const m=new Map();
  for(const r of rows){ const k=keyFn(r); m.set(k,(m.get(k)||0)+1); }
  return [...m.entries()].sort((a,b)=>b[1]-a[1]);
}
function areaStats(name){
  const rows=STATE.all.filter(c=>c.bezirk===name);
  return { name, count:rows.length,
    byLike:LIKELIHOODS.map(l=>[l,rows.filter(r=>r.likelihood===l).length]),
    byCat:distribution(rows,r=>r.category),
    potential:rows.reduce((s,r)=>s+LIKE_WEIGHT[r.likelihood],0),
    rows };
}
// DBSCAN with grid index over the current filtered set
function runDBSCAN(rows, epsM, minPts){
  const n=rows.length; const labels=new Array(n).fill(0); // 0 unvisited, -1 noise, >0 cluster id
  const cell=epsM/111000; // deg approx
  const grid=new Map(); const key=(gx,gy)=>gx+','+gy;
  rows.forEach((r,i)=>{ const gx=Math.floor(r.lng/cell),gy=Math.floor(r.lat/cell);
    const k=key(gx,gy); (grid.get(k)||grid.set(k,[]).get(k)).push(i); r._gx=gx; r._gy=gy; });
  const region=(i)=>{ const r=rows[i],res=[];
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){ const bucket=grid.get(key(r._gx+dx,r._gy+dy)); if(!bucket)continue;
      for(const j of bucket){ if(haversine([r.lat,r.lng],[rows[j].lat,rows[j].lng])<=epsM) res.push(j); } }
    return res; };
  let cid=0;
  for(let i=0;i<n;i++){ if(labels[i]!==0) continue;
    const neigh=region(i);
    if(neigh.length<minPts){ labels[i]=-1; continue; }
    cid++; labels[i]=cid;
    const queue=neigh.slice();
    for(let qi=0;qi<queue.length;qi++){ const j=queue[qi];
      if(labels[j]===-1) labels[j]=cid;
      if(labels[j]!==0) continue;
      labels[j]=cid;
      const nj=region(j); if(nj.length>=minPts) for(const x of nj) if(!queue.includes(x)) queue.push(x);
    }
  }
  const clusters=new Map();
  rows.forEach((r,i)=>{ if(labels[i]>0){ (clusters.get(labels[i])||clusters.set(labels[i],[]).get(labels[i])).push(r); } });
  const out=[...clusters.entries()].map(([id,members])=>{
    const hull=convexHull(members.map(m=>[m.lng,m.lat]));
    const cat=distribution(members,r=>r.category)[0]?.[0]||'—';
    const potential=members.reduce((s,r)=>s+LIKE_WEIGHT[r.likelihood],0);
    return { id, members, hull, dominantCat:cat, size:members.length, potential,
      byLike:LIKELIHOODS.map(l=>[l,members.filter(r=>r.likelihood===l).length]) };
  }).sort((a,b)=>b.size-a.size);
  return { clusters:out, noise:labels.filter(l=>l===-1).length };
}
// Research-opportunity score per Bezirk (transparent, weighted)
function opportunityScores(){
  const w=STATE.weights;
  const areas=bezirkNames().map(areaStats).filter(a=>a.name!=='Unknown');
  const maxPot=Math.max(1,...areas.map(a=>a.potential));
  const maxCnt=Math.max(1,...areas.map(a=>a.count));
  return areas.map(a=>{
    const potential=a.potential/maxPot;
    const conf=a.rows.length? a.rows.reduce((s,r)=>s+r.confidence,0)/a.rows.length : 0;
    // "coverage gap" proxy = fewer high-confidence records ⇒ more room to research.
    const gap=1-conf;
    const score=w.potential*potential + w.confidence*conf + w.gap*gap;
    return { name:a.name, score, potential, conf, gap, count:a.count };
  }).sort((x,y)=>y.score-x.score);
}

/* ===== 6. NL QUERY PARSER (deterministic — no LLM, cannot invent data) =====
   Maps free text onto the SAME filter vocabulary the UI uses, then shows the
   interpretation for confirmation before applying. Unmatched words are flagged.*/
function parseNL(text){
  const t=' '+text.toLowerCase()+' ';
  const res={categories:new Set(),likelihoods:new Set(),sizes:new Set(),
    bezirke:new Set(),profiles:new Set(),fleetTypes:new Set()};
  const matched=[];
  const has=(...ws)=>ws.some(w=>t.includes(' '+w)||t.includes(w+' ')||t.includes(w));
  // categories by keyword
  const catKW={
    'Logistics':['logistic','freight','warehous','haulage','spedition'],
    'Courier / Last-mile':['courier','last-mile','last mile','parcel','delivery service','kurier'],
    'Moving / Relocation':['moving','relocation','removal','umzug'],
    'Car Rental / Leasing':['rental','leasing','car hire','autoverm'],
    'Waste Management':['waste','refuse','recycl','entsorg','müll','mull'],
    'Construction':['construction','builder','roofer','scaffold','bau'],
    'Trades / Field Services':['trade','plumber','electric','hvac','painter','handwerk','field service'],
    'Agriculture / Landscaping':['landscap','garden','agricultur','grounds'],
    'Care Services':['care','nursing','pflege'],
    'Automotive Services':['repair','garage','workshop','tyre','tire','werkstatt'],
    'Building Materials / Trade Retail':['hardware','diy','building material','baumarkt'],
  };
  for(const [cat,kws] of Object.entries(catKW)) if(has(...kws)){ res.categories.add(cat); matched.push(cat); }
  // likelihood
  if(has('high fleet','high potential','high-fleet','fleet-intensive','fleet intensive')){res.likelihoods.add('High');matched.push('High likelihood');}
  if(has('medium fleet','medium potential')){res.likelihoods.add('Medium');matched.push('Medium likelihood');}
  if(has('low fleet','low potential')){res.likelihoods.add('Low');matched.push('Low likelihood');}
  // sizes
  const sizeKW={'1–9':['micro','1-9','1–9'],'10–49':['small','10-49','10–49'],
    '50–249':['medium-sized','mid-size','mid size','50-249','50–249'],
    '250–999':['large','250-999'],'1,000+':['very large','enterprise','1000+','1,000+']};
  for(const [s,kws] of Object.entries(sizeKW)) if(has(...kws)){ res.sizes.add(s); matched.push('Size '+s); }
  // profiles
  const profKW={'Delivery':['delivery'],'Field service':['field service','on-site'],
    'Construction':['construction site'],'Logistics':['logistics operation'],'Maintenance':['maintenance']};
  for(const [p,kws] of Object.entries(profKW)) if(has(...kws)){ res.profiles.add(p); matched.push('Profile '+p); }
  // bezirke (+ directional shorthands)
  for(const b of bezirkNames()){ if(t.includes(b.toLowerCase())){ res.bezirke.add(b); matched.push(b); } }
  const dir={east:['Lichtenberg','Marzahn-Hellersdorf','Treptow-Köpenick','Friedrichshain-Kreuzberg'],
    west:['Spandau','Charlottenburg-Wilmersdorf','Steglitz-Zehlendorf','Reinickendorf'],
    north:['Pankow','Reinickendorf','Mitte'],
    south:['Neukölln','Tempelhof-Schöneberg','Steglitz-Zehlendorf','Treptow-Köpenick'],
    central:['Mitte','Friedrichshain-Kreuzberg']};
  for(const [d,list] of Object.entries(dir)) if(has(d+'ern ',d+' ',d)){ list.forEach(b=>res.bezirke.add(b)); matched.push(d+' Berlin'); }
  // strip empties
  Object.keys(res).forEach(k=>{ if(res[k].size===0) delete res[k]; });
  return { filters:res, matched, empty:matched.length===0 };
}

/* ===== 7. MAP LAYER (Leaflet + custom canvas heatmap) ====================== */
let MAP, boundaryLayer, clusterLayer, pointLayer, hullLayer, heatLayer, labelLayer;

// Compact additive canvas heatmap as a Leaflet layer.
const HeatLayer = L.Layer.extend({
  initialize(getPoints){ this._get=getPoints; },
  onAdd(map){ this._map=map;
    this._c=L.DomUtil.create('canvas','leaflet-zoom-hide');
    const s=map.getSize(); this._c.width=s.x; this._c.height=s.y;
    this._c.style.position='absolute';
    map.getPanes().overlayPane.appendChild(this._c);
    map.on('moveend zoomend resize',this._redraw,this); this._redraw();
  },
  onRemove(map){ map.getPanes().overlayPane.removeChild(this._c); map.off('moveend zoomend resize',this._redraw,this); },
  _redraw(){
    const map=this._map,size=map.getSize();
    const tl=map.containerPointToLayerPoint([0,0]); L.DomUtil.setPosition(this._c,tl);
    this._c.width=size.x; this._c.height=size.y;
    const ctx=this._c.getContext('2d'); ctx.clearRect(0,0,size.x,size.y);
    const pts=this._get(); if(!pts.length) return;
    const z=map.getZoom(); const rad=Math.max(16,Math.min(46, 8+ (z-9)*6));
    // accumulate weighted alpha
    const acc=document.createElement('canvas'); acc.width=size.x; acc.height=size.y;
    const ac=acc.getContext('2d');
    for(const p of pts){
      const cp=map.latLngToContainerPoint([p.lat,p.lng]);
      if(cp.x<-rad||cp.y<-rad||cp.x>size.x+rad||cp.y>size.y+rad) continue;
      const w=p.w==null?1:p.w; if(w<=0) continue;
      const g=ac.createRadialGradient(cp.x,cp.y,0,cp.x,cp.y,rad);
      g.addColorStop(0,`rgba(0,0,0,${0.16*Math.min(1,w)})`); g.addColorStop(1,'rgba(0,0,0,0)');
      ac.fillStyle=g; ac.beginPath(); ac.arc(cp.x,cp.y,rad,0,7); ac.fill();
    }
    const img=ac.getImageData(0,0,size.x,size.y),d=img.data;
    const ramp=this._ramp();
    for(let i=0;i<d.length;i+=4){ const a=d[i+3]; if(!a) continue;
      const t=Math.min(1,a/210); const c=ramp(t);
      d[i]=c[0];d[i+1]=c[1];d[i+2]=c[2];d[i+3]=Math.min(220,a*1.4);
    }
    ctx.putImageData(img,0,0);
  },
  _ramp(){ // blue→teal→amber→red
    const stops=[[0,[31,95,214]],[.4,[15,155,176]],[.7,[224,145,47]],[1,[209,70,47]]];
    return (t)=>{ for(let i=1;i<stops.length;i++){ if(t<=stops[i][0]){ const [p0,c0]=stops[i-1],[p1,c1]=stops[i];
      const k=(t-p0)/((p1-p0)||1); return c0.map((v,j)=>Math.round(v+(c1[j]-v)*k)); } } return stops[stops.length-1][1]; };
  },
  refresh(){ if(this._map) this._redraw(); }
});

function initMap(){
  MAP=L.map('map',{zoomControl:false,preferCanvas:true}).setView(CONFIG.berlinCenter,11);
  L.control.zoom({position:'topright'}).addTo(MAP);
  L.control.scale({imperial:false,position:'bottomright'}).addTo(MAP);
  // Clean grey analytics basemap (Esri Light Gray) — key-free. Falls back to OSM if it errors.
  const esriBase=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',{
    maxZoom:19, maxNativeZoom:16, attribution:'Tiles &copy; Esri'
  }).addTo(MAP);
  const esriRef=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',{
    maxZoom:19, maxNativeZoom:16, opacity:.85
  }).addTo(MAP);
  let tilesSwapped=false;
  esriBase.on('tileerror',()=>{ if(tilesSwapped) return; tilesSwapped=true;
    MAP.removeLayer(esriBase); MAP.removeLayer(esriRef);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(MAP);
  });
  boundaryLayer=L.geoJSON(BEZIRKE,{
    style:()=>({color:'#66707d',weight:1,opacity:.55,fill:true,fillColor:'#000',fillOpacity:0}),
    onEachFeature:(f,layer)=>{ layer.on('click',()=>openAreaPanel(f.properties.name));
      layer.bindTooltip(f.properties.name,{sticky:true,className:'bez-tip'}); }
  }).addTo(MAP);
  hullLayer=L.layerGroup().addTo(MAP);
  pointLayer=L.layerGroup();
  clusterLayer=L.markerClusterGroup({ chunkedLoading:true, maxClusterRadius:48,
    iconCreateFunction:(cl)=>{ const n=cl.getChildCount();
      const size=n<10?30:n<50?36:n<200?44:52;
      return L.divIcon({html:`<div style="width:${size}px;height:${size}px;line-height:${size}px;border-radius:50%;
        background:rgba(37,99,235,.16);border:1.5px solid rgba(37,99,235,.55);color:#123;font-weight:650;
        text-align:center;font-size:12px">${n}</div>`,className:'',iconSize:[size,size]});
    }});
  heatLayer=new HeatLayer(()=>heatPoints());
  MAP.on('overlayadd overlayremove',()=>{});
}

function markerFor(c){
  const col=LIKE_COLOR[c.likelihood];
  const m=L.circleMarker([c.lat,c.lng],{radius:c.adjacent?4:5,color:'#fff',weight:1,
    fillColor:col,fillOpacity:.9});
  m.on('click',()=>openDetail(c));
  m.bindTooltip(c.name,{direction:'top'});
  return m;
}
function colorForMode(c){
  if(STATE.mode==='industry'){ const i=TAXONOMY.findIndex(t=>t.cat===c.category); return CAT_COLORS[i%CAT_COLORS.length]; }
  if(STATE.mode==='size'){ return '#9aa4b1'; } // all Unknown
  return LIKE_COLOR[c.likelihood];
}
function heatPoints(){
  const rows=STATE.filtered;
  if(STATE.mode==='fleetpotential') return rows.map(c=>({lat:c.lat,lng:c.lng,w:LIKE_WEIGHT[c.likelihood]}));
  return rows.map(c=>({lat:c.lat,lng:c.lng,w:1}));
}

function renderMode(){
  // clear dynamic layers
  [clusterLayer,pointLayer].forEach(l=>{ MAP.hasLayer(l)&&MAP.removeLayer(l); });
  clusterLayer.clearLayers(); pointLayer.clearLayers(); hullLayer.clearLayers();
  if(MAP.hasLayer(heatLayer)) MAP.removeLayer(heatLayer);
  const rows=STATE.filtered;
  const mode=STATE.mode;

  if(mode==='density'||mode==='fleetpotential'){
    heatLayer.addTo(MAP); heatLayer.refresh();
  }
  if(mode==='clusters'){
    STATE.dbscan.result=runDBSCAN(rows,STATE.dbscan.eps,STATE.dbscan.minPts);
    STATE.dbscan.result.clusters.forEach((cl,idx)=>{
      const color=CAT_COLORS[idx%CAT_COLORS.length];
      if(cl.hull.length>=3){
        L.polygon(cl.hull.map(p=>[p[1],p[0]]),{color,weight:1.5,fillColor:color,fillOpacity:.10,className:'hullpath'})
          .on('click',()=>openClusterPanel(cl)).bindTooltip(`Cluster ${cl.id} · ${cl.size} companies · ${cl.dominantCat}`)
          .addTo(hullLayer);
      }
      cl.members.forEach(c=>{ L.circleMarker([c.lat,c.lng],{radius:4,color:'#fff',weight:.6,fillColor:color,fillOpacity:.85})
        .on('click',()=>openDetail(c)).addTo(hullLayer); });
    });
    refreshLegend();
    return;
  }
  if(mode==='companies'){
    rows.forEach(c=>clusterLayer.addLayer(markerFor(c)));
    clusterLayer.addTo(MAP);
  } else if(mode==='industry'||mode==='size'){
    rows.forEach(c=>{ const col=colorForMode(c);
      L.circleMarker([c.lat,c.lng],{radius:5,color:'#fff',weight:1,fillColor:col,fillOpacity:.9})
        .on('click',()=>openDetail(c)).bindTooltip(c.name,{direction:'top'}).addTo(pointLayer); });
    pointLayer.addTo(MAP);
  }
  refreshLegend();
}

/* ===== 8. LEGEND / EXPLAIN ================================================= */
function refreshLegend(){
  const el=document.getElementById('legend'); const m=STATE.mode;
  let html='';
  if(m==='companies'||m==='fleetpotential'){
    html=`<h4>Fleet likelihood</h4>`+LIKELIHOODS.map(l=>
      `<div class="li"><span class="sw" style="background:${LIKE_COLOR[l]}"></span>${l}</div>`).join('');
  } else if(m==='industry'){
    html=`<h4>Industry</h4>`+TAXONOMY.map((t,i)=>
      `<div class="li"><span class="sw" style="background:${CAT_COLORS[i%CAT_COLORS.length]}"></span>${t.cat}</div>`).join('');
  } else if(m==='density'){
    html=`<h4>Company density</h4><div class="grad" style="background:linear-gradient(90deg,#1f5fd6,#0f9bb0,#e0912f,#d1462f)"></div>
      <div class="scale"><span>low</span><span>high</span></div>
      <div class="tiny muted" style="margin-top:4px">Count of businesses per area (all industries in filter).</div>`;
  } else if(m==='size'){
    html=`<h4>Company size</h4><div class="li"><span class="sw" style="background:#9aa4b1"></span>Unknown (all records)</div>
      <div class="tiny muted" style="margin-top:4px">OpenStreetMap carries no employee counts. This layer is ready for a source that provides them.</div>`;
  } else if(m==='clusters'){
    const r=STATE.dbscan.result;
    html=`<h4>Exploratory clusters</h4><div class="tiny muted">${r?r.clusters.length:0} clusters · ${r?r.noise:0} unclustered<br>
      DBSCAN, ε=${STATE.dbscan.eps}m, minPts=${STATE.dbscan.minPts}. Statistical only — not verified fleet ecosystems.</div>`;
  }
  el.innerHTML=html;
}

/* ===== 9. UI: rail, dashboard, panels, modals ============================== */
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const fmt=(n)=>n.toLocaleString('en-US');

function buildRail(){
  const rail=$('#rail-scroll');
  rail.innerHTML='';

  // Map mode section
  rail.appendChild(section('View mode', modesUI(), false));
  // Filters
  rail.appendChild(section('Filters', filtersUI(), false));
  // Clusters controls
  rail.appendChild(section('Cluster settings', clusterUI(), true));
  // Research opportunity
  rail.appendChild(section('Research opportunities', opportunityUI(), true));
}
function section(title, contentEl, collapsed){
  const s=document.createElement('div'); s.className='section'+(collapsed?' collapsed':'');
  const h=document.createElement('div'); h.className='head'; h.innerHTML=`${title}<span class="chev">▾</span>`;
  h.onclick=()=>s.classList.toggle('collapsed');
  const c=document.createElement('div'); c.className='content'; c.appendChild(contentEl);
  s.append(h,c); return s;
}
const MODES=[
  ['companies','Companies','Individual businesses'],
  ['density','Density','Concentration heatmap'],
  ['fleetpotential','Fleet potential','Likelihood-weighted'],
  ['industry','Industry','Colour by sector'],
  ['size','Company size','By employee class'],
  ['clusters','Clusters','Exploratory (DBSCAN)'],
];
function modesUI(){
  const w=document.createElement('div'); w.className='modes';
  MODES.forEach(([id,t,d])=>{ const b=document.createElement('button');
    b.className='mode'+(STATE.mode===id?' on':''); b.innerHTML=`<span class="mt">${t}</span><span class="md">${d}</span>`;
    b.onclick=()=>{ STATE.mode=id; buildRail(); renderMode(); };
    w.appendChild(b); });
  return w;
}
function checkGroup(label, items, set, onchange, colorFn){
  const box=document.createElement('div');
  const lab=document.createElement('div'); lab.className='label'; lab.textContent=label; box.appendChild(lab);
  items.forEach(([val,count])=>{
    const line=document.createElement('label'); line.className='checkline';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=set.has(val);
    cb.onchange=()=>{ cb.checked?set.add(val):set.delete(val); onchange(); };
    line.appendChild(cb);
    if(colorFn){ const sw=document.createElement('span'); sw.className='sw'; sw.style.background=colorFn(val); line.appendChild(sw); }
    const t=document.createElement('span'); t.textContent=val; line.appendChild(t);
    const ct=document.createElement('span'); ct.className='ct'; ct.textContent=count!=null?fmt(count):''; line.appendChild(ct);
    box.appendChild(line);
  });
  return box;
}
function countBy(keyFn){ const m=new Map(); STATE.all.forEach(c=>{const k=keyFn(c);m.set(k,(m.get(k)||0)+1);}); return m; }
function filtersUI(){
  const wrap=document.createElement('div'); wrap.style.display='flex'; wrap.style.flexDirection='column'; wrap.style.gap='12px';
  const f=STATE.filters; const refresh=()=>{ applyFilters(); renderMode(); renderDashboard(); };

  const catCounts=countBy(c=>c.category);
  wrap.appendChild(checkGroup('Industry', TAXONOMY.map(t=>[t.cat,catCounts.get(t.cat)||0]), f.categories, refresh,
    (v)=>{const i=TAXONOMY.findIndex(t=>t.cat===v);return CAT_COLORS[i%CAT_COLORS.length];}));

  const likeCounts=countBy(c=>c.likelihood);
  wrap.appendChild(checkGroup('Fleet likelihood', LIKELIHOODS.map(l=>[l,likeCounts.get(l)||0]), f.likelihoods, refresh,
    (v)=>LIKE_COLOR[v]));

  // adjacency toggle
  const adjBox=document.createElement('div');
  const al=document.createElement('div'); al.className='label'; al.textContent='Ecosystem scope'; adjBox.appendChild(al);
  const chips=document.createElement('div'); chips.className='chips';
  [['all','All'],['core','Core fleet operators'],['context','Adjacent context']].forEach(([v,t])=>{
    const c=document.createElement('button'); c.className='chip'+(f.adjacency===v?' on':''); c.textContent=t;
    c.onclick=()=>{ f.adjacency=v; buildRail(); refresh(); }; chips.appendChild(c);
  });
  adjBox.appendChild(chips); wrap.appendChild(adjBox);

  const bezCounts=countBy(c=>c.bezirk);
  wrap.appendChild(checkGroup('Area (Bezirk)', bezirkNames().map(b=>[b,bezCounts.get(b)||0]).filter(x=>x[1]>0), f.bezirke, refresh));

  const ftCounts=countBy(c=>c.fleetType);
  wrap.appendChild(checkGroup('Fleet type', [...ftCounts.entries()].sort((a,b)=>b[1]-a[1]), f.fleetTypes, refresh));

  const profCounts=countBy(c=>c.profile);
  wrap.appendChild(checkGroup('Operational profile', [...profCounts.entries()].sort((a,b)=>b[1]-a[1]), f.profiles, refresh));

  const confCounts=countBy(c=>c.confidenceBucket);
  wrap.appendChild(checkGroup('Record confidence', ['High','Medium','Low'].map(b=>[b,confCounts.get(b)||0]), f.confidence, refresh));

  // size (all Unknown — honest note)
  const sizeBox=document.createElement('div');
  const sl=document.createElement('div'); sl.className='label'; sl.textContent='Company size'; sizeBox.appendChild(sl);
  const note=document.createElement('div'); note.className='tiny muted';
  note.innerHTML='Not available in OpenStreetMap — every record is <b>Unknown</b>. Filter is wired for a future source with employee data.';
  sizeBox.appendChild(note); wrap.appendChild(sizeBox);

  const reset=document.createElement('button'); reset.className='btn sm'; reset.textContent='Reset all filters';
  reset.onclick=()=>{ ['categories','likelihoods','sizes','bezirke','fleetTypes','profiles','confidence'].forEach(k=>f[k].clear());
    f.adjacency='all'; f.q=''; $('#search').value=''; hideInterp(); buildRail(); refresh(); };
  wrap.appendChild(reset);
  return wrap;
}
function clusterUI(){
  const w=document.createElement('div');
  const mk=(label,key,min,max,step)=>{ const r=document.createElement('div'); r.className='w';
    r.innerHTML=`<label>${label}</label>`;
    const inp=document.createElement('input'); inp.type='range'; inp.min=min; inp.max=max; inp.step=step; inp.value=STATE.dbscan[key];
    const v=document.createElement('span'); v.className='val'; v.textContent=STATE.dbscan[key];
    inp.oninput=()=>{ STATE.dbscan[key]=+inp.value; v.textContent=inp.value; };
    inp.onchange=()=>{ if(STATE.mode==='clusters') renderMode(); };
    r.append(inp,v); return r; };
  const box=document.createElement('div'); box.className='weights';
  box.appendChild(mk('Radius ε (m)','eps',200,1500,50));
  box.appendChild(mk('Min companies','minPts',3,15,1));
  w.appendChild(box);
  const note=document.createElement('div'); note.className='tiny muted'; note.style.marginTop='8px';
  note.textContent='Density-based clustering (DBSCAN) over the current filter. Clusters are statistical, not verified ecosystems.';
  w.appendChild(note);
  const go=document.createElement('button'); go.className='btn sm'; go.style.marginTop='8px'; go.textContent='Show clusters on map';
  go.onclick=()=>{ STATE.mode='clusters'; buildRail(); renderMode(); }; w.appendChild(go);
  return w;
}
function opportunityUI(){
  const w=document.createElement('div');
  const box=document.createElement('div'); box.className='weights';
  const mk=(label,key)=>{ const r=document.createElement('div'); r.className='w';
    r.innerHTML=`<label>${label}</label>`;
    const inp=document.createElement('input'); inp.type='range'; inp.min=0; inp.max=1; inp.step=0.05; inp.value=STATE.weights[key];
    const v=document.createElement('span'); v.className='val'; v.textContent=STATE.weights[key].toFixed(2);
    inp.oninput=()=>{ STATE.weights[key]=+inp.value; v.textContent=(+inp.value).toFixed(2); renderOppList(); };
    r.append(inp,v); return r; };
  box.appendChild(mk('Fleet potential','potential'));
  box.appendChild(mk('Data confidence','confidence'));
  box.appendChild(mk('Coverage gap','gap'));
  w.appendChild(box);
  const f=document.createElement('div'); f.className='formula';
  f.textContent='opportunity = 0.5·potential + 0.2·confidence + 0.3·gap';
  w.appendChild(f);
  const list=document.createElement('div'); list.id='opp-list'; list.className='bars'; w.appendChild(list);
  setTimeout(renderOppList,0);
  return w;
}
function renderOppList(){
  const el=$('#opp-list'); if(!el) return;
  const w=STATE.weights;
  $$('.formula').forEach(f=>{ if(f.textContent.startsWith('opportunity'))
    f.textContent=`opportunity = ${w.potential.toFixed(2)}·potential + ${w.confidence.toFixed(2)}·confidence + ${w.gap.toFixed(2)}·gap`; });
  const scores=opportunityScores(); const max=Math.max(...scores.map(s=>s.score),1e-6);
  el.innerHTML=scores.slice(0,8).map(s=>`<div class="bar" title="potential ${s.potential.toFixed(2)} · confidence ${s.conf.toFixed(2)} · gap ${s.gap.toFixed(2)}">
    <span class="nm">${s.name}</span><span class="track"><span class="fill" style="width:${(s.score/max*100).toFixed(0)}%"></span></span>
    <span class="n">${s.score.toFixed(2)}</span></div>`).join('');
}

/* ---- Dashboard ---- */
function renderDashboard(){
  const rows=STATE.filtered;
  const hi=rows.filter(r=>r.likelihood==='High').length;
  const cats=new Set(rows.map(r=>r.category)).size;
  const areas=new Set(rows.map(r=>r.bezirk)); areas.delete('Unknown');
  const topArea=distribution(rows.filter(r=>r.bezirk!=='Unknown'),r=>r.bezirk)[0];
  const stats=[
    ['companies',fmt(rows.length),'Companies','How many businesses match the current filters, out of '+fmt(STATE.all.length)+' fetched.'],
    ['high',fmt(hi),'High fleet potential','Records classified High fleet likelihood by the taxonomy (industry-inferred, not verified vehicle counts).'],
    ['cats',cats,'Industries','Distinct industry categories present in the filtered set.'],
    ['areas',areas.size,'Bezirke','Distinct Berlin districts with at least one matching company.'],
    ['top',topArea?topArea[0]:'—','Highest concentration', topArea?`${topArea[0]} has the most matching companies (${fmt(topArea[1])}). Computed from the current filter — not a fixed ranking.`:'No data.'],
  ];
  $('#dash').innerHTML=stats.map(([id,v,k,exp])=>
    `<div class="stat" data-exp="${encodeURIComponent(exp)}" data-k="${k}"><div class="v">${typeof v==='string'&&v.length>12?('<small>'+v+'</small>'):v}</div><div class="k">${k}</div></div>`).join('');
  $$('#dash .stat').forEach(s=>s.onclick=()=>openModal(s.dataset.k, `<p>${decodeURIComponent(s.dataset.exp)}</p>`));
}

/* ---- Detail panel ---- */
function openDetail(c){
  const s=$('#side'); s.classList.add('open');
  const q=(t)=>`<span class="quality q-${t.toLowerCase()}">${t}</span>`;
  const like=`<span class="badge ${LIKE_CLASS[c.likelihood]}"><span class="sw" style="background:${LIKE_COLOR[c.likelihood]}"></span>${c.likelihood}</span>`;
  $('#side .scroll').innerHTML=`
    <button class="btn ghost sm close" onclick="closeSide()">✕</button>
    <h3>${escapeHtml(c.name)}</h3>
    <div class="muted tiny">${c.category}${c.adjacent?' · adjacent market':''}</div>
    <div class="kv-list">
      <div class="r"><span class="k">Location</span><span class="val">${c.address?escapeHtml(c.address)+'<br>':''}<span class="muted tiny">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</span> ${q('Verified')}</span></div>
      <div class="r"><span class="k">Area</span><span class="val">${c.bezirk} ${q('Verified')}</span></div>
      <div class="r"><span class="k">Industry</span><span class="val">${c.category} ${q('Verified')}</span></div>
      <div class="r"><span class="k">Fleet likelihood</span><span class="val">${like} ${q('Inferred')}</span></div>
      <div class="r"><span class="k">Estimated fleet size</span><span class="val muted">Unknown ${q('Unknown')}</span></div>
      <div class="r"><span class="k">Fleet type</span><span class="val">${c.fleetType}</span></div>
      <div class="r"><span class="k">Operational profile</span><span class="val">${c.profile}</span></div>
      <div class="r"><span class="k">Company size</span><span class="val muted">Unknown ${q('Unknown')}</span></div>
      <div class="r"><span class="k">Operator</span><span class="val">${c.operator?escapeHtml(c.operator):'<span class="muted">—</span>'}</span></div>
      <div class="r"><span class="k">Website</span><span class="val">${c.website?`<a href="${escapeAttr(c.website)}" target="_blank" rel="noopener">${escapeHtml(c.website.replace(/^https?:\/\//,''))}</a>`:'<span class="muted">—</span>'}</span></div>
    </div>
    <div class="evidence">
      <div class="ttl">Why this classification</div>
      <div>${c.evidence}</div>
      <div style="margin-top:7px" class="tiny muted">Matched OSM tag: <span class="mono">${c.matchTag}</span> · Record confidence:
        <b>${c.confidenceBucket}</b> (${(c.confidence*100).toFixed(0)}%)</div>
    </div>
    <div style="margin-top:12px" class="tiny muted">Source: OpenStreetMap
      <a href="${c.sourceUrl}" target="_blank" rel="noopener">${c.osmType}/${c.osmId}</a> · fetched ${STATE.meta?new Date(STATE.meta.fetchedAt).toLocaleDateString():'—'}</div>
    <button class="btn sm" style="margin-top:12px" onclick='showTags(${JSON.stringify(c.id)})'>View raw OSM tags</button>
  `;
}
window.closeSide=()=>$('#side').classList.remove('open');
window.showTags=(id)=>{ const c=STATE.all.find(x=>x.id===id); if(!c)return;
  const rows=Object.entries(c.rawTags).map(([k,v])=>`<tr><td class="mono">${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('');
  openModal('Raw OSM tags — '+c.name, `<p class="tiny muted">Exactly as stored in OpenStreetMap. This is the primary evidence behind every field in the record.</p>
    <table><thead><tr><th>key</th><th>value</th></tr></thead><tbody>${rows}</tbody></table>`);
};

/* ---- Area & cluster panels ---- */
function barBlock(title, entries, colorFn){
  const max=Math.max(...entries.map(e=>e[1]),1);
  return `<div class="label" style="margin-top:10px">${title}</div><div class="bars">`+
    entries.map(([k,v])=>`<div class="bar"><span class="nm">${k}</span><span class="track"><span class="fill" style="width:${v/max*100}%;${colorFn?`background:${colorFn(k)}`:''}"></span></span><span class="n">${fmt(v)}</span></div>`).join('')+`</div>`;
}
function openAreaPanel(name){
  const a=areaStats(name); const s=$('#side'); s.classList.add('open');
  const other=STATE.compare[0]&&STATE.compare[0]!==name?STATE.compare[0]:null;
  $('#side .scroll').innerHTML=`<button class="btn ghost sm close" onclick="closeSide()">✕</button>
    <h3>${name}</h3><div class="muted tiny">Berlin Bezirk</div>
    <div class="kv-list"><div class="r"><span class="k">Companies</span><span class="val"><b>${fmt(a.count)}</b></span></div>
      <div class="r"><span class="k">Fleet potential</span><span class="val">${a.potential.toFixed(0)} <span class="muted tiny">(sum of likelihood weights)</span></span></div></div>
    ${barBlock('Fleet likelihood', a.byLike, (k)=>LIKE_COLOR[k])}
    ${barBlock('Top industries', a.byCat.slice(0,6))}
    <div style="display:flex;gap:6px;margin-top:12px">
      <button class="btn sm" onclick='setCompare(${JSON.stringify(name)})'>${STATE.compare[0]===name?'✓ Selected for compare':'Select for comparison'}</button>
      ${STATE.compare[0]&&STATE.compare[0]!==name?`<button class="btn sm primary" onclick='doCompare(${JSON.stringify(name)})'>Compare with ${STATE.compare[0]}</button>`:''}
    </div>`;
}
window.setCompare=(name)=>{ STATE.compare[0]=name; openAreaPanel(name); };
window.doCompare=(name)=>{ openCompare(STATE.compare[0],name); };
function openCompare(n1,n2){
  const a=areaStats(n1),b=areaStats(n2); openModal(`Compare areas · ${n1} vs ${n2}`,
    `<div class="cmp">
      <div class="col"><h4>${n1}</h4><div class="big">${fmt(a.count)}</div><div class="muted tiny">companies · potential ${a.potential.toFixed(0)}</div></div>
      <div class="col"><h4>${n2}</h4><div class="big">${fmt(b.count)}</div><div class="muted tiny">companies · potential ${b.potential.toFixed(0)}</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px">
      <div>${barBlock(n1+' — likelihood',a.byLike,k=>LIKE_COLOR[k])}${barBlock(n1+' — industries',a.byCat.slice(0,6))}</div>
      <div>${barBlock(n2+' — likelihood',b.byLike,k=>LIKE_COLOR[k])}${barBlock(n2+' — industries',b.byCat.slice(0,6))}</div>
    </div>
    <div class="callout">This tool presents the evidence side by side and does not compute an overall “best area” score — that judgement is left to you as the researcher.</div>`);
}
function openClusterPanel(cl){
  const s=$('#side'); s.classList.add('open');
  $('#side .scroll').innerHTML=`<button class="btn ghost sm close" onclick="closeSide()">✕</button>
    <h3>Exploratory cluster ${cl.id}</h3><div class="muted tiny">DBSCAN · statistical grouping, not a verified ecosystem</div>
    <div class="kv-list"><div class="r"><span class="k">Companies</span><span class="val"><b>${fmt(cl.size)}</b></span></div>
      <div class="r"><span class="k">Dominant industry</span><span class="val">${cl.dominantCat}</span></div>
      <div class="r"><span class="k">Fleet potential</span><span class="val">${cl.potential.toFixed(0)}</span></div></div>
    ${barBlock('Fleet likelihood', cl.byLike, k=>LIKE_COLOR[k])}
    <div class="label" style="margin-top:12px">Companies in cluster</div>
    <div style="max-height:230px;overflow:auto;margin-top:4px">${cl.members.slice(0,60).map(c=>
      `<div class="checkline" style="cursor:pointer" onclick='openDetailById(${JSON.stringify(c.id)})'><span class="sw" style="border-radius:50%;background:${LIKE_COLOR[c.likelihood]}"></span>${escapeHtml(c.name)}</div>`).join('')}
      ${cl.members.length>60?`<div class="tiny muted">…and ${cl.members.length-60} more</div>`:''}</div>`;
}
window.openDetailById=(id)=>{ const c=STATE.all.find(x=>x.id===id); if(c) openDetail(c); };

/* ---- Modal ---- */
function openModal(title,html){ $('#modal-title').textContent=title; $('#modal-body').innerHTML=html; $('#modal-bg').classList.add('open'); }
window.closeModal=()=>$('#modal-bg').classList.remove('open');

function methodologyHTML(){
  const rows=TAXONOMY.map((t,i)=>`<tr>
    <td><span class="badge ${LIKE_CLASS[t.like]}" style="font-size:10px"><span class="sw" style="background:${LIKE_COLOR[t.like]}"></span>${t.like}</span></td>
    <td><b>${t.cat}</b>${t.adjacent?' <span class="tiny muted">(adjacent)</span>':''}</td>
    <td class="mono tiny">${t.sel.map(s=>s[0]+'='+s[1]).join('<br>')}</td>
    <td>${t.prof}</td><td>${t.ftype}</td>
    <td class="tiny">${t.ev}</td></tr>`).join('');
  return `<div class="callout warn"><b>Read this first.</b> Fleet likelihood is an <b>analytical inference from OSM industry tags</b>, not a measurement of vehicles. Company location and industry are verified against OpenStreetMap; fleet size and employee counts are <b>Unknown</b> and never invented.</div>
    <p>Every business is classified by the first matching OpenStreetMap tag below. Editing this taxonomy in the source (one array) changes both the live Overpass query and the classification.</p>
    <table><thead><tr><th>Likelihood</th><th>Industry</th><th>OSM evidence tag</th><th>Profile</th><th>Fleet type</th><th>Reasoning</th></tr></thead><tbody>${rows}</tbody></table>
    <h4 style="margin-top:16px">Confidence score</h4>
    <p class="tiny">Per record, starting at 0.40 (verified location + explicit industry tag): +0.20 name, +0.12 operator, +0.10 website, +0.10 street address, +0.05 opening hours, +0.03 phone. Buckets: High ≥ 0.70, Medium ≥ 0.52, else Low.</p>`;
}
function sourcesHTML(){
  const m=STATE.meta;
  return `<table><thead><tr><th>Dataset</th><th>Detail</th></tr></thead><tbody>
    <tr><td><b>Business locations</b></td><td>OpenStreetMap, via the Overpass API.<br>Organization: OpenStreetMap contributors (ODbL).<br>URL: <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">openstreetmap.org</a> · Overpass: <a href="https://overpass-api.de" target="_blank" rel="noopener">overpass-api.de</a><br>
      Geographic resolution: individual establishments (point / building centroid).<br>Variables: name, operator, industry tags, address, website, coordinates.<br>Update frequency: continuous (community edited).<br>Limitations: coverage is uneven — smaller firms and depots may be missing or untagged; no employee counts or fleet sizes.<br>
      ${m?`Endpoint used: <span class="mono tiny">${m.endpoint||m.source}</span><br>Fetched: ${new Date(m.fetchedAt).toLocaleString()} · Raw elements: ${fmt(m.rawCount||0)} · Classified: ${fmt(STATE.all.length)}`:''}</td></tr>
    <tr><td><b>District boundaries</b></td><td>Berlin Bezirke (12 districts).<br>Source: Geoportal Berlin / OpenStreetMap, via public GeoJSON.<br>Geographic resolution: administrative district.<br>Note: geometry simplified for display; use official boundaries for precise spatial joins.</td></tr>
    </tbody></table>
    <div class="callout">Ortsteil / LOR boundaries are not bundled in this build (no reachable source at build time). Sub-district structure is instead shown through point density and DBSCAN clustering on real coordinates. The area model is a pluggable layer.</div>`;
}
function explainHTML(){
  const rows=STATE.filtered; const modeName=(MODES.find(m=>m[0]===STATE.mode)||[])[1];
  const hi=rows.filter(r=>r.likelihood==='High'||r.likelihood==='Medium').length;
  return `<p>This map is in <b>${modeName}</b> mode showing <b>${fmt(rows.length)}</b> Berlin businesses that match your current filters
    (<b>${fmt(hi)}</b> with high or medium fleet potential). Fleet potential is an analytical estimate based on industry and available
    company information; it does not represent verified vehicle counts.</p>
    <ul class="tiny">
      <li><b>Companies</b> — every matching business as a point, clustered when zoomed out.</li>
      <li><b>Density</b> — where businesses concentrate, regardless of likelihood.</li>
      <li><b>Fleet potential</b> — the same points weighted by likelihood (High 1.0, Medium 0.6, Low 0.25).</li>
      <li><b>Clusters</b> — exploratory DBSCAN groupings; statistical, not verified ecosystems.</li>
    </ul>
    <p class="tiny muted">Colours: <span style="color:${LIKE_COLOR.High}">High</span>, <span style="color:${LIKE_COLOR.Medium}">Medium</span>, <span style="color:${LIKE_COLOR.Low}">Low</span>, <span style="color:${LIKE_COLOR.Unknown}">Unknown</span> fleet likelihood.</p>`;
}

/* ===== 10. NL bar wiring =================================================== */
function runSearch(){
  const text=$('#search').value.trim(); if(!text){ hideInterp(); return; }
  const parsed=parseNL(text);
  const box=$('#interp');
  if(parsed.empty){
    box.innerHTML=`<div class="warn">No filters recognised in “${escapeHtml(text)}”. Try an industry, area, or “high fleet potential”. Searching names instead.</div>
      <div class="actions"><button class="btn sm" onclick="applyText()">Search names</button> <button class="btn sm ghost" onclick="hideInterp()">Dismiss</button></div>`;
    box.style.display='block'; return;
  }
  const tags=[...parsed.matched].map(m=>`<span class="tag">${escapeHtml(m)}</span>`).join('');
  box.innerHTML=`<div class="q">Your query: “${escapeHtml(text)}”</div>
    <div class="tiny muted" style="margin-top:4px">Interpreted as filters:</div>
    <div class="kv">${tags}</div>
    <div class="actions"><button class="btn sm primary" onclick="applyParsed()">Apply filters</button>
      <button class="btn sm ghost" onclick="hideInterp()">Cancel</button></div>
    <div class="tiny muted" style="margin-top:6px">Deterministic interpreter — it only sets filters over the existing dataset and never invents companies or places.</div>`;
  box.style.display='block';
  runSearch._parsed=parsed.filters;
}
window.applyParsed=()=>{ const p=runSearch._parsed; if(!p) return; const f=STATE.filters;
  ['categories','likelihoods','sizes','bezirke','profiles','fleetTypes'].forEach(k=>f[k].clear());
  for(const k of Object.keys(p)) p[k].forEach(v=>f[k].add(v));
  f.q=''; hideInterp(); buildRail(); applyFilters(); renderMode(); renderDashboard(); };
window.applyText=()=>{ STATE.filters.q=$('#search').value.trim(); hideInterp(); applyFilters(); renderMode(); renderDashboard(); };
window.hideInterp=()=>{ $('#interp').style.display='none'; };

/* ===== 11. EXPORT / SNAPSHOT ============================================== */
function exportCSV(){
  const rows=STATE.filtered;
  const cols=['id','name','category','likelihood','profile','fleetType','bezirk','lat','lng','address','operator','website','confidenceBucket','sourceUrl'];
  const esc=(v)=>`"${String(v??'').replace(/"/g,'""')}"`;
  const csv=[cols.join(','),...rows.map(r=>cols.map(c=>esc(r[c])).join(','))].join('\n');
  download('fleetview-berlin-filtered.csv', csv, 'text/csv');
}
function exportSnapshot(){
  const snap={ schema:'fleetview-berlin/1', meta:STATE.meta, taxonomyVersion:TAXONOMY.map(t=>t.cat),
    companies:STATE.all.map(({rawTags,_gx,_gy,...r})=>r) };
  download(`fleetview-berlin-snapshot-${(STATE.meta?.fetchedAt||'').slice(0,10)}.json`, JSON.stringify(snap), 'application/json');
}
function download(name,content,type){ const b=new Blob([content],{type}); const u=URL.createObjectURL(b);
  const a=document.createElement('a'); a.href=u; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(u),2000); }
function loadSnapshotFile(file){ const r=new FileReader();
  r.onload=()=>{ try{ const snap=JSON.parse(r.result);
    if(!snap.companies) throw new Error('not a FleetView snapshot');
    STATE.all=snap.companies.map(c=>({...c,rawTags:c.rawTags||{}}));
    STATE.meta={...(snap.meta||{}),source:'snapshot file',fetchedAt:snap.meta?.fetchedAt||new Date().toISOString()};
    onDataReady();
  }catch(e){ showError('Could not read snapshot: '+e.message); } };
  r.readAsText(file); }

/* ===== 12. OVERLAYS / LIFECYCLE =========================================== */
function showOverlay(html){ $('#overlay').innerHTML=`<div class="card">${html}</div>`; $('#overlay').classList.add('show'); }
function hideOverlay(){ $('#overlay').classList.remove('show'); }
function showLoading(msg){ showOverlay(`<div class="spinner"></div><h3>Loading Berlin fleet data</h3><p id="load-msg">${msg||''}</p>
  <p class="tiny muted">Querying OpenStreetMap live from your browser. First load can take 10–40s.</p>
  <div id="load-elapsed" class="tiny muted"></div>`); }
function showError(msg){ setStatus('err','Data error');
  showOverlay(`<h3>Couldn’t load live data</h3><p>${escapeHtml(msg)}</p>
   <p class="tiny muted">Overpass may be busy, rate-limited, or blocked on your network. You can retry, or load a previously saved snapshot.</p>
   <div class="actions"><button class="btn primary" onclick="startFetch()">Retry live fetch</button>
     <button class="btn" onclick="document.getElementById('snapfile').click()">Load snapshot file</button></div>`); }
function showEmpty(){ showOverlay(`<h3>No companies returned</h3>
   <p>The query succeeded but matched no records. This is unusual for Berlin — likely a transient Overpass issue.</p>
   <div class="actions"><button class="btn primary" onclick="startFetch()">Retry</button></div>`); }

function setStatus(kind,text){ $('#status-dot').className='dot '+(kind||''); $('#status-text').textContent=text; }

window.startFetch=async ()=>{
  hideInterp(); setStatus('busy','Fetching…'); showLoading('Building query…');
  const t0=Date.now();
  const iv=setInterval(()=>{ const el=$('#load-elapsed'); if(el) el.textContent=`${((Date.now()-t0)/1000)|0}s elapsed`; },500);
  try{
    const {rows,fetchedAt,endpoint,rawCount,query}=await fetchOverpass((m)=>{ const el=$('#load-msg'); if(el) el.textContent=m; });
    if(!rows.length){ clearInterval(iv); showEmpty(); return; }
    STATE.all=rows; STATE.meta={fetchedAt,endpoint,rawCount,query,source:'Overpass (live)'};
    clearInterval(iv); onDataReady();
  }catch(e){ clearInterval(iv); showError(e.message||String(e)); }
};
function onDataReady(){
  applyFilters(); buildRail(); renderMode(); renderDashboard();
  setStatus('ok', `${fmt(STATE.all.length)} companies · ${STATE.meta.source==='snapshot file'?'snapshot':'live'} ${new Date(STATE.meta.fetchedAt).toLocaleDateString()}`);
  hideOverlay();
}

/* ===== 13. UTIL & BOOT ==================================================== */
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function escapeAttr(s){ return escapeHtml(s); }

async function boot(){
  // Debug/introspection handle (also handy for the team in the console).
  window.STATE=STATE; window.applyFilters=applyFilters; window.parseNL=parseNL;
  window.FleetView={STATE,TAXONOMY,runDBSCAN,opportunityScores,buildOverpassQuery};
  try{ showLoading('Loading Berlin district boundaries…'); await loadBoundaries(); }
  catch(e){ showError('Could not load district boundaries: '+(e.message||e)); return; }
  initMap();
  // top bar buttons
  $('#btn-methodology').onclick=()=>openModal('Methodology & fleet classification', methodologyHTML());
  $('#btn-sources').onclick=()=>openModal('Data sources & provenance', sourcesHTML());
  $('#btn-explain').onclick=()=>openModal('What am I seeing?', explainHTML());
  $('#btn-csv').onclick=exportCSV;
  $('#btn-snapshot').onclick=exportSnapshot;
  $('#btn-refresh').onclick=()=>startFetch();
  $('#railtoggle').onclick=()=>$('#rail').classList.toggle('open');
  $('#modal-bg').onclick=(e)=>{ if(e.target.id==='modal-bg') closeModal(); };
  $('#search').addEventListener('keydown',e=>{ if(e.key==='Enter') runSearch(); });
  $('#btn-go').onclick=runSearch;
  $('#snapfile').addEventListener('change',e=>{ if(e.target.files[0]) loadSnapshotFile(e.target.files[0]); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closeModal(); closeSide(); } });
  startFetch();
}
document.addEventListener('DOMContentLoaded',boot);
