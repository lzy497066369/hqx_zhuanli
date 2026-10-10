import { expect, test } from '@playwright/test';
import { mergeStructureFacts } from '../src/features/utility/patentStructure';
import type { ConfirmedStructureFact } from '../src/features/utility/patentStructure';

const proposed = (question: string, answer: string): ConfirmedStructureFact => ({ question, answer, origin: 'model_proposal' });
const confirmed = (question: string, answer: string): ConfirmedStructureFact => ({ question, answer });

test('新的拟议方案会替换相冲突的旧拟议方案', () => {
  const result = mergeStructureFacts(
    [proposed('内齿圈如何设置？', '暂不设置内齿圈。')],
    [proposed('内齿圈如何设置？', '增加固定内齿圈。')],
  );

  expect(result).toEqual([proposed('内齿圈如何设置？', '增加固定内齿圈。')]);
});

test('真实确认事实不会被相冲突的拟议方案覆盖', () => {
  const fact = confirmed('内齿圈是否存在？', '依据图纸确认，内齿圈存在。');
  const result = mergeStructureFacts([fact], [proposed('内齿圈是否存在？', '不设置内齿圈。')]);

  expect(result).toEqual([fact]);
});

test('真实确认事实可以替换相冲突的旧拟议方案', () => {
  const result = mergeStructureFacts(
    [proposed('内齿圈如何设置？', '暂不设置内齿圈。')],
    [confirmed('内齿圈如何设置？', '依据图纸确认，内齿圈固定在顶盖法兰上。')],
  );

  expect(result).toEqual([confirmed('内齿圈如何设置？', '依据图纸确认，内齿圈固定在顶盖法兰上。')]);
});

test('同一结构主题的两条真实确认事实保留最新确认结果', () => {
  const result = mergeStructureFacts(
    [confirmed('内齿圈安装在哪里？', '固定在顶盖上。')],
    [confirmed('内齿圈安装在哪里？', '固定在顶盖法兰上。')],
  );

  expect(result).toEqual([confirmed('内齿圈安装在哪里？', '固定在顶盖法兰上。')]);
});

test('问题中的否定方案不覆盖新答案中的固定齿圈方案', () => {
  const result = mergeStructureFacts(
    [proposed('行星机构是否不设置内齿圈？', '拟不设置内齿圈。')],
    [proposed('是否继续不设置内齿圈，还是设置固定内齿圈？', '拟设置固定内齿圈约束行星轮，待实物核对。')],
  );
  expect(result).toEqual([proposed('是否继续不设置内齿圈，还是设置固定内齿圈？', '拟设置固定内齿圈约束行星轮，待实物核对。')]);
});
