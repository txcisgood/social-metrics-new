// Keep native selects as the source of truth; enhance only their presentation.
// A manual popover lives in the top layer and cannot be clipped by the sidebar.
const instances = new WeakMap();
let sequence = 0;

export function initSelectControls(root = document) {
  if (instances.has(root)) return instances.get(root);
  const doc = root.ownerDocument || root;
  const win = doc.defaultView;
  const controller = new win.AbortController();
  const records = new Map();
  const generatedLabels = new Map();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, {...options, signal: controller.signal});
  let active = null;
  let typeahead = '';
  let typedAt = 0;
  let disposed = false;

  function uniqueId(prefix) {
    let id;
    do { id = `sm-${prefix}-${++sequence}`; } while (doc.getElementById(id));
    return id;
  }

  function close({focus = false} = {}) {
    if (!active) return;
    const record = active;
    active = null;
    typeahead = '';
    record.wrapper.classList.remove('is-open');
    record.trigger.setAttribute('aria-expanded', 'false');
    record.trigger.removeAttribute('aria-activedescendant');
    if (record.panel.matches(':popover-open')) record.panel.hidePopover();
    if (focus && !record.trigger.disabled && record.trigger.isConnected) record.trigger.focus({preventScroll: true});
  }

  function visible(record) {
    const {native, trigger} = record;
    if (native.hidden || trigger.disabled || !trigger.isConnected || !trigger.getClientRects().length) return false;
    if (trigger.closest('[hidden]') || trigger.closest('details:not([open])')) return false;
    const computed = win.getComputedStyle(trigger);
    if (computed.visibility === 'hidden' || computed.visibility === 'collapse') return false;
    const rect = trigger.getBoundingClientRect();
    const viewport = win.visualViewport;
    let top = viewport?.offsetTop || 0;
    let left = viewport?.offsetLeft || 0;
    let bottom = top + (viewport?.height || win.innerHeight);
    let right = left + (viewport?.width || doc.documentElement.clientWidth);
    for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
      const style = win.getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, box.left); right = Math.min(right, box.right);
      }
    }
    return rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right;
  }

  function position() {
    if (!active) return;
    if (!visible(active)) { close(); return; }
    const {trigger, panel, list} = active;
    const viewport = win.visualViewport;
    const originX = viewport?.offsetLeft || 0, originY = viewport?.offsetTop || 0;
    const width = viewport?.width || doc.documentElement.clientWidth;
    const height = viewport?.height || win.innerHeight;
    const margin = 12, gap = 7;
    const anchor = trigger.getBoundingClientRect();
    const availableWidth = Math.max(0, width - margin * 2);
    panel.style.width = `${Math.min(Math.max(200, anchor.width), availableWidth)}px`;
    panel.style.maxWidth = `${availableWidth}px`;
    const below = Math.max(0, originY + height - margin - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - originY - margin - gap);
    // Measure the natural list before deciding which side has enough space.
    const desired = Math.min(320, list.scrollHeight + 12);
    const upwards = below < desired && above > below;
    const maxHeight = Math.max(0, Math.min(320, upwards ? above : below));
    if (maxHeight < 40) { close(); return; }
    panel.style.maxHeight = `${maxHeight}px`;
    list.style.maxHeight = `${Math.max(0, maxHeight - 12)}px`;
    const panelHeight = panel.getBoundingClientRect().height;
    panel.style.left = `${Math.max(originX + margin, Math.min(anchor.left, originX + width - panel.getBoundingClientRect().width - margin))}px`;
    panel.style.top = `${Math.max(originY + margin, upwards ? anchor.top - gap - panelHeight : anchor.bottom + gap)}px`;
    panel.dataset.placement = upwards ? 'top' : 'bottom';
  }

  function setActive(record, nativeIndex, {scroll = true} = {}) {
    const item = record.items.find(entry => entry.index === nativeIndex && !entry.disabled);
    record.activeIndex = item?.index ?? -1;
    for (const entry of record.items) entry.element.classList.toggle('is-active', entry === item);
    if (active === record && item) record.trigger.setAttribute('aria-activedescendant', item.element.id);
    else record.trigger.removeAttribute('aria-activedescendant');
    if (scroll && item) {
      const container = record.list.getBoundingClientRect();
      const target = item.element.getBoundingClientRect();
      if (target.top < container.top) record.list.scrollTop -= container.top - target.top;
      else if (target.bottom > container.bottom) record.list.scrollTop += target.bottom - container.bottom;
    }
  }

  function sync(record) {
    const {native, trigger, value, wrapper, list} = record;
    wrapper.hidden = native.hidden;
    const options = [...native.options].map((option, index) => ({
      index, value: option.value, label: option.label,
      disabled: option.disabled || Boolean(option.closest('optgroup[disabled]')),
      hidden: option.hidden || Boolean(option.closest('optgroup[hidden]')),
    }));
    const signature = JSON.stringify(options);
    if (signature !== record.signature) {
      record.signature = signature;
      record.items = [];
      const fragment = doc.createDocumentFragment();
      for (const option of options.filter(option => !option.hidden)) {
        const element = doc.createElement('div');
        element.id = uniqueId('option');
        element.className = 'select-option';
        element.setAttribute('role', 'option');
        element.setAttribute('aria-disabled', String(option.disabled));
        element.dataset.value = option.value;
        element.dataset.index = String(option.index);
        const label = doc.createElement('span');
        label.className = 'select-option-label';
        label.textContent = option.label;
        const check = doc.createElement('span');
        check.className = 'select-option-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = '✓';
        element.append(label, check);
        fragment.append(element);
        record.items.push({...option, element});
      }
      list.replaceChildren(fragment);
    }
    trigger.disabled = native.matches(':disabled') || !record.items.some(option => !option.disabled);
    trigger.setAttribute('aria-disabled', String(trigger.disabled));
    wrapper.classList.toggle('is-disabled', trigger.disabled);
    value.textContent = native.selectedOptions[0]?.label || (native.options.length ? '请选择' : '暂无可选项');
    trigger.title = value.textContent;
    for (const item of record.items) item.element.setAttribute('aria-selected', String(item.index === native.selectedIndex));
    for (const attribute of ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-required', 'aria-invalid']) {
      const content = native.getAttribute(attribute);
      if (content !== null) trigger.setAttribute(attribute, content);
      else trigger.removeAttribute(attribute);
    }
    if (!native.hasAttribute('aria-label') && !native.hasAttribute('aria-labelledby')) {
      const labelIds = [...native.labels].map(label => {
        if (!label.id) {
          label.id = uniqueId('label');
          generatedLabels.set(label, label.id);
        }
        return label.id;
      });
      if (labelIds.length) trigger.setAttribute('aria-labelledby', labelIds.join(' '));
      else trigger.setAttribute('aria-label', native.title || native.name || '选择选项');
    }
    for (const attribute of ['aria-label', 'aria-labelledby']) {
      const content = trigger.getAttribute(attribute);
      if (content !== null) list.setAttribute(attribute, content);
      else list.removeAttribute(attribute);
    }
    if (active === record) {
      if (!visible(record)) { close(); return; }
      const current = record.items.find(item => item.index === record.activeIndex && !item.disabled);
      setActive(record, current?.index ?? record.items.find(item => !item.disabled)?.index ?? -1, {scroll: false});
    }
  }

  function open(record, direction = 1) {
    sync(record);
    if (!visible(record)) return;
    if (active === record) return;
    close();
    active = record;
    record.wrapper.classList.add('is-open');
    record.trigger.setAttribute('aria-expanded', 'true');
    record.panel.showPopover();
    position();
    if (active !== record) return;
    const available = record.items.filter(item => !item.disabled);
    const selected = available.find(item => item.index === record.native.selectedIndex);
    setActive(record, selected?.index ?? (direction < 0 ? available.at(-1)?.index : available[0]?.index) ?? -1);
    record.trigger.focus({preventScroll: true});
  }

  function choose(record, index) {
    sync(record);
    if (record.trigger.disabled) { close(); return; }
    const item = record.items.find(option => option.index === index && !option.disabled);
    if (!item) return;
    const changed = record.native.selectedIndex !== index;
    record.native.selectedIndex = index;
    close({focus: true});
    sync(record);
    if (changed) {
      record.native.dispatchEvent(new win.Event('input', {bubbles: true}));
      record.native.dispatchEvent(new win.Event('change', {bubbles: true}));
    }
  }

  function move(record, direction) {
    const options = record.items.filter(item => !item.disabled);
    const index = options.findIndex(item => item.index === record.activeIndex);
    const next = direction === 'first' ? 0 : direction === 'last' ? options.length - 1 :
      Math.max(0, Math.min(options.length - 1, index + direction));
    setActive(record, options[next]?.index ?? -1);
  }

  function handleKey(record, event) {
    if (record.native.disabled || event.ctrlKey || event.metaKey) return;
    const isOpen = active === record;
    if (event.key === 'Escape') {
      if (isOpen) { event.preventDefault(); close({focus: true}); }
      return;
    }
    if (event.key === 'Tab') { if (isOpen) close(); return; }
    if (event.altKey) {
      if (event.key === 'ArrowUp' && isOpen) { event.preventDefault(); close({focus: true}); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); open(record); }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (isOpen) choose(record, record.activeIndex);
      else open(record);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!isOpen) open(record, event.key === 'ArrowUp' ? -1 : 1);
      if (active !== record) return;
      if (event.key === 'Home' || event.key === 'End') move(record, event.key === 'Home' ? 'first' : 'last');
      else if (isOpen) move(record, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key.length === 1 && !event.isComposing) {
      event.preventDefault();
      if (!isOpen) open(record);
      if (active !== record) return;
      const now = Date.now();
      typeahead = now - typedAt < 700 ? typeahead + event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase();
      typedAt = now;
      const repeated = [...typeahead].every(character => character === typeahead[0]);
      const query = repeated ? typeahead[0] : typeahead;
      const available = record.items.filter(item => !item.disabled);
      const current = available.findIndex(item => item.index === record.activeIndex);
      const start = repeated ? current + 1 : Math.max(current, 0);
      const ordered = [...available.slice(start), ...available.slice(0, start)];
      const match = ordered.find(item => item.label.trim().toLocaleLowerCase().startsWith(query));
      if (match) setActive(record, match.index);
    }
  }

  function enhance(native) {
    if (records.has(native) || native.multiple || native.size > 1 || typeof win.HTMLElement.prototype.showPopover !== 'function') return;
    const wrapper = doc.createElement('div');
    wrapper.className = 'select-control';
    wrapper.dataset.selectId = native.id || native.name;
    const trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-autocomplete', 'none');
    const value = doc.createElement('span');
    value.className = 'select-value';
    const arrow = doc.createElement('span');
    arrow.className = 'select-chevron';
    arrow.setAttribute('aria-hidden', 'true');
    trigger.append(value, arrow);
    const panel = doc.createElement('div');
    panel.className = 'select-popover';
    panel.setAttribute('popover', 'manual');
    const list = doc.createElement('div');
    list.className = 'select-options';
    list.id = uniqueId('listbox');
    list.setAttribute('role', 'listbox');
    trigger.setAttribute('aria-controls', list.id);
    panel.append(list);
    wrapper.append(trigger, panel);
    const record = {native, wrapper, trigger, value, panel, list, items: [], activeIndex: -1,
      originalTabIndex: native.getAttribute('tabindex'), originalAriaHidden: native.getAttribute('aria-hidden'),
      hadClass: native.classList.contains('select-native')};
    records.set(native, record);
    native.classList.add('select-native');
    native.tabIndex = -1;
    native.setAttribute('aria-hidden', 'true');
    native.insertAdjacentElement('afterend', wrapper);
    listen(trigger, 'click', () => { if (active === record) close(); else open(record); });
    listen(trigger, 'keydown', event => handleKey(record, event));
    listen(native, 'focus', () => { if (!trigger.disabled) trigger.focus({preventScroll: true}); });
    listen(native, 'input', () => sync(record));
    listen(native, 'change', () => sync(record));
    for (const label of native.labels) listen(label, 'click', event => {
      // A wrapping label may contain other controls; never hijack those clicks.
      if (event.target.closest('button, input, select, a')) return;
      event.preventDefault();
      if (!trigger.disabled) trigger.focus();
    });
    listen(list, 'pointerdown', event => event.preventDefault());
    listen(list, 'pointermove', event => {
      const option = event.target.closest('[role="option"]');
      if (option && list.contains(option) && option.getAttribute('aria-disabled') !== 'true') {
        setActive(record, Number(option.dataset.index), {scroll: false});
      }
    });
    listen(list, 'click', event => {
      const option = event.target.closest('[role="option"]');
      if (option && list.contains(option)) choose(record, Number(option.dataset.index));
    });
    listen(panel, 'toggle', event => { if (event.newState === 'closed' && active === record) close(); });
    sync(record);
  }

  function restore(record) {
    if (active === record) close();
    for (const [name, original] of [['tabindex', record.originalTabIndex], ['aria-hidden', record.originalAriaHidden]]) {
      if (original === null) record.native.removeAttribute(name);
      else record.native.setAttribute(name, original);
    }
    if (!record.hadClass) record.native.classList.remove('select-native');
    record.wrapper.remove();
    records.delete(record.native);
  }

  function refresh() {
    if (disposed) return;
    for (const select of root.querySelectorAll('select')) enhance(select);
    for (const record of records.values()) {
      if (!root.contains(record.native)) restore(record);
      else sync(record);
    }
    position();
  }

  listen(doc, 'pointerdown', event => {
    if (active && !event.composedPath().includes(active.trigger) && !event.composedPath().includes(active.panel)) close();
  });
  listen(doc, 'focusin', event => {
    if (active && event.target !== active.trigger && !active.panel.contains(event.target)) close();
  });
  listen(doc, 'scroll', event => {
    if (active && !(event.target instanceof win.Node && active.panel.contains(event.target))) position();
  }, {capture: true, passive: true});
  listen(doc, 'reset', () => win.queueMicrotask(refresh));
  listen(win, 'resize', position);
  if (win.visualViewport) {
    listen(win.visualViewport, 'resize', position);
    listen(win.visualViewport, 'scroll', position);
  }
  const observer = new win.MutationObserver(mutations => {
    let needsRefresh = false;
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (target?.closest('select') || (mutation.type === 'attributes' && target?.matches('fieldset'))) { needsRefresh = true; break; }
      if (mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
        node.nodeType === 1 && (node.matches('select') || node.querySelector('select')))) { needsRefresh = true; break; }
    }
    if (needsRefresh) refresh();
    else position();
  });
  observer.observe(root.documentElement || root, {subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['disabled', 'hidden', 'open', 'selected', 'label', 'value', 'aria-label', 'aria-labelledby', 'aria-describedby', 'data-theme', 'data-style']});
  const resizeObserver = new win.ResizeObserver(position);
  resizeObserver.observe(doc.documentElement);
  refresh();
  const api = {refresh, dispose() {
    if (disposed) return;
    disposed = true;
    close();
    controller.abort();
    observer.disconnect();
    resizeObserver.disconnect();
    for (const record of records.values()) restore(record);
    for (const [label, id] of generatedLabels) if (label.id === id) label.removeAttribute('id');
    instances.delete(root);
  }};
  instances.set(root, api);
  return api;
}
