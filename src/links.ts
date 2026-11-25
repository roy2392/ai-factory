export function linkedIssues(body: string | null, repo = ''): number[] {
  const issues = new Set<number>();
  // Explicit cross-repository references are never inferred to be local.
  for (const match of (body ?? '').matchAll(
    /\b(?:fixes|closes|resolves)\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d*)\b/gi,
  )) {
    if (!match[1] || match[1].toLowerCase() === repo.toLowerCase()) {
      const number = Number(match[2]);
      if (Number.isSafeInteger(number)) issues.add(number);
    }
  }
  return [...issues];
}
