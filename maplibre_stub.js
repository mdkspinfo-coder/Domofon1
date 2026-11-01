// Заглушка MapLibre для тестов интерфейса: повторяет только те методы, которые вызывает app.js.
// Реальную карту и 3D она НЕ проверяет.
(function () {
  class Evented {
    constructor() { this.h = {}; }
    on(t, f) { (this.h[t] = this.h[t] || []).push(f); return this; }
    fire(t, e) { (this.h[t] || []).forEach((f) => f(e)); }
  }
  class Map extends Evented {
    constructor(o) {
      super();
      this.c = { lng: o.center[0], lat: o.center[1] };
      this.pitch = 0;
      this.sources = {};
      this.layers = [
        { id: 'building-3d', type: 'fill-extrusion', layout: { visibility: 'visible' } },
        { id: 'road', type: 'line', layout: {} },
      ];
      window.__map = this;
      setTimeout(() => this.fire('load'), 0);
    }
    addControl() {}
    addSource(id, s) { this.sources[id] = { data: s.data, setData(d) { this.data = d; } }; }
    getSource(id) { return this.sources[id]; }
    addLayer(l) { this.layers.push(l); }
    getLayer(id) { return this.layers.find((l) => l.id === id); }
    getStyle() { return { layers: this.layers }; }
    setLayoutProperty(id, k, v) { const l = this.getLayer(id); l.layout = l.layout || {}; l.layout[k] = v; }
    getCenter() { return this.c; }
    easeTo(o) {
      if (o.center) this.c = { lng: o.center[0], lat: o.center[1] };
      if (o.pitch != null) this.pitch = o.pitch;
      this.fire('moveend');
    }
    flyTo(o) { this.easeTo(o); }
    queryRenderedFeatures() {
      const id = window.__tapId;
      return ((this.sources.markers || { data: { features: [] } }).data.features || []).filter((f) => f.properties.id === id);
    }
  }
  class Marker {
    constructor(o) { this.el = o && o.element; }
    setLngLat(l) { window.__userMarker = l; return this; }
    addTo() { document.body.appendChild(this.el); return this; }
  }
  class NavigationControl {}
  window.maplibregl = { Map, Marker, NavigationControl };
})();
