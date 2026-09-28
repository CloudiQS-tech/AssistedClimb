export function splitVocabularyPaste(value: string): string[] {
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];

  const hasListDelimiters = /[,;\n\t]/.test(text);
  return text
    .split(hasListDelimiters ? /[,;\n\t]+/ : /\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

export function mergeVocabularyTerms(existing: string[], incoming: string[]): string[] {
  const merged = [...existing];
  for (const term of incoming) {
    if (!merged.some((item) => item.toLocaleLowerCase() === term.toLocaleLowerCase())) {
      merged.push(term);
    }
  }
  return merged;
}