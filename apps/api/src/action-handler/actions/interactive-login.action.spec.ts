import { vi } from 'vitest';
import { InteractiveLoginAction } from './interactive-login.action';

describe('InteractiveLoginAction', () => {
  let action: InteractiveLoginAction;
  let mockPage: any;
  let requestLogin: any;

  beforeEach(() => {
    mockPage = {
      $: vi.fn().mockResolvedValue(null),
      evaluate: vi.fn().mockResolvedValue(''),
    };

    requestLogin = vi.fn().mockResolvedValue('angemeldet');

    action = Object.create(InteractiveLoginAction.prototype);
    (action as any).page = mockPage;
    (action as any).params = {};
    (action as any).data = {
      scrapeId: 'ikea',
      runId: 'run-1',
      scrapeEventsService: { requestLogin },
    };
    (action as any).logger = {
      log: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(InteractiveLoginAction).toBeDefined();
  });

  describe('run', () => {
    // Der wichtigste Fall: solange die Sitzung haelt, laeuft ein geplanter
    // Lauf unbeaufsichtigt durch und fragt NIEMANDEN.
    it('should skip entirely when the session proof is already there', async () => {
      mockPage.$ = vi.fn().mockResolvedValue({});
      action.params = { successSelector: "a[aria-label^='Datum']" };

      const result = await action.run();

      expect(result).toBe('uebersprungen');
      expect(requestLogin).not.toHaveBeenCalled();
    });

    it('should accept page text as the proof', async () => {
      mockPage.evaluate = vi
        .fn()
        .mockResolvedValue('5 von 70 Ergebnissen werden angezeigt');
      action.params = { successText: 'von 70 Ergebnissen' };

      await expect(action.run()).resolves.toBe('uebersprungen');
      expect(requestLogin).not.toHaveBeenCalled();
    });

    it('should ask for a sign-in when the proof is missing', async () => {
      action.params = {
        successSelector: '#konto',
        message: 'Bitte anmelden',
        timeout: 60000,
      };

      const result = await action.run();

      expect(result).toBe('angemeldet');
      expect(requestLogin).toHaveBeenCalledWith(
        'ikea',
        'Bitte anmelden',
        mockPage,
        'run-1',
        60000,
        expect.any(Function),
      );
    });

    // Ohne Nachweis kann der Lauf die Anmeldung nicht selbst erkennen; dann
    // darf auch keine Selbsterkennung mitgegeben werden, sonst wartet sie
    // ewig auf etwas, das sie nie prueft.
    it('should pass no self-check when there is nothing to check', async () => {
      action.params = {};

      await action.run();

      expect(requestLogin).toHaveBeenCalledWith(
        'ikea',
        expect.any(String),
        mockPage,
        'run-1',
        300000,
        undefined,
      );
      expect((action as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Neither successSelector nor successText'),
      );
    });

    it('should force the live view when skipIfLoggedIn is false', async () => {
      mockPage.$ = vi.fn().mockResolvedValue({});
      action.params = { successSelector: '#konto', skipIfLoggedIn: false };

      await expect(action.run()).resolves.toBe('angemeldet');
      expect(requestLogin).toHaveBeenCalled();
    });

    it('should honour a false condition like the other actions', async () => {
      action.params = { condition: false, successSelector: '#konto' };

      await expect(action.run()).resolves.toBe('uebersprungen');
      expect(requestLogin).not.toHaveBeenCalled();
    });

    // Ohne UI gibt es niemanden, der sich anmelden koennte. Das muss laut
    // scheitern: ein stiller Durchlauf ohne Sitzung meldet spaeter "0 Belege"
    // und sieht wie ein leeres Konto aus.
    it('should fail loudly when the run has no UI attached', async () => {
      (action as any).data = { scrapeId: 'ikea' };
      action.params = { successSelector: '#konto' };

      await expect(action.run()).rejects.toThrow(
        /Interactive login needs the web UI/,
      );
    });

    it('should report the result the service gives back', async () => {
      requestLogin.mockResolvedValue('erkannt');
      action.params = { successSelector: '#konto' };

      await expect(action.run()).resolves.toBe('erkannt');
    });

    it('should let a cancelled sign-in fail the run', async () => {
      requestLogin.mockRejectedValue(
        new Error('Interaktive Anmeldung vom Nutzer abgebrochen'),
      );
      action.params = { successSelector: '#konto' };

      await expect(action.run()).rejects.toThrow(/abgebrochen/);
    });

    // Waehrend einer Navigation werfen beide Pruefungen. Das heisst "noch
    // nicht", nicht "Fehler" — sonst bricht die Selbsterkennung den Lauf ab.
    it('should treat a throwing check as "not yet"', async () => {
      mockPage.$ = vi
        .fn()
        .mockRejectedValue(new Error('Execution context was destroyed'));
      action.params = { successSelector: '#konto' };

      await expect(action.run()).resolves.toBe('angemeldet');
      expect(requestLogin).toHaveBeenCalled();

      // Die mitgegebene Selbsterkennung darf ebenfalls nicht werfen.
      const selbsttest = requestLogin.mock.calls[0][5];
      await expect(selbsttest()).resolves.toBe(false);
    });
  });
});
