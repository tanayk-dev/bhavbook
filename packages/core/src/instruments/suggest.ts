// Manual-mapping suggestions (plan S8): candidates ranked by normalised token overlap (Jaccard), with a near-top
// score for an acronym of the candidate's name ("HCC" -> "Hindustan Construction Company").

/** Words that carry no identity in Indian company names. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'of',
  'and',
  'ltd',
  'limited',
  'co',
  'company',
  'corp',
  'corporation',
  'inc',
  'plc',
  'pvt',
  'private',
]);
/** Words skipped when forming an acronym (the legal suffixes still count: "Corporation" is the C of REC). */
const ACRONYM_SKIP: ReadonlySet<string> = new Set(['the', 'of', 'and', 'ltd', 'limited']);
const ACRONYM_SCORE = 0.9;
export const DEFAULT_SUGGESTIONS = 5;

function rawTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '');
}

/** Lower-case alphanumeric tokens without legal suffixes and filler words, in their original order. */
export function normaliseName(name: string): string[] {
  return rawTokens(name).filter((token) => !STOP_WORDS.has(token));
}

function acronymOf(name: string): string {
  return rawTokens(name)
    .filter((token) => !ACRONYM_SKIP.has(token))
    .map((token) => token[0] ?? '')
    .join('');
}

function score(query: string, candidate: string): number {
  const left = new Set(normaliseName(query));
  const right = new Set(normaliseName(candidate));
  const shared = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  const overlap = union === 0 ? 0 : shared / union;
  const [single, ...others] = rawTokens(query);
  const acronym = single !== undefined && others.length === 0 && single.length >= 2 && single === acronymOf(candidate);
  return Math.max(overlap, acronym ? ACRONYM_SCORE : 0);
}

export interface Scored {
  readonly score: number;
}

/** The best matches for `query` among `options` (score > 0), best first; ties by name. */
export function suggestInstruments<T extends { readonly name: string }>(
  query: string,
  options: readonly T[],
  limit = DEFAULT_SUGGESTIONS,
): (T & Scored)[] {
  return options
    .map((option) => ({ ...option, score: score(query, option.name) }))
    .filter((option) => option.score > 0)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limit);
}
