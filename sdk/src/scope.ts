/** URL policy for typed HTTP tools. This is a predicate, NOT a shell/network sandbox. */
export class URLScope {
  private readonly origins: Set<string>;
  constructor(origins: string[]) {
    if (!origins.length) throw new Error('At least one explicit origin is required');
    this.origins = new Set(origins.map(value => {
      const u = new URL(value);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Scope entries must be exact HTTP(S) origins');
      return u.origin;
    }));
  }
  allows(value: string): boolean {
    try {
      const u = new URL(value);
      return !u.username && !u.password && this.origins.has(u.origin);
    } catch { return false; }
  }
}
