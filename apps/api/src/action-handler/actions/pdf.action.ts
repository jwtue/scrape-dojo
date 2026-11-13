import { PaperFormat } from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import { BaseAction } from './bases/base.action';
import { Action } from '../_decorators/action.decorator';
import { withScrapeSubfolder } from './_helpers/scrape-subfolder.helper';

// Typdefinition für die Parameter der PdfAction
export type PdfActionParams = {
  /** Dateiname; die Endung .pdf wird ergänzt, falls sie fehlt */
  filename: string;
  /** Zielverzeichnis, wie bei download um die scrapeId ergänzt */
  path?: string;
  /** Seitenformat, z.B. 'A4' oder 'Letter' */
  format?: PaperFormat;
  /** Querformat statt Hochformat */
  landscape?: boolean;
  /** Hintergrundgrafiken mitdrucken */
  printBackground?: boolean;
  /** Skalierung zwischen 0.1 und 2 */
  scale?: number;
  /** Seitenränder, z.B. { "top": "1cm" } */
  margin?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
  /** Medientyp, den die Seite beim Rendern sieht */
  media?: 'screen' | 'print';
  /** Timeout in ms */
  timeout?: number;
};

@Action('pdf', {
  displayName: 'PDF',
  icon: 'FileText',
  description: 'Save the current page as a PDF file',
  color: 'rose',
  category: 'utility',
})
export class PdfAction extends BaseAction<PdfActionParams> {
  async run(): Promise<string> {
    const filename = (this.params.filename || '').trim();

    if (!filename) {
      throw new Error('Filename parameter is required and cannot be empty');
    }

    if (!this.page) {
      throw new Error('Page is not initialized');
    }

    const basePath = this.params.path || './downloads';
    const targetPath = withScrapeSubfolder(basePath, this.data?.scrapeId);
    const absolutePath = path.resolve(targetPath);

    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(absolutePath, { recursive: true });
      this.logger.debug(`📁 Created directory: ${absolutePath}`);
    }

    const fullPath = path.join(
      absolutePath,
      filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`,
    );

    this.logger.log(`🖨️ Saving page as PDF: ${fullPath}`);

    // Ohne emulateMediaType rendert Chrome das Print-Stylesheet der Seite.
    // Für Belege und Rechnungen ist die Bildschirmfassung oft die bessere.
    if (this.params.media) {
      await this.page.emulateMediaType(this.params.media);
    }

    try {
      await this.page.pdf({
        path: fullPath,
        format: this.params.format ?? 'A4',
        landscape: this.params.landscape ?? false,
        printBackground: this.params.printBackground ?? true,
        scale: this.params.scale,
        margin: this.params.margin,
        timeout: this.params.timeout ?? 30000,
      });
    } finally {
      // Der Medientyp gilt für die ganze Seite, nicht nur für diesen Aufruf
      if (this.params.media) {
        await this.page.emulateMediaType(null);
      }
    }

    const size = fs.statSync(fullPath).size;
    this.logger.log(`✅ PDF saved (${Math.round(size / 1024)} KB)`);

    return fullPath;
  }
}

export default PdfAction;
