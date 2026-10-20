// Native popovers enter the top layer, so the settings panel cannot clip them.
// The extension's Chrome 120+ baseline supports this API without a dependency.
const instances = new WeakMap();

export function initSettingHelp(root = document) {
  if (instances.has(root)) return instances.get(root);
  const doc = root.ownerDocument || root;
  const win = doc.defaultView;
  const controller = new win.AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, {...options, signal: controller.signal});
  let active = null;
  let hideTimer;
  let fadeTimer;
  let inputMode = 'keyboard';
  const reducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)');

  function cancelHide() {
    win.clearTimeout(hideTimer);
    win.clearTimeout(fadeTimer);
    hideTimer = undefined;
    fadeTimer = undefined;
    if (active) {
      active.closing = false;
      active.panel.classList.remove('is-closing');
    }
  }

  function close({animate = false} = {}) {
    cancelHide();
    if (!active) return;
    const record = active;
    if (animate && !reducedMotion.matches) {
      record.closing = true;
      record.panel.classList.add('is-closing');
      fadeTimer = win.setTimeout(() => {
        fadeTimer = undefined;
        if (active === record && record.closing) close();
      }, 120);
      return;
    }
    active = null;
    record.button.setAttribute('aria-expanded', 'false');
    if (record.panel.matches(':popover-open')) record.panel.hidePopover();
  }

  function position() {
    if (!active) return;
    const {button, panel} = active;
    const viewport = win.visualViewport;
    const width = viewport?.width || doc.documentElement.clientWidth;
    const height = viewport?.height || win.innerHeight;
    const originX = viewport?.offsetLeft || 0;
    const originY = viewport?.offsetTop || 0;
    const margin = 16, gap = 10;
    panel.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    panel.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
    const trigger = button.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    let left = trigger.right + gap;
    let top = trigger.top - 8;
    if (left + box.width > originX + width - margin) {
      left = trigger.left;
      top = trigger.bottom + gap;
      if (top + box.height > originY + height - margin) top = trigger.top - box.height - gap;
    }
    panel.style.left = `${Math.max(originX + margin, Math.min(left, originX + width - box.width - margin))}px`;
    panel.style.top = `${Math.max(originY + margin, Math.min(top, originY + height - box.height - margin))}px`;
  }

  function open(button, panel, mode = 'pointer') {
    cancelHide();
    if (active?.button === button) {
      active.mode = mode;
      return;
    }
    close();
    active = {button, panel, mode, clicked: false, closing: false};
    panel.classList.remove('is-closing');
    panel.showPopover();
    button.setAttribute('aria-expanded', 'true');
    position();
  }

  function scheduleClose() {
    cancelHide();
    if (!active) return;
    const record = active;
    // Let the pointer cross the gap into the explanation before fading it out.
    // Mouse clicks leave focus on the button; only keyboard focus keeps it open.
    hideTimer = win.setTimeout(() => {
      hideTimer = undefined;
      if (active !== record || record.mode === 'touch' ||
          record.button.matches(':hover') || record.panel.matches(':hover') ||
          (record.mode === 'keyboard' && doc.activeElement === record.button)) return;
      close({animate: true});
    }, 120);
  }

  for (const button of root.querySelectorAll('[data-help-trigger]')) {
    const panel = doc.getElementById(button.getAttribute('aria-controls'));
    if (!panel || typeof panel.showPopover !== 'function') continue;
    listen(button, 'pointerenter', event => {
      if (event.pointerType === 'touch') return;
      const keyboardFocused = active?.button === button && active.mode === 'keyboard' && doc.activeElement === button;
      open(button, panel, keyboardFocused ? 'keyboard' : 'pointer');
    });
    listen(button, 'pointerleave', scheduleClose);
    listen(button, 'focus', () => {
      // Touch focuses before click; let click perform its open/toggle operation.
      if (inputMode !== 'touch') open(button, panel, inputMode);
    });
    listen(button, 'blur', scheduleClose);
    listen(button, 'click', event => {
      event.preventDefault();
      event.stopPropagation();
      const mode = event.pointerType === 'touch' ? 'touch' : event.detail === 0 ? 'keyboard' : 'pointer';
      if (active?.button === button && active.clicked && !active.closing) close();
      else {
        open(button, panel, mode);
        active.clicked = true;
      }
    });
    listen(panel, 'pointerenter', cancelHide);
    listen(panel, 'pointerleave', scheduleClose);
    listen(panel, 'toggle', event => {
      if (event.newState === 'closed' && active?.panel === panel && !panel.matches(':popover-open')) close();
    });
  }

  listen(doc, 'pointerdown', event => {
    inputMode = event.pointerType === 'touch' ? 'touch' : 'pointer';
    if (!active) return;
    if (!event.composedPath().includes(active.button) && !event.composedPath().includes(active.panel)) close();
    else active.mode = inputMode;
  }, {capture: true});
  listen(doc, 'keydown', event => {
    inputMode = 'keyboard';
    if (active && doc.activeElement === active.button) active.mode = 'keyboard';
    if (event.key === 'Escape' && active) {
      close();
      event.preventDefault();
    }
  }, {capture: true});
  listen(doc, 'scroll', event => {
    if (!active || (event.target instanceof win.Node && active.panel.contains(event.target))) return;
    // Focus/hover can cause the browser to scroll an anchor into view. That
    // queued scroll must not immediately dismiss the newly opened explanation.
    const rect = active.button.getBoundingClientRect();
    let top = 0, left = 0, bottom = win.innerHeight, right = doc.documentElement.clientWidth;
    for (let parent = active.button.parentElement; parent; parent = parent.parentElement) {
      const style = win.getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
      }
    }
    if (rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) close();
    else position();
  }, {capture: true, passive: true});
  listen(win, 'resize', position);
  if (win.visualViewport) {
    listen(win.visualViewport, 'resize', position);
    listen(win.visualViewport, 'scroll', close);
  }

  const observer = new win.MutationObserver(() => {
    if (active && (active.button.closest('[hidden]') || active.button.closest('details:not([open])'))) close();
  });
  observer.observe(root.documentElement || root, {subtree: true, attributes: true, attributeFilter: ['hidden', 'open']});

  const dispose = () => {
    close();
    controller.abort();
    observer.disconnect();
    instances.delete(root);
  };
  instances.set(root, dispose);
  return dispose;
}
