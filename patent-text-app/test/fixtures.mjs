export const boxPlan = {
  schemaVersion: 2, title: '一种具有通气结构的收纳盒', scenario: '在收纳盒内放置贴近内壁的内盒',
  problem: '取出内盒时底部空气难以及时补入', goal: '使外界空气能够补入内盒底部',
  focus: { improvement: '进气口与侧壁导气槽连通', corePartIds: ['1', '2', '3'], boundary: '仅改善取出过程的空气补入，不扩展电子控制和防水机构' },
  assumptions: ['设计记录专用标记：采用矩形盒体，未做样机试验'], verificationNeeds: ['验证通气截面及内盒拔出力'],
  parts: [
    { id: '1', name: '盒体', kind: 'part', parentId: null, importance: 'core', necessity: '提供收纳空间和通路基体', role: '收纳内盒', position: '围绕内盒设置', motion: '使用时固定' },
    { id: '2', name: '进气口', kind: 'opening', parentId: '1', importance: 'core', necessity: '允许外界空气进入', role: '连通外界', position: '贯通盒体侧壁底部', motion: '随盒体固定' },
    { id: '3', name: '导气槽', kind: 'opening', parentId: '1', importance: 'core', necessity: '连通进气口与内盒底部', role: '提供气流通路', position: '从侧壁进气口延伸至内底面', motion: '随盒体固定' },
    { id: '4', name: '支承面', kind: 'surface', parentId: '1', importance: 'support', necessity: '避免内盒底部封住导气槽', role: '支承内盒', position: '位于盒体内底面且高于导气槽槽底', motion: '随盒体固定' },
  ],
  connections: [{ from: '2', to: '3', type: '连通', detail: '进气口内端与导气槽一端相接，槽另一端延伸至内盒下方' }],
  coreActions: [{ name: '取出内盒时补气', partIds: ['1', '2', '3', '4'], trigger: '向上提起内盒', before: '内盒底部放置于支承面上', constraint: '导气槽槽底低于支承面，进气口外端开向侧方', sequence: ['内盒上移使底部空间增大', '空气由进气口经导气槽补入内盒底部'], after: '空气随内盒上移持续补入', clearance: '侧向进气口不被承载盒体的台面遮挡，支承面使内盒底部与槽底间隔', basis: '贯通侧壁的进气口、低于支承面的导气槽以及二者连通关系提供连续通路' }],
  workingSteps: [{ step: '将内盒放置于支承面上', partIds: ['1', '4'] }, { step: '提起内盒，空气经进气口和导气槽进入底部空间', partIds: ['2', '3'] }],
  improvements: [{ partIds: ['2', '3', '4'], mechanism: '内盒底部保持与导气槽槽底间隔，外界与底部空间连通', effect: '允许空气在内盒提起时补入' }],
  claimPlan: { focus: '具有连续补气通路的收纳盒', independent: [
    { feature: '盒体侧壁进气口与内底面导气槽连通，支承面高于槽底', partIds: ['1', '2', '3', '4'], reason: '缺少上述关系将不能建立未被内盒封闭的补气通路' },
  ], dependent: [{ feature: '导气槽沿盒体内底面延伸', partIds: ['1', '3'], reason: '进一步限定一种延伸布置' }], embodimentOnly: [{ feature: '矩形盒体', partIds: ['1'], reason: '盒体外形不决定通路连通原理' }] },
};

export const boxDocument = {
  title: boxPlan.title, abstract: '本实用新型公开了一种具有通气结构的收纳盒，包括盒体、贯通侧壁底部的进气口以及与进气口连通的导气槽，盒体内的支承面高于导气槽槽底，内盒取出时空气能够经进气口和导气槽补入内盒下方。',
  claims: [
    { number: 1, dependsOn: null, text: '一种具有通气结构的收纳盒，包括盒体（1），其特征在于：所述盒体（1）的侧壁底部贯通设置有进气口（2），所述盒体（1）的内底面设置有与进气口（2）连通的导气槽（3），所述盒体（1）内用于支承内盒的支承面（4）高于导气槽（3）的槽底。', partIds: ['1', '2', '3', '4'] },
    { number: 2, dependsOn: 1, text: '根据权利要求1所述的收纳盒，其特征在于：所述导气槽（3）从进气口（2）的内端沿盒体（1）的内底面延伸。', partIds: ['1', '2', '3'] },
  ],
  technicalField: '本实用新型涉及收纳容器技术领域。', background: '内盒贴近收纳盒内壁时，取出内盒的过程中，空气可能难以及时补入其底部空间。',
  technicalProblem: '提供一种允许空气补入内盒底部空间的收纳盒。', solution: '盒体（1）侧壁的进气口（2）与内底面导气槽（3）连通，支承面（4）高于槽底。',
  benefits: ['进气口与导气槽形成连续通路，支承面使内盒底部与槽底间隔，允许外界空气补入内盒底部。'],
  embodiment: '本实施例采用矩形盒体（1）。进气口（2）从侧方贯穿盒体（1）的侧壁，其内端与导气槽（3）相接。导气槽（3）沿内底面延伸至内盒下方。支承面（4）高于导气槽（3）槽底，使内盒置于支承面（4）时仍留有气流通路。侧方进气口（2）不与承载盒体（1）的台面接触。',
  operation: '使用时将内盒放在支承面（4）上；提起内盒时，空气从进气口（2）经导气槽（3）进入其下方空间。',
};
