import type { Project } from '../../data';
import { filingStatuses, isGeneratedPatent } from './projectManagement';
import type { FilingStatus } from './projectManagement';

export function FilingStatusButtons({ project, onChange }: { project: Project; onChange: (project: Project, status: FilingStatus) => void }) {
  if (!isGeneratedPatent(project)) return null;
  return <div className="filing-status-buttons" role="group" aria-label={`${project.name}申报状态`}>
    {(Object.entries(filingStatuses) as [FilingStatus, string][]).map(([status, label]) =>
      <button key={status} type="button" className={`filing-button ${status}`}
        aria-pressed={(project.filingStatus || 'not_submitted') === status} onClick={() => onChange(project, status)}>{label}</button>)}
  </div>;
}
