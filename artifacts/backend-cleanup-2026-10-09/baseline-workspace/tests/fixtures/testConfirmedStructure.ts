import { expect, type Page } from '@playwright/test';

export const TEST_CONFIRMED_STRUCTURE = 'TEST_CONFIRMED_STRUCTURE' as const;

export async function confirmTestStructure(page: Page) {
  await expect(page.getByTestId('structure-skeleton')).toBeVisible();
  await expect(page.locator('[data-structure-model="determined"]')).toHaveCount(0);
  await page.getByRole('checkbox', {
    name: /我已核对部件、连接、运动和形状/,
  }).check();
  await page.getByRole('button', {
    name: '确认骨架并编译模型',
  }).click();
  await expect(page.locator('[data-structure-model="determined"]')).toBeVisible();
}
