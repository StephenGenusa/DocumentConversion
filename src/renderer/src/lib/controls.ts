import type { SourceFormat, TargetFormat } from '../../../core/types'

/**
 * Which conversion controls are shown (spec 2a).
 *
 * A control that is visible must change the result; one that would do nothing
 * is HIDDEN, not disabled. Two kinds:
 *
 *   output controls  shown for the selected target, and only when some input
 *                    has content they act on (OutputPicker)
 *   input controls   shown on an input's own card, only for the kind of
 *                    input they act on (InputCard, InputList)
 *
 * The rules live here and nowhere else, so the screen, the options sent with a
 * conversion, and every later control agree. Values live in App state: they
 * last for the session and survive being hidden, so switching the target away
 * and back does not reset them.
 */

export interface ControlInput {
  source: SourceFormat
  imageMode?: 'embed' | 'ocr'
  /** JSON that reads as a table of records. */
  jsonTable?: boolean
}

export type OutputControl = 'pdfOptions' | 'slideSplit'
export type InputControl = 'imageMode' | 'ocrLanguage' | 'jsonAs'

const OUTPUT_RULES: Record<OutputControl, (target: TargetFormat, inputs: ControlInput[]) => boolean> = {
  pdfOptions: (target) => target === 'pdf',
  slideSplit: (target) => target === 'revealjs',
}

const INPUT_RULES: Record<InputControl, (input: ControlInput) => boolean> = {
  imageMode: (input) => input.source === 'image',
  ocrLanguage: (input) => input.source === 'image' && input.imageMode === 'ocr',
  // Only where there is a choice: JSON that is records. Other JSON is a listing either way.
  jsonAs: (input) => input.source === 'json' && input.jsonTable === true,
}

export function showsOutput(control: OutputControl, target: TargetFormat, inputs: ControlInput[]): boolean {
  return OUTPUT_RULES[control](target, inputs)
}

export function showsInput(control: InputControl, input: ControlInput): boolean {
  return INPUT_RULES[control](input)
}

/** The options a conversion carries: only those of controls that are shown. */
export function appliedOptions<P, S>(
  target: TargetFormat,
  inputs: ControlInput[],
  values: { pdf: P; slides: S },
): { pdf?: P; slides?: S } {
  return {
    ...(showsOutput('pdfOptions', target, inputs) ? { pdf: values.pdf } : {}),
    ...(showsOutput('slideSplit', target, inputs) ? { slides: values.slides } : {}),
  }
}
