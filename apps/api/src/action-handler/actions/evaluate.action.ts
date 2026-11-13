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
      const result = await this.page.evaluate(expression);

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
}

export default EvaluateAction;
