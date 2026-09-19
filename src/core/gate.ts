import type { ElementRecord, FormRecord, Op } from '../contract/types.js';

export const GATE_WORDS_RE =
  /\b(submit|pay|buy|order|check\s?out|send|delete|remove|confirm|transfer|book|post|publish|sign|agree|apply)/i;

export function gateHeuristic(
  el: ElementRecord,
  form: FormRecord | undefined,
  op: Op,
): { hit: boolean; rule?: 'word' | 'type-submit' | 'enter-in-form' | 'form-word' } {
  if (op === 'scroll') return { hit: false };

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
