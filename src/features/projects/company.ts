import type { Project } from '../../data.ts';

export type Company = { id: string; name: string; mainProducts: string[]; updatedAt: string };
export const companyNameKey = (name: string) => name.normalize('NFKC').trim().toLowerCase();
export function parseMainProducts(value: string): string[] {
  return [...new Set(value.split(/[\n,，、;；]+/u).map(item => item.trim()).filter(Boolean))];
}
export function isCompanies(value: unknown): value is Company[] {
  if (!Array.isArray(value) || value.length > 5000) return false;
  return value.every(company => company && typeof company === 'object' &&
    typeof company.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(company.id) &&
    typeof company.name === 'string' && !!company.name.trim() && company.name.length <= 100 &&
    Array.isArray(company.mainProducts) && company.mainProducts.length <= 50 &&
    company.mainProducts.every((product: unknown) => typeof product === 'string' && !!product.trim() && product.length <= 100) &&
    new Set(company.mainProducts).size === company.mainProducts.length &&
    typeof company.updatedAt === 'string' && Number.isFinite(Date.parse(company.updatedAt))) &&
    new Set(value.map(company => company.id)).size === value.length &&
    new Set(value.map(company => companyNameKey(company.name))).size === value.length;
}
export function companyForProject(project: Project, companies: Company[]): Company | undefined {
  return project.companyId ? companies.find(company => company.id === project.companyId)
    : companies.find(company => companyNameKey(company.name) === companyNameKey(project.owner));
}
/** First-load migration only: existing patents remain accessible under their original companies. */
export function companiesFromProjects(projects: Project[]): Company[] {
  const companies: Company[] = [];
  for (const project of projects) {
    const name = project.owner.trim();
    if (!name) continue;
    let company = companies.find(item => companyNameKey(item.name) === companyNameKey(name));
    if (!company) {
      company = { id: project.companyId || `legacy-company-${companies.length + 1}`, name: name.slice(0, 100), mainProducts: [], updatedAt: project.updatedAt };
      companies.push(company);
    }
    const product = project.baseProductName?.trim() || project.naming?.profile.business.trim() || project.naming?.profile.product.trim();
    if (product && !company.mainProducts.includes(product) && company.mainProducts.length < 50) company.mainProducts.push(product.slice(0, 100));
  }
  return companies;
}
