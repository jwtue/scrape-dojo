import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { watch, FSWatcher } from 'node:fs';
import { join } from 'path';
import { existsSync, statSync } from 'fs';
import type { CDPSession, Page } from 'puppeteer';
import { SecretRedactionService } from '../_logger/secret-redaction.service';

export type LogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose';

export type ActionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'waiting'
  | 'skipped';

export interface ScrapeEvent {
  type:
    | 'step-status'
    | 'action-status'
    | 'otp-required'
    | 'otp-received'
    | 'otp-timeout'
    | 'login-required'
    | 'login-done'
    | 'login-timeout'
    | 'scrape-start'
    | 'scrape-end'
    | 'loop-iteration'
    | 'error'
    | 'reload'
    | 'log'
    | 'notification'
    | 'config-reload';
  scrapeId: string;
  runId?: string; // Eindeutige ID für jeden Scrape-Lauf
  stepName?: string;
  stepIndex?: number;
  actionName?: string;
  actionIndex?: number;
  actionType?: string;
  status?: ActionStatus;
  message?: string;
  error?: string;
  result?: unknown; // Ergebnis der Action
  loopName?: string;
  loopIndex?: number;
  loopTotal?: number;
  loopValue?: string;
  /** Pfad zu verschachtelten Loops: [{name: 'pageLoop', index: 0}, {name: 'pdfLoop', index: 3}] */
  loopPath?: Array<{ name: string; index: number }>;
  timestamp: number;
  // Log-spezifische Felder
  logLevel?: LogLevel;
  logContext?: string;
  // Notification-spezifische Felder
  notification?: NotificationData;
  /** Variablen-Informationen beim Scrape-Start */
  variables?: {
    /** Variablen aus dem Run-Dialog */
    runtime?: Record<string, any>;
    /** Variablen aus der Datenbank */
    database?: Record<string, any>;
    /** Finales gemergtes Resultat (runtime überschreibt database) */
    final?: Record<string, any>;
  };
}

export interface OtpAlternative {
  id: string;
  label: string;
  selector: string;
  icon?: string;
}

export interface OtpRequest {
  scrapeId: string;
  requestId: string;
  message: string;
  selector: string;
  alternatives?: OtpAlternative[];
}

export interface LoginRequest {
  scrapeId: string;
  requestId: string;
  message: string;
  url: string;
  viewport: { width: number; height: number };
  expiresAt?: number;
}

export interface LoginFrame {
  requestId: string;
  data: string;
  width: number;
  height: number;
}

export type LoginInput =
  | {
      kind: 'mouse';
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
      x: number;
      y: number;
      button?: 'none' | 'left' | 'middle' | 'right';
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
    }
  | {
      kind: 'key';
      type: 'keyDown' | 'keyUp' | 'char';
      key?: string;
      code?: string;
      text?: string;
    }
  | { kind: 'text'; text: string };

export interface NotificationData {
  notificationId: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  iconUrl?: string;
  browserNotification?: boolean;
  autoDismiss?: number;
}

