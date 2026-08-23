export enum ApprovalStatus {
  Pending = 'pending',
  Approved = 'approved',
  Blocked = 'blocked',
}

export function resolveApprovalStatus(user: {
  approvalStatus?: ApprovalStatus | string;
  isActive?: boolean;
}): ApprovalStatus {
  if (user.approvalStatus === ApprovalStatus.Pending) {
    return ApprovalStatus.Pending;
  }
  if (user.approvalStatus === ApprovalStatus.Blocked) {
    return ApprovalStatus.Blocked;
  }
  if (user.approvalStatus === ApprovalStatus.Approved) {
    return ApprovalStatus.Approved;
  }
  // Eski yozuvlar: maydon yo‘q — tasdiqlangan; isActive=false — bloklangan
  if (user.isActive === false) return ApprovalStatus.Blocked;
  return ApprovalStatus.Approved;
}

export function isApprovedForAccess(user: {
  approvalStatus?: ApprovalStatus | string;
  isActive?: boolean;
}): boolean {
  return (
    user.isActive !== false &&
    resolveApprovalStatus(user) === ApprovalStatus.Approved
  );
}

export function approvalActorName(user: {
  firstName?: string;
  fullName?: string;
}): string {
  const first = user.firstName?.trim();
  if (first) return first;
  const fromFull = user.fullName?.trim().split(/\s+/)[0];
  return fromFull || 'Admin';
}
