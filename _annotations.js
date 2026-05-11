/* ====================================================================
   Shelfly Deck — In-Deck Annotations Widget v3
   Vanilla JS. Cero deps. Auto-init on DOMContentLoaded.

   v3 changes (sobre v2):
   - Removido File System Access API + IndexedDB handle storage.
   - Sync a disco via local server (http://localhost:8787) que arranca
     solo via launchd. Cero clicks de "Conectar carpeta".
   - localStorage sigue siendo cache primario; auto-POST a /save con
     debounce 500ms cuando hay cambios.
   - Status indicator chiquito: verde = server OK, gris = offline.
   - Si el server no responde, todo funciona local (solo localStorage).

   Conservado de v2:
   - Modo dibujo libre (canvas overlay por slide) con colores + grosor + borrador
   - Modo seleccionDeTexto: comentarios anclados a texto seleccionado
   - Modos present: ?present=clean | ?present=annotated | ?present=true (=clean)
   - Export ZIP-like manual: JSON + PNG por slide + README
   ==================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'shelfly_deck_comments_v1';
  var DECK_NAME = 'shelfly';
  var SCHEMA_VERSION = '2.0';
  var SERVER_URL = 'http://localhost:8787';
  var AUTOSAVE_DEBOUNCE_MS = 500;
  var HEALTH_RECHECK_MS = 15000; // re-ping every 15s if offline

  var SVG_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var SVG_PEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>';
  var SVG_CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var SVG_ERASER = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H7L3 16a2 2 0 0 1 0-2.83l9.17-9.17a2 2 0 0 1 2.83 0l5.17 5.17a2 2 0 0 1 0 2.83L11 20"/></svg>';

  var DRAW_COLORS = [
    { id: 'orange', value: 'rgba(255,107,53,0.7)', solid: '#FF6B35' },
    { id: 'navy', value: 'rgba(10,37,64,0.75)', solid: '#0A2540' },
    { id: 'yellow', value: 'rgba(255,193,7,0.65)', solid: '#FFC107' }
  ];
  var DRAW_WIDTHS = [
    { id: 'thin', value: 2 },
    { id: 'medium', value: 4 },
    { id: 'thick', value: 8 }
  ];

  // ---------- Present mode ----------
  function getPresentMode() {
    try {
      var p = new URLSearchParams(window.location.search);
      var v = p.get('present');
      if (!v) return null;
      if (v === 'true' || v === '1' || v === 'clean') return 'clean';
      if (v === 'annotated') return 'annotated';
      return 'clean';
    } catch (e) {
      return null;
    }
  }

  // ---------- Storage (localStorage) ----------
  function emptySlide() {
    return { comments: [], drawings: [], selections: [] };
  }

  function loadAll() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { version: SCHEMA_VERSION, slides: {} };
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { version: SCHEMA_VERSION, slides: {} };
      }
      // Migration: v1 raw shape was { s1: [comments], s2: [...] }
      if (!parsed.version || !parsed.slides) {
        var migrated = { version: SCHEMA_VERSION, slides: {} };
        Object.keys(parsed).forEach(function (slideId) {
          var val = parsed[slideId];
          if (Array.isArray(val)) {
            migrated.slides[slideId] = { comments: val, drawings: [], selections: [] };
          }
        });
        saveAll(migrated, { silent: true });
        return migrated;
      }
      // Ensure all slides have all three buckets
      Object.keys(parsed.slides).forEach(function (sid) {
        var s = parsed.slides[sid] || {};
        if (!Array.isArray(s.comments)) s.comments = [];
        if (!Array.isArray(s.drawings)) s.drawings = [];
        if (!Array.isArray(s.selections)) s.selections = [];
        parsed.slides[sid] = s;
      });
      parsed.version = SCHEMA_VERSION;
      return parsed;
    } catch (e) {
      console.warn('[annotations] load failed', e);
      return { version: SCHEMA_VERSION, slides: {} };
    }
  }
  function saveAll(data, opts) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[annotations] localStorage save failed', e);
    }
    if (!opts || !opts.silent) {
      try { scheduleAutoSave(); } catch (e) { /* may not be wired yet */ }
    }
  }
  function getSlide(slideId) {
    var all = loadAll();
    if (!all.slides[slideId]) all.slides[slideId] = emptySlide();
    return all.slides[slideId];
  }
  function setSlide(slideId, slide) {
    var all = loadAll();
    all.slides[slideId] = slide;
    saveAll(all);
  }
  function getComments(slideId) { return getSlide(slideId).comments || []; }
  function getDrawings(slideId) { return getSlide(slideId).drawings || []; }
  function getSelections(slideId) { return getSlide(slideId).selections || []; }

  function addComment(slideId, text) {
    var s = getSlide(slideId);
    s.comments.push({ ts: new Date().toISOString(), text: text });
    setSlide(slideId, s);
  }
  function deleteComment(slideId, index) {
    var s = getSlide(slideId);
    s.comments.splice(index, 1);
    setSlide(slideId, s);
  }
  function addDrawingPath(slideId, path) {
    var s = getSlide(slideId);
    s.drawings.push({ ts: new Date().toISOString(), path: path });
    setSlide(slideId, s);
  }
  function clearDrawings(slideId) {
    var s = getSlide(slideId);
    s.drawings = [];
    setSlide(slideId, s);
  }
  function removeLastDrawing(slideId) {
    var s = getSlide(slideId);
    s.drawings.pop();
    setSlide(slideId, s);
  }
  function addSelection(slideId, sel) {
    var s = getSlide(slideId);
    s.selections.push(Object.assign({ ts: new Date().toISOString() }, sel));
    setSlide(slideId, s);
  }
  function deleteSelection(slideId, index) {
    var s = getSlide(slideId);
    s.selections.splice(index, 1);
    setSlide(slideId, s);
  }

  // ---------- Server sync ----------
  var serverState = {
    online: false,
    lastSaveStatus: null, // 'ok' | 'err' | 'pending' | 'offline' | null
    autosaveTimer: null,
    healthTimer: null,
    inFlight: false,
    pending: false
  };

  function buildDataFilePayload() {
    var all = loadAll();
    var slides = document.querySelectorAll('section.slide');
    var slidesOut = {};
    for (var i = 0; i < slides.length; i++) {
      var section = slides[i];
      var sid = section.id;
      if (!sid) continue;
      var s = all.slides[sid] || emptySlide();
      slidesOut[sid] = {
        title: slideTitle(section),
        comments: s.comments || [],
        selections: s.selections || [],
        drawings: s.drawings || []
      };
    }
    // Include slides we have data for but no DOM section
    Object.keys(all.slides || {}).forEach(function (sid) {
      if (slidesOut[sid]) return;
      var s = all.slides[sid];
      slidesOut[sid] = {
        title: '',
        comments: s.comments || [],
        selections: s.selections || [],
        drawings: s.drawings || []
      };
    });
    return {
      version: SCHEMA_VERSION,
      last_updated: new Date().toISOString(),
      deck_path: '/Users/pedro/Projects/personal/marketplace-reps/deck/index.html',
      deck: DECK_NAME,
      slides: slidesOut
    };
  }

  function pingHealth() {
    return fetch(SERVER_URL + '/health', { method: 'GET', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var ok = !!(j && j.ok);
        if (ok !== serverState.online) {
          serverState.online = ok;
          setStatus(ok ? (serverState.lastSaveStatus === 'err' ? 'err' : 'ok') : 'offline');
        }
        return ok;
      })
      .catch(function () {
        if (serverState.online) {
          serverState.online = false;
          setStatus('offline');
        }
        return false;
      });
  }

  function saveToServer() {
    if (!serverState.online) {
      serverState.pending = false;
      setStatus('offline');
      return Promise.resolve(false);
    }
    if (serverState.inFlight) {
      serverState.pending = true;
      return Promise.resolve(false);
    }
    serverState.inFlight = true;
    setStatus('pending');
    var payload = buildDataFilePayload();
    return fetch(SERVER_URL + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    })
      .then(function (r) {
        serverState.inFlight = false;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        setStatus('ok');
        if (serverState.pending) {
          serverState.pending = false;
          return saveToServer();
        }
        return true;
      })
      .catch(function (err) {
        serverState.inFlight = false;
        console.warn('[annotations] save failed', err);
        // Fall back to offline mode and retry health soon
        serverState.online = false;
        setStatus('offline');
        return false;
      });
  }

  function scheduleAutoSave() {
    clearTimeout(serverState.autosaveTimer);
    if (!serverState.online) {
      setStatus('offline');
      return;
    }
    setStatus('pending');
    serverState.autosaveTimer = setTimeout(function () {
      saveToServer();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function saveSnapshotToServer(slideId, dataUrl) {
    if (!serverState.online) return Promise.resolve(false);
    return fetch(SERVER_URL + '/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slideId: slideId,
        dataUrl: dataUrl,
        timestamp: new Date().toISOString()
      }),
      cache: 'no-store'
    })
      .then(function (r) { return r.ok; })
      .catch(function (err) {
        console.warn('[annotations] snapshot failed', err);
        return false;
      });
  }

  function saveAllSnapshotsForSlide(slideId) {
    if (!serverState.online) return;
    var section = document.getElementById(slideId);
    if (!section) return;
    if (!getDrawings(slideId).length) return;
    try {
      var dataUrl = rasterizeSlideDrawings(section);
      saveSnapshotToServer(slideId, dataUrl);
    } catch (e) {
      console.warn('[annotations] snapshot failed', e);
    }
  }

  function loadFromServer() {
    return fetch(SERVER_URL + '/load', { method: 'GET', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // Cold-boot restore: if localStorage is empty but server has data, hydrate.
  function maybeHydrateFromServer() {
    var local = loadAll();
    var hasLocal = Object.keys(local.slides || {}).some(function (sid) {
      var s = local.slides[sid] || {};
      return (s.comments && s.comments.length) ||
             (s.drawings && s.drawings.length) ||
             (s.selections && s.selections.length);
    });
    if (hasLocal) return Promise.resolve(false);
    return loadFromServer().then(function (data) {
      if (!data || !data.slides) return false;
      var migrated = { version: SCHEMA_VERSION, slides: {} };
      Object.keys(data.slides).forEach(function (sid) {
        var s = data.slides[sid] || {};
        migrated.slides[sid] = {
          comments: Array.isArray(s.comments) ? s.comments : [],
          drawings: Array.isArray(s.drawings) ? s.drawings : [],
          selections: Array.isArray(s.selections) ? s.selections : []
        };
      });
      saveAll(migrated, { silent: true });
      console.info('[annotations] hydrated from server · ' + Object.keys(migrated.slides).length + ' slides');
      return true;
    });
  }

  // ---------- Status badge ----------
  var statusBadge = null;
  function renderStatusBadge() {
    if (!statusBadge) {
      statusBadge = document.createElement('div');
      statusBadge.className = 'ann-fs-badge';
      statusBadge.innerHTML =
        '<span class="ann-fs-dot"></span>' +
        '<span class="ann-fs-text"></span>' +
        '<button type="button" class="ann-fs-action" data-action="force">Forzar guardar</button>';
      document.body.appendChild(statusBadge);
      statusBadge.querySelector('[data-action="force"]').addEventListener('click', function () {
        pingHealth().then(function (ok) { if (ok) saveToServer(); });
      });
    }
    var dot = statusBadge.querySelector('.ann-fs-dot');
    var text = statusBadge.querySelector('.ann-fs-text');
    var forceBtn = statusBadge.querySelector('[data-action="force"]');
    var s = serverState.lastSaveStatus;
    if (!serverState.online) {
      dot.className = 'ann-fs-dot off';
      text.textContent = 'Solo local (server offline)';
      forceBtn.hidden = true;
      return;
    }
    forceBtn.hidden = false;
    if (s === 'err') {
      dot.className = 'ann-fs-dot err';
      text.textContent = 'Error al guardar';
    } else if (s === 'pending') {
      dot.className = 'ann-fs-dot pending';
      text.textContent = 'Guardando...';
    } else {
      dot.className = 'ann-fs-dot ok';
      text.textContent = 'Guardado';
    }
  }
  function setStatus(s) {
    serverState.lastSaveStatus = s;
    renderStatusBadge();
  }

  // ---------- Utils ----------
  function fmtTs(iso) {
    try {
      var d = new Date(iso);
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
             ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return iso; }
  }
  function todayStr() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function slideTitle(section) {
    var h = section.querySelector('h1, h2, h3');
    if (h && h.textContent) {
      var t = h.textContent.trim().replace(/\s+/g, ' ');
      if (t.length > 60) t = t.slice(0, 57) + '...';
      return t;
    }
    return section.id || 'slide';
  }

  // ---------- Element selector (xpath-ish) ----------
  function getElementSelector(el, root) {
    if (!el || el === root) return '';
    var parts = [];
    var cur = el;
    while (cur && cur !== root && cur.nodeType === 1) {
      var nodeName = cur.nodeName.toLowerCase();
      var parent = cur.parentNode;
      if (!parent) break;
      var sameTagSiblings = [];
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].nodeName.toLowerCase() === nodeName) {
          sameTagSiblings.push(parent.children[i]);
        }
      }
      var idx = sameTagSiblings.indexOf(cur);
      var part = nodeName + (sameTagSiblings.length > 1 ? '[' + (idx + 1) + ']' : '');
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  // ---------- Drawing layer ----------
  function ensureDrawLayer(section) {
    var layer = section.querySelector(':scope > .ann-draw-layer');
    if (layer) return layer;
    var cs = window.getComputedStyle(section);
    if (cs.position === 'static') section.style.position = 'relative';
    layer = document.createElement('div');
    layer.className = 'ann-draw-layer';
    layer.setAttribute('data-slide-id', section.id);
    var svgNs = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'ann-draw-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    layer.appendChild(svg);
    section.appendChild(layer);
    sizeDrawLayer(section, layer, svg);
    renderDrawings(section);
    return layer;
  }

  function sizeDrawLayer(section, layer, svg) {
    var w = section.clientWidth || 1280;
    var h = section.clientHeight || 720;
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    layer.dataset.width = w;
    layer.dataset.height = h;
  }

  function renderDrawings(section) {
    var layer = section.querySelector(':scope > .ann-draw-layer');
    if (!layer) return;
    var svg = layer.querySelector('svg');
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var drawings = getDrawings(section.id);
    var svgNs = 'http://www.w3.org/2000/svg';
    for (var i = 0; i < drawings.length; i++) {
      var d = drawings[i].path;
      if (!d || !d.points || d.points.length < 1) continue;
      var pts = d.points;
      var pathStr = '';
      if (pts.length === 1) {
        pathStr = 'M ' + pts[0][0] + ' ' + pts[0][1] + ' L ' + (pts[0][0] + 0.01) + ' ' + (pts[0][1] + 0.01);
      } else {
        pathStr = 'M ' + pts[0][0] + ' ' + pts[0][1];
        for (var p = 1; p < pts.length; p++) {
          pathStr += ' L ' + pts[p][0] + ' ' + pts[p][1];
        }
      }
      var pathEl = document.createElementNS(svgNs, 'path');
      pathEl.setAttribute('d', pathStr);
      pathEl.setAttribute('stroke', d.color || 'rgba(255,107,53,0.7)');
      pathEl.setAttribute('stroke-width', d.width || 4);
      pathEl.setAttribute('stroke-linecap', 'round');
      pathEl.setAttribute('stroke-linejoin', 'round');
      pathEl.setAttribute('fill', 'none');
      svg.appendChild(pathEl);
    }
  }

  // ---------- Draw mode state ----------
  var drawState = {
    active: false,
    color: DRAW_COLORS[0].value,
    width: DRAW_WIDTHS[1].value,
    eraser: false,
    activeSection: null,
    currentPoints: null,
    currentPathEl: null
  };

  function activateDrawMode() {
    drawState.active = true;
    document.body.classList.add('ann-draw-active');
    showDrawToolbar();
    var slides = document.querySelectorAll('section.slide');
    for (var i = 0; i < slides.length; i++) {
      attachDrawHandlers(slides[i]);
    }
  }

  function deactivateDrawMode() {
    drawState.active = false;
    document.body.classList.remove('ann-draw-active');
    hideDrawToolbar();
    var slides = document.querySelectorAll('section.slide');
    for (var i = 0; i < slides.length; i++) {
      detachDrawHandlers(slides[i]);
    }
    // Snapshot every slide that has drawings (cheap, async, fire-and-forget)
    if (serverState.online) {
      for (var j = 0; j < slides.length; j++) {
        if (getDrawings(slides[j].id).length) {
          saveAllSnapshotsForSlide(slides[j].id);
        }
      }
    }
    var allFabs = document.querySelectorAll('.ann-fab-draw');
    allFabs.forEach(function (f) { f.classList.remove('active'); });
  }

  function getPointInSvg(svg, evt) {
    var rect = svg.getBoundingClientRect();
    var clientX, clientY;
    if (evt.touches && evt.touches.length) {
      clientX = evt.touches[0].clientX;
      clientY = evt.touches[0].clientY;
    } else {
      clientX = evt.clientX;
      clientY = evt.clientY;
    }
    var x = (clientX - rect.left) * (parseFloat(svg.getAttribute('viewBox').split(' ')[2]) / rect.width);
    var y = (clientY - rect.top) * (parseFloat(svg.getAttribute('viewBox').split(' ')[3]) / rect.height);
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  }

  function onDrawStart(e) {
    if (!drawState.active) return;
    var section = e.currentTarget._annSection;
    if (!section) return;
    e.preventDefault();
    if (drawState.eraser) {
      removeLastDrawing(section.id);
      renderDrawings(section);
      refreshFab(section.id);
      return;
    }
    drawState.activeSection = section;
    drawState.currentPoints = [];
    var svg = section.querySelector('.ann-draw-svg');
    var pt = getPointInSvg(svg, e);
    drawState.currentPoints.push(pt);
    var svgNs = 'http://www.w3.org/2000/svg';
    var pathEl = document.createElementNS(svgNs, 'path');
    pathEl.setAttribute('d', 'M ' + pt[0] + ' ' + pt[1]);
    pathEl.setAttribute('stroke', drawState.color);
    pathEl.setAttribute('stroke-width', drawState.width);
    pathEl.setAttribute('stroke-linecap', 'round');
    pathEl.setAttribute('stroke-linejoin', 'round');
    pathEl.setAttribute('fill', 'none');
    svg.appendChild(pathEl);
    drawState.currentPathEl = pathEl;
  }
  function onDrawMove(e) {
    if (!drawState.active || !drawState.activeSection || !drawState.currentPathEl) return;
    e.preventDefault();
    var svg = drawState.activeSection.querySelector('.ann-draw-svg');
    var pt = getPointInSvg(svg, e);
    var last = drawState.currentPoints[drawState.currentPoints.length - 1];
    var dx = pt[0] - last[0], dy = pt[1] - last[1];
    if (dx * dx + dy * dy < 1) return;
    drawState.currentPoints.push(pt);
    var d = drawState.currentPathEl.getAttribute('d');
    drawState.currentPathEl.setAttribute('d', d + ' L ' + pt[0] + ' ' + pt[1]);
  }
  function onDrawEnd(e) {
    if (!drawState.active || !drawState.activeSection) return;
    if (!drawState.currentPoints || drawState.currentPoints.length < 1) {
      drawState.activeSection = null;
      drawState.currentPathEl = null;
      drawState.currentPoints = null;
      return;
    }
    addDrawingPath(drawState.activeSection.id, {
      color: drawState.color,
      width: drawState.width,
      points: drawState.currentPoints
    });
    refreshFab(drawState.activeSection.id);
    drawState.activeSection = null;
    drawState.currentPathEl = null;
    drawState.currentPoints = null;
  }

  function attachDrawHandlers(section) {
    var layer = ensureDrawLayer(section);
    if (layer._annHandlersAttached) return;
    layer._annSection = section;
    layer.classList.add('interactive');
    layer.addEventListener('mousedown', onDrawStart);
    layer.addEventListener('mousemove', onDrawMove);
    layer.addEventListener('mouseup', onDrawEnd);
    layer.addEventListener('mouseleave', onDrawEnd);
    layer.addEventListener('touchstart', onDrawStart, { passive: false });
    layer.addEventListener('touchmove', onDrawMove, { passive: false });
    layer.addEventListener('touchend', onDrawEnd);
    layer.addEventListener('touchcancel', onDrawEnd);
    layer._annHandlersAttached = true;
  }
  function detachDrawHandlers(section) {
    var layer = section.querySelector(':scope > .ann-draw-layer');
    if (!layer || !layer._annHandlersAttached) return;
    layer.classList.remove('interactive');
    layer.removeEventListener('mousedown', onDrawStart);
    layer.removeEventListener('mousemove', onDrawMove);
    layer.removeEventListener('mouseup', onDrawEnd);
    layer.removeEventListener('mouseleave', onDrawEnd);
    layer.removeEventListener('touchstart', onDrawStart);
    layer.removeEventListener('touchmove', onDrawMove);
    layer.removeEventListener('touchend', onDrawEnd);
    layer.removeEventListener('touchcancel', onDrawEnd);
    layer._annHandlersAttached = false;
  }

  // ---------- Draw toolbar ----------
  var drawToolbar = null;
  function buildDrawToolbar() {
    if (drawToolbar) return drawToolbar;
    drawToolbar = document.createElement('div');
    drawToolbar.className = 'ann-draw-toolbar';
    var colorHtml = '';
    for (var i = 0; i < DRAW_COLORS.length; i++) {
      var c = DRAW_COLORS[i];
      colorHtml += '<button type="button" class="ann-color-swatch' + (i === 0 ? ' active' : '') +
        '" data-color="' + c.value + '" style="background:' + c.solid + '" aria-label="Color ' + c.id + '"></button>';
    }
    var widthHtml = '';
    for (var j = 0; j < DRAW_WIDTHS.length; j++) {
      var w = DRAW_WIDTHS[j];
      widthHtml += '<button type="button" class="ann-width-btn' + (j === 1 ? ' active' : '') +
        '" data-width="' + w.value + '" aria-label="Grosor ' + w.id + '"><span style="height:' + w.value + 'px"></span></button>';
    }
    drawToolbar.innerHTML =
      '<div class="ann-draw-tb-group">' + colorHtml + '</div>' +
      '<div class="ann-draw-tb-divider"></div>' +
      '<div class="ann-draw-tb-group">' + widthHtml + '</div>' +
      '<div class="ann-draw-tb-divider"></div>' +
      '<button type="button" class="ann-draw-tb-btn" data-action="eraser" aria-label="Borrador (un trazo)">' + SVG_ERASER + '</button>' +
      '<button type="button" class="ann-draw-tb-btn" data-action="clear" aria-label="Limpiar slide">Limpiar</button>' +
      '<div class="ann-draw-tb-divider"></div>' +
      '<button type="button" class="ann-draw-tb-btn ann-draw-tb-close" data-action="close" aria-label="Cerrar dibujo">' + SVG_CLOSE + '</button>';
    document.body.appendChild(drawToolbar);

    var swatches = drawToolbar.querySelectorAll('.ann-color-swatch');
    swatches.forEach(function (sw) {
      sw.addEventListener('click', function () {
        swatches.forEach(function (x) { x.classList.remove('active'); });
        sw.classList.add('active');
        drawState.color = sw.getAttribute('data-color');
        drawState.eraser = false;
        drawToolbar.querySelector('[data-action="eraser"]').classList.remove('active');
      });
    });
    var widths = drawToolbar.querySelectorAll('.ann-width-btn');
    widths.forEach(function (wb) {
      wb.addEventListener('click', function () {
        widths.forEach(function (x) { x.classList.remove('active'); });
        wb.classList.add('active');
        drawState.width = parseFloat(wb.getAttribute('data-width'));
      });
    });
    drawToolbar.querySelector('[data-action="eraser"]').addEventListener('click', function () {
      drawState.eraser = !drawState.eraser;
      this.classList.toggle('active', drawState.eraser);
    });
    drawToolbar.querySelector('[data-action="clear"]').addEventListener('click', function () {
      var section = findMostVisibleSlide();
      if (!section) return;
      if (!confirm('Borrar todos los dibujos de "' + slideTitle(section) + '"?')) return;
      clearDrawings(section.id);
      renderDrawings(section);
      refreshFab(section.id);
    });
    drawToolbar.querySelector('[data-action="close"]').addEventListener('click', deactivateDrawMode);
    return drawToolbar;
  }
  function showDrawToolbar() {
    buildDrawToolbar();
    drawToolbar.classList.add('visible');
  }
  function hideDrawToolbar() {
    if (drawToolbar) drawToolbar.classList.remove('visible');
  }
  function findMostVisibleSlide() {
    var slides = document.querySelectorAll('section.slide');
    var best = null, bestArea = 0;
    var vw = window.innerWidth, vh = window.innerHeight;
    for (var i = 0; i < slides.length; i++) {
      var r = slides[i].getBoundingClientRect();
      var x = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      var y = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      var area = x * y;
      if (area > bestArea) { bestArea = area; best = slides[i]; }
    }
    return best;
  }

  // ---------- Text selection popover ----------
  var selPopover = null;
  var pendingSelection = null;

  function buildSelPopover() {
    if (selPopover) return selPopover;
    selPopover = document.createElement('div');
    selPopover.className = 'ann-sel-popover';
    selPopover.innerHTML =
      '<button type="button" class="ann-sel-btn" data-action="open">Comentar selección</button>' +
      '<div class="ann-sel-form" hidden>' +
        '<textarea class="ann-sel-textarea" placeholder="Tu comentario sobre el texto..." rows="3"></textarea>' +
        '<div class="ann-sel-actions">' +
          '<button type="button" class="ann-sel-cancel">Cancelar</button>' +
          '<button type="button" class="ann-sel-save">Guardar</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(selPopover);

    selPopover.querySelector('[data-action="open"]').addEventListener('click', function () {
      selPopover.querySelector('.ann-sel-btn').hidden = true;
      selPopover.querySelector('.ann-sel-form').hidden = false;
      setTimeout(function () {
        var ta = selPopover.querySelector('.ann-sel-textarea');
        if (ta) ta.focus();
      }, 50);
    });
    selPopover.querySelector('.ann-sel-cancel').addEventListener('click', function () {
      closeSelPopover();
    });
    selPopover.querySelector('.ann-sel-save').addEventListener('click', function () {
      if (!pendingSelection) return closeSelPopover();
      var ta = selPopover.querySelector('.ann-sel-textarea');
      var v = (ta.value || '').trim();
      if (!v) return;
      addSelection(pendingSelection.slideId, {
        selectedText: pendingSelection.selectedText,
        elementSelector: pendingSelection.elementSelector,
        comment: v
      });
      applyHighlightsForSlide(pendingSelection.slideId);
      refreshFab(pendingSelection.slideId);
      closeSelPopover();
    });
    return selPopover;
  }
  function showSelPopover(rect) {
    buildSelPopover();
    selPopover.querySelector('.ann-sel-btn').hidden = false;
    selPopover.querySelector('.ann-sel-form').hidden = true;
    selPopover.querySelector('.ann-sel-textarea').value = '';
    selPopover.classList.add('visible');
    var top = window.scrollY + rect.top - 50;
    var left = window.scrollX + rect.left + (rect.width / 2) - 90;
    if (top < window.scrollY + 8) top = window.scrollY + rect.bottom + 8;
    if (left < 8) left = 8;
    if (left + 220 > window.innerWidth) left = window.innerWidth - 228;
    selPopover.style.top = top + 'px';
    selPopover.style.left = left + 'px';
  }
  function closeSelPopover() {
    if (selPopover) selPopover.classList.remove('visible');
    pendingSelection = null;
  }

  function findSlideForNode(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('slide')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function onTextSelection() {
    setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      var text = sel.toString().trim();
      if (!text || text.length < 2) return;
      var range = sel.getRangeAt(0);
      var section = findSlideForNode(range.startContainer);
      if (!section) return;
      var commonAncestor = range.commonAncestorContainer;
      var anc = commonAncestor.nodeType === 1 ? commonAncestor : commonAncestor.parentElement;
      if (anc && (anc.closest('.ann-panel') || anc.closest('.ann-sel-popover') || anc.closest('.ann-draw-toolbar'))) return;
      var rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      var startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      pendingSelection = {
        slideId: section.id,
        selectedText: text,
        elementSelector: getElementSelector(startEl, section)
      };
      showSelPopover(rect);
    }, 10);
  }

  // ---------- Highlight existing selections ----------
  function applyHighlightsForSlide(slideId) {
    var section = document.getElementById(slideId);
    if (!section) return;
    var prev = section.querySelectorAll('.ann-highlight');
    prev.forEach(function (sp) {
      var parent = sp.parentNode;
      if (!parent) return;
      while (sp.firstChild) parent.insertBefore(sp.firstChild, sp);
      parent.removeChild(sp);
      parent.normalize();
    });
    var selections = getSelections(slideId);
    if (!selections.length) return;
    selections.forEach(function (s, idx) {
      wrapFirstOccurrence(section, s.selectedText, idx);
    });
  }

  function wrapFirstOccurrence(root, text, selIndex) {
    if (!text) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('.ann-fab, .ann-panel, .ann-draw-layer, .ann-sel-popover, .ann-draw-toolbar, script, style')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (p.classList && p.classList.contains('ann-highlight')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var idx = node.nodeValue.indexOf(text);
      if (idx !== -1) {
        var before = node.nodeValue.slice(0, idx);
        var match = node.nodeValue.slice(idx, idx + text.length);
        var after = node.nodeValue.slice(idx + text.length);
        var parent = node.parentNode;
        var beforeNode = document.createTextNode(before);
        var span = document.createElement('span');
        span.className = 'ann-highlight';
        span.setAttribute('data-sel-index', selIndex);
        span.textContent = match;
        var afterNode = document.createTextNode(after);
        parent.insertBefore(beforeNode, node);
        parent.insertBefore(span, node);
        parent.insertBefore(afterNode, node);
        parent.removeChild(node);
        return true;
      }
    }
    return false;
  }

  function onHighlightClick(e) {
    var span = e.target.closest && e.target.closest('.ann-highlight');
    if (!span) return;
    var section = findSlideForNode(span);
    if (!section) return;
    var idx = parseInt(span.getAttribute('data-sel-index'), 10);
    var selections = getSelections(section.id);
    if (isNaN(idx) || !selections[idx]) return;
    var sel = selections[idx];
    e.preventDefault();
    e.stopPropagation();
    showHighlightTooltip(span, sel, section.id, idx);
  }

  var highlightTip = null;
  function buildHighlightTip() {
    if (highlightTip) return highlightTip;
    highlightTip = document.createElement('div');
    highlightTip.className = 'ann-hl-tip';
    document.body.appendChild(highlightTip);
    document.addEventListener('click', function (e) {
      if (!highlightTip.classList.contains('visible')) return;
      if (!e.target.closest('.ann-hl-tip') && !e.target.closest('.ann-highlight')) {
        highlightTip.classList.remove('visible');
      }
    });
    return highlightTip;
  }
  function showHighlightTooltip(span, sel, slideId, idx) {
    buildHighlightTip();
    highlightTip.innerHTML =
      '<div class="ann-hl-tip-ts">' + escapeHtml(fmtTs(sel.ts)) + '</div>' +
      '<div class="ann-hl-tip-text">' + escapeHtml(sel.comment) + '</div>' +
      '<button type="button" class="ann-hl-tip-del">Borrar</button>';
    highlightTip.querySelector('.ann-hl-tip-del').addEventListener('click', function (e) {
      e.stopPropagation();
      deleteSelection(slideId, idx);
      applyHighlightsForSlide(slideId);
      refreshFab(slideId);
      highlightTip.classList.remove('visible');
    });
    var r = span.getBoundingClientRect();
    var top = window.scrollY + r.bottom + 6;
    var left = window.scrollX + r.left;
    if (left + 260 > window.innerWidth) left = window.innerWidth - 268;
    if (left < 8) left = 8;
    highlightTip.style.top = top + 'px';
    highlightTip.style.left = left + 'px';
    highlightTip.classList.add('visible');
  }

  // ---------- Panel ----------
  var panel = null;
  var currentSlideId = null;

  function buildPanel() {
    if (panel) return panel;
    panel = document.createElement('aside');
    panel.className = 'ann-panel';
    panel.innerHTML =
      '<div class="ann-panel-header">' +
        '<div>' +
          '<p class="ann-panel-title" data-ann="title">Comentarios</p>' +
          '<p class="ann-panel-subtitle" data-ann="subtitle"></p>' +
        '</div>' +
        '<button class="ann-close" data-ann="close" aria-label="Cerrar">' + SVG_CLOSE + '</button>' +
      '</div>' +
      '<div class="ann-panel-tabs">' +
        '<button type="button" class="ann-tab active" data-tab="comments">Comentarios</button>' +
        '<button type="button" class="ann-tab" data-tab="selections">Selecciones</button>' +
        '<button type="button" class="ann-tab" data-tab="drawings">Dibujos</button>' +
      '</div>' +
      '<div class="ann-panel-body">' +
        '<div data-tab-panel="comments">' +
          '<form class="ann-form" data-ann="form">' +
            '<textarea class="ann-textarea" data-ann="textarea" placeholder="Escribe tu comentario..." rows="3"></textarea>' +
            '<button type="submit" class="ann-save" data-ann="save">Guardar</button>' +
          '</form>' +
          '<div class="ann-list" data-ann="list"></div>' +
        '</div>' +
        '<div data-tab-panel="selections" hidden>' +
          '<div class="ann-list" data-ann="sel-list"></div>' +
        '</div>' +
        '<div data-tab-panel="drawings" hidden>' +
          '<div class="ann-draw-summary" data-ann="draw-summary"></div>' +
          '<button type="button" class="ann-btn" data-ann="clear-drawings">Borrar todos los dibujos del slide</button>' +
        '</div>' +
      '</div>' +
      '<div class="ann-panel-footer">' +
        '<button class="ann-btn" data-ann="export">Guardar / Exportar</button>' +
        '<button class="ann-btn ann-btn-danger" data-ann="clear-slide">Limpiar slide</button>' +
      '</div>';
    document.body.appendChild(panel);

    panel.querySelector('[data-ann="close"]').addEventListener('click', closePanel);
    panel.querySelector('[data-ann="form"]').addEventListener('submit', function (e) {
      e.preventDefault();
      var ta = panel.querySelector('[data-ann="textarea"]');
      var v = (ta.value || '').trim();
      if (!v) return;
      addComment(currentSlideId, v);
      ta.value = '';
      renderList();
      refreshFab(currentSlideId);
    });
    panel.querySelector('[data-ann="export"]').addEventListener('click', function () {
      if (serverState.online) {
        // Force write data.json + snapshots for slides with drawings
        saveToServer().then(function () {
          var slides = document.querySelectorAll('section.slide');
          for (var i = 0; i < slides.length; i++) {
            if (getDrawings(slides[i].id).length) saveAllSnapshotsForSlide(slides[i].id);
          }
        });
      } else {
        exportAll();
      }
    });
    panel.querySelector('[data-ann="clear-slide"]').addEventListener('click', function () {
      if (!confirm('Borrar TODO de este slide (comentarios, dibujos, selecciones)?')) return;
      setSlide(currentSlideId, emptySlide());
      renderList();
      renderSelList();
      renderDrawSummary();
      renderDrawings(document.getElementById(currentSlideId));
      applyHighlightsForSlide(currentSlideId);
      refreshFab(currentSlideId);
    });
    panel.querySelector('[data-ann="clear-drawings"]').addEventListener('click', function () {
      if (!confirm('Borrar todos los dibujos de este slide?')) return;
      clearDrawings(currentSlideId);
      renderDrawings(document.getElementById(currentSlideId));
      renderDrawSummary();
      refreshFab(currentSlideId);
    });
    var tabs = panel.querySelectorAll('.ann-tab');
    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        tabs.forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        var name = t.getAttribute('data-tab');
        panel.querySelectorAll('[data-tab-panel]').forEach(function (p) {
          p.hidden = p.getAttribute('data-tab-panel') !== name;
        });
      });
    });
    return panel;
  }

  function renderList() {
    var list = panel.querySelector('[data-ann="list"]');
    var comments = getComments(currentSlideId);
    if (!comments.length) {
      list.innerHTML = '<div class="ann-empty">Sin comentarios todavia.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < comments.length; i++) {
      var c = comments[i];
      html +=
        '<div class="ann-item">' +
          '<button class="ann-item-del" data-idx="' + i + '" aria-label="Borrar">x</button>' +
          '<div class="ann-item-ts">' + escapeHtml(fmtTs(c.ts)) + '</div>' +
          '<div class="ann-item-text">' + escapeHtml(c.text) + '</div>' +
        '</div>';
    }
    list.innerHTML = html;
    list.querySelectorAll('.ann-item-del').forEach(function (b) {
      b.addEventListener('click', function (e) {
        var idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        if (isNaN(idx)) return;
        deleteComment(currentSlideId, idx);
        renderList();
        refreshFab(currentSlideId);
      });
    });
  }
  function renderSelList() {
    var list = panel.querySelector('[data-ann="sel-list"]');
    var sels = getSelections(currentSlideId);
    if (!sels.length) {
      list.innerHTML = '<div class="ann-empty">Sin selecciones todavia. Selecciona texto en el slide para empezar.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < sels.length; i++) {
      var s = sels[i];
      html +=
        '<div class="ann-item">' +
          '<button class="ann-item-del" data-idx="' + i + '" aria-label="Borrar">x</button>' +
          '<div class="ann-item-ts">' + escapeHtml(fmtTs(s.ts)) + '</div>' +
          '<div class="ann-sel-quote">' + escapeHtml(s.selectedText) + '</div>' +
          '<div class="ann-item-text">' + escapeHtml(s.comment) + '</div>' +
        '</div>';
    }
    list.innerHTML = html;
    list.querySelectorAll('.ann-item-del').forEach(function (b) {
      b.addEventListener('click', function (e) {
        var idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        if (isNaN(idx)) return;
        deleteSelection(currentSlideId, idx);
        applyHighlightsForSlide(currentSlideId);
        renderSelList();
        refreshFab(currentSlideId);
      });
    });
  }
  function renderDrawSummary() {
    var el = panel.querySelector('[data-ann="draw-summary"]');
    var ds = getDrawings(currentSlideId);
    if (!ds.length) {
      el.innerHTML = '<div class="ann-empty">Sin dibujos. Click el icono de lapiz en el FAB para activar el modo dibujo.</div>';
      return;
    }
    el.innerHTML = '<div class="ann-empty">' + ds.length + ' trazo' + (ds.length === 1 ? '' : 's') + ' guardado' + (ds.length === 1 ? '' : 's') + '.</div>';
  }

  function openPanel(slideId, title) {
    currentSlideId = slideId;
    buildPanel();
    panel.querySelector('[data-ann="title"]').textContent = 'Slide ' + slideId;
    panel.querySelector('[data-ann="subtitle"]').textContent = title || '';
    renderList();
    renderSelList();
    renderDrawSummary();
    panel.classList.add('open');
    setTimeout(function () {
      var ta = panel.querySelector('[data-ann="textarea"]');
      if (ta) ta.focus();
    }, 250);
  }
  function closePanel() {
    if (panel) panel.classList.remove('open');
  }

  // ---------- FAB ----------
  function refreshFab(slideId) {
    var section = document.getElementById(slideId);
    if (!section) return;
    var fab = section.querySelector('.ann-fab-stack .ann-fab:not(.ann-fab-draw)');
    if (!fab) return;
    var slide = getSlide(slideId);
    var cCount = slide.comments.length;
    var dCount = slide.drawings.length;
    var sCount = slide.selections.length;
    fab.classList.toggle('has-comments', cCount > 0);
    fab.classList.toggle('has-drawings', dCount > 0);
    fab.classList.toggle('has-selections', sCount > 0);
    var totalBadge = fab.querySelector('.ann-fab-badge');
    var total = cCount + dCount + sCount;
    if (total > 0) {
      if (!totalBadge) {
        totalBadge = document.createElement('span');
        totalBadge.className = 'ann-fab-badge';
        fab.appendChild(totalBadge);
      }
      totalBadge.textContent = total;
    } else if (totalBadge) {
      totalBadge.remove();
    }
  }

  function injectFab(section) {
    if (!section.id) return;
    if (section.querySelector(':scope > .ann-fab-stack')) return;
    var cs = window.getComputedStyle(section);
    if (cs.position === 'static') section.style.position = 'relative';

    var stack = document.createElement('div');
    stack.className = 'ann-fab-stack';

    var btnDraw = document.createElement('button');
    btnDraw.className = 'ann-fab ann-fab-draw';
    btnDraw.setAttribute('type', 'button');
    btnDraw.setAttribute('aria-label', 'Modo dibujo');
    btnDraw.innerHTML = SVG_PEN;
    btnDraw.addEventListener('click', function (e) {
      e.stopPropagation();
      if (drawState.active) {
        deactivateDrawMode();
      } else {
        activateDrawMode();
      }
      btnDraw.classList.toggle('active', drawState.active);
    });

    var btnChat = document.createElement('button');
    btnChat.className = 'ann-fab';
    btnChat.setAttribute('type', 'button');
    btnChat.setAttribute('aria-label', 'Comentarios');
    btnChat.innerHTML = SVG_CHAT;
    btnChat.addEventListener('click', function (e) {
      e.stopPropagation();
      openPanel(section.id, slideTitle(section));
    });

    stack.appendChild(btnDraw);
    stack.appendChild(btnChat);
    section.appendChild(stack);

    ensureDrawLayer(section);
    applyHighlightsForSlide(section.id);
    refreshFab(section.id);
  }

  // ---------- Export (manual fallback for offline / non-Chromium edge) ----------
  function rasterizeSlideDrawings(section) {
    var w = section.clientWidth || 1280;
    var h = section.clientHeight || 720;
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFF8F3';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(10,37,64,0.35)';
    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.fillText('slide ' + section.id + ' · ' + slideTitle(section), 12, h - 12);
    var drawings = getDrawings(section.id);
    for (var i = 0; i < drawings.length; i++) {
      var d = drawings[i].path;
      if (!d || !d.points || !d.points.length) continue;
      ctx.beginPath();
      ctx.strokeStyle = d.color || 'rgba(255,107,53,0.7)';
      ctx.lineWidth = d.width || 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(d.points[0][0], d.points[0][1]);
      for (var p = 1; p < d.points.length; p++) {
        ctx.lineTo(d.points[p][0], d.points[p][1]);
      }
      ctx.stroke();
    }
    return canvas.toDataURL('image/png');
  }

  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var binary = atob(parts[1]);
    var len = binary.length;
    var buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = binary.charCodeAt(i);
    var mime = parts[0].match(/data:(.*?);/)[1];
    return new Blob([buf], { type: mime });
  }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function buildReadme() {
    return [
      'Shelfly Deck — Annotations Export v' + SCHEMA_VERSION,
      'Generado: ' + new Date().toISOString(),
      '',
      'ARCHIVOS EN ESTE EXPORT',
      '- comments.json: storage completo del widget de anotaciones.',
      '- slide-<id>-drawings.png: PNG renderizado de los dibujos del slide.',
      '- README-export.txt: este archivo.',
      '',
      'ESTRUCTURA DE comments.json',
      '{',
      '  "deck": "shelfly",',
      '  "exported_at": "ISO-8601",',
      '  "schema_version": "' + SCHEMA_VERSION + '",',
      '  "slides": {',
      '    "<slide-id>": {',
      '      "title": "string (heading del slide)",',
      '      "comments":   [{ "ts": "ISO", "text": "string" }],',
      '      "selections": [{ "ts": "ISO", "selectedText": "string", "elementSelector": "...", "comment": "string" }],',
      '      "drawings":   [{ "ts": "ISO", "path": { "color": "rgba|hex", "width": number, "points": [[x,y], ...] } }]',
      '    }',
      '  }',
      '}',
      ''
    ].join('\n');
  }

  function exportAll() {
    var all = loadAll();
    var slides = document.querySelectorAll('section.slide');
    var slidesOut = {};
    var slideIdsWithDrawings = [];
    for (var i = 0; i < slides.length; i++) {
      var section = slides[i];
      var sid = section.id;
      if (!sid) continue;
      var s = all.slides[sid] || emptySlide();
      slidesOut[sid] = {
        title: slideTitle(section),
        comments: s.comments || [],
        selections: s.selections || [],
        drawings: s.drawings || []
      };
      if (slidesOut[sid].drawings.length) slideIdsWithDrawings.push(sid);
    }
    var payload = {
      deck: DECK_NAME,
      exported_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
      slides: slidesOut
    };
    var stamp = todayStr();
    var jsonBlob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(jsonBlob, DECK_NAME + '-annotations-' + stamp + '.json');
    var readmeBlob = new Blob([buildReadme()], { type: 'text/plain;charset=utf-8' });
    downloadBlob(readmeBlob, DECK_NAME + '-annotations-' + stamp + '-README.txt');
    if (slideIdsWithDrawings.length) {
      slideIdsWithDrawings.forEach(function (sid, idx) {
        setTimeout(function () {
          var section = document.getElementById(sid);
          if (!section) return;
          var dataUrl = rasterizeSlideDrawings(section);
          var blob = dataUrlToBlob(dataUrl);
          downloadBlob(blob, DECK_NAME + '-annotations-' + stamp + '-slide-' + sid + '-drawings.png');
        }, 200 * (idx + 1));
      });
    }
    console.info('[annotations] exported · ' + Object.keys(slidesOut).length + ' slides · ' + slideIdsWithDrawings.length + ' with drawings');
  }

  // ---------- Init ----------
  function applyPresentMode(mode) {
    if (mode === 'clean') {
      var s = document.createElement('style');
      s.textContent =
        '.ann-fab, .ann-fab-stack, .ann-panel, .ann-draw-toolbar, .ann-sel-popover, .ann-hl-tip, .ann-fs-badge { display: none !important; }' +
        '.ann-draw-layer { display: none !important; }' +
        '.ann-highlight { background: transparent !important; border: 0 !important; }';
      document.head.appendChild(s);
      console.info('[annotations] present=clean active');
    } else if (mode === 'annotated') {
      var s2 = document.createElement('style');
      s2.textContent =
        '.ann-fab, .ann-fab-stack, .ann-panel, .ann-draw-toolbar, .ann-sel-popover, .ann-hl-tip, .ann-fs-badge { display: none !important; }';
      document.head.appendChild(s2);
      console.info('[annotations] present=annotated active');
    }
  }

  function startHealthLoop() {
    pingHealth().then(function (ok) {
      if (ok) {
        // Cold-boot hydrate (if local is empty) then force one save
        maybeHydrateFromServer().then(function () {
          // re-render UI bits that depend on slide data
          var slides = document.querySelectorAll('section.slide');
          for (var i = 0; i < slides.length; i++) {
            refreshFab(slides[i].id);
            renderDrawings(slides[i]);
            applyHighlightsForSlide(slides[i].id);
          }
          saveToServer();
        });
      }
    });
    // Re-check periodically; if previously offline this picks the server back up.
    clearInterval(serverState.healthTimer);
    serverState.healthTimer = setInterval(function () {
      var wasOnline = serverState.online;
      pingHealth().then(function (ok) {
        if (ok && !wasOnline) {
          // came back online → flush any local-only changes
          saveToServer();
        }
      });
    }, HEALTH_RECHECK_MS);
  }

  function init() {
    var presentMode = getPresentMode();
    var slides = document.querySelectorAll('section.slide');
    if (!slides.length) {
      console.info('[annotations] no slides found');
      return;
    }

    if (presentMode === 'clean') {
      applyPresentMode('clean');
      return;
    }

    for (var i = 0; i < slides.length; i++) {
      injectFab(slides[i]);
    }

    if (presentMode === 'annotated') {
      applyPresentMode('annotated');
      return;
    }

    renderStatusBadge();
    startHealthLoop();

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (drawState.active) { deactivateDrawMode(); return; }
      if (panel && panel.classList.contains('open')) { closePanel(); return; }
      if (selPopover && selPopover.classList.contains('visible')) { closeSelPopover(); }
    });

    document.addEventListener('mouseup', onTextSelection);
    document.addEventListener('touchend', onTextSelection);
    document.addEventListener('click', onHighlightClick);

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        for (var i = 0; i < slides.length; i++) {
          var section = slides[i];
          var layer = section.querySelector(':scope > .ann-draw-layer');
          if (!layer) continue;
          var svg = layer.querySelector('svg');
          if (svg) {
            sizeDrawLayer(section, layer, svg);
            renderDrawings(section);
          }
        }
      }, 150);
    });

    window.addEventListener('storage', function (e) {
      if (e.key !== STORAGE_KEY) return;
      for (var i = 0; i < slides.length; i++) {
        refreshFab(slides[i].id);
        renderDrawings(slides[i]);
        applyHighlightsForSlide(slides[i].id);
      }
      if (panel && panel.classList.contains('open')) {
        renderList();
        renderSelList();
        renderDrawSummary();
      }
    });

    window.__shelflyAnnotations = {
      dump: function () { return loadAll(); },
      export: exportAll,
      forceSave: function () { return saveToServer(); },
      forceHealth: pingHealth,
      loadFromServer: loadFromServer,
      serverState: function () {
        return {
          online: serverState.online,
          lastSaveStatus: serverState.lastSaveStatus,
          url: SERVER_URL
        };
      },
      activateDraw: activateDrawMode,
      deactivateDraw: deactivateDrawMode,
      clearAll: function () {
        if (!confirm('Borrar TODAS las anotaciones (comentarios, dibujos, selecciones) de TODOS los slides?')) return;
        saveAll({ version: SCHEMA_VERSION, slides: {} });
        for (var i = 0; i < slides.length; i++) {
          refreshFab(slides[i].id);
          renderDrawings(slides[i]);
          applyHighlightsForSlide(slides[i].id);
        }
        if (panel && panel.classList.contains('open')) {
          renderList(); renderSelList(); renderDrawSummary();
        }
      }
    };
    console.info('[annotations v3] ready · ' + slides.length + ' slides · server=' + SERVER_URL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
