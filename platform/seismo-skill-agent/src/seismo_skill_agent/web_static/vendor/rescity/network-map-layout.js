/* Keep engineering cartography dominant without replacing its map instance. */
(() => {
  "use strict";
  const mounted = new WeakMap();

  function mount(element, options = {}) {
    if (!element || !element.classList.contains("engineering-network-map")) return null;
    if (mounted.has(element)) return mounted.get(element);
    const doc = element.ownerDocument, win = doc.defaultView || window;
    const english = String(options.language || "").startsWith("en");
    const toolbar = element.querySelector(".medical-map-toolbar");
    const layout = element.querySelector(".medical-map-layout");
    const cartography = element.querySelector(".medical-map-cartography");
    const sidebar = element.querySelector(".medical-map-sidebar");
    if (!toolbar || !layout || !cartography || !sidebar) return null;
    const changes = [], listeners = [];
    let disposed = false, frame = null;
    const resize = () => {
      if (disposed) return;
      win.cancelAnimationFrame(frame);
      frame = win.requestAnimationFrame(() => { if (!disposed) options.onResize?.(); });
    };
    const listen = (target, event, handler) => {
      target.addEventListener(event, handler);
      listeners.push(() => target.removeEventListener(event, handler));
    };
    const move = (node, target, before = null) => {
      if (!node) return;
      const placeholder = doc.createComment("network-map-layout");
      node.parentNode.insertBefore(placeholder, node);
      changes.push({ node, placeholder });
      target.insertBefore(node, before);
    };
    const button = (attribute, text) => {
      const node = doc.createElement("button");
      node.type = "button";
      node.setAttribute(attribute, "");
      node.textContent = text;
      return node;
    };
    const layersButton = button("data-map-layers", english ? "Layers & notes" : "图层与说明");
    const detailsButton = button("data-map-details", english ? "Object details" : "对象详情");
    const actions = doc.createElement("div");
    actions.className = "medical-map-control-group network-map-workspace-actions";
    actions.append(layersButton, detailsButton);
    toolbar.append(actions);

    const panel = doc.createElement("aside");
    panel.className = "network-map-layer-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", english ? "Map layers and explanation" : "地图图层与说明");
    const header = doc.createElement("div");
    header.className = "network-map-panel-header";
    const title = doc.createElement("strong");
    title.textContent = english ? "Layers & notes" : "图层与说明";
    const closeLayers = button("data-map-layers-close", english ? "Close" : "收起");
    closeLayers.setAttribute("aria-label", english ? "Close layers panel" : "收起图层与说明");
    header.append(title, closeLayers);
    const content = doc.createElement("div");
    content.className = "network-map-panel-content";
    panel.append(header, content);
    layout.append(panel);

    const sidebarHeader = doc.createElement("div");
    sidebarHeader.className = "network-map-panel-header";
    const sidebarTitle = doc.createElement("strong");
    sidebarTitle.textContent = english ? "Object details" : "对象详情";
    const closeDetails = button("data-map-details-close", english ? "Close" : "收起");
    closeDetails.setAttribute("aria-label", english ? "Close object details" : "收起对象详情");
    sidebarHeader.append(sidebarTitle, closeDetails);
    const sidebarContent = doc.createElement("div");
    sidebarContent.className = "network-map-panel-content";
    for (const child of [...sidebar.childNodes]) move(child, sidebarContent);
    sidebar.append(sidebarHeader, sidebarContent);
    sidebar.hidden = true;

    const filters = doc.createElement("div");
    filters.className = "network-map-native-layers";
    for (const node of [...toolbar.querySelectorAll(".medical-map-control-group > label")]) {
      if (node.matches(".network-map-basemap-control")) continue;
      move(node, filters);
    }
    for (const node of [...toolbar.querySelectorAll("select:not([data-metric])")]) {
      if (node.matches("[data-regional-view],[data-engineering-basemap]")) continue;
      move(node, filters);
    }
    if (filters.childNodes.length) content.append(filters);
    const extraActions = doc.createElement("div");
    extraActions.className = "network-map-data-tools";
    move(element.querySelector("[data-initial]"), extraActions);
    move(element.querySelector("[data-export]"), extraActions);
    if (extraActions.childNodes.length) content.append(extraActions);

    const regional = element.querySelector(".regional-map-controls");
    if (regional) {
      const presets = regional.querySelector(".regional-map-presets");
      if (presets) move(presets, toolbar, actions);
      const view = regional.querySelector("[data-regional-view]")?.closest("label");
      if (view) {
        view.classList.add("network-map-view-control");
        move(view, toolbar, actions);
      }
      const picker = regional.querySelector(".regional-object-picker");
      if (picker) move(picker, sidebarContent, sidebarContent.firstChild);
      const legend = regional.querySelector(".regional-map-legend");
      if (legend) move(legend, cartography.querySelector(".medical-map-map-footer"));
      const summary = regional.querySelector(".regional-map-summary");
      if (summary) {
        summary.classList.add("network-map-status-strip");
        move(summary, layout);
      }
      move(regional, content);
    }
    for (const node of [...element.children]) {
      if (node.matches(".power-map-key,.network-scene-view-note,.medical-map-warning,.medical-map-method,.regional-playback-note")) move(node, content);
    }
    const player = element.querySelector(".network-recovery-controls");
    if (player) {
      player.classList.add("network-map-player");
      move(player, cartography);
    }
    element.classList.add("network-map-workspace");

    function setPanel(which, opened, focus = false) {
      if (disposed) return;
      const layerOpen = which === "layers" ? opened : false;
      const detailOpen = which === "details" ? opened : false;
      element.classList.toggle("network-layers-open", layerOpen);
      element.classList.toggle("network-details-open", detailOpen);
      panel.hidden = !layerOpen;
      sidebar.hidden = !detailOpen;
      layersButton.setAttribute("aria-expanded", String(layerOpen));
      detailsButton.setAttribute("aria-expanded", String(detailOpen));
      if (focus && opened) (layerOpen ? closeLayers : closeDetails).focus({ preventScroll: true });
      resize();
    }
    const toggleLayers = () => setPanel("layers", panel.hidden, true);
    const toggleDetails = () => setPanel("details", sidebar.hidden, true);
    listen(layersButton, "click", toggleLayers);
    listen(detailsButton, "click", toggleDetails);
    listen(closeLayers, "click", () => { setPanel("layers", false); layersButton.focus({ preventScroll: true }); });
    listen(closeDetails, "click", () => { setPanel("details", false); detailsButton.focus({ preventScroll: true }); });
    listen(doc, "keydown", event => {
      if (event.key === "Escape" && (!panel.hidden || !sidebar.hidden)) setPanel("layers", false);
    });
    listen(doc, "fullscreenchange", resize);
    listen(win, "resize", resize);
    const observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(resize) : null;
    observer?.observe(element);
    setPanel("layers", false);

    const controller = {
      openDetails() { setPanel("details", true); },
      openLayers() { setPanel("layers", true); },
      toggleDetails, toggleLayers,
      destroy() {
        if (disposed) return;
        disposed = true;
        observer?.disconnect();
        win.cancelAnimationFrame(frame);
        for (const remove of listeners) remove();
        // Restore mounts and their event listeners, including a fullscreen map
        // that is leaving its dialog. Never replace Leaflet/Cesium canvases.
        for (const { node, placeholder } of changes.reverse()) {
          if (placeholder.parentNode) placeholder.parentNode.insertBefore(node, placeholder);
          placeholder.remove();
        }
        element.querySelector(".network-map-view-control")?.classList.remove("network-map-view-control");
        element.querySelector(".network-map-status-strip")?.classList.remove("network-map-status-strip");
        element.querySelector(".network-map-player")?.classList.remove("network-map-player");
        panel.remove(); actions.remove(); sidebarHeader.remove(); sidebarContent.remove();
        sidebar.hidden = false;
        element.classList.remove("network-map-workspace", "network-layers-open", "network-details-open");
        mounted.delete(element);
      },
    };
    mounted.set(element, controller);
    return controller;
  }
  window.NetworkMapLayout = Object.freeze({ mount });
})();
