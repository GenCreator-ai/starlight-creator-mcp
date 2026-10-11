/** Pack patterns are a bounded literal grammar, never executable regular expressions. */
export class PackPatternError extends Error {}

const asciiLower = (text: string) => text.replace(/[A-Z]/g, character => character.toLowerCase())
const word = (character: string | undefined) => character !== undefined && /^[a-z0-9_]$/i.test(character)
const space = (character: string | undefined) => character !== undefined && /^\s$/.test(character)
const boundary = (text: string, offset: number) => word(text[offset - 1]) !== word(text[offset])

export interface PackPatternMatch { index: number; text: string }

/** One budget is shared by every pattern in a routing or canon-lint request. */
export class PackPatternBudget {
  #remaining = 1_000_000

  spend(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new PackPatternError('invalid pack pattern work charge')
    if (amount > this.#remaining) {
      this.#remaining = 0
      throw new PackPatternError('pack pattern work budget exceeded')
    }
    this.#remaining -= amount
  }
}

/** Literal alternatives, optional outer group/word boundaries, \s+ gaps and a final \w* suffix. */
export function compilePackPattern(pattern: string): (text: string, budget?: PackPatternBudget) => Iterable<PackPatternMatch> {
  if (!pattern.length || pattern.length > 512) throw new PackPatternError('pack pattern must contain 1-512 characters')
  let body = pattern
  const left = body.startsWith('\\b'); if (left) body = body.slice(2)
  const right = body.endsWith('\\b'); if (right) body = body.slice(0, -2)
  if (body.startsWith('(') && body.endsWith(')')) body = body.slice(1, -1)
  const alternatives = body.split('|')
  if (alternatives.length > 32) throw new PackPatternError('pack pattern permits at most 32 alternatives')
  const branches = alternatives.map(alternative => {
    const tail = alternative.endsWith('\\w*')
    const parts = (tail ? alternative.slice(0, -3) : alternative).split('\\s+')
    if (parts.some(part => !/^[a-z0-9 _'"/:,-]+$/i.test(part) || !/[^\s]/.test(part))) {
      throw new PackPatternError('unsupported pack pattern; use literal alternatives, word boundaries, whitespace gaps or a final word suffix')
    }
    return { parts: parts.map(asciiLower), tail }
  })
  return function* (text: string, budget = new PackPatternBudget()): Iterable<PackPatternMatch> {
    if (text.length > 65_536) throw new PackPatternError('pack pattern input exceeds 65536 characters')
    budget.spend(pattern.length + text.length + 1)
    const lower = asciiLower(text)
    for (let index = 0; index < lower.length; index++) {
      budget.spend(1)
      if (left && !boundary(lower, index)) continue
      for (const branch of branches) {
        let end = index
        let matches = true
        for (let part = 0; part < branch.parts.length; part++) {
          if (part > 0) {
            if (!space(lower[end])) { matches = false; break }
            while (space(lower[end])) { budget.spend(1); end++ }
          }
          const literal = branch.parts[part]!
          // Charge the full possible comparison before entering native startsWith.
          budget.spend(literal.length)
          if (!lower.startsWith(literal, end)) { matches = false; break }
          end += literal.length
        }
        if (!matches) continue
        if (branch.tail) while (word(lower[end])) { budget.spend(1); end++ }
        if (right && !boundary(lower, end)) continue
        yield { index, text: text.slice(index, end) }
        index = end - 1
        break
      }
    }
  }
}
