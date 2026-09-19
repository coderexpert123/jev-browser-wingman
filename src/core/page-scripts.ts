import type { Fingerprint } from '../contract/types.js';

/**
 * Every `build*Expression` function below returns a self-contained JavaScript
 * expression string, evaluated by an adapter inside an isolated world
 * (`Page.createIsolatedWorld`, world name `wingman`; see § 3.5). Each backing
 * function is stringified via `Function.prototype.toString()` and therefore
 * must reference nothing outside its own body: no module-level helpers, no
 * closures, no imports. Any shared logic between two of these functions is
 * duplicated inline for that reason.
 */

export function buildEnumerateExpression(opts: { maxElements: number; maxTextChars: number }): string {
  return `(${enumerate.toString()})(${JSON.stringify(opts)})`;
}

function enumerate(opts: { maxElements: number; maxTextChars: number }): unknown {
  var MAX_ENUMERATED = 1000;
  var OTP_TEXT_RE = /\b(one[- ]time (pass)?code|verification code|security code|otp|2-step|two-factor)\b/i;
  var CAPTCHA_RE = /recaptcha|hcaptcha|turnstile|captcha|challenges\.cloudflare\.com/i;
  var ROLE_VALUES = [
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton',
  ];

  function clip(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) : s;
  }
  function collapse(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }
  function isAriaHiddenAncestor(el: Element): boolean {
    var node: Element | null = el.parentElement;
    while (node) {
      if (node.getAttribute('aria-hidden') === 'true') return true;
      node = node.parentElement;
    }
    return false;
  }
  function isVisible(el: Element): boolean {
    var anyEl = el as unknown as { checkVisibility?: (opts: unknown) => boolean };
    if (typeof anyEl.checkVisibility === 'function') {
      if (!anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    }
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (isAriaHiddenAncestor(el)) return false;
    return true;
  }
  function implicitRole(el: Element): string {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'summary') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') {
      var selEl = el as HTMLSelectElement;
      var multiple = !!selEl.multiple;
      var size = selEl.size || 0;
      return !multiple && size <= 1 ? 'combobox' : 'listbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    if (el.hasAttribute('onclick')) return 'button';
    return '';
  }
  function roleOf(el: Element): string {
    var explicit = el.getAttribute('role');
    return explicit || implicitRole(el);
  }
  function labelForOf(id: string): HTMLElement | null {
    if (!id) return null;
    return document.querySelector('label[for="' + CSS.escape(id) + '"]');
  }
  function wrappingLabel(el: Element): HTMLElement | null {
    var node: Element | null = el.parentElement;
    while (node) {
      if (node.tagName === 'LABEL') return node as HTMLElement;
      node = node.parentElement;
    }
    return null;
  }
  function accessibleName(el: Element): string {
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var parts = labelledBy
        .split(/\s+/)
        .map(function (id) {
          var target = document.getElementById(id);
          return target ? collapse(target.textContent || '') : '';
        })
        .filter(Boolean);
      if (parts.length) return clip(collapse(parts.join(' ')), 80);
    }
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return clip(collapse(ariaLabel), 80);
    var byFor = el.id ? labelForOf(el.id) : null;
    if (byFor) return clip(collapse(byFor.textContent || ''), 80);
    var wrap = wrappingLabel(el);
    if (wrap) return clip(collapse(wrap.textContent || ''), 80);
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) return clip(collapse(placeholder), 80);
    var title = el.getAttribute('title');
    if (title) return clip(collapse(title), 80);
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) {
      var val = el.getAttribute('value');
      if (val) return clip(collapse(val), 80);
    }
    var isTextValueTag = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (!isTextValueTag && !(el as HTMLElement).isContentEditable) {
      return clip(collapse(el.textContent || ''), 80);
    }
    return '';
  }
  function hasUniqueId(node: Element): boolean {
    return !!node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1;
  }
  function nthOfType(node: Element): number {
    var i = 1;
    var sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName === node.tagName) i++;
      sib = sib.previousElementSibling;
    }
    return i;
  }
  function pathFor(el: Element): string {
    if (hasUniqueId(el)) return '#' + CSS.escape(el.id);
    var chain: string[] = [];
    var node: Element = el;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (node.tagName === 'HTML') {
        return 'html > ' + chain.join(' > ');
      }
      if (node !== el && hasUniqueId(node)) {
        return '#' + CSS.escape(node.id) + ' > ' + chain.join(' > ');
      }
      chain.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + nthOfType(node) + ')');
      var parent: Element | null = node.parentElement;
      if (!parent) return chain.join(' > ');
      node = parent;
    }
  }
  function rectOf(el: Element) {
    var r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }
  function isCandidateTag(el: Element): boolean {
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href');
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
    if (tag === 'input') return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
    return false;
  }
  function isCandidate(el: Element): boolean {
    if (isCandidateTag(el)) return true;
    var ce = el.getAttribute('contenteditable');
    if (ce === '' || ce === 'true') return true;
    if (el.hasAttribute('onclick')) return true;
    var role = el.getAttribute('role');
    if (role && ROLE_VALUES.indexOf(role) !== -1) return true;
    return false;
  }

  var formEls = Array.prototype.slice.call(document.querySelectorAll('form')) as HTMLFormElement[];
  var forms = formEls.map(function (fe, index) {
    return {
      index: index,
      id: fe.id || '',
      name: fe.getAttribute('name') || '',
      actionPath: fe.getAttribute('action') || '',
      method: (fe.getAttribute('method') || 'get').toLowerCase(),
    };
  });

  function formIndexOf(el: Element): number {
    var formOwner: Element | null = (el as unknown as { form?: HTMLFormElement | null }).form || null;
    if (!formOwner) formOwner = el.closest('form');
    if (!formOwner) return -1;
    for (var i = 0; i < formEls.length; i++) {
      if (formEls[i] === formOwner) return i;
    }
    return -1;
  }

  function buildRecord(el: Element): Record<string, unknown> | null {
    var tag = el.tagName.toLowerCase();
    // `button.type` is the IDL default ('submit' when the attribute is
    // absent); inputs keep the raw attribute (absent means text).
    var type =
      tag === 'button'
        ? ((el as HTMLButtonElement).type || '').toLowerCase()
        : (el.getAttribute('type') || '').toLowerCase();
    var isProxy = false;
    var labelEl: HTMLElement | null = null;
    var controlPath: string | undefined;
    var pathEl: Element = el;

    if (tag === 'input' && (type === 'checkbox' || type === 'radio') && !isVisible(el)) {
      var wrap = wrappingLabel(el);
      var byFor = el.id ? labelForOf(el.id) : null;
      var label = wrap || byFor;
      if (label && isVisible(label)) {
        isProxy = true;
        labelEl = label;
        pathEl = label;
        controlPath = pathFor(el);
      } else {
        return null;
      }
    } else if (!isVisible(el)) {
      return null;
    }

    var role = roleOf(el);
    var name = isProxy ? clip(collapse((labelEl as HTMLElement).textContent || ''), 80) : accessibleName(el);
    var rect = rectOf(pathEl);
    var vpRect = pathEl.getBoundingClientRect();
    var inViewport =
      vpRect.bottom > 0 && vpRect.right > 0 && vpRect.top < window.innerHeight && vpRect.left < window.innerWidth;

    var editable = false;
    if (tag === 'textarea') editable = true;
    else if (tag === 'input') {
      var nonEditable: Record<string, boolean> = {
        checkbox: true, radio: true, button: true, submit: true, reset: true, image: true, file: true,
        range: true, color: true,
      };
      editable = !nonEditable[type];
    } else if ((el as HTMLElement).isContentEditable) {
      editable = true;
    }

    var state: Record<string, unknown> = { disabled: !!(el as unknown as { disabled?: boolean }).disabled };
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      state.checked = !!(el as HTMLInputElement).checked;
    }
    if (editable) {
      state.filled = ((el as HTMLInputElement | HTMLTextAreaElement).value || '').length > 0;
    }
    if (tag === 'select') {
      var selEl = el as HTMLSelectElement;
      var opt = selEl.options[selEl.selectedIndex];
      state.selected = opt ? clip(collapse(opt.textContent || opt.label || ''), 80) : '';
    }
    var expandedAttr = el.getAttribute('aria-expanded');
    if (expandedAttr === 'true' || expandedAttr === 'false') {
      state.expanded = expandedAttr === 'true';
    }

    var options: Array<{ value: string; label: string }> | undefined;
    if (tag === 'select') {
      var selEl2 = el as HTMLSelectElement;
      options = [];
      for (var oi = 0; oi < selEl2.options.length; oi++) {
        var o = selEl2.options[oi];
        options.push({ value: clip(o.value || '', 200), label: clip(collapse(o.textContent || ''), 80) });
      }
    }

    var fingerprint = { tag: tag, role: role, name: name, x: rect.x, y: rect.y };

    var record: Record<string, unknown> = {
      id: '',
      path: pathFor(pathEl),
      tag: tag,
      role: role,
      name: name,
      type: type || '',
      attrName: clip(el.getAttribute('name') || '', 80),
      ariaLabel: clip(el.getAttribute('aria-label') || '', 80),
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      state: state,
      editable: editable,
      inViewport: inViewport,
      rect: rect,
      form: formIndexOf(el),
      fingerprint: fingerprint,
    };
    if (isProxy) record.controlPath = controlPath;
    if (options) record.options = options;
    return record;
  }

  function textExcerpt(maxChars: number): string {
    var skipTags: Record<string, boolean> = {
      SCRIPT: true, STYLE: true, NOSCRIPT: true, TEMPLATE: true, TEXTAREA: true, SELECT: true, OPTION: true,
    };
    function skip(parent: Element | null): boolean {
      var node: Element | null = parent;
      while (node) {
        if (skipTags[node.tagName]) return true;
        if ((node as HTMLElement).isContentEditable) return true;
        node = node.parentElement;
      }
      return false;
    }
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var parts: string[] = [];
    var node: Node | null;
    // eslint-disable-next-line no-cond-assign
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent) continue;
      if (skip(parent)) continue;
      var anyParent = parent as unknown as { checkVisibility?: () => boolean };
      if (typeof anyParent.checkVisibility === 'function' && !anyParent.checkVisibility()) continue;
      var t = node.nodeValue;
      if (t) parts.push(t);
    }
    return clip(collapse(parts.join(' ')), maxChars);
  }

  function computeSignals(textExcerptStr: string) {
    var password = !!document.querySelector('input[type="password"]');
    var currentPassword = !!document.querySelector('[autocomplete="current-password"]');
    var newPassword = !!document.querySelector('[autocomplete="new-password"]');
    var otpAutocomplete = !!document.querySelector('[autocomplete="one-time-code"]');
    var ccAutocomplete = false;
    var acs = document.querySelectorAll('[autocomplete]');
    for (var i = 0; i < acs.length; i++) {
      var v = (acs[i].getAttribute('autocomplete') || '').toLowerCase();
      if (v.indexOf('cc-') === 0 || v.indexOf(' cc-') !== -1) {
        ccAutocomplete = true;
        break;
      }
    }
    var otpText = OTP_TEXT_RE.test(textExcerptStr);
    var captcha = false;
    var iframes = document.querySelectorAll('iframe[src]');
    for (var fi = 0; fi < iframes.length; fi++) {
      if (CAPTCHA_RE.test(iframes[fi].getAttribute('src') || '')) {
        captcha = true;
        break;
      }
    }
    if (!captcha) {
      var all = document.querySelectorAll('[id],[class]');
      for (var ai = 0; ai < all.length; ai++) {
        var idc = (all[ai].id || '') + ' ' + (all[ai].className || '');
        if (CAPTCHA_RE.test(idc)) {
          captcha = true;
          break;
        }
      }
    }
    return {
      password: password, currentPassword: currentPassword, newPassword: newPassword,
      otpAutocomplete: otpAutocomplete, ccAutocomplete: ccAutocomplete, otpText: otpText, captcha: captcha,
    };
  }

  var allNodes = document.querySelectorAll('*');
  var candidates: Element[] = [];
  for (var ci = 0; ci < allNodes.length; ci++) {
    if (isCandidate(allNodes[ci])) candidates.push(allNodes[ci]);
  }
  var validRecords: Array<Record<string, unknown>> = [];
  for (var vi = 0; vi < candidates.length; vi++) {
    var rec = buildRecord(candidates[vi]);
    if (rec) validRecords.push(rec);
  }
  var effectiveMax = Math.min(opts.maxElements, MAX_ENUMERATED);
  var truncated = validRecords.length > effectiveMax;
  var records = validRecords.slice(0, effectiveMax);
  for (var ri = 0; ri < records.length; ri++) {
    records[ri].id = 'e' + (ri + 1);
  }

  var text = textExcerpt(opts.maxTextChars);
  var signals = computeSignals(text);

  return {
    url: location.href,
    title: clip(document.title || '', 80),
    elements: records,
    forms: forms,
    signals: signals,
    text: text,
    truncated: truncated,
  };
}

