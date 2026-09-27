import type { ElementRecord, FormRecord, Op } from '../contract/types.js';

export const GATE_WORDS_RE =
  /\b(submit|pay|buy|order|check\s?out|send|delete|remove|confirm|transfer|book|post|publish|sign|agree|apply)/i;

export function gateHeuristic(
  el: ElementRecord,
  form: FormRecord | undefined,
  op: Op,
): { hit: boolean; rule?: 'word' | 'type-submit' | 'enter-in-form' | 'form-word' } {
  // § 5.5.3 (B2-E13): targetless and non-committal verbs never gate — the
  // gate keys on an element-directed, potentially irreversible act.
  if (
    op === 'scroll' || op === 'scroll_up' || op === 'scroll_to' || op === 'hover' ||
    op === 'wait' || op === 'navigate' || op === 'back' || op === 'reload'
  ) {
    return { hit: false };
  }

  if (
    op === 'click' &&
    ((el.tag === 'button' && el.type === 'submit') ||
      (el.tag === 'input' && (el.type === 'submit' || el.type === 'image')))
  ) {
    return { hit: true, rule: 'type-submit' };
  }

  if (op === 'press' && el.form >= 0) {
    return { hit: true, rule: 'enter-in-form' };
  }

  if (
    (op === 'click' || op === 'press') &&
    form &&
    GATE_WORDS_RE.test(`${form.id} ${form.name} ${form.actionPath}`)
  ) {
    return { hit: true, rule: 'form-word' };
  }

  if (GATE_WORDS_RE.test(`${el.name} ${el.attrName} ${el.ariaLabel}`)) {
    return { hit: true, rule: 'word' };
  }

  return { hit: false };
}
