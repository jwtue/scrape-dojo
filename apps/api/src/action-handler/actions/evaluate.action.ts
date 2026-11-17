import { PuppeteerLifeCycleEvent } from 'puppeteer';
import { BaseAction } from './bases/base.action';
import { Action } from '../_decorators/action.decorator';

// Typdefinition für die Parameter der EvaluateAction
export type EvaluateActionParams = {
  /** JavaScript, das im Kontext der Seite ausgeführt wird. Der Wert des
   *  Ausdrucks wird zum Ergebnis der Action (muss serialisierbar sein). */
  expression: string;
  /** Auf eine Navigation warten, die der Ausdruck auslöst (z.B. form.submit()) */
  waitForNavigation?: boolean;
  /** Lifecycle-Event, auf das bei waitForNavigation gewartet wird */
  waitUntil?: PuppeteerLifeCycleEvent;
  /** Timeout für die Navigation in ms */
  timeout?: number;
  /** Fehler nur loggen statt werfen */
  optional?: boolean;
  /** Bei "Execution context was destroyed" einmal wiederholen (Vorgabe: true).
   *  Der Ausdruck laeuft dann ZWEIMAL — er muss seine Vorbedingung also selbst
   *  pruefen, was fuer Ausdruecke mit Nebenwirkung ohnehin gilt. */
  retryOnNavigation?: boolean;
};

@Action('evaluate', {
  displayName: 'Evaluate',
  icon: 'Code',
  description: 'Run JavaScript in the page context and return its result',
  color: 'amber',
  category: 'interaction',
})
export class EvaluateAction extends BaseAction<EvaluateActionParams> {
  async run(): Promise<unknown> {
    const { expression, optional = false } = this.params;

    if (!expression) {
      throw new Error('Missing required parameter: expression');
    }

    if (!this.page) {
      throw new Error('Page is not initialized');
    }

    const waitForNavigation = this.params.waitForNavigation ?? false;
    const waitUntil = this.params.waitUntil ?? 'networkidle2';
    const timeout = this.params.timeout ?? 30000;

    const preview =
      expression.length > 80 ? `${expression.slice(0, 80)}…` : expression;
    this.logger.log(`🧩 Evaluating: ${preview}`);

    try {
      // Der Navigation-Listener muss VOR der Auswertung stehen, sonst ist die
      // Navigation unter Umständen schon durch, bevor gewartet wird.
      const navigation = waitForNavigation
        ? this.page
            .waitForNavigation({ waitUntil, timeout })
            .then(() => true)
            .catch(() => false)
        : null;

      // Puppeteer wertet einen String über Runtime.evaluate aus. Anders als
      // `new Function(...)` im Seitenkontext greift dort keine CSP-Regel
      // gegen eval - das ist für Seiten mit strikter CSP der einzige Weg.
      const result = await this.auswertenMitWiederholung(expression);

      if (navigation) {
        const navigated = await navigation;
        if (navigated) {
          this.logger.debug(`🧭 Navigation completed`);
        } else {
          this.logger.warn(
            `⚠️ No navigation within ${timeout}ms after evaluation`,
          );
        }
      }

      if (result === undefined) {
        this.logger.debug(`✅ Evaluation completed (no return value)`);
        return null;
      }

      const serialized =
        typeof result === 'string' ? result : JSON.stringify(result);
      const resultPreview =
        serialized && serialized.length > 50
          ? `${serialized.slice(0, 50)}...`
          : serialized;
      this.logger.log(`📤 Result: "${resultPreview}"`);

      return result;
    } catch (error) {
      if (optional) {
        this.logger.warn(`⚠️ Optional evaluation failed: ${error.message}`);
        return null;
      }
      this.logger.error(`❌ Evaluation error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Wertet den Ausdruck aus und wiederholt EINMAL, wenn die Seite dabei
   * navigiert ist.
   *
   * "Execution context was destroyed, most likely because of a navigation"
   * sagt nichts ueber den Ausdruck — die Seite wurde unter ihm weggezogen. Das
   * passiert regelmaessig nach einem Formular-Absenden, waehrend die
   * Weiterleitungskette der Gegenseite noch laeuft und der naechste Schritt
   * schon prueft. In diesem Repo zweimal passiert: nach dem Mail-Schritt und
   * nach dem OTP-Schritt des Amazon-Logins, beide Male mit einer festen
   * Wartezeit davor, die zu kurz war. Eine Wiederholung trifft den neuen
   * Kontext.
   *
   * ACHTUNG: der Ausdruck laeuft dabei zweimal. Hat er eine Nebenwirkung, muss
   * er seine Vorbedingung selbst pruefen (also etwa nur abschicken, wenn das
   * Feld noch gefuellt und die Maske noch da ist). Wer das nicht will, setzt
   * retryOnNavigation auf false.
   */
  private async auswertenMitWiederholung(expression: string): Promise<unknown> {
    const wiederholen = this.params.retryOnNavigation ?? true;

    try {
      return await this.page.evaluate(expression);
    } catch (error) {
      const meldung = error?.message ?? '';
      const navigiert =
        /Execution context was destroyed|Cannot find context with specified id/i.test(
          meldung,
        );

      if (!wiederholen || !navigiert) {
        throw error;
      }

      this.logger.warn(
        '⚠️ Seite ist während der Auswertung navigiert — zweiter Versuch',
      );

      // Die laufende Weiterleitungskette abwarten, aber begrenzt: bleibt die
      // Navigation aus, geht es nach dem Timeout trotzdem weiter.
      await this.page
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));

      return await this.page.evaluate(expression);
    }
  }
}

export default EvaluateAction;
