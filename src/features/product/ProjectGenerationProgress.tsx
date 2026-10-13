import { hasCurrentCad, hasCurrentConfirmation, hasCurrentImageFigures, hasCurrentPreview, isProductWorkflowComplete, namingFingerprint } from './productWorkflow';
import { PATENT_FIGURE_TEMPLATES } from './productPrompts';
import type { Project } from '../../data';
import './projectGenerationProgress.css';

export function ProjectGenerationProgress({ project }: { project: Project }) {
  const workflow = project.productWorkflow;
  if (!workflow || workflow.sourceFingerprint !== namingFingerprint(project)) return null;
  const generation = workflow.generation;
  const complete = isProductWorkflowComplete(workflow);
  const confirmed = hasCurrentConfirmation(workflow);
  const preview = hasCurrentPreview(workflow);
  const stages = [
    { label: '逻辑校验', done: workflow.review?.verdict === 'feasible' },
    { label: '产品简介', done: !!workflow.brief && workflow.brief.reviewId === workflow.review?.id },
    { label: '彩色预览', done: preview },
    { label: '预览确认', done: confirmed },
    { label: '专利附图', done: confirmed && (hasCurrentCad(workflow) || hasCurrentImageFigures(workflow, PATENT_FIGURE_TEMPLATES.map(item => item.id))) },
    { label: '申请文案', done: confirmed && workflow.materials?.briefId === workflow.brief?.id },
  ];
  const done = stages.filter(stage => stage.done).length;
  const state = generation?.state === 'running' ? 'running' : generation?.state === 'failed' ? 'failed'
    : complete ? 'complete' : generation?.state === 'cancelled' ? 'cancelled' : 'waiting';
  const label = state === 'running' ? generation!.label : state === 'failed' ? '生成失败' : complete ? '生成完成'
    : state === 'cancelled' ? '已停止' : workflow.review?.verdict === 'conflicts' ? '待处理产品矛盾'
    : workflow.revision ? '待补充重画意见' : preview && !confirmed ? '待确认彩色预览' : confirmed ? '待继续生成成品' : '待继续生成';
  const detail = state === 'running' || state === 'failed' || state === 'cancelled' ? generation!.error || generation!.detail
    : complete ? '文案与附图已就绪，可下载 Word' : preview && !confirmed ? '进入项目核对四张预览后继续' : '进入项目继续处理';
  return <div className={`project-generation ${state}`} data-testid="project-generation-progress" role="status" aria-live="polite">
    <div className="project-generation-heading"><strong>{label}</strong><small>已完成 {done}/{stages.length} 阶段</small></div>
    <div className="project-generation-track" role="progressbar" aria-label={`${project.name}生成进度`} aria-valuemin={0} aria-valuemax={stages.length} aria-valuenow={done} aria-valuetext={`${label}，已完成 ${done} 个阶段`}>
      {stages.map(stage => <span key={stage.label} className={stage.done ? 'done' : ''} title={`${stage.label}：${stage.done ? '已完成' : '待完成'}`} />)}
    </div>
    <p>{detail}</p>
  </div>;
}
