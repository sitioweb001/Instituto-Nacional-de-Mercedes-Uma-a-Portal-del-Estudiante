/**
 * ══════════════════════════════════════════════════════════════════════════════
 * SICA-INMU — firebase-alumno.js
 * Módulo Firebase para Portal PERMANENCIA (INDEX_ALUMNO.html)
 * Versión 1.0 — 2026
 *
 * PROBLEMA QUE RESUELVE:
 *   El portal hace 2 llamadas al GAS por cada verificación:
 *     1. horario_asistencia  → 3-5 segundos (cold start GAS)
 *     2. validar_alumno_nie  → 3-5 segundos más
 *   Total: 6-10 segundos de espera para el alumno.
 *
 * SOLUCIÓN:
 *   - La lista de alumnos se guarda en Firestore y se descarga al abrir
 *     el portal (una sola vez, en segundo plano).
 *   - La verificación del NIE se hace LOCALMENTE contra esa lista.
 *   - Resultado: verificación en < 0.1 segundos.
 *   - El registro de asistencia sigue yendo al GAS (es el único POST).
 *   - El horario también se cachea en Firestore para carga instantánea.
 * ══════════════════════════════════════════════════════════════════════════════
 */

// ── MISMA CONFIG QUE firebase-notas.js ───────────────────────────────────────
const FB_ALUMNO_CONFIG = {
  apiKey:            "AIzaSyCXILuuU2UZUZxG8iGkFpGN_mljN_e1ESc",
  authDomain:        "sica-inmu-2026.firebaseapp.com",
  projectId:         "sica-inmu-2026",
  storageBucket:     "sica-inmu-2026.firebasestorage.app",
  messagingSenderId: "264940304462",
  appId:             "1:264940304462:web:643c263f1ad46139102b1f",
  measurementId:     "G-BM4NT0G46F"
};
// ─────────────────────────────────────────────────────────────────────────────

const FB_CACHE_KEY      = 'fb_alumnos_cache';
const FB_CACHE_TS_KEY   = 'fb_alumnos_cache_ts';
const FB_CACHE_TTL      = 1000 * 60 * 30; // 30 minutos
const FB_HORARIO_KEY    = 'fb_horario_cache';
const FB_HORARIO_TS_KEY = 'fb_horario_cache_ts';
const FB_HORARIO_TTL    = 1000 * 60 * 5;  // 5 minutos

let _fbDb         = null;
let _fbListo      = false;
let _alumnosLocal = [];   // lista completa en memoria
let _cargando     = false;

// ── Inicialización ────────────────────────────────────────────────────────────
(function initFbAlumno() {
  if (!window.firebase) {
    setTimeout(initFbAlumno, 800);
    return;
  }
  try {
    if (!firebase.apps || firebase.apps.length === 0) {
      firebase.initializeApp(FB_ALUMNO_CONFIG);
    }
    _fbDb    = firebase.firestore();
    _fbListo = true;

    // Habilitar persistencia offline
    _fbDb.enablePersistence({ synchronizeTabs: true }).catch(() => {});

    console.log('[FB-Alumno] Firebase listo ✓');

    // Cargar alumnos en segundo plano inmediatamente
    _cargarAlumnosEnSegundoPlano();

    // Escuchar cambios en horario en tiempo real
    _escucharHorario();

  } catch (e) {
    console.warn('[FB-Alumno] Firebase no disponible, usando GAS:', e);
  }
})();

// ── Cargar alumnos desde Firestore ───────────────────────────────────────────

async function _cargarAlumnosEnSegundoPlano() {
  if (_cargando) return;
  _cargando = true;

  // 1. Intentar desde localStorage primero (instantáneo)
  try {
    const ts    = parseInt(localStorage.getItem(FB_CACHE_TS_KEY) || '0');
    const datos = localStorage.getItem(FB_CACHE_KEY);
    if (datos && (Date.now() - ts) < FB_CACHE_TTL) {
      _alumnosLocal = JSON.parse(datos);
      console.log(`[FB-Alumno] ${_alumnosLocal.length} alumnos desde caché local ✓`);
      _cargando = false;
      // Refrescar desde Firestore en segundo plano igual
      _refrescarDesdeFirestore();
      return;
    }
  } catch (_) {}

  await _refrescarDesdeFirestore();
  _cargando = false;
}

