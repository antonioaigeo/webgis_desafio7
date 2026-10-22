/* WebGIS Exporter - motor do site gerado */
(function () {
  "use strict";

  var BASEMAPS = {
    osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap"
    }),
    carto_light: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20, attribution: "&copy; OpenStreetMap &copy; CARTO"
    }),
    esri_sat: L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Esri World Imagery" }
    ),
  };

  var map = L.map("map", { zoomControl: true, preferCanvas: true });
  var currentBasemap = null;
  var activeLeafletLayers = {};   // id -> L.layer
  var layersMeta = {};            // id -> config entry
  var legendOrder = [];

  function setBasemap(key) {
    if (!BASEMAPS[key]) key = "osm";
    if (currentBasemap) map.removeLayer(currentBasemap);
    currentBasemap = BASEMAPS[key];
    currentBasemap.addTo(map);
  }

  // Camadas de tiles (Google Hybrid, Bing, etc.) detectadas no QGIS
  // entram aqui como mapas base reais — leves, com zoom nítido — em
  // vez de uma imagem estática pesada.
  function registerExtraBasemaps(list) {
    if (!list || !list.length) return;
    var sel = document.getElementById("basemap-select");
    list.forEach(function (bm) {
      BASEMAPS[bm.id] = L.tileLayer(bm.url, {
        minZoom: bm.minZoom || 0,
        maxZoom: bm.maxZoom || 22,
        attribution: bm.name,
      });
      var opt = document.createElement("option");
      opt.value = bm.id;
      opt.textContent = bm.name;
      sel.appendChild(opt);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function buildPopup(props) {
    var rows = [];
    for (var k in props) {
      if (k === "_label" || k === "_labelPoint") continue;
      var v = props[k];
      if (v === null || v === undefined || v === "") continue;
      rows.push(
        "<tr><td>" + escapeHtml(k) + "</td><td>" + escapeHtml(v) + "</td></tr>"
      );
    }
    if (!rows.length) return null;
    return '<table class="popup-table">' + rows.join("") + "</table>";
  }

  // ---------- estilos vetoriais ----------
  function styleForFeatureCategorized(props, cfg) {
    var val = props[cfg.field];
    for (var i = 0; i < cfg.classes.length; i++) {
      var c = cfg.classes[i];
      if (String(c.value) === String(val)) return c.style;
    }
    return cfg.default || cfg.classes[0].style;
  }

  function styleForFeatureGraduated(props, cfg) {
    var raw = props[cfg.field];
    var val = typeof raw === "number" ? raw : parseFloat(raw);
    if (isNaN(val)) return cfg.default;
    for (var i = 0; i < cfg.classes.length; i++) {
      var c = cfg.classes[i];
      if (val >= c.min && val <= c.max) return c.style;
    }
    return cfg.default || (cfg.classes.length ? cfg.classes[0].style : null);
  }

  function styleForFeatureRule(props, cfg) {
    // avaliação simplificada: sem motor de expressão QGIS no browser,
    // usamos a primeira classe como aproximação visual.
    return (cfg.classes[0] && cfg.classes[0].style) || cfg.default;
  }

  function resolveStyle(props, cfg) {
    if (cfg.kind === "categorized") return styleForFeatureCategorized(props, cfg) || cfg.default;
    if (cfg.kind === "graduated") return styleForFeatureGraduated(props, cfg) || cfg.default;
    if (cfg.kind === "rule") return styleForFeatureRule(props, cfg) || cfg.default;
    return cfg.default;
  }

  function pointToLayerFactory(cfg, pane) {
    return function (feature, latlng) {
      var st = resolveStyle(feature.properties, cfg) || {};
      return L.circleMarker(latlng, {
        pane: pane,
        radius: st.radius || 6,
        color: st.color || "#1f6fd6",
        weight: st.weight || 1.5,
        opacity: st.opacity != null ? st.opacity : 1,
        fillColor: st.fillColor || "#3388ff",
        fillOpacity: st.fillOpacity != null ? st.fillOpacity : 0.65,
      });
    };
  }

  function vectorStyleFactory(cfg, pane) {
    return function (feature) {
      var st = resolveStyle(feature.properties, cfg) || {};
      if (cfg.geomType === "line") {
        return {
          pane: pane,
          color: st.color || "#1f6fd6",
          weight: st.weight || 2.5,
          opacity: st.opacity != null ? st.opacity : 1,
        };
      }
      return {
        pane: pane,
        color: st.color || "#1f6fd6",
        weight: st.weight || 1.5,
        opacity: st.opacity != null ? st.opacity : 1,
        fillColor: st.fillColor || "#3388ff",
        fillOpacity: st.fillOpacity != null ? st.fillOpacity : 0.5,
      };
    };
  }

  // ---------- hierarquia de sobreposição (definida na exportação) ----------
  // Cada camada ganha seu próprio "pane" do Leaflet, com um z-index baseado
  // na ordem escolhida no plugin (topo da lista = por cima), para que a
  // sobreposição visual no site siga fielmente o que foi definido no QGIS,
  // não importando a ordem em que as camadas são ligadas/desligadas.
  var PANE_Z_TOP = 620;
  var PANE_Z_FLOOR = 410;
  function ensurePane(meta) {
    var paneName = "wg-pane-" + meta.id;
    if (!map.getPane(paneName)) {
      var pane = map.createPane(paneName);
      var rank = typeof meta.order === "number" ? meta.order : 0;
      var z = PANE_Z_TOP - rank;
      if (z < PANE_Z_FLOOR) z = PANE_Z_FLOOR;
      pane.style.zIndex = z;
    }
    return paneName;
  }

  function onEachFeature(feature, layer) {
    var html = buildPopup(feature.properties || {});
    if (html) layer.bindPopup(html);
  }

  // ---------- legenda dinâmica ----------
  function renderLegend() {
    var box = document.getElementById("legend-content");
    var visible = legendOrder.filter(function (id) {
      return activeLeafletLayers[id];
    });
    if (!visible.length) {
      box.innerHTML = '<p class="muted">Ative uma camada para ver a legenda.</p>';
      return;
    }
    var html = "";
    visible.forEach(function (id) {
      var meta = layersMeta[id];
      html += '<div class="legend-group"><h3>' + escapeHtml(meta.name) + "</h3>";
      if (meta.legendKind === "ramp" && meta.legend && meta.legend.length) {
        var stops = meta.legend.map(function (it) { return it.color; }).join(",");
        html += '<div class="legend-ramp"><div class="legend-ramp-bar" style="background:linear-gradient(to right,' + stops + ')"></div>';
        html += '<div class="legend-ramp-labels"><span>' + escapeHtml(meta.legend[0].label) + "</span><span>" +
          escapeHtml(meta.legend[meta.legend.length - 1].label) + "</span></div></div>";
      } else if (meta.legend && meta.legend.length) {
        meta.legend.forEach(function (it) {
          var shapeClass = it.shape === "point" ? "point" : (it.shape === "line" ? "line" : "");
          var style = "background:" + (it.color || "#3388ff") + ";";
          if (it.shape !== "line") style += "opacity:" + (it.fillOpacity != null ? it.fillOpacity : 1) + ";";
          html += '<div class="legend-row"><span class="legend-swatch ' + shapeClass + '" style="' + style + '"></span><span>' +
            escapeHtml(it.label) + "</span></div>";
        });
      } else {
        html += '<p class="muted small">Sem classes de legenda.</p>';
      }
      html += "</div>";
    });
    box.innerHTML = html;
  }

  // ---------- montagem de camadas (sob demanda) ----------
  // Estratégia de leveza: os dados de uma camada (GeoJSON ou PNG) só são
  // buscados na rede na PRIMEIRA vez que ela é ligada — camadas incluídas
  // no site mas que começam desmarcadas não custam banda nem tempo de
  // carregamento inicial nenhum.
  function loadVectorLayer(meta, onReady) {
    var pane = ensurePane(meta);
    fetch(meta.data).then(function (r) { return r.json(); }).then(function (geojson) {
      var opts = { onEachFeature: onEachFeature, pane: pane };
      if (meta.geomType === "point") {
        opts.pointToLayer = pointToLayerFactory(meta, pane);
      } else {
        opts.style = vectorStyleFactory(meta, pane);
      }
      var layer = L.geoJSON(geojson, opts);
      meta._leafletLayerRef = layer;
      onReady(layer);
    }).catch(function (err) {
      console.error("Falha ao carregar camada", meta.id, err);
      meta._loadFailed = true;
    });
  }

  function loadRasterLayer(meta, onReady) {
    var pane = ensurePane(meta);
    var layer = L.imageOverlay(meta.image, meta.bounds, { opacity: 0.9, pane: pane });
    meta._leafletLayerRef = layer;
    onReady(layer);
  }

  function activateLayer(id) {
    var meta = layersMeta[id];
    if (!meta) return;
    if (meta._leafletLayerRef) {
      meta._leafletLayerRef.addTo(map);
      activeLeafletLayers[id] = meta._leafletLayerRef;
      renderLegend();
      return;
    }
    var onReady = function (layer) {
      // a pessoa pode ter desmarcado de novo antes do fetch terminar
      var cb = document.getElementById("layer-cb-" + id);
      if (!cb || !cb.checked) return;
      activeLeafletLayers[id] = layer;
      layer.addTo(map);
      renderLegend();
    };
    if (meta.type === "vector") loadVectorLayer(meta, onReady);
    else loadRasterLayer(meta, onReady);
  }

  function toggleLayer(id, on) {
    var meta = layersMeta[id];
    if (!meta) return;
    if (on) {
      activateLayer(id);
    } else {
      if (meta._leafletLayerRef) map.removeLayer(meta._leafletLayerRef);
      delete activeLeafletLayers[id];
      renderLegend();
    }
  }

  function renderLayerRow(meta, parent) {
    layersMeta[meta.id] = meta;
    legendOrder.push(meta.id);
    var label = document.createElement("label");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "layer-cb-" + meta.id;
    cb.checked = !!meta.visibleByDefault;
    cb.addEventListener("change", function () { toggleLayer(meta.id, cb.checked); });
    label.appendChild(cb);
    var span = document.createElement("span");
    span.textContent = meta.name;
    label.appendChild(span);
    parent.appendChild(label);
    if (meta.visibleByDefault) activateLayer(meta.id);
  }

  // Reproduz os grupos (pastas) do painel de camadas do QGIS no site,
  // como seções recolhíveis nativas (<details>), sem nenhuma biblioteca.
  function buildLayerList(layers) {
    var box = document.getElementById("layer-list");
    box.innerHTML = "";
    // Mesma hierarquia definida na exportação: topo da lista = por cima no mapa.
    var ordered = (layers || []).slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0);
    });

    var groups = {};
    var groupOrder = [];
    var ungrouped = [];
    ordered.forEach(function (meta) {
      if (meta.group) {
        if (!groups[meta.group]) { groups[meta.group] = []; groupOrder.push(meta.group); }
        groups[meta.group].push(meta);
      } else {
        ungrouped.push(meta);
      }
    });

    groupOrder.forEach(function (groupName) {
      var details = document.createElement("details");
      details.className = "layer-group";
      details.open = true;
      var summary = document.createElement("summary");
      summary.textContent = groupName;
      details.appendChild(summary);
      var body = document.createElement("div");
      body.className = "layer-group-body";
      groups[groupName].forEach(function (meta) { renderLayerRow(meta, body); });
      details.appendChild(body);
      box.appendChild(details);
    });

    ungrouped.forEach(function (meta) { renderLayerRow(meta, box); });
  }

  function fitToAll(layers) {
    var b = null;
    layers.forEach(function (meta) {
      var bounds = meta.bounds;
      if (!bounds) return;
      var lb = L.latLngBounds(bounds);
      b = b ? b.extend(lb) : lb;
    });
    if (b && b.isValid()) map.fitBounds(b, { padding: [20, 20] });
    else map.setView([-15.78, -47.93], 4); // fallback: Brasil
  }

  function initUI(cfg) {
    document.getElementById("page-title").textContent = cfg.title || "WebGIS";
    document.getElementById("site-title").textContent = cfg.title || "WebGIS";
    document.getElementById("site-subtitle").textContent = cfg.subtitle || "";
    if (cfg.logo) {
      var img = document.getElementById("site-logo");
      img.src = cfg.logo;
      img.style.display = "inline-block";
    }
    document.getElementById("about-title-modal").textContent = "Sobre " + (cfg.title || "este mapa");
    document.getElementById("about-text").textContent = cfg.about || "Nenhuma descrição foi adicionada.";
    document.getElementById("authors-text").textContent = cfg.authors || "Não informado.";

    var contactsHtml = [];
    if (cfg.email) {
      contactsHtml.push('<a href="mailto:' + escapeHtml(cfg.email) + '">&#9993; ' + escapeHtml(cfg.email) + "</a>");
    }
    (cfg.links || []).forEach(function (lk) {
      if (!lk.url) return;
      contactsHtml.push('<a href="' + escapeHtml(lk.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(lk.label || lk.url) + "</a>");
    });
    var contactsBox = document.getElementById("about-contacts");
    if (contactsHtml.length) {
      contactsBox.innerHTML = "<h3>Contato</h3><p>" + contactsHtml.join(" &nbsp;·&nbsp; ") + "</p>";
    } else {
      contactsBox.innerHTML = "";
    }

    var aboutModal = document.getElementById("about-modal");
    document.getElementById("btn-about").addEventListener("click", function () {
      aboutModal.classList.add("is-open");
    });
    document.getElementById("about-close").addEventListener("click", function () {
      aboutModal.classList.remove("is-open");
    });
    aboutModal.addEventListener("click", function (e) {
      if (e.target === aboutModal) aboutModal.classList.remove("is-open");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") aboutModal.classList.remove("is-open");
    });
    document.getElementById("btn-layers").addEventListener("click", function () {
      document.getElementById("sidebar").classList.toggle("open");
    });

    registerExtraBasemaps(cfg.extraBasemaps);

    var basemapSel = document.getElementById("basemap-select");
    basemapSel.value = cfg.basemap || "osm";
    basemapSel.addEventListener("change", function () { setBasemap(basemapSel.value); });
    setBasemap(cfg.basemap || "osm");

    addLocateControl();
    addSearchControl();
    addMeasureControl();
    addScaleControl();
    addNorthArrow();
    addFullscreenControl();
    setupFooter(cfg);
    setupUrlSync();
  }

  // ---------- Escala (controle nativo do Leaflet, custo zero) ----------
  function addScaleControl() {
    L.control.scale({ position: "bottomleft", metric: true, imperial: false, maxWidth: 140 }).addTo(map);
  }

  // ---------- Seta do norte ----------
  function addNorthArrow() {
    var NorthControl = L.Control.extend({
      options: { position: "topright" },
      onAdd: function () {
        var div = L.DomUtil.create("div", "wg-north-arrow");
        div.title = "Norte";
        div.innerHTML =
          '<svg width="30" height="30" viewBox="0 0 30 30">' +
          '<polygon points="15,2 20,20 15,16 10,20" fill="#1f2531" stroke="#fff" stroke-width="1"/>' +
          '<text x="15" y="29" text-anchor="middle" font-size="8" font-weight="700" fill="#1f2531">N</text>' +
          "</svg>";
        return div;
      },
    });
    map.addControl(new NorthControl());
  }

  // ---------- Tela cheia (Fullscreen API nativa, sem lib) ----------
  function addFullscreenControl() {
    var FullscreenControl = L.Control.extend({
      options: { position: "topright" },
      onAdd: function () {
        var div = L.DomUtil.create("div", "leaflet-bar");
        var a = L.DomUtil.create("a", "wg-tool-btn", div);
        a.href = "#"; a.title = "Tela cheia"; a.innerHTML = "&#9974;";
        L.DomEvent.on(a, "click", function (e) {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          var root = document.documentElement;
          if (!document.fullscreenElement) {
            (root.requestFullscreen || root.webkitRequestFullscreen || function () {}).call(root);
            a.innerHTML = "&#9975;";
          } else {
            (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
            a.innerHTML = "&#9974;";
          }
        });
        document.addEventListener("fullscreenchange", function () {
          a.innerHTML = document.fullscreenElement ? "&#9975;" : "&#9974;";
        });
        return div;
      },
    });
    map.addControl(new FullscreenControl());
  }

  // ---------- Rodapé: contato, redes, atualização, atribuição ----------
  function setupFooter(cfg) {
    var footer = document.getElementById("app-footer");
    var parts = [];

    if (cfg.generatedAt) {
      var d = new Date(cfg.generatedAt);
      var dateStr = isNaN(d.getTime()) ? cfg.generatedAt : d.toLocaleDateString("pt-BR");
      parts.push('<span>Atualizado em ' + escapeHtml(dateStr) + "</span>");
    }

    var contact = [];
    if (cfg.email) {
      contact.push('<a href="mailto:' + escapeHtml(cfg.email) + '" title="E-mail">&#9993; ' + escapeHtml(cfg.email) + "</a>");
    }
    (cfg.links || []).forEach(function (lk) {
      if (!lk.url) return;
      contact.push('<a href="' + escapeHtml(lk.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(lk.label || lk.url) + "</a>");
    });
    if (contact.length) parts.push('<span class="footer-contacts">' + contact.join(" · ") + "</span>");

    parts.push('<span class="muted">Gerado com WebGIS Exporter (QGIS)</span>');

    if (!parts.length) { footer.style.display = "none"; return; }
    footer.innerHTML = parts.join('<span class="footer-sep">•</span>');
  }

  // ---------- Compartilhar visão atual pela URL (#lat/lng/zoom) ----------
  var hashViewApplied = false;
  function hashHasView() {
    var parts = window.location.hash.replace("#", "").split("/");
    if (parts.length !== 3) return null;
    var lat = parseFloat(parts[0]), lng = parseFloat(parts[1]), z = parseInt(parts[2], 10);
    if (isNaN(lat) || isNaN(lng) || isNaN(z)) return null;
    return { lat: lat, lng: lng, zoom: z };
  }
  function setupUrlSync() {
    var v = hashHasView();
    if (v) {
      map.setView([v.lat, v.lng], v.zoom);
      hashViewApplied = true;
    }
    map.on("moveend", function () {
      var c = map.getCenter();
      var hash = "#" + c.lat.toFixed(5) + "/" + c.lng.toFixed(5) + "/" + map.getZoom();
      history.replaceState(null, "", hash);
    });
  }

  // ---------- Localizar-me ----------
  function addLocateControl() {
    var LocateControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var div = L.DomUtil.create("div", "leaflet-bar");
        var a = L.DomUtil.create("a", "wg-tool-btn", div);
        a.href = "#"; a.title = "Minha localização"; a.innerHTML = "&#128205;";
        var marker = null, circle = null;
        L.DomEvent.on(a, "click", function (e) {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          if (!navigator.geolocation) {
            alert("Geolocalização não suportada neste navegador.");
            return;
          }
          a.innerHTML = "&#8987;";
          navigator.geolocation.getCurrentPosition(function (pos) {
            a.innerHTML = "&#128205;";
            var latlng = [pos.coords.latitude, pos.coords.longitude];
            if (marker) map.removeLayer(marker);
            if (circle) map.removeLayer(circle);
            marker = L.circleMarker(latlng, {
              radius: 7, color: "#fff", weight: 2, fillColor: "#1f6fd6", fillOpacity: 1,
            }).addTo(map);
            circle = L.circle(latlng, { radius: pos.coords.accuracy, color: "#1f6fd6", weight: 1, fillOpacity: 0.08 }).addTo(map);
            map.setView(latlng, Math.max(map.getZoom(), 15));
          }, function (err) {
            a.innerHTML = "&#128205;";
            alert("Não foi possível obter sua localização: " + err.message);
          }, { enableHighAccuracy: true, timeout: 10000 });
        });
        return div;
      },
    });
    map.addControl(new LocateControl());
  }

  // ---------- Buscar endereço (Nominatim/OpenStreetMap) ----------
  function addSearchControl() {
    var SearchControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var wrap = L.DomUtil.create("div", "wg-search-wrap");
        var box = L.DomUtil.create("div", "wg-search-control", wrap);
        var input = L.DomUtil.create("input", "", box);
        input.type = "text";
        input.placeholder = "Buscar endereço ou local...";
        var btn = L.DomUtil.create("button", "", box);
        btn.type = "button"; btn.innerHTML = "&#128269;";
        var results = L.DomUtil.create("div", "wg-search-results", wrap);

        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);

        var marker = null;
        var searchTimer = null;

        function doSearch() {
          var q = input.value.trim();
          if (!q) return;
          results.innerHTML = '<div class="muted">Buscando...</div>';
          results.classList.add("show");
          fetch("https://nominatim.openstreetmap.org/search?format=json&limit=6&q=" + encodeURIComponent(q))
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (!data.length) {
                results.innerHTML = '<div class="muted">Nenhum resultado encontrado.</div>';
                return;
              }
              results.innerHTML = "";
              data.forEach(function (place) {
                var row = document.createElement("div");
                row.textContent = place.display_name;
                row.addEventListener("click", function () {
                  var latlng = [parseFloat(place.lat), parseFloat(place.lon)];
                  if (marker) map.removeLayer(marker);
                  marker = L.marker(latlng).addTo(map).bindPopup(place.display_name).openPopup();
                  if (place.boundingbox) {
                    var bb = place.boundingbox.map(parseFloat);
                    map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]]);
                  } else {
                    map.setView(latlng, 15);
                  }
                  results.classList.remove("show");
                });
                results.appendChild(row);
              });
            })
            .catch(function () {
              results.innerHTML = '<div class="muted">Falha na busca. Tente novamente.</div>';
            });
        }

        btn.addEventListener("click", doSearch);
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") doSearch();
          if (e.key === "Escape") results.classList.remove("show");
        });
        input.addEventListener("input", function () {
          clearTimeout(searchTimer);
          if (input.value.trim().length < 3) { results.classList.remove("show"); return; }
          searchTimer = setTimeout(doSearch, 600);
        });

        return wrap;
      },
    });
    map.addControl(new SearchControl());
  }

  // ---------- Medir distância e área ----------
  function geodesicArea(latlngs) {
    var n = latlngs.length, area = 0, d2r = Math.PI / 180;
    if (n < 3) return 0;
    for (var i = 0; i < n; i++) {
      var p1 = latlngs[i], p2 = latlngs[(i + 1) % n];
      area += ((p2.lng - p1.lng) * d2r) * (2 + Math.sin(p1.lat * d2r) + Math.sin(p2.lat * d2r));
    }
    return Math.abs(area * 6378137.0 * 6378137.0 / 2.0);
  }

  function formatDistance(m) {
    return m < 1000 ? m.toFixed(0) + " m" : (m / 1000).toFixed(2) + " km";
  }
  function formatArea(m2) {
    return m2 < 10000 ? m2.toFixed(0) + " m²" : (m2 / 10000).toFixed(2) + " ha";
  }

  function addMeasureControl() {
    var mode = null; // "distance" | "area" | null
    var points = [];
    var drawLayer = null;
    var tooltip = null;
    var distBtn = null, areaBtn = null;

    function reset() {
      points = [];
      if (drawLayer) { map.removeLayer(drawLayer); drawLayer = null; }
      if (tooltip) { map.removeLayer(tooltip); tooltip = null; }
    }

    function stop() {
      mode = null;
      map.getContainer().style.cursor = "";
      map.doubleClickZoom.enable();
      if (distBtn) distBtn.classList.remove("wg-active");
      if (areaBtn) areaBtn.classList.remove("wg-active");
    }

    function redraw() {
      if (drawLayer) map.removeLayer(drawLayer);
      if (!points.length) return;
      if (mode === "area" && points.length > 2) {
        drawLayer = L.polygon(points, { color: "#e0672c", weight: 2, fillOpacity: 0.15 }).addTo(map);
      } else {
        drawLayer = L.polyline(points, { color: "#e0672c", weight: 3 }).addTo(map);
      }
      var label = mode === "area" && points.length > 2
        ? formatArea(geodesicArea(points))
        : formatDistance(pathLength(points));
      var last = points[points.length - 1];
      if (tooltip) map.removeLayer(tooltip);
      tooltip = L.tooltip({ permanent: true, direction: "top", className: "wg-measure-tooltip" })
        .setLatLng(last).setContent(label).addTo(map);
    }

    function pathLength(pts) {
      var total = 0;
      for (var i = 1; i < pts.length; i++) total += pts[i - 1].distanceTo(pts[i]);
      return total;
    }

    function onMapClick(e) {
      if (!mode) return;
      points.push(e.latlng);
      redraw();
    }
    function onMapDblClick() {
      if (!mode) return;
      stop();
    }

    map.on("click", onMapClick);
    map.on("dblclick", onMapDblClick);

    var MeasureControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var div = L.DomUtil.create("div", "leaflet-bar");
        L.DomEvent.disableClickPropagation(div);

        var d = L.DomUtil.create("a", "wg-tool-btn", div);
        d.href = "#"; d.title = "Medir distância"; d.innerHTML = "&#128207;";
        var ar = L.DomUtil.create("a", "wg-tool-btn", div);
        ar.href = "#"; ar.title = "Medir área"; ar.innerHTML = "&#9723;";
        var clr = L.DomUtil.create("a", "wg-tool-btn", div);
        clr.href = "#"; clr.title = "Limpar medição"; clr.innerHTML = "&#10006;";

        distBtn = d; areaBtn = ar;

        L.DomEvent.on(d, "click", function (e) {
          L.DomEvent.preventDefault(e);
          reset();
          if (mode === "distance") { stop(); return; }
          mode = "distance";
          map.getContainer().style.cursor = "crosshair";
          map.doubleClickZoom.disable();
          d.classList.add("wg-active"); ar.classList.remove("wg-active");
        });
        L.DomEvent.on(ar, "click", function (e) {
          L.DomEvent.preventDefault(e);
          reset();
          if (mode === "area") { stop(); return; }
          mode = "area";
          map.getContainer().style.cursor = "crosshair";
          map.doubleClickZoom.disable();
          ar.classList.add("wg-active"); d.classList.remove("wg-active");
        });
        L.DomEvent.on(clr, "click", function (e) {
          L.DomEvent.preventDefault(e);
          reset();
          stop();
        });
        return div;
      },
    });
    map.addControl(new MeasureControl());
  }

  fetch("config.json").then(function (r) { return r.json(); }).then(function (cfg) {
    initUI(cfg);
    buildLayerList(cfg.layers || []);
    if (hashViewApplied) {
      // a URL já trazia uma posição específica (link compartilhado) — respeita ela
    } else if (cfg.initialBounds) {
      // visão atual do QGIS no momento da exportação
      map.fitBounds(cfg.initialBounds);
    } else if (cfg.initialCenter && cfg.initialZoom) {
      map.setView(cfg.initialCenter, cfg.initialZoom);
    } else {
      fitToAll(cfg.layers || []);
    }
  }).catch(function (err) {
    console.error("Erro ao carregar config.json", err);
    map.setView([-15.78, -47.93], 4);
    setBasemap("osm");
  });
})();
