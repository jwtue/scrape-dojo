/**
 * Verwandelt einen beliebigen Wert für eine Log-Zeile in Text, ohne zu werfen.
 *
 * JSONata baut die Ergebnisse von Objekt-Konstruktoren mit `Object.create(null)`
 * (jsonata 2.2.1). Solche Objekte haben kein `toString`, und eine Interpolation
 * wie `${result}` wirft deshalb `Cannot convert object to primitive value`.
 * Weil das in Log-Zeilen passiert, die noch vor dem Speichern des Ergebnisses
 * stehen, beendet eine einzige `transform`-Aktion mit Objekt-Ergebnis den
 * ganzen Lauf — und `paginationConfig` im mitgelieferten Amazon-Workflow ist
 * genau so eine.
 *
 * Ein Log darf einen Lauf nie scheitern lassen. Deshalb sind hier auch
 * zyklische Strukturen, BigInt und ein werfendes `toJSON` abgedeckt.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    const text = JSON.stringify(value);
    if (text !== undefined) {
      return text;
    }
  } catch {
    // Zyklisch, BigInt oder ein werfendes toJSON — unten weiter.
  }

  try {
    return String(value);
  } catch {
    return `[${typeof value}, nicht darstellbar]`;
  }
}
