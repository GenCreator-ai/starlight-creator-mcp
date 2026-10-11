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
  #input?: { text: string; lower: string; positions: Map<string, number[]> }

  spend(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new PackPatternError('invalid pack pattern work charge')
    if (amount > this.#remaining) {
      this.#remaining = 0
      throw new PackPatternError('pack pattern work budget exceeded')
    }
    this.#remaining -= amount
  }

  #prepare(text: string): { text: string; lower: string; positions: Map<string, number[]> } {
    if (text.length > 65_536) throw new PackPatternError('pack pattern input exceeds 65536 characters')
    if (this.#input?.text === text) return this.#input
    // Own one bounded index per request budget; replacing input discards the old cache.
    this.spend(text.length * 2 + 1)
    const lower = asciiLower(text), positions = new Map<string, number[]>()
    for (let index = 0; index < lower.length; index++) {
      const character = lower[index]!
      if (!/^[a-z0-9 _'"/:,-]$/.test(character)) continue
      let indices = positions.get(character)
      if (!indices) { indices = []; positions.set(character, indices) }
      indices.push(index)
    }
    return this.#input = { text, lower, positions }
  }

  normalized(text: string): string { return this.#prepare(text).lower }

  /** Ordered possible starts without exposing the cached mutable position arrays. */
  *candidateIndices(text: string, firstCharacters: readonly string[]): Iterable<number> {
    if (firstCharacters.length > 32 || firstCharacters.some(character => !/^[a-z0-9 _'"/:,-]$/.test(character))) {
      throw new PackPatternError('invalid pack pattern candidate characters')
    }
    this.spend(firstCharacters.length + 1)
    const input = this.#prepare(text)
    const groups = [...new Set(firstCharacters)].map(character => input.positions.get(character)).filter((indices): indices is number[] => indices !== undefined)
    const offsets = new Uint32Array(groups.length)
    while (groups.length) {
      this.spend(groups.length)
      let selected = -1, next = Infinity
      for (let group = 0; group < groups.length; group++) {
        const index = groups[group]![offsets[group]!]
        if (index !== undefined && index < next) { next = index; selected = group }
      }
      if (selected === -1) return
      offsets[selected] = offsets[selected]! + 1
      yield next
    }
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
    budget.spend(pattern.length + 1)
    const lower = budget.normalized(text)
    let nextAllowed = 0
    for (const index of budget.candidateIndices(text, branches.map(branch => branch.parts[0]![0]!))) {
      if (index < nextAllowed) continue
      if (left && !boundary(lower, index)) continue
      for (const branch of branches) {
        budget.spend(1)
        if (branch.parts[0]![0] !== lower[index]) continue
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
        nextAllowed = end
        break
      }
    }
  }
}