async function _refrescarDesdeFirestore() {
  if (!_fbListo || !_fbDb) return;
  try {
    const snap = await _fbDb.collection('alumnos_inmu').get();
    const lista = [];
    snap.forEach(doc => {
      const d = doc.data();
      lista.push({
        nie:     d.nie     || doc.id,
        nombre:  d.nombre  || '',
        grado:   d.grado   || '',
        seccion: d.seccion || '',
        sexo:    d.sexo    || '',
        telefono: d.telefono || ''
      });
    });
    if (lista.length > 0) {
      _alumnosLocal = lista;
      localStorage.setItem(FB_CACHE_KEY, JSON.stringify(lista));
      localStorage.setItem(FB_CACHE_TS_KEY, Date.now().toString());
      console.log(`[FB-Alumno] ${lista.length} alumnos sincronizados desde Firestore ✓`);
    }
  } catch (e) {
    console.warn('[FB-Alumno] Error leyendo alumnos desde Firestore:', e);
  }
}

// ── Escuchar horario en tiempo real ──────────────────────────────────────────

function _escucharHorario() {
  if (!_fbListo || !_fbDb) return;
  _fbDb.collection('config_inmu').doc('horario')
    .onSnapshot(snap => {
      if (!snap.exists) return;
      const h = snap.data();
      try {
        localStorage.setItem(FB_HORARIO_KEY, JSON.stringify(h));
        localStorage.setItem(FB_HORARIO_TS_KEY, Date.now().toString());
      } catch (_) {}
      // Actualizar el chip de horario si está visible
      if (typeof actualizarChip === 'function') actualizarChip(h);
      console.log('[FB-Alumno] Horario actualizado en tiempo real ✓');
    }, e => {
      console.warn('[FB-Alumno] Error escuchando horario:', e);
    });
}

// ── VERIFICACIÓN LOCAL (la magia) ─────────────────────────────────────────────

/**
 * Busca un alumno por NIE o nombre LOCALMENTE.
 * Tiempo: < 5ms. Sin llamada al servidor.
 */
function _buscarAlumnoLocal(query, tipo) {
  if (_alumnosLocal.length === 0) return null;

  const norm = s => (s || '').toString().toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const q = norm(query);

  if (tipo === 'nie' || tipo === 'dui') {
    return _alumnosLocal.find(a => norm(String(a.nie)) === q) || null;
  }
  // Búsqueda por nombre
  return _alumnosLocal.find(a => norm(a.nombre).includes(q)) || null;
}

/**
 * Verifica si el alumno ya marcó asistencia hoy en Firestore.
 * Más confiable que localStorage solo.
 */