export function buildVerifyExpression(path: string, fp: Fingerprint): string {
  return `(${verify.toString()})(${JSON.stringify(path)}, ${JSON.stringify(fp)})`;
}

function verify(path: string, fp: { tag: string; role: string; name: string; x: number; y: number }): unknown {
  var el = document.querySelector(path);
  if (!el) return { ok: false, reason: 'missing' };

  function collapse(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }
  function implicitRole(el: Element): string {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'summary') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') {
      var selEl = el as HTMLSelectElement;
      return !selEl.multiple && (selEl.size || 0) <= 1 ? 'combobox' : 'listbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    if (el.hasAttribute('onclick')) return 'button';
    return '';
  }
  function roleOf(el: Element): string {
    var explicit = el.getAttribute('role');
    return explicit || implicitRole(el);
  }
  function labelForOf(id: string): HTMLElement | null {
    if (!id) return null;
    return document.querySelector('label[for="' + CSS.escape(id) + '"]');
  }
  function wrappingLabel(el: Element): HTMLElement | null {
    var node: Element | null = el.parentElement;
    while (node) {
      if (node.tagName === 'LABEL') return node as HTMLElement;
      node = node.parentElement;
    }
    return null;
  }
  function accessibleName(el: Element): string {
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var parts = labelledBy
        .split(/\s+/)
        .map(function (id) {
          var target = document.getElementById(id);
          return target ? collapse(target.textContent || '') : '';
        })
        .filter(Boolean);
      if (parts.length) return collapse(parts.join(' ')).slice(0, 80);
    }
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return collapse(ariaLabel).slice(0, 80);
    var byFor = el.id ? labelForOf(el.id) : null;
    if (byFor) return collapse(byFor.textContent || '').slice(0, 80);
    var wrap = wrappingLabel(el);
    if (wrap) return collapse(wrap.textContent || '').slice(0, 80);
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) return collapse(placeholder).slice(0, 80);
    var title = el.getAttribute('title');
    if (title) return collapse(title).slice(0, 80);
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) {
      var val = el.getAttribute('value');
      if (val) return collapse(val).slice(0, 80);
    }
    var isTextValueTag = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (!isTextValueTag && !(el as HTMLElement).isContentEditable) {
      return collapse(el.textContent || '').slice(0, 80);
    }
    return '';
  }

  var tag = el.tagName.toLowerCase();
  var role = roleOf(el);
  var name = accessibleName(el);
  var rect = el.getBoundingClientRect();
  var x = Math.round(rect.left + window.scrollX);
  var y = Math.round(rect.top + window.scrollY);

  if (tag !== fp.tag || role !== fp.role || name !== fp.name) {
    return { ok: false, reason: 'mismatch' };
  }
  if (Math.abs(x - fp.x) > 64 || Math.abs(y - fp.y) > 64) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}

