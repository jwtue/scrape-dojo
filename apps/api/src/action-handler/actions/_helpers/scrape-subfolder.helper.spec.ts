import { withScrapeSubfolder } from './scrape-subfolder.helper';

describe('withScrapeSubfolder', () => {
  it('should return the path unchanged without a scrapeId', () => {
    expect(withScrapeSubfolder('./downloads')).toBe('./downloads');
  });

  it('should insert the scrapeId behind a relative root', () => {
    expect(withScrapeSubfolder('./downloads', 'amazon')).toBe(
      './downloads/amazon',
    );
  });

  it('should insert the scrapeId behind the root, before the rest', () => {
    expect(withScrapeSubfolder('./downloads/invoices/2026', 'amazon')).toBe(
      './downloads/amazon/invoices/2026',
    );
  });

  it('should handle a path without a leading dot', () => {
    expect(withScrapeSubfolder('downloads/invoices', 'amazon')).toBe(
      'downloads/amazon/invoices',
    );
  });

  it('should handle parent directory segments', () => {
    expect(withScrapeSubfolder('../downloads/invoices', 'amazon')).toBe(
      '../downloads/amazon/invoices',
    );
  });

  it('should normalize backslashes', () => {
    expect(withScrapeSubfolder('.\\downloads\\invoices', 'amazon')).toBe(
      './downloads/amazon/invoices',
    );
  });

  it('should append the scrapeId when there is no usable segment', () => {
    expect(withScrapeSubfolder('/', 'amazon')).toContain('amazon');
  });
});
