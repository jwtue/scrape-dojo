import { BaseAction } from './bases/base.action';
import { Action } from '../_decorators/action.decorator';

export type InteractiveLoginActionParams = {
  /** Message shown to the user above the live view. */
  message?: string;
  /** How long to wait for the sign-in, in ms (default 300000 = 5 minutes). 0 waits forever. */
  timeout?: number;
  /**
   * Selector that proves a usable session exists. When it is already there the
   * action does nothing, so a scheduled run passes straight through for as
   * long as the session holds.
   */
  successSelector?: string;
  /** Same proof via page text, for pages without a stable selector. */
  successText?: string;
  /**
   * Skip when the proof is already present (default true). Set to false to
   * force the live view open, which is useful when setting a workflow up.
   */
  skipIfLoggedIn?: boolean;
  /** Optional condition (Handlebars template), as in the other actions. */
  condition?: string | boolean;
};

/**
 * Hands the live page to the user so they can sign in by hand, then continues
 * the run with the session that produced.
 *
 * Why: a growing number of portals guard their sign-in with a bot check
 * (Cloudflare Turnstile, reCAPTCHA) or want a passkey. Those cannot be
 * scripted — and should not be, since the point of the check is that a person
 * signs in. Everything *after* the sign-in is ordinary scraping, so only the
 * sign-in needs a human. This action is that seam.
 *
 * The page is streamed to the UI as a CDP screencast and the UI's pointer and
 * keyboard events are dispatched back into it. Nothing is recorded, nothing is
 * typed for the user, and no credential ever passes through the workflow
 * config: the user types into the real page.
 *
 * Because the browser profile is persistent, the session outlives the run.
 * With `successSelector` set, later runs skip this action entirely until the
 * session expires — so a nightly workflow keeps running unattended and only
 * asks for a person when it truly has to.
 */
@Action('interactiveLogin', {
  displayName: 'Interactive Login',
  icon: 'UserCheck',
  description: 'Pause the run and let the user sign in in a live view',
  color: 'orange',
  category: 'interaction',
})
export class InteractiveLoginAction extends BaseAction<InteractiveLoginActionParams> {
  async run(): Promise<string> {
    const {
      message = 'Bitte melde dich im Fenster an.',
      timeout = 300000,
      successSelector,
      successText,
      skipIfLoggedIn = true,
    } = this.params;

    // Same condition handling as waitForOtp.
    if (this.params.condition !== undefined) {
      const erfuellt =
        this.params.condition === true || this.params.condition === 'true';
      if (!erfuellt) {
        this.logger.log(
          `⏭️ Skipping interactiveLogin: condition not met (${this.params.condition})`,
        );
        return 'uebersprungen';
      }
    }

    if (!successSelector && !successText) {
      this.logger.warn(
        '⚠️ Neither successSelector nor successText is set — the run cannot tell when the sign-in worked and will wait for the user to confirm.',
      );
    }

    if (skipIfLoggedIn && (await this.istAngemeldet())) {
      this.logger.log('✅ Sitzung ist noch gueltig — keine Anmeldung noetig');
      return 'uebersprungen';
    }

    const events = this.data?.scrapeEventsService;
    if (!events?.requestLogin) {
      throw new Error(
        'Interactive login needs the web UI: no scrapeEventsService on this run. Run the workflow from the UI, or give the workflow a path that signs in without a person.',
      );
    }

    this.logger.log('🧑‍💻 Warte auf die Anmeldung in der Live-Ansicht...');

    const ergebnis = await events.requestLogin(
      this.data.scrapeId || 'unknown',
      message,
      this.page,
      this.data.runId,
      timeout,
      // Self-detection: as soon as the proof appears, the wait ends by itself.
      successSelector || successText
        ? () => this.istAngemeldet()
        : undefined,
    );

    this.logger.log(`✅ Anmeldung abgeschlossen (${ergebnis})`);
    return ergebnis;
  }

  /**
   * Is there a usable session? Checked via selector and/or page text.
   *
   * Errors are swallowed on purpose: while the page navigates, both checks
   * throw, and that is not an answer — it just means "not yet".
   */
  private async istAngemeldet(): Promise<boolean> {
    const { successSelector, successText } = this.params;

    if (successSelector) {
      try {
        if (await this.page.$(successSelector)) return true;
      } catch {
        return false;
      }
    }

    if (successText) {
      try {
        const text = await this.page.evaluate(
          () => document.body?.innerText || '',
        );
        if (text.includes(successText)) return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}

export default InteractiveLoginAction;
