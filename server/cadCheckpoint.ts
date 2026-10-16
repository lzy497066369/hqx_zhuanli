import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiConfig } from './aiSupport.ts';
import { AiFailure } from './aiSupport.ts';
import { signProductArtifact, verifyProductArtifact } from './productProof.ts';
import type { CadDecision } from './productCad.ts';
import type { CadRepairScope } from './cadVisualReview.ts';
import type { CadViewDrawing, CadLabel, ProductBrief, ProductCad, ProductMaterials } from '../src/features/product/productWorkflow.ts';

export type CadCheckpoint = { decision: CadDecision; generationModel?: string; issues?: string[]; repairScope?: CadRepairScope; findingHistory?: string[]; rendered?: {
  views: CadViewDrawing[]; labels: CadLabel[]; meshDigest: string; vertexCount: number; triangleCount: number; freecadVersion: string;
}; cad?: ProductCad; pendingMaterials?: ProductMaterials; draftSignature?: string };
const MAX_BYTES = 16 * 1024 * 1024, TTL = 7 * 86400000;
export function cadCheckpointKey(brief: ProductBrief, config: AiConfig): string {
  return createHash('sha256').update(`drawing-pipeline-7:${brief.signature}:${config.vision?.model || config.model}`).digest('hex');
}
const directory = (config: AiConfig) => config.cadCheckpointDir || join(homedir(), '.local', 'state', 'zhichuang-workshop', 'cad-checkpoints');
export async function readCadCheckpoint(brief: ProductBrief, config: AiConfig): Promise<CadCheckpoint | undefined> {
  if (config.cadCheckpointDir === false) return;
  try {
    const file = join(directory(config), `${cadCheckpointKey(brief, config)}.json`);
    const info = await stat(file);
    if (info.size > MAX_BYTES || Date.now() - info.mtimeMs > TTL) return;
    const record = JSON.parse(await readFile(file, 'utf8'));
    verifyProductArtifact('cad-checkpoint', record, config);
    if (record.briefSignature !== brief.signature) return;
    return record.checkpoint;
  } catch { return; }
}
export async function saveCadCheckpoint(brief: ProductBrief, checkpoint: CadCheckpoint, config: AiConfig): Promise<void> {
  if (config.cadCheckpointDir === false) return;
  const dir = directory(config), key = cadCheckpointKey(brief, config), file = join(dir, `${key}.json`), temporary = `${file}.${randomUUID()}.tmp`;
  const body = JSON.stringify(signProductArtifact('cad-checkpoint', { briefSignature: brief.signature, checkpoint }, config));
  if (Buffer.byteLength(body) > MAX_BYTES) throw new AiFailure(502, 'CAD_CHECKPOINT_TOO_LARGE', '附图记录过大，请减少无关细节。');
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    throw new AiFailure(503, 'CAD_CHECKPOINT_WRITE_FAILED', '附图检查点保存失败，请检查服务存储空间；已有正文和预览保留。');
  }
  // Bound long-running disk use. Cleanup failure must not discard a successfully saved checkpoint.
  try {
    const names = await readdir(dir);
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(n))) {
      if (Date.now() - (await stat(join(dir, name))).mtimeMs > 86400000) await rm(join(dir, name), { force: true });
    }
    const entries = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const files = await Promise.all(entries.map(async name => ({ name, ...await stat(join(dir, name)) })));
    files.sort((a,b) => b.mtimeMs-a.mtimeMs);
    let bytes=0;
    for (const [i, entry] of files.entries()) {
      bytes += entry.size;
      if (entry.name !== `${key}.json` && (i >= 64 || bytes > 256*1024*1024 || Date.now()-entry.mtimeMs > TTL)) await rm(join(dir, entry.name), { force: true });
    }
  } catch { /* Retention retries at the next save. */ }
}
