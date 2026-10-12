import { expect, test } from '@playwright/test';
import { fitWordImage, WORD_PAGE } from '../src/features/utility/wordFormat';

test('Word 图片布局：横图、长图按版心和图号空间等比缩放', () => {
  const maxWidth = (WORD_PAGE.size.width - WORD_PAGE.margin.left - WORD_PAGE.margin.right) / 15;
  const maxHeight = (WORD_PAGE.size.height - WORD_PAGE.margin.top - WORD_PAGE.margin.bottom) / 15;
  for (const [width, height] of [[4000, 300], [300, 6000], [2400, 2400], [120, 80]]) {
    for (const caption of [true, false]) {
      const fitted = fitWordImage(width, height, caption);
      expect(fitted.width).toBeLessThanOrEqual(maxWidth);
      expect(fitted.height).toBeLessThan(maxHeight - 40);
      expect(fitted.width / fitted.height).toBeCloseTo(width / height, 8);
      expect(fitted.width).toBeLessThanOrEqual(width);
    }
  }
  for (const [width, height] of [[0, 10], [10, -1], [NaN, 10], [10, Infinity]]) {
    expect(() => fitWordImage(width, height, true)).toThrow('附图尺寸无效');
  }
});