export function buildHitTestExpression(path: string): string {
  return `(${hitTest.toString()})(${JSON.stringify(path)})`;
}

function hitTest(path: string): unknown {
  var el = document.querySelector(path);
  if (!el) return { ok: false, covered: true };
  el.scrollIntoView({ block: 'center' });
  var rect = el.getBoundingClientRect();
  var x = Math.round(rect.left + rect.width / 2);
  var y = Math.round(rect.top + rect.height / 2);
  var top = document.elementFromPoint(x, y);
  var ok = false;
  var node: Element | null = top;
  while (node) {
    if (node === el) {
      ok = true;
      break;
    }
    node = node.parentElement;
  }
  if (!ok) return { ok: false, covered: true };
  return { ok: true, x: x, y: y };
}

export function buildControlStateExpression(controlPath: string): string {
  return `(${controlState.toString()})(${JSON.stringify(controlPath)})`;
}

function controlState(path: string): unknown {
  var el = document.querySelector(path) as HTMLInputElement | null;
  return { checked: !!(el && el.checked) };
}

export function buildSettleProbeExpression(): string {
  return `(${settleProbe.toString()})()`;
}

function settleProbe(): unknown {
  var sig = document.getElementsByTagName('*').length + ':' + (document.body ? document.body.innerText.length : 0);
  return { readyState: document.readyState, sig: sig };
}

export function buildVisibilityExpression(): string {
  return 'document.visibilityState';
}
