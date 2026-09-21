/* ============================================================================
   FleetView Berlin — Initial research insights.
   Loaded after app.js. All figures are computed live from the current dataset
   (window.STATE) so they update automatically and are never fabricated.
   ============================================================================ */
(function(){
  'use strict';

  function insightsHTML(){
    var S = window.STATE || {all:[], meta:null};
    var all = S.all || [];
    var n = all.length || 1;
    var pct = function(x){ return Math.round(x / n * 100); };
    var F = function(x){ try { return x.toLocaleString('en-US'); } catch(e){ return String(x); } };
    var countWhere = function(fn){ return all.filter(fn).length; };
    var dist = function(fn){
      var m = {};
      all.forEach(function(c){ var k = fn(c); m[k] = (m[k]||0)+1; });
      return Object.keys(m).map(function(k){ return [k, m[k]]; }).sort(function(a,b){ return b[1]-a[1]; });
    };
    var topStr = function(entries, k){
      return entries.slice(0, k).map(function(e){ return e[0] + ' (' + F(e[1]) + ')'; }).join(', ');
    };

    var core = all.filter(function(c){ return !c.adjacent; });
    var adj  = all.filter(function(c){ return c.adjacent; });
    var high = countWhere(function(c){ return c.likelihood === 'High'; });
    var low  = countWhere(function(c){ return c.likelihood === 'Low'; });
    var logCour = countWhere(function(c){ return c.category === 'Logistics' || c.category === 'Courier / Last-mile'; });
    var named = countWhere(function(c){ return c.named; });
    var addr  = countWhere(function(c){ return c.address; });
    var web   = countWhere(function(c){ return c.website; });
    var unknownBez = countWhere(function(c){ return c.bezirk === 'Unknown'; });
    var topBez = topStr(dist(function(c){ return c.bezirk; }).filter(function(e){ return e[0] !== 'Unknown'; }), 3);
    var topCore = topStr((function(){ var m={}; core.forEach(function(c){ m[c.category]=(m[c.category]||0)+1; });
      return Object.keys(m).map(function(k){ return [k,m[k]]; }).sort(function(a,b){ return b[1]-a[1]; }); })(), 3);

    var when = S.meta ? new Date(S.meta.fetchedAt).toLocaleDateString() : '—';

    var block = function(h, fig, imp){
      return '<div style="margin:0 0 15px">' +
        '<div style="font-weight:650;letter-spacing:-.01em;margin-bottom:3px">' + h + '</div>' +
        '<div style="color:var(--accent);font-weight:600;font-size:12px;margin-bottom:4px">' + fig + '</div>' +
        '<div class="tiny muted">' + imp + '</div></div>';
    };

    return '' +
      '<div class="callout warn">These read off the <b>data currently loaded in your browser</b> (' + F(n) +
        ' businesses, fetched ' + when + '). They are directional signals from a single OpenStreetMap snapshot — ' +
        'fleet likelihood is inferred, coverage is uneven, and fleet / employee sizes are unknown. ' +
        'Treat them as hypotheses to validate, not measured facts.</div>' +

      block('The market is many small fleets, not a few big logistics players',
        'Classic Logistics + Courier are only ' + F(logCour) + ' of ' + F(n) + ' businesses (' + pct(logCour) + '%). The core is led by ' + topCore + '.',
        'A fleet product has to serve the long tail of small trade and service fleets — plumbers, electricians, care services — ' +
        'who don’t call themselves “fleet managers”. The obvious heavy-logistics segment is numerically tiny.') +

      block('Nearly half the map is adjacent market, not fleet operators',
        F(adj.length) + ' of ' + F(n) + ' (' + pct(adj.length) + '%) are auto-repair / parts / builders’ merchants — they serve fleets but don’t run them. Core operators: ' + F(core.length) + '.',
        'Counting businesses overstates the operator market. Demand sizing must separate operators from the service economy around them — that’s what the Core / Adjacent toggle is for.') +

      block('Fleet involvement is thin and uncertain in open data',
        'Only ' + F(high) + ' (' + pct(high) + '%) are high fleet-likelihood; ' + pct(low) + '% are low.',
        'Public tags can’t reliably tell you who runs a fleet. A real product needs operator onboarding or a licensing / telematics source — exactly the gap an MDS data layer could fill.') +

      block('The businesses are spread across residential / outer Berlin, not downtown',
        'Most-represented districts: ' + topBez + '. ' + (unknownBez ? '(' + F(unknownBez) + ' points fell outside the district boundaries — a geocoding limit, not a finding.)' : ''),
        'Fleet activity clusters where people live and where building and repair happen, not in the transit-dense centre — relevant if the product links fleets to MDS mobility data or plans charging / low-emission zones.') +

      block('The most valuable data is exactly what’s missing',
        pct(named) + '% have names, ' + pct(addr) + '% addresses, ' + pct(web) + '% websites — but 0% carry fleet size or vehicle mix.',
        'The high-value fields (fleet size, vehicles, routes) are absent from open data by definition. The product’s job is to capture or broker that data, not scrape it — which confirms the “translation + contribution layer” framing of the challenge.') +

      block('Live open-data querying is too slow and flaky to ship on',
        'Loading this set needs multi-mirror fallback and up to ~90s per endpoint; public Overpass instances regularly time out.',
        'A production MDS product can’t hit public endpoints live per user — it needs a cached, governed backend. That reliability gap is itself part of what MDS infrastructure offers.') +

      '<div class="tiny muted" style="margin-top:4px">Fuller write-up and a reproducible snapshot live in the team’s MDS Challenge notes. These figures update automatically with whatever data you’ve loaded.</div>';
  }

  window.insightsHTML = insightsHTML;

  document.addEventListener('DOMContentLoaded', function(){
    var b = document.getElementById('btn-insights');
    if (b) b.onclick = function(){
      if (window.openModal) window.openModal('Initial research insights', insightsHTML());
    };
  });
})();