async function _yaMarcoHoyFirestore(nie) {
  if (!_fbListo || !_fbDb) return false;
  try {
    const hoy  = new Date().toLocaleDateString('es-ES').replace(/\//g, '_');
    const snap = await _fbDb.collection('asistencia_alumnos_inmu')
      .where('nie', '==', String(nie))
      .where('fecha_key', '==', hoy)
      .limit(1)
      .get();
    return !snap.empty;
  } catch (_) {
    return false;
  }
}

/**
 * Registra la asistencia en Firestore (rápido) Y en GAS (respaldo).
 */
async function _registrarAsistenciaFirestore(alumno, fechaStr, horaStr) {
  if (!_fbListo || !_fbDb) return false;
  try {
    const hoy = fechaStr.replace(/\//g, '_');
    const docId = `${String(alumno.nie)}_${hoy}`;
    await _fbDb.collection('asistencia_alumnos_inmu').doc(docId).set({
      nie:      String(alumno.nie),
      nombre:   alumno.nombre   || '',
      grado:    alumno.grado    || '',
      seccion:  alumno.seccion  || '',
      sexo:     alumno.sexo     || '',
      estado:   'presente',
      fecha:    fechaStr,
      fecha_key: hoy,
      hora:     horaStr,
      ts:       firebase.firestore.FieldValue.serverTimestamp()
    });
    console.log('[FB-Alumno] Asistencia registrada en Firestore ✓');
    return true;
  } catch (e) {
    console.warn('[FB-Alumno] Error registrando asistencia en Firestore:', e);
    return false;
  }
}

// ── INTERCEPTAR LAS FUNCIONES DEL PORTAL ─────────────────────────────────────

/**
 * Intercepta _ejecutarVerificacion para hacerla local cuando hay datos.
 * Si no hay datos locales, cae al GAS original (comportamiento actual).
 */
(function interceptarVerificacion() {
  const MAX = 20;
  let intentos = 0;

  function intentar() {
    if (typeof window._ejecutarVerificacion === 'function') {
      const _original = window._ejecutarVerificacion;

      window._ejecutarVerificacion = async function(query) {
        const tipo = (document.getElementById('tipo-doc') || {}).value || 'nie';

        // Si tenemos alumnos en memoria → verificar LOCAL (instantáneo)
        if (_alumnosLocal.length > 0) {
          console.log(`[FB-Alumno] Verificando localmente (${_alumnosLocal.length} alumnos en memoria)...`);

          const btn = document.getElementById('btn-verificar');
          if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }

          if (typeof resetResult === 'function') resetResult();

          const alumno = _buscarAlumnoLocal(query, tipo);

          if (!alumno) {
            if (typeof mostrarError === 'function') {
              mostrarError('No se encontró ningún alumno con esos datos.');
            }
            if (btn) { btn.disabled = false; btn.textContent = 'Verificar'; }
            return;
          }

          // Verificar si ya marcó hoy (primero local, luego Firestore)
          const hoy      = new Date().toLocaleDateString('es-ES');
          const keyLocal = `asist_${alumno.nie}_${hoy.replace(/\//g,'_')}`;
          let yaMarcado  = false;

          try {
            yaMarcado = !!localStorage.getItem(keyLocal);
          } catch (_) {}

          // Si no está en local, revisar Firestore
          if (!yaMarcado) {
            yaMarcado = await _yaMarcoHoyFirestore(alumno.nie);
          }

          // Actualizar caché local
          try {
            const cache = JSON.parse(localStorage.getItem('cache_alumnos') || '[]');
            const idx   = cache.findIndex(a => a.nie == alumno.nie);
            const entry = { ...alumno, marcado_hoy: yaMarcado };
            if (idx >= 0) cache[idx] = entry; else cache.push(entry);
            localStorage.setItem('cache_alumnos', JSON.stringify(cache.slice(-300)));
          } catch (_) {}

          window.alumnoActual = { ...alumno, marcado_hoy: yaMarcado };

          if (yaMarcado) {
            if (typeof mostrarYaMarcado === 'function') mostrarYaMarcado(alumno);
          } else {
            if (typeof mostrarResultadoOK === 'function') mostrarResultadoOK(alumno);
            if (typeof habilitarValidacion === 'function') habilitarValidacion();
          }

          if (btn) { btn.disabled = false; btn.textContent = 'Verificar'; }
          return; // ← No llamamos al GAS
        }

        // Sin datos locales → usar función original (GAS)
        console.log('[FB-Alumno] Sin datos locales, usando GAS...');
        return _original.call(this, query);
      };

      console.log('[FB-Alumno] _ejecutarVerificacion interceptada ✓');
    } else if (intentos < MAX) {
      intentos++;
      setTimeout(intentar, 400);
    }
  }
  intentar();
})();

/**
 * Intercepta validarAsistencia para registrar también en Firestore.
 */
(function interceptarValidacion() {
  const MAX = 20;
  let intentos = 0;

  function intentar() {
    if (typeof window.validarAsistencia === 'function') {
      const _original = window.validarAsistencia;

      window.validarAsistencia = async function() {
        if (!window.alumnoActual) {
          if (typeof notif === 'function') notif('Primero verifica tu identidad.', 'error');
          return;
        }

        const btn = document.getElementById('btn-validar');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Registrando...'; }

        const ahora    = new Date();
        const fechaStr = ahora.toLocaleDateString('es-ES');
        const horaStr  = ahora.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' });

        // Registrar en Firestore (rápido, no bloquea)
        const okFirebase = await _registrarAsistenciaFirestore(window.alumnoActual, fechaStr, horaStr);

        if (okFirebase) {
          // Marcar dispositivo usado
          if (typeof marcarDispositivoUsado === 'function') {
            marcarDispositivoUsado(window.alumnoActual.nie, window.alumnoActual.nombre);
          }
          // Guardar en localStorage también
          const key = `asist_${window.alumnoActual.nie}_${fechaStr.replace(/\//g,'_')}`;
          try { localStorage.setItem(key, JSON.stringify({ nie: window.alumnoActual.nie, fecha: fechaStr })); } catch (_) {}

          if (typeof mostrarExito === 'function') mostrarExito(window.alumnoActual, horaStr);

          // Enviar al GAS en segundo plano (respaldo para Google Sheets)
          _enviarAsistenciaGASSegundoPlano(window.alumnoActual, fechaStr, horaStr);

        } else {
          // Firestore falló → usar función original completa
          if (btn) { btn.disabled = false; btn.innerHTML = 'Validar mi asistencia ✓'; }
          return _original.call(this);
        }
      };

      console.log('[FB-Alumno] validarAsistencia interceptada ✓');
    } else if (intentos < MAX) {
      intentos++;
      setTimeout(intentar, 400);
    }
  }
  intentar();
})();

/**
 * Intercepta cargarHorario para usar Firestore/caché primero.
 */
(function interceptarHorario() {
  const MAX = 20;
  let intentos = 0;

  function intentar() {
    if (typeof window.cargarHorario === 'function') {
      const _original = window.cargarHorario;

      window.cargarHorario = async function() {
        // Intentar desde caché local primero (instantáneo)
        try {
          const ts = parseInt(localStorage.getItem(FB_HORARIO_TS_KEY) || '0');
          const h  = localStorage.getItem(FB_HORARIO_KEY);
          if (h && (Date.now() - ts) < FB_HORARIO_TTL) {
            const horario = JSON.parse(h);
            if (typeof actualizarChip === 'function') actualizarChip(horario);
            console.log('[FB-Alumno] Horario desde caché local (instantáneo) ✓');
            // Refrescar en segundo plano
            _original.call(this);
            return;
          }
        } catch (_) {}

        // Sin caché → usar función original
        return _original.call(this);
      };

      console.log('[FB-Alumno] cargarHorario interceptada ✓');
    } else if (intentos < MAX) {
      intentos++;
      setTimeout(intentar, 400);
    }
  }
  intentar();
})();

// ── Enviar asistencia a GAS en segundo plano ─────────────────────────────────

function _enviarAsistenciaGASSegundoPlano(alumno, fechaStr, horaStr) {
  if (typeof SCRIPT_URL === 'undefined') return;
  try {
    const urlMarcar = SCRIPT_URL
      + '?tipo=marcar_alumno'
      + '&nie='    + encodeURIComponent(alumno.nie    || '')
      + '&estado=presente'
      + '&nombre=' + encodeURIComponent(alumno.nombre || '')
      + '&grado='  + encodeURIComponent(alumno.grado  || '')
      + '&seccion='+ encodeURIComponent(alumno.seccion|| '');

    // Fire and forget — no bloqueamos al alumno
    fetch(urlMarcar, { method: 'GET', mode: 'no-cors' })
      .then(() => console.log('[FB-Alumno] Respaldo GAS enviado ✓'))
      .catch(() => {
        // Guardar para reintentar después
        const pendientes = JSON.parse(localStorage.getItem('asist_pendientes_gas') || '[]');
        pendientes.push({ alumno, fechaStr, horaStr, ts: Date.now() });
        localStorage.setItem('asist_pendientes_gas', JSON.stringify(pendientes.slice(-50)));
      });
  } catch (_) {}
}

// ── Sincronizar alumnos desde GAS a Firestore (función de admin) ─────────────

/**
 * Llama a esta función UNA SOLA VEZ desde la consola del navegador
 * en el panel docente para poblar Firestore con todos los alumnos de Sheets.
 *
 * Ejemplo: await window.FB_sincronizarAlumnosDesdeGAS()
 */
window.FB_sincronizarAlumnosDesdeGAS = async function() {
  if (!_fbListo || !_fbDb) {
    console.error('[FB-Alumno] Firebase no disponible');
    return;
  }
  if (typeof SCRIPT_URL === 'undefined') {
    console.error('[FB-Alumno] SCRIPT_URL no definido');
    return;
  }

  console.log('[FB-Alumno] Iniciando sincronización de alumnos GAS → Firestore...');

  try {
    const resp = await fetch(SCRIPT_URL + '?tipo=alumnos');
    const data = await resp.json();
    const lista = Array.isArray(data) ? data : (data.alumnos || []);

    if (lista.length === 0) {
      console.warn('[FB-Alumno] No se obtuvieron alumnos del GAS');
      return;
    }

    // Escribir en lotes de 500 (límite de Firestore)
    const LOTE = 400;
    let total = 0;
    for (let i = 0; i < lista.length; i += LOTE) {
      const batch = _fbDb.batch();
      const chunk = lista.slice(i, i + LOTE);
      chunk.forEach(alumno => {
        const nie = String(alumno.nie || alumno.NIE || '').trim();
        if (!nie) return;
        const ref = _fbDb.collection('alumnos_inmu').doc(nie);
        batch.set(ref, {
          nie:      nie,
          nombre:   alumno.nombre   || alumno.Nombre   || '',
          grado:    alumno.grado    || alumno.Grado    || '',
          seccion:  alumno.seccion  || alumno.Seccion  || '',
          sexo:     alumno.sexo     || alumno.Sexo     || '',
          telefono: alumno.telefono || alumno.Telefono || ''
        }, { merge: true });
        total++;
      });
      await batch.commit();
      console.log(`[FB-Alumno] Lote ${Math.floor(i/LOTE)+1}: ${chunk.length} alumnos subidos...`);
    }
    console.log(`[FB-Alumno] ✅ Sincronización completa: ${total} alumnos en Firestore`);

    // También subir DI Refuerzo
    try {
      const resp2 = await fetch(SCRIPT_URL + "?tipo=alumnos&grado=DI%20REFUERZO&seccion=%C3%9Anica");
      const data2 = await resp2.json();
      const di = Array.isArray(data2) ? data2 : [];
      if (di.length > 0) {
        const batch2 = _fbDb.batch();
        di.forEach(alumno => {
          const nie = String(alumno.nie || '').trim();
          if (!nie) return;
          const ref = _fbDb.collection('alumnos_inmu').doc(nie);
          batch2.set(ref, {
            nie: nie, nombre: alumno.nombre || '',
            grado: alumno.grado || 'DI REFUERZO',
            seccion: alumno.seccion || 'Única',
            sexo: alumno.sexo || '', telefono: alumno.telefono || ''
          }, { merge: true });
        });
        await batch2.commit();
        console.log(`[FB-Alumno] ✅ DI Refuerzo: ${di.length} alumnos subidos`);
      }
    } catch (_) {}

    // Refrescar caché local
    await _refrescarDesdeFirestore();

  } catch (e) {
    console.error('[FB-Alumno] Error en sincronización:', e);
  }
};

// ── Reglas Firestore adicionales necesarias ──────────────────────────────────
// Agregar a firestore.rules:
//
//   match /alumnos_inmu/{nie} {
//     allow read: if true;
//     allow write: if false;  // Solo el admin puede escribir (via consola o GAS)
//   }
//   match /asistencia_alumnos_inmu/{docId} {
//     allow read: if true;
//     allow write: if request.resource.data.keys().hasAll(['nie','fecha_key']);
//   }
//   match /config_inmu/{doc} {
//     allow read: if true;
//     allow write: if false;
//   }

console.log('[FB-Alumno] Módulo portal PERMANENCIA cargado ✓');
