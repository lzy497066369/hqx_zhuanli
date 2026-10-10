import { expect, test } from '@playwright/test';
import { openNamedWorkspace } from './fixtures/structureFlow';

test('系统：旧 AI 产品方案、草案编辑和手动建模入口不再出现', async ({ page }) => {
  await openNamedWorkspace(page);
  await expect(page.getByTestId('patent-structure-flow')).toBeVisible();
  await expect(page.locator('.uw-concept-entry, .uw-advanced, .uw-flow-optional, .uw-ai-preview')).toHaveCount(0);
  await expect(page.locator('.utility-workspace').getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /手动创建|填入结构草案|检索专利并生成产品方案/ })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '申请材料' })).toBeDisabled();
});
