import { vi } from 'vitest';
import { EvaluateAction } from './evaluate.action';

describe('EvaluateAction', () => {
  let action: EvaluateAction;
  let mockPage: any /*Partial<Page>*/;

  beforeEach(() => {
    mockPage = {
      evaluate: vi.fn(),
      waitForNavigation: vi.fn(),
    };

    action = Object.create(EvaluateAction.prototype);
    (action as any).page = mockPage;
    (action as any).params = {};
    (action as any).data = {};
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
    expect(EvaluateAction).toBeDefined();
  });

  describe('run', () => {
    it('should evaluate the expression in the page context and return its value', async () => {
      mockPage.evaluate = vi.fn().mockResolvedValue('Amazon');
      action.params = { expression: 'document.title' };

      const result = await action.run();

      expect(mockPage.evaluate).toHaveBeenCalledWith('document.title');
      expect(result).toBe('Amazon');
      expect((action as any).logger.log).toHaveBeenCalledWith(
        '🧩 Evaluating: document.title',
      );
      expect((action as any).logger.log).toHaveBeenCalledWith(
        '📤 Result: "Amazon"',
      );
    });

    it('should return objects unchanged and log a serialized preview', async () => {
      const value = { items: 2 };
      mockPage.evaluate = vi.fn().mockResolvedValue(value);
      action.params = { expression: '({ items: 2 })' };

      const result = await action.run();

      expect(result).toBe(value);
      expect((action as any).logger.log).toHaveBeenCalledWith(
        '📤 Result: "{"items":2}"',
      );
    });

    it('should return null when the expression yields undefined', async () => {
      mockPage.evaluate = vi.fn().mockResolvedValue(undefined);
      action.params = { expression: 'void 0' };

      const result = await action.run();

      expect(result).toBeNull();
      expect((action as any).logger.debug).toHaveBeenCalledWith(
        '✅ Evaluation completed (no return value)',
      );
    });

    it('should truncate long expressions in the log', async () => {
      const expression = `console.log('${'x'.repeat(120)}')`;
      mockPage.evaluate = vi.fn().mockResolvedValue(undefined);
      action.params = { expression };

      await action.run();

      expect((action as any).logger.log).toHaveBeenCalledWith(
        `🧩 Evaluating: ${expression.slice(0, 80)}…`,
      );
    });

    it('should truncate long results in the log', async () => {
      mockPage.evaluate = vi.fn().mockResolvedValue('y'.repeat(80));
      action.params = { expression: 'longText' };

      await action.run();

      expect((action as any).logger.log).toHaveBeenCalledWith(
        `📤 Result: "${'y'.repeat(50)}..."`,
      );
    });

    it('should throw when expression is missing', async () => {
      action.params = {} as any;

      await expect(action.run()).rejects.toThrow(
        'Missing required parameter: expression',
      );
    });

    it('should throw when page is not initialized', async () => {
      (action as any).page = null;
      action.params = { expression: 'document.title' };

      await expect(action.run()).rejects.toThrow('Page is not initialized');
    });

    it('should wait for a navigation triggered by the expression', async () => {
      mockPage.evaluate = vi.fn().mockResolvedValue(undefined);
      mockPage.waitForNavigation = vi.fn().mockResolvedValue(undefined);
      action.params = {
        expression: 'document.forms[0].submit()',
        waitForNavigation: true,
      };

      await action.run();

      expect(mockPage.waitForNavigation).toHaveBeenCalledWith({
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      expect((action as any).logger.debug).toHaveBeenCalledWith(
        '🧭 Navigation completed',
      );
    });

    it('should register the navigation listener before evaluating', async () => {
      const order: string[] = [];
      mockPage.waitForNavigation = vi.fn(() => {
        order.push('waitForNavigation');
        return Promise.resolve(undefined);
      });
      mockPage.evaluate = vi.fn(() => {
        order.push('evaluate');
        return Promise.resolve(undefined);
      });
      action.params = {
        expression: 'document.forms[0].submit()',
        waitForNavigation: true,
      };

      await action.run();

      expect(order).toEqual(['waitForNavigation', 'evaluate']);
    });

    it('should use custom waitUntil and timeout', async () => {
      mockPage.evaluate = vi.fn().mockResolvedValue(undefined);
      mockPage.waitForNavigation = vi.fn().mockResolvedValue(undefined);
      action.params = {
        expression: 'location.reload()',
        waitForNavigation: true,
        waitUntil: 'domcontentloaded',
        timeout: 5000,
      };

      await action.run();

      expect(mockPage.waitForNavigation).toHaveBeenCalledWith({
        waitUntil: 'domcontentloaded',
        timeout: 5000,
      });
    });

    it('should warn but not throw when the awaited navigation does not happen', async () => {
      mockPage.evaluate = vi.fn().mockResolvedValue(undefined);
      mockPage.waitForNavigation = vi
        .fn()
        .mockRejectedValue(
          new Error('Navigation timeout of 30000 ms exceeded'),
        );
      action.params = {
        expression: 'noop()',
        waitForNavigation: true,
      };

      await expect(action.run()).resolves.toBeNull();
      expect((action as any).logger.warn).toHaveBeenCalledWith(
        '⚠️ No navigation within 30000ms after evaluation',
      );
    });

    it('should not wait for navigation by default', async () => {
      mockPage.evaluate = vi.fn().mockResolvedValue(undefined);
      action.params = { expression: 'document.title' };

      await action.run();

      expect(mockPage.waitForNavigation).not.toHaveBeenCalled();
    });

    it('should throw when the expression fails', async () => {
      mockPage.evaluate = vi
        .fn()
        .mockRejectedValue(new Error('ReferenceError: foo is not defined'));
      action.params = { expression: 'foo()' };

      await expect(action.run()).rejects.toThrow(
        'ReferenceError: foo is not defined',
      );
      expect((action as any).logger.error).toHaveBeenCalledWith(
        '❌ Evaluation error: ReferenceError: foo is not defined',
      );
    });

    it('should return null and warn when an optional evaluation fails', async () => {
      mockPage.evaluate = vi.fn().mockRejectedValue(new Error('boom'));
      action.params = { expression: 'foo()', optional: true };

      const result = await action.run();

      expect(result).toBeNull();
      expect((action as any).logger.warn).toHaveBeenCalledWith(
        '⚠️ Optional evaluation failed: boom',
      );
    });
  });
});
