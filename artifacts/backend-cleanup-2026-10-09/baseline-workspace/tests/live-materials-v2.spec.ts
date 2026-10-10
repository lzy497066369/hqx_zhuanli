// Explicit opt-in: this test calls the configured paid AI service.
import { expect, test } from '@playwright/test';
import { generateStructure, mockStructure, openNamedWorkspace, savedProject } from './fixtures/structureFlow';

test('live V2 generation persists validated materials and exports Word', async ({ page }) => {
  test.skip(process.env.LIVE_MATERIALS_V2 !== '1', 'Set LIVE_MATERIALS_V2=1 to run against the configured AI service.');
  test.setTimeout(360_000);

  await mockStructure(page);
  const title = await openNamedWorkspace(page);
  await generateStructure(page);
  await page.getByRole('tab', { name: '申请材料' }).click();
  await page.getByRole('button', { name: '重新生成文案' }).click();
  await expect(page.getByText('V2 文案已生成并通过最终校验。')).toBeVisible({ timeout: 320_000 });

  const project = await savedProject(page, title);
  expect(project.utilityMaterials.generationSource).toBe('materials-v2');
  expect(project.utilityMaterials.sourceModelVersion).toBe(project.utilityDrawing.patentStructureModel.modelVersion);
  expect(project.utilityMaterials.claims).toContain(title);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Word' }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.docx$/);
});
