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
  /** KB proof switch (r17 WP-B mutant): composed into the hidden-input
   * sibling-label resolution. Lives INSIDE enumerate's function body so it
   * stringifies along; never flip in shipped code. */
  var KB_HIDDEN_SIBLING = false;
  /** KB proof switches (r19 D-1/D-2 mutants): flip = restore pre-fix
   * behaviour (no th enumeration / no ondblclick candidacy). Same body-local
   * shape as KB_HIDDEN_SIBLING so they stringify along; never flip in
   * shipped code. KB_TABLE_HEADERS also has a questions.ts const twin that a
   * mutant flips with this one. */
  var KB_TABLE_HEADERS = false;
  var KB_DBLCLICK_ENUM = false;
  /** KB proof switch (r21 D10 mutant): flip = remove the cursor-pointer
   * candidacy/role arms (restore pre-P-5 enumerate). Same body-local shape
   * as KB_HIDDEN_SIBLING so it stringifies along; never flip in shipped
   * code. verify()'s implicitRole mirror is deliberately UNGATED (the r19
   * D-2 precedent): a gated verify would throw stale on every enumerated
   * heuristic element. */
  var KB_CURSOR_POINTER = false;

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
      if (type === 'file') return 'button'; // A1: Jev picks upload targets by role; a file input acts like a button
      return 'textbox';
    }
    if (tag === 'summary') return 'button';
    if (!KB_TABLE_HEADERS && tag === 'th') return 'columnheader';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') {
      var selEl = el as HTMLSelectElement;
      var multiple = !!selEl.multiple;
      var size = selEl.size || 0;
      return !multiple && size <= 1 ? 'combobox' : 'listbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    if (el.hasAttribute('onclick')) return 'button';
    if (!KB_DBLCLICK_ENUM && el.hasAttribute('ondblclick')) return 'button';
    if (
      !KB_CURSOR_POINTER &&
      el.childElementCount <= 50 &&
      collapse(el.textContent || '') !== '' &&
      getComputedStyle(el).cursor === 'pointer'
    )
      return 'button';
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
  // r17 (D7): a visually hidden input can resolve its name through an
  // adjacent visible sibling <label> (the TodoMVC shape). Checks the next
  // element sibling, then the previous one. A label with its OWN association —
  // a `for` attribute or a wrapped control — is owned by that control and
  // never names a sibling (r17b: a hidden #t7 next to a label[for=#t6] must
  // not steal that label's text as its name).
  function siblingLabel(el: Element): HTMLElement | null {
    function owned(node: Element): boolean {
      if (node.hasAttribute('for')) return true;
      return node.querySelectorAll('input,select,textarea,button').length > 0;
    }
    var next = el.nextElementSibling;
    if (next && next.tagName === 'LABEL' && !owned(next) && isVisible(next)) return next as HTMLElement;
    var prev = el.previousElementSibling;
    if (prev && prev.tagName === 'LABEL' && !owned(prev) && isVisible(prev)) return prev as HTMLElement;
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
    if (!KB_TABLE_HEADERS && tag === 'th') return true;
    if (tag === 'input') return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
    return false;
  }
  // r21 (D10): cursor-pointer candidacy for div-like interactive elements —
  // menu items and custom buttons wired by delegated listeners, which carry
  // no onclick attribute and no role. Cheap gates first, the style read
  // LAST: candidacy is evaluated per node the earlier arms REJECT, so
  // getComputedStyle must only fire for elements already text-bearing,
  // light and visible. Structured/form elements never reach it (they
  // returned from isCandidateTag above).
  function cursorCandidacy(el: Element): boolean {
    return (
      el.childElementCount <= 50 &&
      collapse(el.textContent || '').length > 0 &&
      isVisible(el) &&
      getComputedStyle(el).cursor === 'pointer'
    );
  }
  function isCandidate(el: Element): boolean {
    if (isCandidateTag(el)) return true;
    var ce = el.getAttribute('contenteditable');
    if (ce === '' || ce === 'true') return true;
    if (el.hasAttribute('onclick')) return true;
    if (!KB_DBLCLICK_ENUM && el.hasAttribute('ondblclick')) return true;
    var role = el.getAttribute('role');
    if (role && ROLE_VALUES.indexOf(role) !== -1) return true;
    if (!KB_CURSOR_POINTER && cursorCandidacy(el)) return true;
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
      // r17 (D7/C7): a hidden checkbox/radio resolves its name through a
      // wrap label, a label[for], or an adjacent VISIBLE sibling label —
      // all three take the PROXY arm (path = the label, controlPath = the
      // input, name = the label's textContent). Failing that, a non-empty
      // accessibleName (aria-label → placeholder → title here, since
      // wrap/for/labelledby already failed) keeps the record on the input's
      // own path (named-only arm); anything else still enumerates null.
      var label = wrap || byFor || (KB_HIDDEN_SIBLING ? null : siblingLabel(el));
      if (label && isVisible(label)) {
        isProxy = true;
        labelEl = label;
        pathEl = label;
        controlPath = pathFor(el);
      } else if (accessibleName(el) === '') {
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

    // r19 (D-1): the enclosing table's id, so identical headers across
    // tables on one page stay distinguishable in the criteria (t7's table1 vs
    // table2 "Last Name"). Assigned ONLY when found — an absent key, never
    // { tableId: undefined }. Deliberately NOT in the fingerprint.
    var tableId: string | undefined;
    if (!KB_TABLE_HEADERS) {
      var tbl = pathEl.closest('table');
      if (tbl && tbl.id) tableId = clip(tbl.id, 80);
    }

    // Enumerate-time occlusion probe (§ 3.5 amendment 2026-09-21h): what is
    // on top at the record's center right now? A hit that is neither the
    // element nor its descendant means the element is covered and a click
    // would land on the cover. A point outside the viewport answers null —
    // that is not evidence of a cover, so `obscured` stays false.
    var obscured = false;
    var coveredBy: string | undefined;
    if (vpRect.width > 0 && vpRect.height > 0) {
      var top = document.elementFromPoint(vpRect.left + vpRect.width / 2, vpRect.top + vpRect.height / 2);
      if (top && top !== pathEl && !pathEl.contains(top)) {
        obscured = true;
        var topTag = top.tagName.toLowerCase();
        coveredBy = clip(topTag + (top.id ? '#' + top.id : ''), 80);
      }
    }

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
      placeholder: clip(collapse(el.getAttribute('placeholder') || ''), 80),
      htmlId: clip(el.id || '', 80),
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
    record.obscured = obscured;
    if (obscured) record.coveredBy = coveredBy;
    if (tableId !== undefined) record.tableId = tableId;
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
    /** KB proof switch (r21 D5 mutant): flip = restore the pre-fix whole-page
     * any-substring captcha match. Same body-local shape as KB_HIDDEN_SIBLING
     * so it stringifies along; never flip in shipped code. */
    var KB_CAPTCHA_SCOPED = false;
    var CHALLENGE_MIN_AREA = 16000;
    var scoped = !KB_CAPTCHA_SCOPED;
    function area(el: Element): number {
      var r = el.getBoundingClientRect();
      return r.width * r.height;
    }
    var captcha = false;
    var iframes = document.querySelectorAll('iframe[src]');
    for (var fi = 0; fi < iframes.length; fi++) {
      var src = iframes[fi].getAttribute('src') || '';
      if (
        CAPTCHA_RE.test(src) &&
        (!scoped || (src.indexOf('size=invisible') === -1 && isVisible(iframes[fi]) && area(iframes[fi]) >= CHALLENGE_MIN_AREA))
      ) {
        captcha = true;
        break;
      }
    }
    if (!captcha) {
      var SKIP_TAGS: Record<string, boolean> = {
        SCRIPT: true, STYLE: true, TEMPLATE: true, NOSCRIPT: true, LINK: true, META: true,
      };
      var all = document.querySelectorAll('[id],[class]');
      for (var ai = 0; ai < all.length; ai++) {
        // r21 verifier F3: read the class via the ATTRIBUTE — an SVG
        // element's className is an SVGAnimatedString object (stringifies to
        // '[object SVGAnimatedString]'), so a captcha class carried by an
        // SVG never matched. getAttribute('class') works for HTML and SVG.
        var idc = (all[ai].id || '') + ' ' + (all[ai].getAttribute('class') || '');
        if (CAPTCHA_RE.test(idc)) {
          if (!scoped || (!SKIP_TAGS[all[ai].tagName] && isVisible(all[ai]) && area(all[ai]) >= CHALLENGE_MIN_AREA)) {
            captcha = true;
            break;
          }
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

  // r17 (D2): the focused element, computed once beside textExcerpt — evidence
  // for the loop's focus-changed promotion; evidence-only, never sent to Jev.
  var ae = document.activeElement;
  var focus = ae ? { path: pathFor(ae), role: roleOf(ae), name: clip(accessibleName(ae), 80) } : undefined;

  // r17 (C8): repeated-element group tallies, document-wide over all nodes —
  // candidate or not (lazy-load lists are <li>/<div> items, not interactive
  // elements). Signature = tag.className(collapsed, clipped to 60); groups with
  // count >= 3 kept, top 5 by count desc then signature asc.
  var groupCounts: Record<string, number> = {};
  for (var gi = 0; gi < allNodes.length; gi++) {
    var gn = allNodes[gi];
    var sig = gn.tagName.toLowerCase() + '.' + clip(collapse(String(gn.className)), 60);
    groupCounts[sig] = (groupCounts[sig] ?? 0) + 1;
  }
  var repeatedGroups = Object.keys(groupCounts)
    .map(function (s) { return { signature: s, count: groupCounts[s] }; })
    .filter(function (g) { return g.count >= 3; })
    .sort(function (a, b) {
      return b.count - a.count || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);
    })
    .slice(0, 5);

  var out: Record<string, unknown> = {
    url: location.href,
    title: clip(document.title || '', 80),
    elements: records,
    forms: forms,
    signals: signals,
    text: text,
    truncated: truncated,
    // r17c (D-A): the viewport offset, always a number — evidence for the
    // loop's scroll-specific targetless signal; never sent to Jev.
    scrollY: Math.round(window.scrollY),
  };
  if (focus !== undefined) out.focus = focus;
  if (repeatedGroups.length > 0) out.repeatedGroups = repeatedGroups;
  return out;
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
      if (type === 'file') return 'button'; // A1: mirrors enumerate's implicitRole
      return 'textbox';
    }
    if (tag === 'summary') return 'button';
    if (tag === 'th') return 'columnheader'; // r19 D-1: ungated mirror of enumerate's th role
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') {
      var selEl = el as HTMLSelectElement;
      return !selEl.multiple && (selEl.size || 0) <= 1 ? 'combobox' : 'listbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    if (el.hasAttribute('onclick')) return 'button';
    if (el.hasAttribute('ondblclick')) return 'button'; // r19 D-2: ungated mirror of enumerate's ondblclick role
    // r21 D10: ungated mirror of enumerate's cursor-pointer role — a gated
    // verify would throw mismatch on every enumerated heuristic element.
    if (el.childElementCount <= 50 && collapse(el.textContent || '') !== '' && getComputedStyle(el).cursor === 'pointer')
      return 'button';
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
  // Mirrors enumerate's isVisible so the proxy rule below agrees with the
  // enumeration side of the contract.
  function isVisible(elm: Element): boolean {
    var anyEl = elm as unknown as { checkVisibility?: (opts: unknown) => boolean };
    if (typeof anyEl.checkVisibility === 'function') {
      if (!anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    }
    var r = elm.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var anc: Element | null = elm.parentElement;
    while (anc) {
      if (anc.getAttribute('aria-hidden') === 'true') return false;
      anc = anc.parentElement;
    }
    return true;
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
  // Proxy rule, mirroring buildRecord: a record for a visually hidden
  // checkbox/radio stores the visible LABEL's path, so when the node found at
  // `path` is such a label, tag/role/name come from the paired input. The
  // position fingerprint was taken at the label, so the rect check stays on el.
  if (el.tagName === 'LABEL') {
    var labelEl = el as HTMLLabelElement;
    var ctrl: HTMLInputElement | null = null;
    var forId = labelEl.htmlFor;
    if (forId) {
      var target = document.getElementById(forId);
      if (target && target.tagName === 'INPUT') ctrl = target as HTMLInputElement;
    }
    if (!ctrl) {
      var inner = labelEl.querySelectorAll('input[type="checkbox"],input[type="radio"]');
      if (inner.length > 0) ctrl = inner[0] as HTMLInputElement;
    }
    // r17 (D7 mirror): enumerate also proxies a hidden checkbox/radio through
    // an adjacent sibling label, so when `path` names that label the sibling
    // probe finds the hidden input — the tag/role/name rewrite below then
    // applies unchanged.
    if (!ctrl) {
      var sib: Element | null = labelEl.nextElementSibling;
      if (sib && sib.tagName === 'INPUT') {
        var st = (sib.getAttribute('type') || '').toLowerCase();
        if (st === 'checkbox' || st === 'radio') ctrl = sib as HTMLInputElement;
      }
      if (!ctrl) {
        sib = labelEl.previousElementSibling;
        if (sib && sib.tagName === 'INPUT') {
          var st2 = (sib.getAttribute('type') || '').toLowerCase();
          if (st2 === 'checkbox' || st2 === 'radio') ctrl = sib as HTMLInputElement;
        }
      }
    }
    var ctrlType = ctrl ? (ctrl.getAttribute('type') || '').toLowerCase() : '';
    if (ctrl && (ctrlType === 'checkbox' || ctrlType === 'radio') && !isVisible(ctrl) && isVisible(labelEl)) {
      tag = ctrl.tagName.toLowerCase();
      role = roleOf(ctrl);
      // Enumerate derives a proxy record's name from the label's text.
      name = collapse(labelEl.textContent || '').slice(0, 80);
    }
  }
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
