export type ClaimDependencyReference = {
  claimNo: number;
  parentClaimNo?: number;
  componentIds?: string[];
};

/** Select the latest earlier claim that already establishes the anchor feature. */
export function selectParentClaim(
  claimNo: number,
  anchorComponentId: string | undefined,
  references: ClaimDependencyReference[],
) {
  if (claimNo <= 1) return undefined;
  const candidates = references.filter(reference =>
    reference.claimNo < claimNo && (anchorComponentId === undefined ||
      reference.claimNo === 1 || reference.componentIds?.includes(anchorComponentId)),
  );
  return candidates.at(-1)?.claimNo || 1;
}

export function claimDependencyText(claim: string) {
  return /根据权利要求\s*(\d+)\s*所述/u.exec(claim)?.[1];
}

export function validateClaimDependencies(claims: string[]) {
  const errors: string[] = [];
  for (const [index, claim] of claims.entries()) {
    const claimNo = index + 1;
    const parent = claimDependencyText(claim);
    if (claimNo === 1) {
      if (parent !== undefined) errors.push('权利要求1不能引用上位权利要求。');
      continue;
    }
    if (!parent || !Number.isInteger(Number(parent)) || Number(parent) < 1 || Number(parent) >= claimNo) {
      errors.push(`权利要求${claimNo}的上位权利要求无效，应引用编号更小的权利要求。`);
    }
  }
  return errors;
}
