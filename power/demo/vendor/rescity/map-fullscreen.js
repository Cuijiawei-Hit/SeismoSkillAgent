/* Expand the existing map rather than rebuilding its camera or playback state. */
(() => {
  "use strict";
  let active = null;
  function mount(element, options = {}) {
    const button = options.button;
    if (!element || !button) return null;
    const doc = element.ownerDocument, win = doc.defaultView || window;
    const english = String(options.language || "").startsWith("en");
    let disposed = false, expanded = false, fallback = false, busy = false;
    let previousFocus = null, bodyOverflow = "", resizeFrame = null, dialog = null;
    const resize = () => {
      win.cancelAnimationFrame(resizeFrame);
      resizeFrame = win.requestAnimationFrame(() => { if (!disposed) options.onResize?.(); });
    };
    const notifyHost = value => {
      if (win.parent !== win) win.parent.postMessage({ source: "rescity-engineering-native", type: "map-fullscreen", active: value }, win.location.origin);
    };
    const paint = value => {
      expanded = value;
      element.classList.toggle("map-fullscreen", value);
      button.setAttribute("aria-expanded", String(value));
      button.textContent = value ? (english ? "Exit full screen" : "退出全屏") : (english ? "Full screen" : "全屏查看");
      button.title = value ? (english ? "Exit full screen (Esc)" : "退出全屏（Esc）") : (english ? "View the map in full screen" : "全屏查看地图");
      if (!value && active === controller) active = null;
      resize();
    };
    const finishExit = () => {
      if (fallback) {
        fallback = false;
        if (dialog) {
          dialog.removeEventListener("cancel", onDialogCancel);
          // The map stays within its original mount throughout the fallback.
          dialog.parentNode?.insertBefore(element, dialog);
          if (dialog.open) dialog.close();
          dialog.remove(); dialog = null;
        }
        element.classList.remove("map-fullscreen--fallback");
        doc.body.style.overflow = bodyOverflow;
        notifyHost(false);
      }
      paint(false);
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
      previousFocus = null;
    };
    const enterFallback = () => {
      fallback = true;
      bodyOverflow = doc.body.style.overflow;
      doc.body.style.overflow = "hidden";
      element.classList.add("map-fullscreen--fallback");
      // A modal dialog's top layer escapes layout containment and clipped result panels.
      dialog = doc.createElement("dialog");
      dialog.className = "map-fullscreen-dialog";
      dialog.setAttribute("aria-label", english ? "Full-screen map overview" : "地图全屏总览");
      dialog.addEventListener("cancel", onDialogCancel);
      element.parentNode.insertBefore(dialog, element);
      dialog.append(element);
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      notifyHost(true);
      paint(true);
      button.focus({ preventScroll: true });
    };
    async function exit() {
      if (!expanded) return;
      if (!fallback && doc.fullscreenElement === element && doc.exitFullscreen) {
        try { await doc.exitFullscreen(); } catch (_error) { /* The browser may have already exited. */ }
        if (doc.fullscreenElement === element) return;
      }
      if (expanded) finishExit();
    }
    async function enter() {
      if (disposed || expanded || busy) return;
      busy = true;
      if (active && active !== controller) await active.exit();
      if (disposed) { busy = false; return; }
      active = controller;
      previousFocus = doc.activeElement;
      // Keep this request in the button's user activation. No map instance is replaced.
      if (element.requestFullscreen && doc.fullscreenEnabled !== false) {
        try {
          await element.requestFullscreen();
          if (disposed) {
            if (doc.fullscreenElement === element) await doc.exitFullscreen?.();
            busy = false; return;
          }
          if (doc.fullscreenElement === element) { paint(true); button.focus({ preventScroll: true }); }
          else finishExit();
          busy = false; return;
        } catch (_error) { /* Browser/iframe policy fallback: fill the platform viewport. */ }
      }
      if (!disposed) enterFallback();
      busy = false;
    }
    const onClick = () => { if (!busy) expanded ? exit() : enter(); };
    const onFullscreen = () => {
      if (doc.fullscreenElement === element) { if (!disposed) paint(true); }
      else if (expanded && !fallback) finishExit();
    };
    const onKey = event => {
      // Browser fullscreenchange remains authoritative when Esc is consumed by
      // the browser; an Esc delivered to the document must also dismiss the map.
      if (event.key === "Escape" && expanded) { event.preventDefault(); exit(); }
      if (event.key !== "Tab" || !expanded || !fallback) return;
      const focusable = Array.from(element.querySelectorAll("button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[tabindex='0']"))
        .filter(node => !node.hidden && node.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) return;
      if (event.shiftKey && (doc.activeElement === first || !element.contains(doc.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (doc.activeElement === last || !element.contains(doc.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const onMessage = event => {
      if (event.origin === win.location.origin && event.source === win.parent && event.data?.source === "rescity-workstation" && event.data.type === "close-map-fullscreen") exit();
    };
    const onDialogCancel = event => { event.preventDefault(); exit(); };
    const controller = { enter, exit, destroy() {
      if (disposed) return;
      if (expanded) {
        if (!fallback && doc.fullscreenElement === element) Promise.resolve(doc.exitFullscreen?.()).catch(() => {});
        finishExit();
      }
      disposed = true;
      win.cancelAnimationFrame(resizeFrame);
      button.removeEventListener("click", onClick);
      doc.removeEventListener("fullscreenchange", onFullscreen);
      doc.removeEventListener("keydown", onKey);
      win.removeEventListener("message", onMessage);
      win.removeEventListener("resize", resize);
      if (active === controller) active = null;
    } };
    button.classList.add("map-fullscreen-button");
    paint(false);
    button.addEventListener("click", onClick);
    doc.addEventListener("fullscreenchange", onFullscreen);
    doc.addEventListener("keydown", onKey);
    win.addEventListener("message", onMessage);
    win.addEventListener("resize", resize);
    return controller;
  }
  window.MapFullscreen = Object.freeze({ mount });
})();
