import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  ViewChild,
  CUSTOM_ELEMENTS_SCHEMA,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LoginRequest } from '@scrape-dojo/shared';
import { ModalComponent, ButtonComponent } from '../shared';
import { TranslocoModule } from '@jsverse/transloco';
import { LoginSessionService } from '../../services/login-session.service';
import 'iconify-icon';

/**
 * Live view of a paused run's page, so the user can sign in by hand.
 *
 * The page arrives as JPEG frames and is shown in an <img>; pointer and
 * keyboard events are scaled to the page's own coordinates and sent back. The
 * user types into the real page — no credential passes through the workflow
 * config, and nothing is stored here.
 */
@Component({
  selector: 'app-login-modal',
  standalone: true,
  imports: [CommonModule, ModalComponent, ButtonComponent, TranslocoModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './login-modal.html',
})
export class LoginModalComponent {
  private sitzung = inject(LoginSessionService);

  loginRequest = input<LoginRequest | null>(null);

  close = output<void>();

  @ViewChild('bild') bild?: ElementRef<HTMLImageElement>;

  isOpen = computed(() => this.loginRequest() !== null);
  frame = this.sitzung.frame;
  streaming = this.sitzung.streaming;

  /** Seconds left, or null when the request waits without a limit. */
  restSekunden = signal<number | null>(null);
  private uhr: ReturnType<typeof setInterval> | null = null;

  // The pointer is only forwarded while the mouse is over the view, and moves
  // are throttled: a screencast at 60 moves a second would flood the endpoint
  // without making the view any more responsive.
  private letzterZug = 0;

  constructor() {
    // Open and close the frame stream along with the request.
    effect(() => {
      const anfrage = this.loginRequest();
      if (anfrage) {
        void this.sitzung.connect(anfrage.requestId);
        this.starteUhr(anfrage);
      } else {
        this.sitzung.disconnect();
        this.stoppeUhr();
      }
    });
  }

  private starteUhr(anfrage: LoginRequest): void {
    this.stoppeUhr();
    if (!anfrage.expiresAt) {
      this.restSekunden.set(null);
      return;
    }
    const tick = () => {
      const rest = Math.max(
        0,
        Math.round(((anfrage.expiresAt as number) - Date.now()) / 1000),
      );
      this.restSekunden.set(rest);
    };
    tick();
    this.uhr = setInterval(tick, 1000);
  }

  private stoppeUhr(): void {
    if (this.uhr) clearInterval(this.uhr);
    this.uhr = null;
  }

  /**
   * Translate a browser event's position into page coordinates.
   *
   * The <img> is scaled to fit the modal, so a click at its top left is not a
   * click at the page's top left unless we divide by that scale.
   */
  private zuSeitenKoordinaten(
    ereignis: MouseEvent,
  ): { x: number; y: number } | null {
    const el = this.bild?.nativeElement;
    if (!el) return null;

    const rechteck = el.getBoundingClientRect();
    if (!rechteck.width || !rechteck.height) return null;

    const groesse = this.sitzung.frameSize() ?? this.loginRequest()?.viewport;
    if (!groesse) return null;

    return {
      x: ((ereignis.clientX - rechteck.left) / rechteck.width) * groesse.width,
      y: ((ereignis.clientY - rechteck.top) / rechteck.height) * groesse.height,
    };
  }

  private sende(eingabe: Parameters<LoginSessionService['sendInput']>[1]): void {
    const anfrage = this.loginRequest();
    if (!anfrage) return;
    this.sitzung.sendInput(anfrage.requestId, eingabe);
  }

  onMouseDown(e: MouseEvent): void {
    const p = this.zuSeitenKoordinaten(e);
    if (!p) return;
    e.preventDefault();
    this.sende({ kind: 'mouse', type: 'mousePressed', ...p, clickCount: 1 });
  }

  onMouseUp(e: MouseEvent): void {
    const p = this.zuSeitenKoordinaten(e);
    if (!p) return;
    e.preventDefault();
    this.sende({ kind: 'mouse', type: 'mouseReleased', ...p, clickCount: 1 });
  }

  onMouseMove(e: MouseEvent): void {
    const jetzt = Date.now();
    if (jetzt - this.letzterZug < 60) return;
    this.letzterZug = jetzt;

    const p = this.zuSeitenKoordinaten(e);
    if (!p) return;
    this.sende({ kind: 'mouse', type: 'mouseMoved', ...p, button: 'none' });
  }

  onWheel(e: WheelEvent): void {
    const p = this.zuSeitenKoordinaten(e);
    if (!p) return;
    e.preventDefault();
    this.sende({
      kind: 'mouse',
      type: 'mouseWheel',
      ...p,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  }

  /**
   * Keyboard. A printable character goes in as text; everything else is sent
   * as a key event, which is what makes Tab, Enter and Backspace work.
   */
  onKeyDown(e: KeyboardEvent): void {
    if (!this.loginRequest()) return;

    // Let the browser's own shortcuts through, so the user keeps their
    // reload, copy and paste.
    if (e.ctrlKey || e.metaKey) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.key.length === 1) {
      this.sende({ kind: 'key', type: 'char', text: e.key, key: e.key });
      return;
    }

    this.sende({ kind: 'key', type: 'keyDown', key: e.key, code: e.code });
    this.sende({ kind: 'key', type: 'keyUp', key: e.key, code: e.code });
  }

  onPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    e.preventDefault();
    this.sende({ kind: 'text', text });
  }

  async fertig(): Promise<void> {
    const anfrage = this.loginRequest();
    if (!anfrage) return;
    await this.sitzung.done(anfrage.requestId).catch(() => undefined);
    this.close.emit();
  }

  async abbrechen(): Promise<void> {
    const anfrage = this.loginRequest();
    if (!anfrage) return;
    await this.sitzung.cancel(anfrage.requestId).catch(() => undefined);
    this.close.emit();
  }
}
