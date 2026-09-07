import cssText from './overlay.css?inline';
import { loadHistory, saveVersion, setActiveVersion } from '../storage/history';
import { EditableProperty, SavedVersion, StyleRule } from '../shared/types';

declare global {
  interface Window {
    __htmlTweakerLoaded?: boolean;
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<HtmlFileHandle>;
  }
}

interface HtmlFileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: string | Blob): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}

const PERSISTED_START = '<!-- HTML_VISUAL_TWEAKER:START -->';
const PERSISTED_END = '<!-- HTML_VISUAL_TWEAKER:END -->';
const PERSISTED_RULES_ID = 'html-tweaker-persisted-rules';
const EXTENSION_ACTIVE_ATTRIBUTE = 'data-html-tweaker-active';
document.documentElement?.setAttribute(EXTENSION_ACTIVE_ATTRIBUTE, '');
const prePaintGuard = installPrePaintGuard();

if (!window.__htmlTweakerLoaded) {
  window.__htmlTweakerLoaded = true;
  void init().catch((error) => {
    prePaintGuard?.remove();
    console.error('[HTML Visual Tweaker] initialization failed', error);
  });
} else {
  prePaintGuard?.remove();
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
    <div id="html-tweaker-toolbar"><strong>HTML 微调器</strong><button id="html-tweaker-edit">修改</button><button id="html-tweaker-undo" class="secondary html-tweaker-icon" hidden disabled aria-label="撤销" title="撤销（Ctrl+Z）">↶</button><button id="html-tweaker-redo" class="secondary html-tweaker-icon" hidden disabled aria-label="重做" title="重做（Ctrl+Shift+Z）">↷</button><button id="html-tweaker-save" hidden disabled>保存</button><button id="html-tweaker-export">导出副本</button><button id="html-tweaker-overwrite">覆盖原文件</button><button id="html-tweaker-cancel" class="secondary" hidden disabled>取消</button><button id="html-tweaker-more" class="secondary html-tweaker-icon" aria-label="更多操作" aria-expanded="false" title="更多操作">•••</button><div id="html-tweaker-more-menu" hidden><button id="html-tweaker-restore">恢复历史</button><button id="html-tweaker-exit">隐藏工具栏</button></div><span id="html-tweaker-status"></span></div>
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
  const undoButton = shadow.querySelector<HTMLButtonElement>('#html-tweaker-undo')!;
  const redoButton = shadow.querySelector<HTMLButtonElement>('#html-tweaker-redo')!;
  const saveButton = shadow.querySelector<HTMLButtonElement>('#html-tweaker-save')!;
  const exportButton = shadow.querySelector<HTMLButtonElement>('#html-tweaker-export')!;
  const overwriteButton = shadow.querySelector<HTMLButtonElement>('#html-tweaker-overwrite')!;
  const cancelButton = shadow.querySelector<HTMLButtonElement>('#html-tweaker-cancel')!;
  const moreButton = shadow.querySelector<HTMLButtonElement>('#html-tweaker-more')!;
  const moreMenu = shadow.querySelector<HTMLElement>('#html-tweaker-more-menu')!;
  const rules = new Map<string, StyleRule>();
  let selected: HTMLElement | null = null;
  let editing = false;
  let editingSnapshot: StyleRule[] = [];
  const undoStack: StyleRule[][] = [];
  const redoStack: StyleRule[][] = [];
  let lastUndoAction = '';
  let lastUndoAt = 0;
  let copiedStyles: Partial<Record<EditableProperty, string>> | null = null;
  const sessionBaselines = new Map<string, { properties: Partial<Record<EditableProperty, string>>; textContent: string }>();
  const appliedProperties = new Map<string, string[]>();
  const originalInline = new WeakMap<HTMLElement, Map<string, { value: string; priority: string }>>();
  const originalMarkup = new WeakMap<HTMLElement, string>();
  const originalImageAttributes = new WeakMap<HTMLImageElement, { src: string | null; srcset: string | null }>();
  const originalPictureSources = new WeakMap<HTMLImageElement, Array<{ element: HTMLSourceElement; src: string | null; srcset: string | null }>>();
  const touchedProperties = new Map<string, Set<string>>();
  let reapplyTimer: number | null = null;
  const exportFolder = defaultExportFolder();

  function queryPageElements(selector: string): HTMLElement[] {
    if (!document.body) return [];
    try { return [...document.body.querySelectorAll<HTMLElement>(selector)]; }
    catch { return []; }
  }

  const history = await loadHistory();
  const latest = history.activeVersionId === null
    ? undefined
    : history.versions.find((version) => version.id === history.activeVersionId) ?? history.versions[0];
  const initialRules = latest?.rules ?? readPersistedRules();
  if (initialRules.length) {
    await waitForRuleTargets(initialRules);
    applyRules(initialRules);
  }
  prePaintGuard?.remove();

  function applyRules(nextRules: StyleRule[], restorePreviousText = true) {
    const selectors = new Set([...appliedProperties.keys(), ...touchedProperties.keys(), ...rules.keys()]);
    selectors.forEach((selector) => {
      const properties = new Set([
        ...(appliedProperties.get(selector) ?? []),
        ...(touchedProperties.get(selector) ?? []),
        ...((rules.get(selector) && Object.keys(rules.get(selector)!.properties).map((key) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`))) ?? [])
      ]);
      queryPageElements(selector).forEach((el) => [...properties].forEach((property) => {
        const previous = originalInline.get(el)?.get(property);
        if (previous?.value) el.style.setProperty(property, previous.value, previous.priority);
        else el.style.removeProperty(property);
      }));
    });
    if (restorePreviousText) rules.forEach((rule) => queryPageElements(rule.selector).forEach((el) => {
      if (originalMarkup.has(el)) el.innerHTML = originalMarkup.get(el)!;
    }));
    rules.forEach((rule) => {
      if (rule.imageSource === undefined) return;
      queryPageElements(rule.selector).forEach((element) => {
        if (element instanceof HTMLImageElement) restoreImageSource(element);
      });
    });
    appliedProperties.clear();
    rules.clear();
    nextRules.forEach((rule) => {
      rules.set(rule.selector, rule);
      const properties = Object.keys(rule.properties).map((key) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
      appliedProperties.set(rule.selector, properties);
      queryPageElements(rule.selector).forEach((el) => {
        if (rule.textContent !== undefined) {
          if (!originalMarkup.has(el)) originalMarkup.set(el, el.innerHTML);
          if (el.textContent !== rule.textContent) setElementText(el, rule.textContent);
        }
        if (rule.imageSource !== undefined && el instanceof HTMLImageElement) {
          setImageSource(el, rule.imageSource);
        }
        Object.entries(rule.properties).forEach(([key, value]) => {
          if (value) setImportant(el, key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), value);
        });
      });
    });
    if (selected && restorePreviousText) refreshInspector();
  }

  function updateUndoButtons() {
    undoButton.disabled = !editing || undoStack.length === 0;
    redoButton.disabled = !editing || redoStack.length === 0;
  }

  function recordUndo(action: string, coalesce = false) {
    const now = Date.now();
    if (!coalesce || action !== lastUndoAction || now - lastUndoAt > 500) {
      undoStack.push(cloneRules([...rules.values()]));
      if (undoStack.length > 60) undoStack.shift();
      redoStack.length = 0;
    }
    lastUndoAction = action;
    lastUndoAt = now;
    updateUndoButtons();
  }

  function undo() {
    const previous = undoStack.pop();
    if (!editing || !previous) return;
    redoStack.push(cloneRules([...rules.values()]));
    applyRules(previous);
    lastUndoAction = '';
    status.textContent = '已撤销';
    updateUndoButtons();
  }

  function redo() {
    const next = redoStack.pop();
    if (!editing || !next) return;
    undoStack.push(cloneRules([...rules.values()]));
    applyRules(next);
    lastUndoAction = '';
    status.textContent = '已重做';
    updateUndoButtons();
  }

  function pruneRule(selector: string) {
    const rule = rules.get(selector);
    if (rule && !Object.keys(rule.properties).length && rule.textContent === undefined && rule.imageSource === undefined) {
      rules.delete(selector);
    }
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
    const selector = selectorFor(el);
    if (!sessionBaselines.has(selector)) {
      const computed = getComputedStyle(el);
      const properties: Partial<Record<EditableProperty, string>> = {};
      const visibleProperties: EditableProperty[] = ['width', 'height', 'fontSize', 'color', 'fontFamily', 'margin', 'borderRadius', 'transform'];
      visibleProperties.forEach((key) => {
        properties[key] = computed.getPropertyValue(key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`));
      });
      sessionBaselines.set(selector, {
        properties,
        textContent: el.textContent ?? ''
      });
    }
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

  function ruleBeforeEditing(selector: string): StyleRule | undefined {
    return editingSnapshot.find((rule) => rule.selector === selector);
  }

  function propertyChangedThisSession(selector: string, key: EditableProperty): boolean {
    const baseline = sessionBaselines.get(selector);
    if (baseline && selected && selectorFor(selected) === selector) {
      const cssKey = key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
      return getComputedStyle(selected).getPropertyValue(cssKey) !== baseline.properties[key];
    }
    const current = rules.get(selector)?.properties;
    const before = ruleBeforeEditing(selector)?.properties;
    const keys: EditableProperty[] = key === 'width' ? ['width', 'maxWidth', 'flex'] : [key];
    return keys.some((property) => current?.[property] !== before?.[property]);
  }

  function textChangedThisSession(selector: string): boolean {
    const baseline = sessionBaselines.get(selector);
    if (baseline && selected && selectorFor(selected) === selector) return (selected.textContent ?? '') !== baseline.textContent;
    return rules.get(selector)?.textContent !== ruleBeforeEditing(selector)?.textContent;
  }

  function imageChangedThisSession(selector: string): boolean {
    return rules.get(selector)?.imageSource !== ruleBeforeEditing(selector)?.imageSource;
  }

  function refreshInspector() {
    if (!selected) return;
    const rule = currentRule();
    const selector = selectorFor(selected);
    targetLabel.innerHTML = `<div>${selected.tagName.toLowerCase()}${selected.id ? `#${selected.id}` : ''}<small class="html-tweaker-scope">样式作用于整个元素</small></div><div class="html-tweaker-selection-actions"><button data-copy-styles title="复制样式（Ctrl+Shift+C）">复制</button><button data-paste-styles title="粘贴样式（Ctrl+Shift+V）" ${copiedStyles ? '' : 'disabled'}>粘贴</button></div>`;
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
    const textEditor = selected instanceof HTMLImageElement ? '' : `<div class="html-tweaker-field-row html-tweaker-copy-row"><label class="html-tweaker-copy-label">文案<textarea data-text-content>${escapeHtml(selected.textContent ?? '')}</textarea></label><button class="html-tweaker-reset" data-reset-text aria-label="恢复本次修改前的文案" title="恢复本次修改前的文案" ${textChangedThisSession(selector) ? '' : 'disabled'}>↺</button></div>`;
    const imageEditor = selected instanceof HTMLImageElement
      ? `<div class="html-tweaker-image-field"><span>图片</span><div class="html-tweaker-image-actions"><button type="button" class="html-tweaker-image-button" data-choose-image>选择替换</button><input data-image-source type="file" accept="image/*" hidden><button class="html-tweaker-reset" data-reset-image aria-label="恢复本次修改前的图片" title="恢复本次修改前的图片" ${imageChangedThisSession(selector) ? '' : 'disabled'}>↺</button></div><small>支持 PNG、JPG、WebP、GIF、SVG 等浏览器可显示的图片</small></div>`
      : '';
    fields.innerHTML = imageEditor + textEditor + fieldsConfig.map((field) => field.type === 'select'
      ? `<div class="html-tweaker-field-row"><label>${field.label}<select data-style="${field.key}">${field.options!.map((option) => `<option ${option === field.value ? 'selected' : ''}>${option}</option>`).join('')}</select></label><button class="html-tweaker-reset" data-reset-style="${field.key}" aria-label="恢复本次修改前的${field.label}" title="恢复本次修改前的${field.label}" ${propertyChangedThisSession(selector, field.key) ? '' : 'disabled'}>↺</button></div>`
      : `<div class="html-tweaker-field-row"><label>${field.label}<input data-style="${field.key}" type="${field.type}" value="${escapeAttr(field.value)}"></label><button class="html-tweaker-reset" data-reset-style="${field.key}" aria-label="恢复本次修改前的${field.label}" title="恢复本次修改前的${field.label}" ${propertyChangedThisSession(selector, field.key) ? '' : 'disabled'}>↺</button></div>`).join('');
    targetLabel.querySelector<HTMLButtonElement>('[data-copy-styles]')?.addEventListener('click', copySelectedStyles);
    targetLabel.querySelector<HTMLButtonElement>('[data-paste-styles]')?.addEventListener('click', pasteSelectedStyles);
    fields.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-style]').forEach((input) => {
      input.addEventListener('input', () => {
        updateProperty(input.dataset.style as EditableProperty, input.value);
        const reset = input.closest('.html-tweaker-field-row')?.querySelector<HTMLButtonElement>('[data-reset-style]');
        if (reset) reset.disabled = !propertyChangedThisSession(selectorFor(selected!), input.dataset.style as EditableProperty);
      });
    });
    fields.querySelectorAll<HTMLButtonElement>('[data-reset-style]').forEach((button) => button.addEventListener('click', () => {
      resetProperty(button.dataset.resetStyle as EditableProperty);
    }));
    fields.querySelector<HTMLButtonElement>('[data-reset-text]')?.addEventListener('click', resetText);
    fields.querySelector<HTMLButtonElement>('[data-reset-image]')?.addEventListener('click', resetImage);
    const imageInput = fields.querySelector<HTMLInputElement>('[data-image-source]');
    fields.querySelector<HTMLButtonElement>('[data-choose-image]')?.addEventListener('click', () => imageInput?.click());
    fields.querySelector<HTMLTextAreaElement>('[data-text-content]')?.addEventListener('input', (event) => {
      if (!selected) return;
      const value = (event.target as HTMLTextAreaElement).value;
      const selector = selectorFor(selected);
      recordUndo(`text:${selector}`, true);
      const rule = rules.get(selector) ?? { selector, fingerprint: fingerprint(selected), properties: {} };
      rule.textContent = value;
      rules.set(selector, rule);
      if (!originalMarkup.has(selected)) originalMarkup.set(selected, selected.innerHTML);
      setElementText(selected, value);
      const reset = fields.querySelector<HTMLButtonElement>('[data-reset-text]');
      if (reset) reset.disabled = !textChangedThisSession(selector);
      updateHighlight();
    });
    imageInput?.addEventListener('change', async (event) => {
      const image = selected;
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (!(image instanceof HTMLImageElement) || !file) return;
      if (file.type && !file.type.startsWith('image/')) {
        status.textContent = '请选择图片文件';
        input.value = '';
        return;
      }
      try {
        status.textContent = '正在读取图片…';
        const source = await fileToDataUrl(file);
        const selector = selectorFor(image);
        recordUndo(`image:${selector}`);
        const rule = rules.get(selector) ?? { selector, fingerprint: fingerprint(image), properties: {} };
        rule.imageSource = source;
        rules.set(selector, rule);
        setImageSource(image, source);
        image.addEventListener('load', () => {
          status.textContent = `已替换：${file.name}`;
          updateHighlight();
        }, { once: true });
        image.addEventListener('error', () => {
          status.textContent = '图片格式无法显示，请换一张图片';
        }, { once: true });
        status.textContent = `已替换：${file.name}`;
        refreshInspector();
        updateHighlight();
      } catch {
        status.textContent = '图片读取失败，请重试';
      }
    });
  }

  function updateProperty(key: EditableProperty, value: string, shouldRecord = true) {
    if (!selected || !value) return;
    const selector = selectorFor(selected);
    if (shouldRecord) recordUndo(`style:${selector}:${key}`, true);
    const rule = rules.get(selector) ?? { selector, fingerprint: fingerprint(selected), properties: {} };
    rule.properties[key] = value;
    rules.set(selector, rule);
    const cssKey = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    setImportant(selected, cssKey, value);
    updateHighlight();
  }

  function restoreRuleProperty(rule: StyleRule, before: StyleRule | undefined, key: EditableProperty) {
    const value = before?.properties[key];
    if (value === undefined) delete rule.properties[key];
    else rule.properties[key] = value;
  }

  function resetProperty(key: EditableProperty) {
    if (!selected) return;
    const selector = selectorFor(selected);
    if (!propertyChangedThisSession(selector, key)) return;
    recordUndo(`reset:${selector}:${key}`);
    const before = ruleBeforeEditing(selector);
    const rule = rules.get(selector) ?? { selector, fingerprint: fingerprint(selected), properties: {} };
    const related: EditableProperty[] = key === 'width' ? ['width', 'maxWidth', 'flex'] : [key];
    related.forEach((property) => restoreRuleProperty(rule, before, property));
    if ((key === 'width' || key === 'height')
      && rule.properties.width === before?.properties.width
      && rule.properties.height === before?.properties.height) {
      restoreRuleProperty(rule, before, 'display');
    }
    rules.set(selector, rule);
    pruneRule(selector);
    applyRules(cloneRules([...rules.values()]));
    status.textContent = '已恢复到本次修改前';
  }

  function resetText() {
    if (!selected) return;
    const selector = selectorFor(selected);
    if (!textChangedThisSession(selector)) return;
    recordUndo(`reset-text:${selector}`);
    const before = ruleBeforeEditing(selector);
    const rule = rules.get(selector) ?? { selector, fingerprint: fingerprint(selected), properties: {} };
    if (before?.textContent === undefined) delete rule.textContent;
    else rule.textContent = before.textContent;
    rules.set(selector, rule);
    pruneRule(selector);
    applyRules(cloneRules([...rules.values()]));
    status.textContent = '已恢复到本次修改前';
  }

  function resetImage() {
    if (!(selected instanceof HTMLImageElement)) return;
    const selector = selectorFor(selected);
    if (!imageChangedThisSession(selector)) return;
    recordUndo(`reset-image:${selector}`);
    const before = ruleBeforeEditing(selector);
    const rule = rules.get(selector) ?? { selector, fingerprint: fingerprint(selected), properties: {} };
    if (before?.imageSource === undefined) delete rule.imageSource;
    else rule.imageSource = before.imageSource;
    rules.set(selector, rule);
    pruneRule(selector);
    applyRules(cloneRules([...rules.values()]));
    status.textContent = '已恢复到本次修改前';
  }

  function copySelectedStyles() {
    if (!selected) return;
    const rule = currentRule();
    const computed = getComputedStyle(selected);
    const copyable: EditableProperty[] = ['width', 'height', 'fontSize', 'color', 'fontFamily', 'margin', 'borderRadius'];
    copiedStyles = {};
    copyable.forEach((key) => {
      const cssKey = key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
      copiedStyles![key] = rule?.properties[key] ?? computed.getPropertyValue(cssKey);
    });
    status.textContent = '已复制样式';
    refreshInspector();
  }

  function pasteSelectedStyles() {
    if (!selected || !copiedStyles) return;
    const selector = selectorFor(selected);
    recordUndo(`paste:${selector}`);
    const rule = rules.get(selector) ?? { selector, fingerprint: fingerprint(selected), properties: {} };
    Object.entries(copiedStyles).forEach(([key, value]) => {
      if (!value) return;
      const typedKey = key as EditableProperty;
      rule.properties[typedKey] = value;
      queryPageElements(selector).forEach((element) => {
        setImportant(element, typedKey.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`), value);
      });
    });
    rules.set(selector, rule);
    status.textContent = '已粘贴样式';
    refreshInspector();
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

  function setImageSource(image: HTMLImageElement, source: string) {
    if (!originalImageAttributes.has(image)) {
      originalImageAttributes.set(image, { src: image.getAttribute('src'), srcset: image.getAttribute('srcset') });
    }
    if (!originalPictureSources.has(image)) {
      const picture = image.closest('picture');
      originalPictureSources.set(image, picture
        ? [...picture.querySelectorAll<HTMLSourceElement>('source')].map((element) => ({ element, src: element.getAttribute('src'), srcset: element.getAttribute('srcset') }))
        : []);
    }
    originalPictureSources.get(image)?.forEach(({ element }) => {
      element.removeAttribute('src');
      element.removeAttribute('srcset');
    });
    image.setAttribute('src', source);
    image.removeAttribute('srcset');
  }

  function restoreImageSource(image: HTMLImageElement) {
    const original = originalImageAttributes.get(image);
    if (!original) return;
    if (original.src === null) image.removeAttribute('src');
    else image.setAttribute('src', original.src);
    if (original.srcset === null) image.removeAttribute('srcset');
    else image.setAttribute('srcset', original.srcset);
    originalPictureSources.get(image)?.forEach(({ element, src, srcset }) => {
      if (src === null) element.removeAttribute('src');
      else element.setAttribute('src', src);
      if (srcset === null) element.removeAttribute('srcset');
      else element.setAttribute('srcset', srcset);
    });
  }

  function setUiVisible(visible: boolean) {
    root.style.display = visible ? '' : 'none';
  }

  function setEditing(value: boolean) {
    if (value && !editing) {
      readPersistedRules().forEach((rule) => { if (!rules.has(rule.selector)) rules.set(rule.selector, rule); });
      editingSnapshot = cloneRules([...rules.values()]);
      undoStack.length = 0;
      redoStack.length = 0;
      lastUndoAction = '';
      sessionBaselines.clear();
    }
    editing = value;
    document.documentElement.classList.toggle('html-tweaker-editing', value);
    setUiVisible(true);
    editButton.hidden = value;
    undoButton.hidden = !value;
    redoButton.hidden = !value;
    saveButton.hidden = !value;
    cancelButton.hidden = !value;
    exportButton.hidden = value;
    overwriteButton.hidden = value;
    saveButton.disabled = !value;
    cancelButton.disabled = !value;
    moreMenu.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
    if (!value) { selected = null; inspector.hidden = true; }
    updateUndoButtons();
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

  document.addEventListener('keydown', (event) => {
    if (!editing) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      event.stopPropagation();
      redo();
      return;
    }
    if (modifier && event.shiftKey && event.key.toLowerCase() === 'c' && selected) {
      event.preventDefault();
      copySelectedStyles();
      return;
    }
    if (modifier && event.shiftKey && event.key.toLowerCase() === 'v' && selected) {
      event.preventDefault();
      pasteSelectedStyles();
      return;
    }
    const target = event.target as HTMLElement;
    if (!selected || root.contains(target) || target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    if (event.altKey) resizeSelectedWithKeyboard(event.key, step);
    else moveSelectedWithKeyboard(event.key, step);
  }, true);

  function moveSelectedWithKeyboard(key: string, step: number) {
    if (!selected) return;
    const selector = selectorFor(selected);
    recordUndo(`keyboard-move:${selector}`, true);
    const current = rules.get(selector)?.properties.transform ?? selected.style.transform ?? '';
    const normalized = current === 'none' ? '' : current.trim();
    const suffix = /(?:^|\s)translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)\s*$/i.exec(normalized);
    let x = suffix ? Number(suffix[1]) : 0;
    let y = suffix ? Number(suffix[2]) : 0;
    if (key === 'ArrowLeft') x -= step;
    if (key === 'ArrowRight') x += step;
    if (key === 'ArrowUp') y -= step;
    if (key === 'ArrowDown') y += step;
    const base = suffix ? normalized.slice(0, suffix.index).trim() : normalized;
    const translation = `translate(${x}px, ${y}px)`;
    updateProperty('transform', base ? `${base} ${translation}` : translation, false);
    status.textContent = `位置：${x}px, ${y}px`;
    refreshInspector();
  }

  function resizeSelectedWithKeyboard(key: string, step: number) {
    if (!selected) return;
    const selector = selectorFor(selected);
    recordUndo(`keyboard-size:${selector}`, true);
    const rect = selected.getBoundingClientRect();
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      updateProperty('maxWidth', 'none', false);
      updateProperty('flex', 'none', false);
      updateProperty('width', `${Math.max(20, Math.round(rect.width + (key === 'ArrowRight' ? step : -step)))}px`, false);
    } else {
      updateProperty('height', `${Math.max(20, Math.round(rect.height + (key === 'ArrowDown' ? step : -step)))}px`, false);
    }
    status.textContent = `尺寸：${Math.round(selected.getBoundingClientRect().width)} × ${Math.round(selected.getBoundingClientRect().height)}px`;
    refreshInspector();
  }

  let drag: { x: number; y: number; rect: DOMRect; baseTransform: string; pointerId: number; snapTargets: { x: number[]; y: number[] }; frame: number | null; latestX: number; latestY: number; recorded: boolean } | null = null;
  document.addEventListener('pointerdown', (event) => {
    if (!editing || !selected || event.button !== 0 || event.target !== selected) return;
    const selector = selectorFor(selected);
    const baseTransform = rules.get(selector)?.properties.transform ?? selected.style.transform ?? '';
    drag = { x: event.clientX, y: event.clientY, rect: selected.getBoundingClientRect(), baseTransform: baseTransform === 'none' ? '' : baseTransform, pointerId: event.pointerId, snapTargets: collectSnapTargets(), frame: null, latestX: event.clientX, latestY: event.clientY, recorded: false };
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
      if (!drag.recorded) {
        recordUndo(`drag:${selectorFor(selected)}`);
        drag.recorded = true;
      }
      const snapped = snapPosition(drag.rect, drag.latestX - drag.x, drag.latestY - drag.y, drag.snapTargets);
      const translation = 'translate(' + Math.round(snapped.x) + 'px, ' + Math.round(snapped.y) + 'px)';
      updateProperty('transform', drag.baseTransform ? drag.baseTransform + ' ' + translation : translation, false);
      updateGuides(snapped.guides);
    });
  }, true);
  document.addEventListener('pointerup', () => {
    const changed = Boolean(drag?.recorded || resize?.recorded);
    if (drag && selected) selected.releasePointerCapture?.(drag.pointerId);
    if (drag?.frame !== null && drag?.frame !== undefined) cancelAnimationFrame(drag.frame);
    drag = null; resize = null; clearGuides();
    if (changed && selected) refreshInspector();
  }, true);

  let resize: { x: number; y: number; width: number; height: number; corner: string; baseTransform: string; recorded: boolean } | null = null;
  function beginResize(event: PointerEvent, handle: HTMLElement) {
    if (!editing || !selected || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = selected.getBoundingClientRect();
    const selector = selectorFor(selected);
    const baseTransform = rules.get(selector)?.properties.transform ?? selected.style.transform ?? '';
    resize = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, corner: handle.className, baseTransform: baseTransform === 'none' ? '' : baseTransform, recorded: false };
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
    if (!resize.recorded) {
      recordUndo(`resize:${selectorFor(selected)}`);
      resize.recorded = true;
    }
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
    updateProperty('maxWidth', 'none', false);
    updateProperty('flex', 'none', false);
    updateProperty('width', `${Math.max(20, Math.round(resize.width + (isWest ? -dx : dx)))}px`, false);
    updateProperty('height', `${Math.max(20, Math.round(resize.height + (isNorth ? -dy : dy)))}px`, false);
    if (isWest || isNorth) {
      const translation = `translate(${isWest ? Math.round(dx) : 0}px, ${isNorth ? Math.round(dy) : 0}px)`;
      updateProperty('transform', resize.baseTransform ? `${resize.baseTransform} ${translation}` : translation, false);
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
      if (rule.imageSource !== undefined && element instanceof HTMLImageElement && element.getAttribute('src') !== rule.imageSource) return true;
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
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'src', 'srcset'] });
  window.setTimeout(() => { if (rules.size) scheduleRuleReapply(); }, 500);

  editButton.addEventListener('click', () => setEditing(true));
  undoButton.addEventListener('click', undo);
  redoButton.addEventListener('click', redo);
  moreButton.addEventListener('click', () => {
    moreMenu.hidden = !moreMenu.hidden;
    moreButton.setAttribute('aria-expanded', String(!moreMenu.hidden));
  });
  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target as Node)) {
      moreMenu.hidden = true;
      moreButton.setAttribute('aria-expanded', 'false');
    }
  }, true);
  saveButton.addEventListener('click', async () => {
    if (!editing) return;
    try {
      status.textContent = '正在保存…';
      const nextRules = [...rules.values()];
      const version = await saveVersion(nextRules, document.title || location.hostname);
      status.textContent = `已保存 ${new Date(version.createdAt).toLocaleTimeString()}`;
      setEditing(false);
      setTimeout(() => { status.textContent = ''; }, 2500);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '保存失败';
      console.error('[HTML Visual Tweaker] unable to save changes', error);
    }
  });
  exportButton.addEventListener('click', async () => {
    try {
      exportButton.disabled = true;
      status.textContent = '正在导出页面和本地资源…';
      const result = await exportRulesAsPackage(collectOutputRules(), exportFolder);
      status.textContent = result.warningCount
        ? `已导出副本：下载/${exportFolder}（入口 ${result.filename}，${result.warningCount} 个资源未能复制）`
        : `已导出副本：下载/${exportFolder}（${result.fileCount} 个文件，入口 ${result.filename}）`;
      setTimeout(() => { status.textContent = ''; }, 3500);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '导出失败';
      console.error('[HTML Visual Tweaker] unable to export page', error);
    } finally {
      exportButton.disabled = false;
    }
  });
  overwriteButton.addEventListener('click', () => {
    overwriteButton.disabled = true;
    // The system picker must be opened synchronously from this click event.
    void overwriteOriginalHtml(collectOutputRules()).then(() => {
      setTimeout(() => { status.textContent = ''; }, 3500);
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') {
        status.textContent = '已取消覆盖';
        return;
      }
      status.textContent = error instanceof Error ? error.message : '覆盖失败';
      console.error('[HTML Visual Tweaker] unable to overwrite source HTML', error);
    }).finally(() => {
      overwriteButton.disabled = false;
    });
  });
  cancelButton.addEventListener('click', () => {
    if (!editing) return;
    applyRules(editingSnapshot);
    status.textContent = '已取消本次修改';
    setEditing(false);
  });
  shadow.querySelector('#html-tweaker-restore')!.addEventListener('click', () => {
    moreMenu.hidden = true;
    openRestoreModal();
  });
  shadow.querySelector('#html-tweaker-exit')!.addEventListener('click', () => {
    moreMenu.hidden = true;
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

  function collectOutputRules(): StyleRule[] {
    return cloneRules([...rules.values()]);
  }

  async function overwriteOriginalHtml(outputRules: StyleRule[]): Promise<void> {
    if (typeof window.showSaveFilePicker !== 'function') {
      throw new Error('当前浏览器不支持覆盖本地文件，请使用“导出副本”');
    }
    const filename = sourceFilename();
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: 'HTML 文件', accept: { 'text/html': ['.html', '.htm'] } }]
    });
    status.textContent = '正在校验源文件…';
    const [source, selectedFile] = await Promise.all([readCurrentPageSource(), handle.getFile()]);
    if (handle.name.toLocaleLowerCase() !== filename.toLocaleLowerCase()) {
      throw new Error(`请选择当前页面的源文件 ${filename}，已停止覆盖`);
    }
    if (await selectedFile.text() !== source) {
      throw new Error('所选文件与当前打开的源 HTML 内容不一致，已停止覆盖');
    }
    const updated = updatePersistedBlock(source, outputRules);
    const writable = await handle.createWritable();
    try {
      status.textContent = '正在覆盖原文件…';
      await writable.write(new Blob([updated], { type: 'text/html;charset=utf-8' }));
      await writable.close();
    } catch (error) {
      await writable.abort?.().catch(() => undefined);
      throw error;
    }
    status.textContent = `已覆盖原文件：${filename}`;
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
      const nextRules = button.dataset.version === 'initial' ? [] : version?.rules;
      if (!nextRules) return;
      applyRules(nextRules);
      await setActiveVersion(version?.id ?? null);
      status.textContent = button.dataset.version === 'initial' ? '已恢复初始状态' : '已恢复';
      setEditing(false);
      modal.remove();
    }));
  }

  function readPersistedRules(): StyleRule[] {
    const node = document.getElementById(PERSISTED_RULES_ID);
    if (!node?.textContent) return [];
    try {
      const stored = JSON.parse(node.textContent);
      return Array.isArray(stored) ? stored as StyleRule[] : [];
    } catch {
      return [];
    }
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

function installPrePaintGuard(): HTMLStyleElement | null {
  if (document.readyState !== 'loading' || !document.documentElement) return null;
  const guard = document.createElement('style');
  guard.id = 'html-tweaker-prepaint';
  guard.textContent = 'html{visibility:hidden!important}';
  document.documentElement.appendChild(guard);
  return guard;
}

function waitForRuleTargets(rules: StyleRule[]): Promise<void> {
  const targetsExist = () => rules.every((rule) => {
    try { return Boolean(document.body?.querySelector(rule.selector)); }
    catch { return true; }
  });
  if (document.readyState !== 'loading' || targetsExist()) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (targetsExist()) finish();
    });
    const finish = () => {
      observer.disconnect();
      document.removeEventListener('DOMContentLoaded', finish);
      resolve();
    };
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', finish, { once: true });
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Invalid image data')));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Unable to read image')));
    reader.readAsDataURL(file);
  });
}

async function exportRulesAsPackage(rules: StyleRule[], exportFolder: string): Promise<{ filename: string; fileCount: number; warningCount: number }> {
  const source = await readCurrentPageSource();
  const prepared = prepareExportSource(source);
  const updated = updatePersistedBlock(prepared.source, rules);
  const filename = sourceFilename();
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    const result = await chrome.runtime.sendMessage({
      type: 'export-package',
      content: updated,
      filename,
      exportFolder,
      assetRootUrl: prepared.assetRootUrl
    }) as { ok?: boolean; fileCount?: number; warningCount?: number; error?: string } | undefined;
    if (!result?.ok) throw new Error(result?.error ?? '浏览器导出失败');
    return { filename, fileCount: result.fileCount ?? 1, warningCount: result.warningCount ?? 0 };
  } else {
    const url = URL.createObjectURL(new Blob([updated], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { filename, fileCount: 1, warningCount: 0 };
  }
}

async function readCurrentPageSource(): Promise<string> {
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    const result = await chrome.runtime.sendMessage({ type: 'read-page-source' }) as { ok?: boolean; source?: string; error?: string } | undefined;
    if (!result?.ok || typeof result.source !== 'string') throw new Error(result?.error ?? '无法读取当前 HTML 源码');
    return result.source;
  }
  const response = await fetch(location.href);
  if (!response.ok) throw new Error(`无法读取当前 HTML 源码：${response.status}`);
  return response.text();
}

function sourceFilename(): string {
  return decodeURIComponent(new URL(location.href).pathname.split('/').pop() || 'index.html');
}

function prepareExportSource(source: string): { source: string; assetRootUrl: string } {
  let assetRootUrl = new URL('.', location.href).href;
  const absoluteFileBase = /<base\b[^>]*\bhref\s*=\s*(["'])(file:\/\/[^"']+)\1[^>]*>/i;
  const match = source.match(absoluteFileBase);
  if (match) {
    try { assetRootUrl = new URL(match[2]).href; }
    catch { /* Keep the page directory as the resource root. */ }
    source = source.replace(absoluteFileBase, '');
  }
  return { source, assetRootUrl };
}

function defaultExportFolder(): string {
  const parts = decodeURIComponent(new URL(location.href).pathname).split('/').filter(Boolean);
  const parent = parts.length > 1 ? parts[parts.length - 2] : 'html-export';
  return `HTML Tweaker Exports/${sanitizePathSegment(parent)}`;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  return sanitized || 'html-export';
}

function updatePersistedBlock(source: string, rules: StyleRule[]): string {
  const markerPattern = /\s*<!-- HTML_VISUAL_TWEAKER:START -->[\s\S]*?<!-- HTML_VISUAL_TWEAKER:END -->\s*/g;
  const withoutPrevious = source.replace(markerPattern, '\n');
  if (!rules.length) return withoutPrevious;
  const block = buildPersistedBlock(rules);
  if (/<\/head\s*>/i.test(withoutPrevious)) {
    return withoutPrevious.replace(/<\/head\s*>/i, `${block}\n</head>`);
  }
  return `${block}\n${withoutPrevious}`;
}

function buildPersistedBlock(rules: StyleRule[]): string {
  const css = buildPersistedCss(rules);
  const json = serializePersistedRules(rules);
  const runtime = `(()=>{const active=()=>!document.documentElement.hasAttribute('${EXTENSION_ACTIVE_ATTRIBUTE}'),n=document.getElementById('${PERSISTED_RULES_ID}');if(!n||!active())return;let r=[];const u=()=>{try{r=JSON.parse(n.textContent||'[]')}catch{r=[]}};const t=(e,v)=>{if(!e.children.length){e.textContent=v;return}const a=[],w=e.ownerDocument.createTreeWalker(e,NodeFilter.SHOW_TEXT);let x;while(x=w.nextNode())a.push(x);if(!a.length){e.textContent=v;return}const o=e.textContent||'';let p=0;while(p<o.length&&p<v.length&&o[p]===v[p])p++;let s=0;while(s<o.length-p&&s<v.length-p&&o[o.length-s-1]===v[v.length-s-1])s++;const z=o.length-s,c=v.slice(p,v.length-s);let d=0,f=-1,l=-1;a.forEach((q,i)=>{const b=d,h=d+q.data.length;if((p===z?p>=b&&p<=h:h>p&&b<z)){if(f<0)f=i;l=i}d=h});if(f<0){d=0;for(const q of a){if(p<=d+q.data.length){const i=Math.max(0,p-d);q.data=q.data.slice(0,i)+c+q.data.slice(i);return}d+=q.data.length}a[a.length-1].data+=c;return}d=0;a.forEach((q,i)=>{if(i<f||i>l){d+=q.data.length;return}const b=d,h=Math.max(0,p-b),m=Math.max(0,b+q.data.length-z);q.data=q.data.slice(0,h)+(i===f?c:'')+(m?q.data.slice(q.data.length-m):'');d=b+q.data.length})};const a=()=>{if(!active())return;u();r.forEach(q=>{let e=[];try{e=document.querySelectorAll(q.selector)}catch{return}e.forEach(v=>{if(q.textContent!==undefined&&v.textContent!==q.textContent)t(v,q.textContent);if(q.imageSource!==undefined&&v instanceof HTMLImageElement){if(v.getAttribute('src')!==q.imageSource)v.setAttribute('src',q.imageSource);v.removeAttribute('srcset');const g=v.closest('picture');if(g)g.querySelectorAll('source').forEach(s=>{s.removeAttribute('src');s.removeAttribute('srcset')})}})})};new MutationObserver(a).observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['src','srcset']});a();document.addEventListener('DOMContentLoaded',a,{once:true})})();`;
  return `${PERSISTED_START}\n<style id="html-tweaker-persisted-styles">\n${css}\n</style>\n<script type="application/json" id="${PERSISTED_RULES_ID}">${json}</script>\n<script id="html-tweaker-persisted-runtime">${runtime}</script>\n${PERSISTED_END}`;
}

function buildPersistedCss(rules: StyleRule[]): string {
  return rules.flatMap((rule) => {
    const declarations = Object.entries(rule.properties)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([key, value]) => `  ${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}: ${value.replace(/<\/style/gi, '<\\/style')} !important;`);
    return declarations.length ? [`${rule.selector} {\n${declarations.join('\n')}\n}`] : [];
  }).join('\n');
}

function serializePersistedRules(rules: StyleRule[]): string {
  return JSON.stringify(rules)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
