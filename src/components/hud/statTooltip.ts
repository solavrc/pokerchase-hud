/**
 * Native `title` tooltip composition for HUD stat cells (#143).
 *
 * Shared by StatDisplay (full 16-stat grid) and CompactStatDisplay (compact
 * mode's classic line + secondary line) so every stat cell -- full-grid row
 * or compact element alike -- gets the same beginner-friendly tooltip:
 *
 *   {base line}
 *   {helpText}
 *
 * The base line is the stat's dynamic tooltip (`StatDefinition.tooltip`,
 * #130 -- e.g. vpipF's per-layer breakdown) when the stat defines one,
 * otherwise `${name}: ${displayValue}` (name + value with its (num/den)).
 * `helpText` (#143, `StatDefinition.helpText`) is a static, one-line
 * Japanese explanation of what the stat means -- looked up from the shared
 * stats registry by id, since it doesn't vary with calculation context.
 */
import { defaultRegistry } from '../../stats'

export const composeStatTitle = (
  id: string,
  name: string,
  displayValue: string,
  dynamicTooltip?: string
): string => {
  const base = dynamicTooltip || `${name}: ${displayValue}`
  const helpText = defaultRegistry.get(id)?.helpText
  return helpText ? `${base}\n${helpText}` : base
}
