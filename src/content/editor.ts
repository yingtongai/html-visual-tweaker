import cssText from './overlay.css?inline';
import { loadHistory, saveVersion, setActiveVersion } from '../storage/history';
import { EditableProperty, SavedVersion, StyleRule } from '../shared/types';

declare global {
  interface Window { __htmlTweakerLoaded?: boolean }
}

if (!window.__htmlTweakerLoaded) {
  window.__htmlTweakerLoaded = true;
  void init();
}

async function init() {
  const style = document.createElement('style');
  style.id = 'html-tweaker-styles';
  style.textContent = cssText;
  document.documentElement.appendChild(style);

  const root = document.createElement('div');
  root.id = 'html-tweaker-root';
  const shadow = root.attachShadow({ mode: 'open' });
  const shadowCss = cssText.replace(/#html-tweaker-root/g, ':host');
  shadow.innerHTML = `<style>${shadowCss}</style><div id="html-tweaker-guide-x"></div><div id="html-tweaker-guide-y"></div><div id="html-tweaker-highlight"><span class="html-tweaker-selected-label"></span><span class="html-tweaker-handle nw"></span><span class="html-tweaker-handle ne"></span><span class="html-tweaker-handle sw"></span><span class="html-tweaker-handle se"></span></div>
    <div id="html-tweaker-toolbar"><strong>HTML 微调器</strong><button id="html-tweaker-edit">修改</button><button id="html-tweaker-save" disabled>保存修改</button><button id="html-tweaker-cancel" class="secondary" disabled>取消</button><button id="html-tweaker-restore" class="secondary">恢复</button><button id="html-tweaker-exit" class="secondary">隐藏</button><span id="html-tweaker-status"></span></div>
    <aside id="html-tweaker-inspector" hidden><h2>元素样式</h2><div id="html-tweaker-target"></div><div id="html-tweaker-fields"></div></aside>`;
  document.documentElement.appendChild(root);

  const highlight = shadow.querySelector<HTMLElement>('#html-tweaker-highlight')!;
  const guideX = shadow.querySelector<HTMLElement>('#html-tweaker-guide-x')!;
  const guideY = shadow.querySelector<HTMLElement>('#html-tweaker-guide-y')!;
  const inspector = shadow.querySelector<HTMLElement>('#html-tweaker-inspector')!;
  const fields = shadow.querySelector<HTMLElement>('#html-tweaker-fields')!;
  const targetLabel = shadow.querySelector<HTMLElement>('#html-tweaker-target')!;
  const selectedLabel = shadow.querySelector<HTMLElement>('.html-tweaker-selected-label')!;
  const status = shadow.querySelector<HTMLElement>('#html-tweaker-status')!;
  const editButton = shadow.querySelector<HTMLButtonElement>('#html-tweaker-edit')!;
  const saveButton = shadow.querySelector<HTMLButtonElement>('#html-tweaker-save')!;
  const cancelButton = shadow.querySelector<HTMLButtonElement>('#html-tweaker-cancel')!;
  const rules = new Map<string, StyleRule>();
  let selected: HTMLElement | null = null;
  let editing = false;
  let editingSnapshot: StyleRule[] = [];
  const appliedProperties = new Map<string, string[]>();
  const originalInline = new WeakMap<HTMLElement, Map<string, { value: string; priority: string }>>();
  const originalMarkup = new WeakMap<HTMLElement, string>();
  const touchedProperties = new Map<string, Set<string>>();
  let reapplyTimer: number | null = null;

  const history = await loadHistory();
  const latest = history.activeVersionId === null
    ? undefined
    : history.versions.find((version) => version.id === history.activeVersionId) ?? history.versions[0];
  if (latest) applyRules(latest.rules);

  function applyRules(nextRules: StyleRule[], restorePreviousText = true) {
    const selectors = new Set([...appliedProperties.keys(), ...touchedProperties.keys(), ...rules.keys()]);
    selectors.forEach((selector) => {
      const properties = new Set([
        ...(appliedProperties.get(selector) ?? []),
        ...(touchedProperties.get(selector) ?? []),
        ...((rules.get(selector) && Object.keys(rules.get(selector)!.properties).map((key) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`))) ?? [])
      ]);
      document.querySelectorAll<HTMLElement>(selector).forEach((el) => [...properties].forEach((property) => {
        const previous = originalInline.get(el)?.get(property);
        if (previous?.value) el.style.setProperty(property, previous.value, previous.priority);
        else el.style.removeProperty(property);
      }));
    });
    if (restorePreviousText) rules.forEach((rule) => document.querySelectorAll<HTMLElement>(rule.selector).forEach((el) => {
      if (originalMarkup.has(el)) el.innerHTML = originalMarkup.get(el)!;
    }));
    appliedProperties.clear();
    rules.clear();
    nextRules.forEach((rule) => {
      rules.set(rule.selector, rule);
      const properties = Object.keys(rule.properties).map((key) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
      appliedProperties.set(rule.selector, properties);
      document.querySelectorAll<HTMLElement>(rule.selector).forEach((el) => {
        if (rule.textContent !== undefined) {
          if (!originalMarkup.has(el)) originalMarkup.set(el, el.innerHTML);
          if (el.textContent !== rule.textContent) setElementText(el, rule.textContent);
        }
        Object.entries(rule.properties).forEach(([key, value]) => {
          if (value) setImportant(el, key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), value);
        });
      });
    });
    if (selected && restorePreviousText) refreshInspector();
  }

  function selectorFor(el: HTMLElement): string {
    if (el.id && !el.id.startsWith('html-tweaker')) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let current: HTMLElement | null = el;
    while (current && current !== document.body && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      const classes = [...current.classList].filter((c) => !c.startsWith('html-tweaker')).slice(0, 2);
      if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join('');
      const siblings = current.parentElement ? [...current.parentElement.children].filter((node) => node.tagName === current!.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  function fingerprint(el: HTMLElement) {
    return `${el.tagName.toLowerCase()}|${el.textContent?.trim().slice(0, 40) ?? ''}|${el.getAttribute('src') ?? ''}`;
  }

  function selectElement(el: HTMLElement) {
    if (el === root || root.contains(el) || ['HTML', 'BODY', 'SCRIPT', 'STYLE'].includes(el.tagName)) return;
    selected = el;
    inspector.hidden = false;
    setResizeHandlesVisible(isResizeable(el));
    refreshInspector();
    updateHighlight();
  }

  function updateHighlight() {
    if (!selected || !editing) { highlight.style.display = 'none'; return; }
    const rect = selected.getBoundingClientRect();
    selectedLabel.textContent = selected.tagName.toLowerCase() + (selected.id ? `#${selected.id}` : "");
    Object.assign(highlight.style, { display: 'block', position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, boxSizing: 'border-box', zIndex: '2147483647' });
  }

  function isResizeable(_el: HTMLElement) { return true; }

  function setResizeHandlesVisible(visible: boolean) {
    shadow.querySelectorAll<HTMLElement>('.html-tweaker-handle').forEach((handle) => { handle.style.display = visible ? 'block' : 'none'; });
  }

  function currentRule(): StyleRule | undefined { return selected ? rules.get(selectorFor(selected)) : undefined; }

  function refreshInspector() {
    if (!selected) return;
    const rule = currentRule();
    targetLabel.innerHTML = `${selected.tagName.toLowerCase()}${selected.id ? `#${selected.id}` : ''}<small class="html-tweaker-scope">样式作用于整个元素</small>`;
    const computed = getComputedStyle(selected);
    const fieldsConfig: Array<{ key: EditableProperty; label: string; type: string; value: string; options?: string[] }> = [
      { key: 'width', label: '宽度', type: 'text', value: rule?.properties.width ?? computed.width },
      { key: 'height', label: '高度', type: 'text', value: rule?.properties.height ?? computed.height },
      { key: 'fontSize', label: '字号', type: 'text', value: rule?.properties.fontSize ?? computed.fontSize },
      { key: 'color', label: '颜色', type: 'color', value: rgbToHex(rule?.properties.color ?? computed.color) },
      { key: 'fontFamily', label: '字体', type: 'select', value: rule?.properties.fontFamily ?? computed.fontFamily, options: ['system-ui', 'sans-serif', 'serif', 'monospace'] },
      { key: 'margin', label: '外边距', type: 'text', value: rule?.properties.margin ?? computed.margin },
      { key: 'borderRadius', label: '圆角', type: 'text', value: rule?.properties.borderRadius ?? computed.borderRadius },
      { key: 'transform', label: '位移', type: 'text', value: rule?.properties.transform ?? computed.transform }
    ];
    const textEditor = `<label class="html-tweaker-copy-label">文案<textarea data-text-content>${escapeHtml(selected.textContent ?? '')}</textarea></label>`;
    fields.innerHTML = textEditor + fieldsConfig.map((field) => field.type === 'select'
      ? `<label>${field.label}<select data-style="${field.key}">${field.options!.map((option) => `<option ${option === field.value ? 'selected' : ''}>${option}</option>`).join('')}</select></label>`
      : `<label>${field.label}<input data-style="${field.key}" type="${field.type}" value="${escapeAttr(field.value)}"></label>`).join('');
    fields.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-style]').forEach((input) => {
      input.addEventListener('input', () => updateProperty(input.dataset.style as EditableProperty, input.value));
    });
    fields.querySelector<HTMLTextAreaElement>('[data-text-content]')?.addEventListener('input', (event) => {
      if (!selected) return;
      const value = (event.target as HTMLTextAreaElement).value;
      const selector = selectorFor(selected);
      const rule = rules.get(selector) ?? { selector, fingerprint: fingerprint(selected), properties: {} };
      rule.textContent = value;
      rules.set(selector, rule);
      if (!originalMarkup.has(selected)) originalMarkup.set(selected, selected.innerHTML);
      setElementText(selected, value);
      updateHighlight();
    });
  }

  function updateProperty(key: EditableProperty, value: string) {
    if (!selected || !value) return;
    const selector = selectorFor(selected);
    const rule = rules.get(selector) ?? { selector, fingerprint: fingerprint(selected), properties: {} };
    rule.properties[key] = value;
    rules.set(selector, rule);
    const cssKey = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    setImportant(selected, cssKey, value);
    updateHighlight();
  }

  function setImportant(el: HTMLElement, property: string, value: string) {
    let saved = originalInline.get(el);
    if (!saved) { saved = new Map(); originalInline.set(el, saved); }
    if (!saved.has(property)) saved.set(property, { value: el.style.getPropertyValue(property), priority: el.style.getPropertyPriority(property) });
    const selector = selectorFor(el);
    let touched = touchedProperties.get(selector);
    if (!touched) { touched = new Set(); touchedProperties.set(selector, touched); }
    touched.add(property);
    el.style.setProperty(property, value, 'important');
  }

  function setUiVisible(visible: boolean) {
    root.style.display = visible ? '' : 'none';
  }

  function setEditing(value: boolean) {
    if (value && !editing) editingSnapshot = cloneRules([...rules.values()]);
    editing = value;
    document.documentElement.classList.toggle('html-tweaker-editing', value);
    setUiVisible(true);
    editButton.disabled = value;
    saveButton.disabled = !value;
    cancelButton.disabled = !value;
    editButton.textContent = value ? '修改中' : '修改';
    if (!value) { selected = null; inspector.hidden = true; }
    updateHighlight();
  }

  document.addEventListener('click', (event) => {
    if (!editing) return;
    const target = event.target as HTMLElement;
    if (root.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    selectElement(target.closest<HTMLElement>('img,button,a,input,textarea,select,svg,canvas,div,section,article,header,footer,p,span,h1,h2,h3,h4,h5,h6') ?? target);
  }, true);

  let drag: { x: number; y: number; rect: DOMRect; baseTransform: string; pointerId: number; snapTargets: { x: number[]; y: number[] }; frame: number | null; latestX: number; latestY: number } | null = null;
  document.addEventListener('pointerdown', (event) => {
    if (!editing || !selected || event.button !== 0 || event.target !== selected) return;
    const selector = selectorFor(selected);
    const baseTransform = rules.get(selector)?.properties.transform ?? selected.style.transform ?? '';
    drag = { x: event.clientX, y: event.clientY, rect: selected.getBoundingClientRect(), baseTransform: baseTransform === 'none' ? '' : baseTransform, pointerId: event.pointerId, snapTargets: collectSnapTargets(), frame: null, latestX: event.clientX, latestY: event.clientY };
    selected.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (!drag || !selected) return;
    drag.latestX = event.clientX;
    drag.latestY = event.clientY;
    if (drag.frame !== null) return;
    drag.frame = requestAnimationFrame(() => {
      if (!drag || !selected) return;
      drag.frame = null;
      const snapped = snapPosition(drag.rect, drag.latestX - drag.x, drag.latestY - drag.y, drag.snapTargets);
      const translation = 'translate(' + Math.round(snapped.x) + 'px, ' + Math.round(snapped.y) + 'px)';
      updateProperty('transform', drag.baseTransform ? drag.baseTransform + ' ' + translation : translation);
      updateGuides(snapped.guides);
    });
  }, true);
  document.addEventListener('pointerup', () => {
    if (drag && selected) selected.releasePointerCapture?.(drag.pointerId);
    if (drag?.frame !== null && drag?.frame !== undefined) cancelAnimationFrame(drag.frame);
    drag = null; resize = null; clearGuides();
  }, true);

  let resize: { x: number; y: number; width: number; height: number; corner: string; baseTransform: string } | null = null;
  function beginResize(event: PointerEvent, handle: HTMLElement) {
    if (!editing || !selected || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = selected.getBoundingClientRect();
    const selector = selectorFor(selected);
    const baseTransform = rules.get(selector)?.properties.transform ?? selected.style.transform ?? '';
    resize = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, corner: handle.className, baseTransform: baseTransform === 'none' ? '' : baseTransform };
    drag = null;
    handle.setPointerCapture?.(event.pointerId);
  }
  shadow.querySelectorAll<HTMLElement>('.html-tweaker-handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => beginResize(event, handle));
  });
  root.addEventListener('pointerdown', (event) => {
    const handle = (event.target as HTMLElement).closest<HTMLElement>('.html-tweaker-handle');
    if (handle) beginResize(event, handle);
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (!resize || !selected) return;
    const dx = event.clientX - resize.x;
    const dy = event.clientY - resize.y;
    const isWest = resize.corner.includes('nw') || resize.corner.includes('sw');
    const isNorth = resize.corner.includes('nw') || resize.corner.includes('ne');
    if (getComputedStyle(selected).display === 'inline') {
      const selector = selectorFor(selected);
      const rule = rules.get(selector) ?? { selector, fingerprint: fingerprint(selected), properties: {} };
      rule.properties.display = 'inline-block';
      rules.set(selector, rule);
      setImportant(selected, 'display', 'inline-block');
    }
    updateProperty('maxWidth', 'none');
    updateProperty('flex', 'none');
    updateProperty('width', `${Math.max(20, Math.round(resize.width + (isWest ? -dx : dx)))}px`);
    updateProperty('height', `${Math.max(20, Math.round(resize.height + (isNorth ? -dy : dy)))}px`);
    if (isWest || isNorth) {
      const translation = `translate(${isWest ? Math.round(dx) : 0}px, ${isNorth ? Math.round(dy) : 0}px)`;
      updateProperty('transform', resize.baseTransform ? `${resize.baseTransform} ${translation}` : translation);
    }
  }, true);

  function collectSnapTargets() {
    const others = [...document.body.querySelectorAll<HTMLElement>('*')].filter((el) => el !== selected && !root.contains(el) && el.offsetWidth > 0 && el.offsetHeight > 0);
    return {
      x: others.flatMap((el) => { const r = el.getBoundingClientRect(); return [r.left, r.left + r.width / 2, r.right]; }),
      y: others.flatMap((el) => { const r = el.getBoundingClientRect(); return [r.top, r.top + r.height / 2, r.bottom]; })
    };
  }
  function snapPosition(rect: DOMRect, rawX: number, rawY: number, targets = collectSnapTargets()) {
    const xTargets = targets.x;
    const yTargets = targets.y;
    const xPoints = [rect.left + rawX, rect.left + rect.width / 2 + rawX, rect.right + rawX];
    const yPoints = [rect.top + rawY, rect.top + rect.height / 2 + rawY, rect.bottom + rawY];
    let bestX = { delta: rawX, distance: 7, line: 0 };
    let bestY = { delta: rawY, distance: 7, line: 0 };
    xPoints.forEach((point) => xTargets.forEach((target) => { const distance = Math.abs(point - target); if (distance < bestX.distance) bestX = { delta: rawX + target - point, distance, line: target }; }));
    yPoints.forEach((point) => yTargets.forEach((target) => { const distance = Math.abs(point - target); if (distance < bestY.distance) bestY = { delta: rawY + target - point, distance, line: target }; }));
    return { x: bestX.delta, y: bestY.delta, guides: { x: bestX.distance < 7 ? bestX.line : null, y: bestY.distance < 7 ? bestY.line : null } };
  }
  function updateGuides(guides: { x: number | null; y: number | null }) {
    guideX.style.display = guides.x === null ? 'none' : 'block';
    guideY.style.display = guides.y === null ? 'none' : 'block';
    if (guides.x !== null) guideX.style.left = `${guides.x}px`;
    if (guides.y !== null) guideY.style.top = `${guides.y}px`;
  }
  function clearGuides() { guideX.style.display = 'none'; guideY.style.display = 'none'; }

  window.addEventListener('resize', updateHighlight);
  window.addEventListener('scroll', updateHighlight, true);
  function needsStyleReapply(element: HTMLElement) {
    return [...rules.values()].some((rule) => {
      if (!element.matches(rule.selector)) return false;
      return Object.entries(rule.properties).some(([key, value]) => {
        if (!value) return false;
        const property = key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
        return element.style.getPropertyValue(property) !== value || element.style.getPropertyPriority(property) !== 'important';
      });
    });
  }

  function scheduleRuleReapply() {
    if (reapplyTimer !== null) return;
    reapplyTimer = window.setTimeout(() => {
      reapplyTimer = null;
      if (rules.size) applyRules([...rules.values()], false);
    }, 0);
  }

  const observer = new MutationObserver((records) => {
    if (!rules.size || records.every((record) => root.contains(record.target))) return;
    if (records.some((record) => record.type === 'childList' || needsStyleReapply(record.target as HTMLElement))) scheduleRuleReapply();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  window.setTimeout(() => { if (rules.size) scheduleRuleReapply(); }, 500);

  editButton.addEventListener('click', () => setEditing(true));
  saveButton.addEventListener('click', async () => {
    if (!editing) return;
    const version = await saveVersion([...rules.values()], document.title || location.hostname);
    status.textContent = `已保存 ${new Date(version.createdAt).toLocaleTimeString()}`;
    setEditing(false);
    setTimeout(() => { status.textContent = ''; }, 2500);
  });
  cancelButton.addEventListener('click', () => {
    if (!editing) return;
    applyRules(editingSnapshot);
    status.textContent = '已取消本次修改';
    setEditing(false);
  });
  shadow.querySelector('#html-tweaker-restore')!.addEventListener('click', () => openRestoreModal());
  shadow.querySelector('#html-tweaker-exit')!.addEventListener('click', () => {
    if (editing) {
      applyRules(editingSnapshot);
      status.textContent = '已取消本次修改';
    }
    setEditing(false);
    setUiVisible(false);
  });
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'show-editor') setUiVisible(true);
    });
  }

  async function openRestoreModal() {
    const modal = document.createElement('div');
    modal.className = 'html-tweaker-modal';
    const current = await loadHistory();
    modal.innerHTML = `<button class="html-tweaker-close" aria-label="关闭">×</button><h2>恢复历史版本</h2><div class="html-tweaker-version"><span>刚打开页面的初始状态<br><small>清除所有已保存覆盖</small></span><button data-version="initial">恢复</button></div><div>${current.versions.length ? current.versions.map((v) => `<div class="html-tweaker-version"><span>${escapeHtml(new Date(v.createdAt).toLocaleString())}<br><small>${v.rules.length} 条样式规则</small></span><button data-version="${v.id}">恢复</button></div>`).join('') : '<p>暂无保存版本</p>'}</div>`;
    shadow.appendChild(modal);
    modal.querySelector('.html-tweaker-close')!.addEventListener('click', () => modal.remove());
    modal.querySelectorAll<HTMLButtonElement>('[data-version]').forEach((button) => button.addEventListener('click', async () => {
      const version = current.versions.find((item) => item.id === button.dataset.version);
      if (button.dataset.version === 'initial') {
        applyRules([]);
        await setActiveVersion(null);
        selected = null;
        inspector.hidden = true;
        status.textContent = '已恢复初始状态';
        modal.remove();
      } else if (version) {
        applyRules(version.rules);
        await setActiveVersion(version.id);
        selected = null;
        inspector.hidden = true;
        status.textContent = '已恢复';
        modal.remove();
      }
    }));
  }

  setEditing(false);
  setUiVisible(true);
}

function rgbToHex(value: string) {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return match ? `#${[match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}` : value;
}
function escapeAttr(value: string) { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
function escapeHtml(value: string) {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, (char) => entities[char]);
}
function setElementText(element: HTMLElement, value: string) {
  const original = element.textContent ?? '';
  if (!element.children.length) {
    element.textContent = value;
    return;
  }
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);
  if (!textNodes.length) { element.textContent = value; return; }
  let prefix = 0;
  while (prefix < original.length && prefix < value.length && original[prefix] === value[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < original.length - prefix && suffix < value.length - prefix && original[original.length - suffix - 1] === value[value.length - suffix - 1]) suffix += 1;
  const oldEnd = original.length - suffix;
  const replacement = value.slice(prefix, value.length - suffix);
  let offset = 0;
  let firstAffected = -1;
  let lastAffected = -1;
  textNodes.forEach((textNode, index) => {
    const start = offset;
    const end = offset + textNode.data.length;
    if (prefix === oldEnd ? prefix >= start && prefix <= end : end > prefix && start < oldEnd) {
      if (firstAffected < 0) firstAffected = index;
      lastAffected = index;
    }
    offset = end;
  });
  if (firstAffected < 0) {
    let position = 0;
    for (const textNode of textNodes) {
      if (prefix <= position + textNode.data.length) {
        const local = Math.max(0, prefix - position);
        textNode.data = textNode.data.slice(0, local) + replacement + textNode.data.slice(local);
        return;
      }
      position += textNode.data.length;
    }
    textNodes[textNodes.length - 1].data += replacement;
    return;
  }
  offset = 0;
  textNodes.forEach((textNode, index) => {
    if (index < firstAffected || index > lastAffected) { offset += textNode.data.length; return; }
    const start = offset;
    const keepBefore = Math.max(0, prefix - start);
    const keepAfter = Math.max(0, start + textNode.data.length - oldEnd);
    textNode.data = textNode.data.slice(0, keepBefore) + (index === firstAffected ? replacement : '') + (keepAfter ? textNode.data.slice(textNode.data.length - keepAfter) : '');
    offset = start + textNode.data.length;
  });
}
function cloneRules(rules: StyleRule[]): StyleRule[] {
  return rules.map((rule) => ({ ...rule, properties: { ...rule.properties } }));
}