@Injectable()
export class ScrapeEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScrapeEventsService.name);

  private eventSubject = new Subject<ScrapeEvent>();

  constructor(
    @Optional()
    @Inject(SecretRedactionService)
    private readonly secretRedaction?: SecretRedactionService,
  ) {}

  private pendingOtpRequests = new Map<
    string,
    {
      resolve: (code: string) => void;
      page: Page;
      alternatives?: OtpAlternative[];
      timer?: NodeJS.Timeout;
    }
  >();
  private pendingLoginRequests = new Map<
    string,
    {
      resolve: (ergebnis: string) => void;
      reject: (fehler: Error) => void;
      page: Page;
      cdp?: CDPSession;
      timer?: NodeJS.Timeout;
      scrapeId: string;
      runId?: string;
    }
  >();

  // Bildfolgen laufen über einen EIGENEN Kanal, nicht über eventSubject:
  // emit() legt jedes Nicht-Log-Event im Workflow-Puffer ab (1000 Einträge),
  // und ein Screencast mit mehreren Bildern je Sekunde würde ihn binnen
  // Sekunden leeren. Ausserdem haben Bilder in der Redaction nichts zu suchen.
  private loginFrameSubject = new Subject<LoginFrame>();

  private fileWatchers: FSWatcher[] = [];
  private reloadDebounce: NodeJS.Timeout | null = null;

  // In-Memory Buffer für Workflow-Events (für Reload-Persistenz)
  private workflowEventsBuffer: ScrapeEvent[] = [];
  private readonly maxWorkflowEvents = 1000;

  // Log-Level Filter für SSE-Stream (debug und verbose werden nicht gestreamt)
  private readonly streamLogLevels: LogLevel[] = ['log', 'warn', 'error'];

  onModuleInit() {
    // Nur im Development-Modus aktivieren
    if (process.env.SCRAPE_DOJO_NODE_ENV !== 'production') {
      this.startFileWatcher();
    }
  }

  onModuleDestroy() {
    this.fileWatchers.forEach((watcher) => watcher.close());
    this.fileWatchers = [];
  }

  /**
   * File-Watcher für HMR-ähnliches Live-Reload
   */
  private startFileWatcher() {
    const watchPaths = [join(process.cwd(), 'config', 'sites')];

    this.logger.log(`👀 Starting file watcher for HMR...`);

    // Verzeichnisse überwachen (rekursiv)
    for (const watchPath of watchPaths) {
      if (existsSync(watchPath) && statSync(watchPath).isDirectory()) {
        try {
          const watcher = watch(
            watchPath,
            { recursive: true },
            (eventType, filename) => {
              if (filename) {
                const fullPath = join(watchPath, filename);
                this.logger.debug(`📝 File ${eventType}: ${fullPath}`);
                this.triggerReload(fullPath);
              }
            },
          );
          this.fileWatchers.push(watcher);
          this.logger.log(`👀 Watching directory: ${watchPath}`);
        } catch (err) {
          this.logger.warn(`⚠️ Could not watch ${watchPath}: ${err}`);
        }
      }
    }
  }

  /**
   * Trigger reload mit Debounce
   */
  private triggerReload(changedPath: string) {
    if (this.reloadDebounce) {
      clearTimeout(this.reloadDebounce);
    }

    this.reloadDebounce = setTimeout(() => {
      this.logger.log(`🔄 Triggering reload for: ${changedPath}`);
      this.emit({
        type: 'config-reload',
        scrapeId: '__system__',
        message: `Configuration changed: ${changedPath}`,
      });
    }, 300); // 300ms debounce
  }
  // SSE Connection Tracking
  private activeConnections = 0;
  private lastPingTime = 0;

  /**
   * Observable für alle Scrape-Events
   */
  getEvents(): Observable<ScrapeEvent> {
    return new Observable<ScrapeEvent>((subscriber) => {
      this.activeConnections++;
      this.logger.debug(
        `📡 SSE client connected. Active connections: ${this.activeConnections}`,
      );

      const subscription = this.eventSubject
        .asObservable()
        .subscribe(subscriber);

      // Cleanup when client disconnects
      return () => {
        this.activeConnections = Math.max(0, this.activeConnections - 1);
        this.logger.debug(
          `📡 SSE client disconnected. Active connections: ${this.activeConnections}`,
        );
        subscription.unsubscribe();
      };
    });
  }

  /**
   * Ping zur SSE-Verbindungsprüfung - sendet ein Heartbeat-Event
   */
  pingConnections(): { activeConnections: number; lastPingTime: number } {
    this.lastPingTime = Date.now();

    // Sende Ping-Event an alle Clients
    this.eventSubject.next({
      type: 'log',
      scrapeId: '__system__',
      message: 'ping',
      logLevel: 'debug',
      timestamp: this.lastPingTime,
    });

    return {
      activeConnections: this.activeConnections,
      lastPingTime: this.lastPingTime,
    };
  }

  /**
   * SSE-Status abrufen
   */
  getConnectionStatus(): { activeConnections: number; lastPingTime: number } {
    return {
      activeConnections: this.activeConnections,
      lastPingTime: this.lastPingTime,
    };
  }

  /**
   * Emit eines Events
   */
  emit(event: Omit<ScrapeEvent, 'timestamp'>) {
    const fullEvent: ScrapeEvent = {
      ...event,
      timestamp: Date.now(),
    };

    // Log-Events: debug/verbose nicht an SSE-Stream senden (EventLogger schreibt bereits in Datei)
    if (
      event.type === 'log' &&
      event.logLevel &&
      !this.streamLogLevels.includes(event.logLevel)
    ) {
      return;
    }

    // Redact secrets from the event before sending to SSE clients
    const redactedEvent = this.redactEvent(fullEvent);

    // Workflow-Events im Buffer speichern (für Reload-Persistenz)
    if (event.type !== 'log') {
      this.workflowEventsBuffer.push(redactedEvent);
      // Buffer-Größe begrenzen
      if (this.workflowEventsBuffer.length > this.maxWorkflowEvents) {
        this.workflowEventsBuffer.shift();
      }
      this.logger.debug(
        `📡 Event: ${event.type} - ${event.status || event.message || ''}`,
      );
    }
    this.eventSubject.next(redactedEvent);
  }

  /**
   * Redact all secret values from a ScrapeEvent before broadcasting.
   */
  private redactEvent(event: ScrapeEvent): ScrapeEvent {
    if (!this.secretRedaction?.hasSecrets()) {
      return event;
    }

    return this.secretRedaction.redactObject(event);
  }

  /**
   * Log-Event emittieren (wird vom EventLogger aufgerufen)
   */
  emitLog(level: LogLevel, message: string, context: string) {
    const logEvent: ScrapeEvent = {
      type: 'log',
      scrapeId: '',
      message,
      logLevel: level,
      logContext: context,
      timestamp: Date.now(),
    };

    // Redact secrets before sending to SSE clients
    const redactedEvent = this.redactEvent(logEvent);

    // An SSE-Clients senden (EventLogger hat bereits in Datei geschrieben)
    this.eventSubject.next(redactedEvent);
  }

  /**
   * Gespeicherte Logs aus Datei lesen (delegiert an EventLogger)
   * @deprecated Verwendet EventLogger.readLogs() intern
   */
  getStoredLogs(limit = 500): ScrapeEvent[] {
    // EventLogger verwendet ein anderes Format - konvertiere zu ScrapeEvent
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const EventLogger = require('../_logger/event-logger').EventLogger;
    const logs = EventLogger.readLogs(limit);

    return logs.map(
      (log: {
        timestamp: string;
        level: string;
        context: string;
        message: string;
      }) => ({
        type: 'log' as const,
        scrapeId: '',
        message: log.message,
        logLevel: log.level as LogLevel,
        logContext: log.context,
        timestamp: new Date(log.timestamp).getTime(),
      }),
    );
  }

  /**
   * Alle gespeicherten Logs löschen (delegiert an EventLogger)
   */
  clearStoredLogs() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const EventLogger = require('../_logger/event-logger').EventLogger;
    EventLogger.clearLogs();
  }

  /**
   * Gespeicherte Workflow-Events aus Buffer lesen
   * Diese Events bleiben bis zum Server-Neustart erhalten
   */
  getWorkflowEvents(limit = 500): ScrapeEvent[] {
    const events = this.workflowEventsBuffer.slice(-limit);
    return events;
  }

  /**
   * Workflow-Events Buffer leeren
   */
  clearWorkflowEvents() {
    this.workflowEventsBuffer = [];
  }

  /**
   * Workflow-Events für einen bestimmten Run löschen
   */
  clearWorkflowEventsForRun(runId: string) {
    const before = this.workflowEventsBuffer.length;
    this.workflowEventsBuffer = this.workflowEventsBuffer.filter(
      (e) => e.runId !== runId,
    );
    const after = this.workflowEventsBuffer.length;
    this.logger.debug(
      `🗑️ Cleared ${before - after} workflow events for run: ${runId}`,
    );
  }

  /**
   * Workflow-Events für einen bestimmten Scrape löschen
   */
  clearWorkflowEventsForScrape(scrapeId: string) {
    const before = this.workflowEventsBuffer.length;
    this.workflowEventsBuffer = this.workflowEventsBuffer.filter(
      (e) => e.scrapeId !== scrapeId,
    );
    const after = this.workflowEventsBuffer.length;
    this.logger.debug(
      `🗑️ Cleared ${before - after} workflow events for scrape: ${scrapeId}`,
    );
  }

  /**
   * Scrape gestartet
   */
  scrapeStarted(
    scrapeId: string,
    runId?: string,
    variables?: {
      runtime?: Record<string, any>;
      database?: Record<string, any>;
      final?: Record<string, any>;
    },
  ) {
    this.emit({
      type: 'scrape-start',
      scrapeId,
      runId,
      message: `Scrape "${scrapeId}" gestartet`,
      variables,
    });
  }

  /**
   * Scrape beendet
   */
  scrapeEnded(
    scrapeId: string,
    success: boolean,
    error?: string,
    runId?: string,
  ) {
    this.emit({
      type: 'scrape-end',
      scrapeId,
      runId,
      status: success ? 'completed' : 'error',
      message: success
        ? `Scrape "${scrapeId}" abgeschlossen`
        : `Scrape "${scrapeId}" fehlgeschlagen`,
      error,
    });
  }

  /**
   * Step-Status aktualisieren
   */
  updateStepStatus(
    scrapeId: string,
    stepName: string,
    stepIndex: number,
    status: ActionStatus,
    runId?: string,
  ) {
    this.emit({
      type: 'step-status',
      scrapeId,
      runId,
      stepName,
      stepIndex,
      status,
    });
  }

  /**
   * Action-Status aktualisieren
   */
  updateActionStatus(
    scrapeId: string,
    stepName: string,
    stepIndex: number,
    actionName: string,
    actionIndex: number,
    actionType: string,
    status: ActionStatus,
    error?: string,
    runId?: string,
    result?: unknown,
  ) {
    this.emit({
      type: 'action-status',
      scrapeId,
      runId,
      stepName,
      stepIndex,
      actionName,
      actionIndex,
      actionType,
      status,
      error,
      result,
    });
  }

  /**
   * Loop-Iteration aktualisieren
   */
  updateLoopIteration(
    scrapeId: string,
    loopName: string,
    loopIndex: number,
    loopTotal: number,
    loopValue?: string,
    runId?: string,
    loopPath?: Array<{ name: string; index: number }>,
    status: 'running' | 'completed' | 'error' = 'running',
  ) {
    this.emit({
      type: 'loop-iteration',
      scrapeId,
      runId,
      loopName,
      loopIndex,
      loopTotal,
      loopValue,
      loopPath, // Sende den Parent-Loop-Pfad für verschachtelte Loops
      status,
      message: `🔄 Loop "${loopName}": ${loopIndex + 1}/${loopTotal}${loopPath?.length ? ` (nested in ${loopPath.map((p) => p.name).join(' > ')})` : ''} [${status}]`,
    });
  }

  /**
   * OTP anfordern - gibt ein Promise zurück das mit dem Code resolved
   */
  async requestOtp(
    scrapeId: string,
    message: string,
    selector: string,
    runId?: string,
    page?: Page,
    alternatives?: OtpAlternative[],
    timeoutMs?: number,
  ): Promise<string> {
    const requestId = `otp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    this.logger.log(`🔐 OTP angefordert: ${requestId}`);

    return new Promise((resolve, reject) => {
      // Begrenzt die Wartezeit. Ohne sie wartet ein unbeaufsichtigter Lauf
      // endlos: der geplante Lauf haengt, bis jemand den Code eintippt oder
      // den Lauf abbricht. Der Timer lebt hier und nicht in der Aktion, weil
      // nur hier die requestId und damit der wartende Eintrag bekannt ist.
      // 0 oder kein Wert heisst bewusst: ohne Grenze warten.
      const timer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              this.pendingOtpRequests.delete(requestId);
              this.logger.warn(
                `\u23f1\ufe0f OTP-Eingabe nicht innerhalb von ${timeoutMs} ms erfolgt: ${requestId}`,
              );
              this.emit({
                type: 'otp-timeout',
                scrapeId,
                runId,
                message: `Keine OTP-Eingabe innerhalb von ${timeoutMs} ms`,
              });
              reject(
                new Error(
                  `Keine OTP-Eingabe innerhalb von ${timeoutMs} ms (Request ${requestId})`,
                ),
              );
            }, timeoutMs)
          : undefined;

      // Speichere den Resolver + Page-Referenz
      this.pendingOtpRequests.set(requestId, {
        resolve,
        page,
        alternatives,
        timer,
      });

      // Emit das Event
      this.emit({
        type: 'otp-required',
        scrapeId,
        runId,
        message: JSON.stringify({
          requestId,
          message,
          selector,
          alternatives,
        } as OtpRequest),
      });
    });
  }

  /**
   * OTP-Code empfangen (von der UI)
   */
  submitOtp(requestId: string, code: string) {
    this.logger.log(`🔑 OTP empfangen für Request: ${requestId}`);

    const pending = this.pendingOtpRequests.get(requestId);
    if (pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.resolve(code);
      this.pendingOtpRequests.delete(requestId);

      this.emit({
        type: 'otp-received',
        scrapeId: '',
        message: `OTP-Code empfangen`,
      });
    } else {
      this.logger.warn(`⚠️ Kein ausstehender OTP-Request für ID: ${requestId}`);
    }
  }

  /**
   * OTP-Alternative ausführen (z.B. WhatsApp-Button klicken)
   */
  async executeOtpAction(
    requestId: string,
    selector: string,
  ): Promise<boolean> {
    const pending = this.pendingOtpRequests.get(requestId);
    if (!pending?.page) {
      this.logger.warn(
        `⚠️ Kein ausstehender OTP-Request oder keine Page für ID: ${requestId}`,
      );
      return false;
    }

    try {
      this.logger.log(`🔘 Klicke OTP-Alternative: ${selector}`);
      await pending.page.click(selector);
      this.logger.log(`✅ OTP-Alternative geklickt: ${selector}`);
      return true;
    } catch (error) {
      this.logger.error(
        `❌ Fehler beim Klicken der OTP-Alternative: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Interaktive Anmeldung anfordern: der Lauf haelt an, die UI bekommt die
   * laufende Seite als Bildfolge und gibt Maus- und Tastatureingaben zurueck.
   *
   * Warum nicht einfach skripten: Portale wie IKEA sichern ihre Anmeldung mit
   * einer Bot-Pruefung (Cloudflare Turnstile) oder verlangen einen Passkey.
   * Beides laesst sich nicht nachbauen, und es soll sich auch nicht nachbauen
   * lassen — der Sinn ist, dass ein Mensch sich anmeldet. Der Lauf zeigt daher
   * die Seite, auf der er schon steht, und macht mit der Sitzung weiter, die
   * dabei entsteht.
   *
   * @param fertigWenn Optionaler Test, der zyklisch geprueft wird. Trifft er
   *        zu, endet die Wartezeit von selbst — der Nutzer muss nichts
   *        bestaetigen. Damit laeuft eine erfolgreiche Anmeldung durch, ohne
   *        dass jemand auf "fertig" klickt.
   */
  async requestLogin(
    scrapeId: string,
    message: string,
    page: Page,
    runId?: string,
    timeoutMs?: number,
    fertigWenn?: () => Promise<boolean>,
  ): Promise<string> {
    const requestId = `login-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const viewport = page.viewport() ?? { width: 1280, height: 800 };
    const url = page.url();

    this.logger.log(`🧑‍💻 Interaktive Anmeldung angefordert: ${requestId}`);

    return new Promise<string>((resolve, reject) => {
      // Wie beim OTP: ohne Grenze wartet ein unbeaufsichtigter Lauf endlos.
      // 0 oder kein Wert heisst bewusst "ohne Grenze".
      const timer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              this.logger.warn(
                `⏱️ Keine Anmeldung innerhalb von ${timeoutMs} ms: ${requestId}`,
              );
              void this.beendeLogin(requestId);
              this.emit({
                type: 'login-timeout',
                scrapeId,
                runId,
                message: `Keine Anmeldung innerhalb von ${timeoutMs} ms`,
              });
              reject(
                new Error(
                  `Keine Anmeldung innerhalb von ${timeoutMs} ms (Request ${requestId})`,
                ),
              );
            }, timeoutMs)
          : undefined;

      this.pendingLoginRequests.set(requestId, {
        resolve,
        reject,
        page,
        timer,
        scrapeId,
        runId,
      });

      // Selbsterkennung: trifft der Test zu, ist die Anmeldung durch.
      if (fertigWenn) {
        const prueferId = setInterval(async () => {
          if (!this.pendingLoginRequests.has(requestId)) {
            clearInterval(prueferId);
            return;
          }
          let durch = false;
          try {
            durch = await fertigWenn();
          } catch {
            // Waehrend einer Navigation schlaegt der Test fehl; das ist kein
            // Grund aufzugeben, beim naechsten Durchgang steht die Seite.
            durch = false;
          }
          if (durch) {
            clearInterval(prueferId);
            this.logger.log(`✅ Anmeldung selbst erkannt: ${requestId}`);
            this.completeLogin(requestId, 'erkannt');
          }
        }, 2000);
      }

      // Bildfolge starten und die UI benachrichtigen. Schlaegt der Screencast
      // fehl, wird NICHT abgebrochen: ohne Bild ist die Anmeldung muehsam,
      // aber der Lauf wartet weiter und die Selbsterkennung greift trotzdem.
      void this.starteBildfolge(requestId, page);

      this.emit({
        type: 'login-required',
        scrapeId,
        runId,
        message: JSON.stringify({
          scrapeId,
          requestId,
          message,
          url,
          viewport: { width: viewport.width, height: viewport.height },
          expiresAt:
            timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : undefined,
        } as LoginRequest),
      });
    });
  }

  /**
   * Bildfolge der angehaltenen Seite per CDP-Screencast.
   */
  private async starteBildfolge(requestId: string, page: Page): Promise<void> {
    const wartend = this.pendingLoginRequests.get(requestId);
    if (!wartend) return;

    try {
      const cdp = await page.createCDPSession();
      wartend.cdp = cdp;

      cdp.on('Page.screencastFrame', (frame: any) => {
        this.loginFrameSubject.next({
          requestId,
          data: frame.data,
          width: frame.metadata?.deviceWidth ?? 0,
          height: frame.metadata?.deviceHeight ?? 0,
        });
        // Ohne Bestaetigung schickt Chrome kein weiteres Bild.
        void cdp
          .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
          .catch(() => undefined);
      });

      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 1,
      });
      this.logger.debug(`🎥 Screencast laeuft: ${requestId}`);
    } catch (fehler) {
      this.logger.warn(
        `⚠️ Screencast nicht gestartet (${requestId}): ${(fehler as Error).message}`,
      );
    }
  }

  /**
   * Eine Eingabe aus der UI in die angehaltene Seite geben.
   */
  async forwardLoginInput(
    requestId: string,
    eingabe: LoginInput,
  ): Promise<boolean> {
    const wartend = this.pendingLoginRequests.get(requestId);
    if (!wartend) {
      this.logger.warn(`⚠️ Keine wartende Anmeldung fuer: ${requestId}`);
      return false;
    }

    try {
      const cdp = wartend.cdp;
      if (!cdp) return false;

      if (eingabe.kind === 'mouse') {
        await cdp.send('Input.dispatchMouseEvent', {
          type: eingabe.type,
          x: Math.round(eingabe.x),
          y: Math.round(eingabe.y),
          button: eingabe.button ?? 'left',
          clickCount: eingabe.clickCount ?? 1,
          deltaX: eingabe.deltaX ?? 0,
          deltaY: eingabe.deltaY ?? 0,
          modifiers: 0,
        });
      } else if (eingabe.kind === 'key') {
        await cdp.send('Input.dispatchKeyEvent', {
          type: eingabe.type,
          key: eingabe.key,
          code: eingabe.code,
          text: eingabe.text,
        });
      } else {
        await cdp.send('Input.insertText', { text: eingabe.text });
      }
      return true;
    } catch (fehler) {
      this.logger.warn(
        `⚠️ Eingabe nicht zugestellt (${requestId}): ${(fehler as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Bildfolge einer wartenden Anmeldung.
   */
  getLoginFrames(requestId: string): Observable<LoginFrame> {
    return new Observable<LoginFrame>((subscriber) => {
      const sub = this.loginFrameSubject.asObservable().subscribe((bild) => {
        if (bild.requestId === requestId) subscriber.next(bild);
      });
      return () => sub.unsubscribe();
    });
  }

  /**
   * Die Anmeldung ist durch — der Lauf geht weiter.
   */
  completeLogin(requestId: string, ergebnis = 'angemeldet'): boolean {
    const wartend = this.pendingLoginRequests.get(requestId);
    if (!wartend) {
      this.logger.warn(`⚠️ Keine wartende Anmeldung fuer: ${requestId}`);
      return false;
    }

    const { scrapeId, runId, resolve } = wartend;
    void this.beendeLogin(requestId);
    resolve(ergebnis);

    this.emit({
      type: 'login-done',
      scrapeId,
      runId,
      message: `Anmeldung abgeschlossen (${ergebnis})`,
    });
    return true;
  }

  /**
   * Abbruch durch den Nutzer. Der Lauf scheitert dann mit Begruendung, statt
   * stumm ohne Sitzung weiterzulaufen.
   */
  cancelLogin(requestId: string, grund = 'vom Nutzer abgebrochen'): boolean {
    const wartend = this.pendingLoginRequests.get(requestId);
    if (!wartend) return false;

    const { scrapeId, runId, reject } = wartend;
    void this.beendeLogin(requestId);
    this.emit({
      type: 'login-done',
      scrapeId,
      runId,
      message: `Anmeldung abgebrochen: ${grund}`,
    });
    reject(new Error(`Interaktive Anmeldung ${grund}`));
    return true;
  }

  /**
   * Screencast beenden, CDP-Sitzung loesen, Eintrag entfernen. Wird aus jedem
   * Ausgang aufgerufen (fertig, abgebrochen, Zeit abgelaufen).
   */
  private async beendeLogin(requestId: string): Promise<void> {
    const wartend = this.pendingLoginRequests.get(requestId);
    if (!wartend) return;
    this.pendingLoginRequests.delete(requestId);

    if (wartend.timer) clearTimeout(wartend.timer);

    if (wartend.cdp) {
      try {
        await wartend.cdp.send('Page.stopScreencast');
      } catch {
        // Seite kann schon weg sein — nicht weiter wichtig.
      }
      try {
        await wartend.cdp.detach();
      } catch {
        // dito
      }
    }
  }

  /**
   * Send a notification to the frontend
   */
  async sendNotification(
    scrapeId: string,
    runId: string | undefined,
    options: {
      type: 'info' | 'success' | 'warning' | 'error';
      title: string;
      message: string;
      browserNotification?: boolean;
      autoDismiss?: number;
      iconUrl?: string;
    },
  ): Promise<void> {
    const notificationId = `notify-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    this.logger.log(
      `🔔 Sending notification: ${options.title} (${notificationId})`,
    );

    const notification: NotificationData = {
      notificationId,
      type: options.type,
      title: options.title,
      message: options.message,
      iconUrl: options.iconUrl,
      browserNotification: options.browserNotification ?? false,
      autoDismiss: options.autoDismiss ?? 5000,
    };

    this.emit({
      type: 'notification',
      scrapeId,
      runId,
      notification,
      message: `${options.type.toUpperCase()}: ${options.title}`,
    });
  }
}
