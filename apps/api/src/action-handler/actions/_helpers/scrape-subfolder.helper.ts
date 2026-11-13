import * as path from 'path';

/**
 * Fügt die scrapeId als Unterordner direkt hinter dem Wurzelverzeichnis ein,
 * damit die Dateien eines Laufs beieinander liegen:
 *
 *   './downloads',             'amazon' -> './downloads/amazon'
 *   './downloads/invoices',    'amazon' -> './downloads/amazon/invoices'
 *
 * Ohne scrapeId bleibt der Pfad unverändert.
 */
export function withScrapeSubfolder(
  basePath: string,
  scrapeId?: string,
): string {
  if (!scrapeId) {
    return basePath;
  }

  // Zerlege den Pfad in Segmente und füge scrapeId nach dem Root ein
  const normalizedPath = basePath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter((s) => s !== '');

  if (segments.length === 0) {
    return path.join(basePath, scrapeId);
  }

  // Finde den Root-Teil (z.B. "./downloads" oder "downloads" oder "C:/downloads")
  const rootParts: string[] = [];

  // Behandle relative Pfade (., ..)
  let i = 0;
  while (i < segments.length && (segments[i] === '.' || segments[i] === '..')) {
    rootParts.push(segments[i]);
    i++;
  }

  // Das erste "echte" Verzeichnis ist auch Teil des Roots
  if (i < segments.length) {
    rootParts.push(segments[i]);
    i++;
  }

  // Der Rest kommt nach dem scrapeId
  const restParts = segments.slice(i);

  return [...rootParts, scrapeId, ...restParts].join('/');
}
