/* ====================================================================
   Shelfly Deck — In-Deck Annotations Widget
   Vanilla JS. Cero deps. Auto-init on DOMContentLoaded.

   - Inyecta un boton flotante en cada <section class="slide">
   - Panel lateral con form + lista por slide
   - Persiste en localStorage bajo "shelfly_deck_comments_v1"
   - Export JSON para pegar al chat
   - URL ?present=true esconde todo (modo presentacion)
   ==================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'shelfly_deck_comments_v1';
  var DECK_NAME = 'shelfly';
  var SVG_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var SVG_CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // ---------- Present mode short-circuit ----------
  function isPresentMode() {
    try {
      var p = new URLSearchParams(window.location.search);
      return p.get('present') === 'true' || p.get('present') === '1';
    } catch (e) {
      return false;
    }
  }

  // ---------- Storage ----------
  function loadAll() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      console.warn('[annotations] load failed', e);
      return {};
    }
  }
  function saveAll(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[annotations] save failed', e);
    }
  }
  function getComments(slideId) {
    var all = loadAll();
    return Array.isArray(all[slideId]) ? all[slideId] : [];
  }
  function setComments(slideId, list) {
    var all = loadAll();
    all[slideId] = list;
    saveAll(all);
  }
  function addComment(slideId, text) {
    var list = getComments(slideId);
    list.push({ ts: new Date().toISOString(), text: text });
    setComments(slideId, list);
  }
  function deleteComment(slideId, index) {
    var list = getComments(slideId);
    list.splice(index, 1);
    setComments(slideId, list);
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
    // Try to find a heading inside the section for a nicer label
    var h = section.querySelector('h1, h2, h3');
    if (h && h.textContent) {
      var t = h.textContent.trim().replace(/\s+/g, ' ');
      if (t.length > 60) t = t.slice(0, 57) + '...';
      return t;
    }
    return section.id || 'slide';
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
      '<div class="ann-panel-body">' +
        '<form class="ann-form" data-ann="form">' +
          '<textarea class="ann-textarea" data-ann="textarea" placeholder="Escribe tu comentario..." rows="3"></textarea>' +
          '<button type="submit" class="ann-save" data-ann="save">Guardar</button>' +
        '</form>' +
        '<div class="ann-list" data-ann="list"></div>' +
      '</div>' +
      '<div class="ann-panel-footer">' +
        '<button class="ann-btn" data-ann="export">Exportar JSON</button>' +
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
      exportJson();
    });
    panel.querySelector('[data-ann="clear-slide"]').addEventListener('click', function () {
      if (!confirm('Borrar todos los comentarios de este slide?')) return;
      setComments(currentSlideId, []);
      renderList();
      refreshFab(currentSlideId);
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
    var dels = list.querySelectorAll('.ann-item-del');
    for (var k = 0; k < dels.length; k++) {
      dels[k].addEventListener('click', function (e) {
        var idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        if (isNaN(idx)) return;
        deleteComment(currentSlideId, idx);
        renderList();
        refreshFab(currentSlideId);
      });
    }
  }

  function openPanel(slideId, title) {
    currentSlideId = slideId;
    buildPanel();
    panel.querySelector('[data-ann="title"]').textContent = 'Slide ' + slideId;
    panel.querySelector('[data-ann="subtitle"]').textContent = title || '';
    renderList();
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
    var fab = section.querySelector('.ann-fab');
    if (!fab) return;
    var count = getComments(slideId).length;
    if (count > 0) {
      fab.classList.add('has-comments');
      var badge = fab.querySelector('.ann-fab-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ann-fab-badge';
        fab.appendChild(badge);
      }
      badge.textContent = count;
    } else {
      fab.classList.remove('has-comments');
      var b = fab.querySelector('.ann-fab-badge');
      if (b) b.remove();
    }
  }

  function injectFab(section) {
    if (!section.id) return;
    if (section.querySelector(':scope > .ann-fab')) return; // already
    // Ensure section is positioned so absolute FAB works
    var cs = window.getComputedStyle(section);
    if (cs.position === 'static') section.style.position = 'relative';

    var btn = document.createElement('button');
    btn.className = 'ann-fab';
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'Comentarios');
    btn.innerHTML = SVG_CHAT;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      openPanel(section.id, slideTitle(section));
    });
    section.appendChild(btn);
    refreshFab(section.id);
  }

  // ---------- Export ----------
  function exportJson() {
    var data = loadAll();
    var payload = {
      deck: DECK_NAME,
      exported_at: new Date().toISOString(),
      schema_version: 1,
      slides: data
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = DECK_NAME + '-comments-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // ---------- Init ----------
  function init() {
    if (isPresentMode()) {
      // Hide all annotation UI in presentation mode
      var root = document.createElement('style');
      root.textContent = '.ann-fab, .ann-panel { display: none !important; }';
      document.head.appendChild(root);
      console.info('[annotations] present mode active, widget hidden');
      return;
    }
    var slides = document.querySelectorAll('section.slide');
    if (!slides.length) {
      console.info('[annotations] no slides found');
      return;
    }
    for (var i = 0; i < slides.length; i++) {
      injectFab(slides[i]);
    }
    // Esc closes panel
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel && panel.classList.contains('open')) {
        closePanel();
      }
    });
    // Cross-tab sync
    window.addEventListener('storage', function (e) {
      if (e.key !== STORAGE_KEY) return;
      for (var i = 0; i < slides.length; i++) refreshFab(slides[i].id);
      if (panel && panel.classList.contains('open')) renderList();
    });
    // Expose tiny console helper
    window.__shelflyAnnotations = {
      dump: function () { return loadAll(); },
      export: exportJson,
      clearAll: function () {
        if (!confirm('Borrar TODOS los comentarios de TODOS los slides?')) return;
        saveAll({});
        for (var i = 0; i < slides.length; i++) refreshFab(slides[i].id);
        if (panel && panel.classList.contains('open')) renderList();
      }
    };
    console.info('[annotations] ready · ' + slides.length + ' slides · type __shelflyAnnotations.dump() to inspect');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
