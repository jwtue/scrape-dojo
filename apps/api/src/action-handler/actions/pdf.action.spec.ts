import { vi } from 'vitest';

vi.mock('../../_decorators/action.decorator', () => ({
  Action: () => (constructor: any) => constructor,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 2048 }),
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { PdfAction } from './pdf.action';

describe('PdfAction', () => {
  function createAction(params: any, scrapeId: string | null = 'amazon') {
    const action = Object.create(PdfAction.prototype);
    action.params = params;
    action.data = scrapeId ? { scrapeId } : {};
    action.previousData = new Map();
    action.page = {
      pdf: vi.fn().mockResolvedValue(Buffer.from('')),
      emulateMediaType: vi.fn().mockResolvedValue(undefined),
    };
    action.logger = {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
    return action as InstanceType<typeof PdfAction>;
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(PdfAction).toBeDefined();
  });

  it('should write the pdf below the scrape subfolder and return its path', async () => {
    const action = createAction({ filename: 'invoice-1.pdf' });

    const result = await action.run();

    const expected = path.resolve('./downloads/amazon/invoice-1.pdf');
    expect(result).toBe(expected);
    expect((action as any).page.pdf).toHaveBeenCalledWith(
      expect.objectContaining({ path: expected }),
    );
  });

  it('should append the .pdf extension when missing', async () => {
    const action = createAction({ filename: 'invoice-2' });

    const result = await action.run();

    expect(result).toBe(path.resolve('./downloads/amazon/invoice-2.pdf'));
  });

  it('should keep an uppercase extension as given', async () => {
    const action = createAction({ filename: 'invoice-3.PDF' });

    const result = await action.run();

    expect(result).toBe(path.resolve('./downloads/amazon/invoice-3.PDF'));
  });

  it('should honour a custom path', async () => {
    const action = createAction({
      filename: 'receipt.pdf',
      path: './downloads/receipts',
    });

    const result = await action.run();

    expect(result).toBe(
      path.resolve('./downloads/amazon/receipts/receipt.pdf'),
    );
  });

  it('should leave the path untouched without a scrapeId', async () => {
    const action = createAction({ filename: 'receipt.pdf' }, null);

    const result = await action.run();

    expect(result).toBe(path.resolve('./downloads/receipt.pdf'));
  });

  it('should create the target directory when it does not exist', async () => {
    (fs.existsSync as any).mockReturnValueOnce(false);
    const action = createAction({ filename: 'invoice.pdf' });

    await action.run();

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.resolve('./downloads/amazon'),
      { recursive: true },
    );
  });

  it('should use A4, portrait and background printing by default', async () => {
    const action = createAction({ filename: 'invoice.pdf' });

    await action.run();

    expect((action as any).page.pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'A4',
        landscape: false,
        printBackground: true,
        timeout: 30000,
      }),
    );
  });

  it('should pass through format, orientation, scale, margin and timeout', async () => {
    const action = createAction({
      filename: 'invoice.pdf',
      format: 'Letter',
      landscape: true,
      printBackground: false,
      scale: 0.8,
      margin: { top: '1cm' },
      timeout: 5000,
    });

    await action.run();

    expect((action as any).page.pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'Letter',
        landscape: true,
        printBackground: false,
        scale: 0.8,
        margin: { top: '1cm' },
        timeout: 5000,
      }),
    );
  });

  it('should emulate the requested media type and reset it afterwards', async () => {
    const action = createAction({ filename: 'invoice.pdf', media: 'screen' });

    await action.run();

    expect((action as any).page.emulateMediaType).toHaveBeenNthCalledWith(
      1,
      'screen',
    );
    expect((action as any).page.emulateMediaType).toHaveBeenNthCalledWith(
      2,
      null,
    );
  });

  it('should reset the media type even when the pdf fails', async () => {
    const action = createAction({ filename: 'invoice.pdf', media: 'screen' });
    (action as any).page.pdf = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(action.run()).rejects.toThrow('boom');
    expect((action as any).page.emulateMediaType).toHaveBeenLastCalledWith(
      null,
    );
  });

  it('should not touch the media type when none is requested', async () => {
    const action = createAction({ filename: 'invoice.pdf' });

    await action.run();

    expect((action as any).page.emulateMediaType).not.toHaveBeenCalled();
  });

  it('should log the resulting file size', async () => {
    const action = createAction({ filename: 'invoice.pdf' });

    await action.run();

    expect((action as any).logger.log).toHaveBeenCalledWith(
      '✅ PDF saved (2 KB)',
    );
  });

  it('should throw when filename is empty', async () => {
    const action = createAction({ filename: '   ' });

    await expect(action.run()).rejects.toThrow(
      'Filename parameter is required and cannot be empty',
    );
  });

  it('should throw when page is not initialized', async () => {
    const action = createAction({ filename: 'invoice.pdf' });
    (action as any).page = null;

    await expect(action.run()).rejects.toThrow('Page is not initialized');
  });
});
