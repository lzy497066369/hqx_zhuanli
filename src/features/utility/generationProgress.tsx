import { Check, CircleDot, LoaderCircle } from 'lucide-react';
import './generationProgress.css';

export type ProgressStep = { label: string; detail: string };

export function GenerationProgress({ title, label, steps, next, note, testId }: {
  title: string; label: string; steps: ProgressStep[]; next?: string; note?: string; testId?: string;
}) {
  const current = steps.at(-1)!;
  return <div className="generation-progress" role="status" aria-live="polite" aria-busy="true" data-testid={testId}>
    <div className="generation-progress-heading"><strong>{title}</strong><span>{current.detail}</span></div>
    <div className="generation-progress-track" role="progressbar" aria-label={label} aria-valuetext={current.label}><span /></div>
    <ol className="generation-progress-steps" aria-label={`${label}阶段`}>
      {steps.map((step, index) => <li key={index} className={index === steps.length - 1 ? 'active' : 'complete'}>
        {index === steps.length - 1 ? <LoaderCircle size={15} className="generation-progress-spinner" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
        <span><strong>{step.label}</strong><small>{step.detail}</small></span>
      </li>)}
      {next && <li className="pending"><CircleDot size={15} aria-hidden="true" /><span><strong>{next}</strong><small>等待前一步完成</small></span></li>}
    </ol>
    {note && <p className="generation-progress-note">{note}</p>}
  </div>;
}
