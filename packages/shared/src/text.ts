// FILE: text.ts
// Purpose: Small, dependency-free text helpers shared across server and web so
// repeated string semantics (count pluralization, etc.) live in one place.
// Layer: Shared runtime utility
// Exports: pluralize and splitLines

// Splits complete LF and CRLF-delimited text while preserving String#split
// semantics for empty input and trailing delimiters. A lone trailing carriage
// return remains part of the final entry so incremental consumers can retain it
// until a following chunk supplies the line feed.
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// Returns the singular or plural form of a noun based on `count`. The plural
// defaults to `${singular}s`; pass an explicit plural for irregular forms or
// when a verb travels with the noun (e.g. "thread is" / "threads are").
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
