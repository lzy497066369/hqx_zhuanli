import type { Page } from '@playwright/test';

export async function mockNaming(page: Page, primaryProduct = '光伏组件安装支架') {
  await page.route('**/api/utility/structure-evidence-options', async route => {
    const input = route.request().postDataJSON();
    const product = input.profile.product;
    await route.fulfill({ json: { options: [
      { id: 'E01', category: 'component', label: '壳体与支架', detail: `${product}含壳体与支架`, technicalMeaning: '确定主体部件' },
      { id: 'E02', category: 'relationship', label: '固定连接', detail: '支架固定在壳体上', technicalMeaning: '确定装配关系' },
      { id: 'E03', category: 'motion', label: '部件相对固定', detail: '装配后部件无相对运动', technicalMeaning: '确定静态运动关系' },
      { id: 'E04', category: 'geometry', label: '平板与方壳', detail: '可用长方体示意主体外形', technicalMeaning: '可表达几何' },
      { id: 'E05', category: 'problem', label: '装配定位', detail: '需要确定安装位置', technicalMeaning: '待解决问题' },
    ] } });
  });
  await page.route('**/api/utility/naming-options', async route => {
    const input = route.request().postDataJSON();
    // 「钢材」是原材料，按规则只能细化为保留该材料的实体产品本身，而不是它的配件或加工设备。
    const product = input.business === '钢材' ? 'H型钢梁' : primaryProduct;
    const products = [product, '槽钢柱', '钢梁定位夹具', '钢梁固定件', '钢构件防护罩'];
    await route.fulfill({ json: { options: products.map(item => ({ product: item, features: ['H型截面', '螺栓连接板', '带滑槽限位结构'] })), providerModel: 'claude-opus-5-5' } });
  });
  await page.route('**/api/utility/naming-names', async route => {
    const input = route.request().postDataJSON();
    const product = input.profile.product;
    const batch = input.previous.length ? ['双侧', '多段', '组合'] : ['可拆卸', '滑槽', '限位'];
    await route.fulfill({ json: { candidates: batch.map((modifier: string) => ({ name: `一种带${modifier}连接结构的${product}`, product, feature: input.profile.features, basis: '根据已选保护客体与结构特征生成', inferred: false })), providerModel: 'claude-opus-5-5' } });
  });
}
