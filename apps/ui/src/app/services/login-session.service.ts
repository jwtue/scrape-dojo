import { Injectable, NgZone, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LoginFrame, LoginInput } from '@scrape-dojo/shared';

/**
 * Carries the live view of an interactive login: the frames of the paused page
 * in, the user's pointer and keyboard events back out.
 *
 * The frames ride on their own EventSource, separate from the workflow event
 * stream, because a screencast sends several frames a second and would drown
 * that stream's buffer.
 */
@Injectable({ providedIn: 'root' })
export class LoginSessionService {
  private http = inject(HttpClient);
  private ngZone = inject(NgZone);

  private eventSource: EventSource | null = null;

  /** The newest frame as a data URL, ready for an <img src>. */
  readonly frame = signal<string | null>(null);
  /** Size of the streamed page, needed to scale pointer coordinates. */
  readonly frameSize = signal<{ width: number; height: number } | null>(null);
  /** Did at least one frame arrive? Without one the user is typing blind. */
  readonly streaming = signal(false);

  async connect(requestId: string): Promise<void> {
    this.disconnect();

    // Same ticket dance as the workflow stream, so the JWT never lands in a
    // URL (query string, server logs, browser history).
    const res = await firstValueFrom(
      this.http.post<{ ticket: string }>('/api/events/ticket', {}),
    );

    this.ngZone.runOutsideAngular(() => {
      const url = `/api/login-stream/${encodeURIComponent(requestId)}?ticket=${encodeURIComponent(res.ticket)}`;
      this.eventSource = new EventSource(url);

      this.eventSource.onmessage = (event) => {
        this.ngZone.run(() => {
          try {
            const bild = JSON.parse(event.data) as LoginFrame;
            this.frame.set(`data:image/jpeg;base64,${bild.data}`);
            if (bild.width && bild.height) {
              this.frameSize.set({ width: bild.width, height: bild.height });
            }
            this.streaming.set(true);
          } catch {
            // A broken frame is not worth tearing the stream down for.
          }
        });
      };

      this.eventSource.onerror = () => {
        this.ngZone.run(() => this.streaming.set(false));
      };
    });
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
    this.frame.set(null);
    this.frameSize.set(null);
    this.streaming.set(false);
  }

  sendInput(requestId: string, eingabe: LoginInput): void {
    // Fire and forget: an input that does not arrive must not block the next
    // one, and the user sees the result in the stream anyway.
    this.http
      .post(`/api/login-input/${encodeURIComponent(requestId)}`, eingabe)
      .subscribe({ error: () => undefined });
  }

  done(requestId: string): Promise<unknown> {
    return firstValueFrom(
      this.http.post(`/api/login-done/${encodeURIComponent(requestId)}`, {}),
    );
  }

  cancel(requestId: string): Promise<unknown> {
    return firstValueFrom(
      this.http.post(`/api/login-cancel/${encodeURIComponent(requestId)}`, {}),
    );
  }
}
