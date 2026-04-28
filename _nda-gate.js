/**
 * Shelfly NDA gate · client-side blindaje.
 * Inserta modal full-screen si el visitante no ha firmado.
 * Guarda en localStorage. Opcionalmente envia ping a Formspree.
 *
 * Uso en cualquier pagina:
 *   <script src="/shelfly-preview/_nda-gate.js"></script>
 *
 * Para activar log a Pedro: reemplaza FORMSPREE_ENDPOINT con tu URL real.
 * Crear endpoint gratis en https://formspree.io (50 submissions/mes free).
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'shelfly_nda_v1';
  // FormSubmit.co: cero cuenta. La primera firma dispara un email de
  // confirmacion a pedroc11@gmail.com. Click una vez para activar.
  // Despues, cada firma llega por email automaticamente.
  var NOTIFY_ENDPOINT = 'https://formsubmit.co/ajax/pedroc11@gmail.com';

  // ============================================================
  // WHITELIST · editar y push a GitHub para actualizar
  // ============================================================
  // Si AMBAS listas estan vacias, modo abierto (cualquier email entra).
  // Si HAY entradas, solo se aceptan las que matchean.
  // Match es case-insensitive. Email exact match. Dominio compara sufijo.
  var ALLOWED_EMAILS = [
    // 'diego@timetracker.com.mx',
    // 'pedroc11@gmail.com',
  ];
  var ALLOWED_DOMAINS = [
    // 'timetracker.com.mx',
    // 'storecheck.com.mx',
    // 'vuelocapital.com',
  ];

  function isAllowed(email) {
    var e = (email || '').trim().toLowerCase();
    if (!e) return false;
    if (ALLOWED_EMAILS.length === 0 && ALLOWED_DOMAINS.length === 0) return true;
    for (var i = 0; i < ALLOWED_EMAILS.length; i++) {
      if (ALLOWED_EMAILS[i].toLowerCase() === e) return true;
    }
    var atIdx = e.lastIndexOf('@');
    if (atIdx < 0) return false;
    var domain = e.substring(atIdx + 1);
    for (var j = 0; j < ALLOWED_DOMAINS.length; j++) {
      if (domain === ALLOWED_DOMAINS[j].toLowerCase()) return true;
    }
    return false;
  }

  // Si ya firmo, salir sin hacer nada
  try {
    var signed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (signed && signed.timestamp) return;
  } catch (e) {}

  // Inyectar fonts + tailwind si no estan
  var head = document.head;
  if (!document.querySelector('script[src*="tailwindcss"]')) {
    var s1 = document.createElement('script');
    s1.src = 'https://cdn.tailwindcss.com';
    head.appendChild(s1);
  }
  if (!document.querySelector('link[href*="Inter"]')) {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@600;700&display=swap';
    head.appendChild(l);
  }

  // Bloquear interaccion con el resto del DOM
  var prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  var overlay = document.createElement('div');
  overlay.id = 'shelfly-nda-gate';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'background:rgba(10,37,64,0.85)', 'backdrop-filter:blur(8px)',
    '-webkit-backdrop-filter:blur(8px)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'padding:24px', 'overflow-y:auto',
    'font-family:Inter,system-ui,-apple-system,sans-serif',
  ].join(';');

  overlay.innerHTML = [
    '<div style="background:#FFF8F3;border-radius:20px;max-width:560px;width:100%;padding:40px 36px;box-shadow:0 24px 72px rgba(0,0,0,0.4);max-height:90vh;overflow-y:auto;">',
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">',
        '<div style="width:36px;height:36px;background:#FF6B35;border-radius:8px;display:flex;align-items:center;justify-content:center;color:white;font-family:\'Space Grotesk\',sans-serif;font-weight:700;font-size:20px;">S</div>',
        '<div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(10,37,64,0.6);font-weight:600;">Shelfly · acceso restringido</div>',
      '</div>',
      '<h1 style="font-family:\'Space Grotesk\',sans-serif;font-size:28px;font-weight:700;color:#0A2540;letter-spacing:-0.02em;margin:8px 0 12px;">Informacion confidencial</h1>',
      '<p style="font-size:14px;line-height:1.6;color:rgba(10,37,64,0.75);margin-bottom:20px;">El contenido de este sitio incluye estrategia de producto, modelo de negocio, integraciones con socios y proyecciones financieras del proyecto Shelfly. Es propietario y no esta destinado a difusion publica.</p>',

      '<div style="background:white;border:1px solid rgba(10,37,64,0.1);border-radius:12px;padding:16px 18px;margin-bottom:24px;">',
        '<div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#FF6B35;font-weight:700;margin-bottom:8px;">Acuerdo de confidencialidad</div>',
        '<p style="font-size:13px;line-height:1.55;color:rgba(10,37,64,0.8);margin:0 0 8px;">Al continuar, declaras y aceptas:</p>',
        '<ul style="font-size:13px;line-height:1.55;color:rgba(10,37,64,0.8);margin:0;padding-left:18px;">',
          '<li>Tratar la informacion como confidencial.</li>',
          '<li>No compartir, reproducir ni difundir el contenido de este sitio sin autorizacion escrita de Pedro Rojas Campuzano.</li>',
          '<li>Usar la informacion solo para evaluar una posible colaboracion, inversion o relacion comercial con el proyecto.</li>',
          '<li>Que tu acceso queda registrado.</li>',
        '</ul>',
      '</div>',

      '<form id="shelfly-nda-form" style="display:flex;flex-direction:column;gap:12px;">',
        '<div>',
          '<label style="display:block;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(10,37,64,0.6);font-weight:600;margin-bottom:4px;">Nombre completo *</label>',
          '<input required name="nombre" type="text" style="width:100%;padding:10px 14px;border:1px solid rgba(10,37,64,0.15);border-radius:8px;font-size:14px;background:white;font-family:inherit;" placeholder="Tu nombre">',
        '</div>',
        '<div>',
          '<label style="display:block;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(10,37,64,0.6);font-weight:600;margin-bottom:4px;">Empresa / rol *</label>',
          '<input required name="empresa" type="text" style="width:100%;padding:10px 14px;border:1px solid rgba(10,37,64,0.15);border-radius:8px;font-size:14px;background:white;font-family:inherit;" placeholder="Time Tracker · CEO">',
        '</div>',
        '<div>',
          '<label style="display:block;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(10,37,64,0.6);font-weight:600;margin-bottom:4px;">Email *</label>',
          '<input required name="email" type="email" style="width:100%;padding:10px 14px;border:1px solid rgba(10,37,64,0.15);border-radius:8px;font-size:14px;background:white;font-family:inherit;" placeholder="tu@empresa.com">',
        '</div>',
        '<label style="display:flex;align-items:flex-start;gap:10px;margin-top:8px;font-size:13px;line-height:1.5;color:rgba(10,37,64,0.85);cursor:pointer;">',
          '<input required name="acepto" type="checkbox" style="margin-top:3px;width:16px;height:16px;accent-color:#FF6B35;">',
          '<span>He leido y acepto los terminos del acuerdo de confidencialidad.</span>',
        '</label>',
        '<button type="submit" id="shelfly-nda-submit" style="margin-top:12px;background:#FF6B35;color:white;border:none;padding:14px 24px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;letter-spacing:0.01em;transition:all 0.15s;">Aceptar y continuar</button>',
      '</form>',

      '<p style="font-size:11px;color:rgba(10,37,64,0.5);margin-top:20px;text-align:center;line-height:1.5;">Para preguntas o solicitar acceso adicional: <span style="color:#FF6B35;font-weight:600;">pedroc11@gmail.com</span></p>',
    '</div>',
  ].join('');

  document.body.appendChild(overlay);

  var form = document.getElementById('shelfly-nda-form');
  var btn = document.getElementById('shelfly-nda-submit');

  btn.addEventListener('mouseenter', function () { btn.style.background = '#E85A28'; });
  btn.addEventListener('mouseleave', function () { btn.style.background = '#FF6B35'; });

  // Mostrar / ocultar el mensaje de error de whitelist
  function showError(msg) {
    var el = document.getElementById('shelfly-nda-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'shelfly-nda-error';
      el.style.cssText = 'background:#FEE2E2;border:1px solid #FCA5A5;color:#991B1B;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px;line-height:1.5;';
      form.insertBefore(el, form.firstChild);
    }
    el.textContent = msg;
  }
  function clearError() {
    var el = document.getElementById('shelfly-nda-error');
    if (el) el.remove();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();

    var emailVal = form.email.value.trim();
    if (!isAllowed(emailVal)) {
      showError('Tu email no esta autorizado. Contacta a Pedro Rojas (pedroc11@gmail.com) para solicitar acceso.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Procesando...';

    var data = {
      nombre: form.nombre.value.trim(),
      empresa: form.empresa.value.trim(),
      email: emailVal,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      userAgent: navigator.userAgent,
      referrer: document.referrer,
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {}

    var done = function () {
      document.body.style.overflow = prevOverflow;
      overlay.remove();
    };

    if (NOTIFY_ENDPOINT) {
      // FormSubmit.co espera campos planos. Agregamos meta opcionales.
      var payload = {
        _subject: 'Shelfly NDA firmado: ' + data.nombre + ' (' + data.empresa + ')',
        _template: 'box',
        _captcha: 'false',
        nombre: data.nombre,
        empresa: data.empresa,
        email: data.email,
        timestamp: data.timestamp,
        url: data.url,
        referrer: data.referrer || '(direct)',
        userAgent: data.userAgent,
      };
      fetch(NOTIFY_ENDPOINT, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () {}).finally(done);
    } else {
      setTimeout(done, 200);
    }
  });
})();
