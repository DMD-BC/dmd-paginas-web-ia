/**
 * Trajectory — registro mínimo de eventos del builder.
 * Guarda los eventos en memoria y actualiza el contador de la barra
 * lateral (#evtCount). No envía nada a ningún servidor.
 */
window.Trajectory = (function () {
  'use strict';

  var events = [];

  function renderCount() {
    var el = document.getElementById('evtCount');
    if (el) el.textContent = String(events.length);
  }

  function log(type, title, meta) {
    var ev = { type: type || 'event', title: title || '', meta: meta || '', time: new Date().toISOString() };
    events.push(ev);
    renderCount();
    return ev;
  }

  function getEvents() {
    return events.slice();
  }

  function clear() {
    events = [];
    renderCount();
  }

  return { log: log, getEvents: getEvents, clear: clear };
})();
