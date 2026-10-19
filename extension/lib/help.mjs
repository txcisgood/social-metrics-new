// Native popovers enter the top layer, so the settings panel cannot clip them.
// The extension's Chrome 120+ baseline supports this API without a dependency.
const instances = new WeakMap();

export function initSettingHelp(root = document) {
  if (instances.has(root)) return instances.get(root);
  const doc = root.ownerDocument || root;
  const win = doc.defaultView;
  const controller = new AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, {...options, signal: controller.signal});
  let active = null;
  let hideTimer;

  function cancelHide() {
    win.clearTimeout(hideTimer);
    hideTimer = undefined;
  }

  function close() {
    cancelHide();
    if (!active) return;
    const {button, panel} = active;
    active = null;
    button.setAttribute('aria-expanded', 'false');
    if (panel.matches(':popover-open')) panel.hidePopover();
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

  function open(button, panel, pinned = false) {
    cancelHide();
    if (active?.button === button) {
      active.pinned ||= pinned;
      return;
    }
    close();
    active = {button, panel, pinned};
    panel.showPopover();
    button.setAttribute('aria-expanded', 'true');
    position();
  }

  function scheduleClose() {
    cancelHide();
    // Allow the pointer to cross the small gap and select or read the text.
    hideTimer = win.setTimeout(() => {
      if (!active || active.pinned || active.button.matches(':hover') || active.panel.matches(':hover') || doc.activeElement === active.button) return;
      close();
    }, 180);
  }

  for (const button of root.querySelectorAll('[data-help-trigger]')) {
    const panel = doc.getElementById(button.getAttribute('aria-controls'));
    if (!panel || typeof panel.showPopover !== 'function') continue;
    listen(button, 'pointerenter', event => {
      if (event.pointerType === 'touch' || (active?.pinned && active.button !== button)) return;
      open(button, panel);
    });
    listen(button, 'pointerleave', scheduleClose);
    listen(button, 'focus', () => open(button, panel));
    listen(button, 'blur', scheduleClose);
    listen(button, 'click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (active?.button === button && active.pinned) close();
      else open(button, panel, true);
    });
    listen(panel, 'pointerenter', cancelHide);
    listen(panel, 'pointerleave', scheduleClose);
    listen(panel, 'toggle', event => {
      if (event.newState === 'closed' && active?.panel === panel) close();
    });
  }

  listen(doc, 'pointerdown', event => {
    if (active && !event.composedPath().includes(active.button) && !event.composedPath().includes(active.panel)) close();
  });
  listen(doc, 'keydown', event => {
    if (event.key === 'Escape' && active) {
      close();
      event.preventDefault();
    }
  });
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

  const observer = new MutationObserver(() => {
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
