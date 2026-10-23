export interface AdminInvitation {
  email: string;
  invitedAt: number;
  expiresAt: number;
  claimedAt: number | null;
  status: "pending" | "expired" | "claimed" | "revoked";
  mailStatus: "accepted" | "uncertain" | "sending" | "unknown";
  lastSentAt: number | null;
}

export interface AdminAuditEntry {
  id: string;
  actor: string;
  action: "invite" | "revoke";
  email: string;
  at: number;
  status: "sending" | "accepted" | "uncertain" | "revoked";
}

export interface AdminInvitations {
  invitations: AdminInvitation[];
  audit: AdminAuditEntry[];
  limit: number;
  invitationsTruncated: boolean;
  auditTruncated: boolean;
}

export interface AdminInvitationResult {
  invitation: AdminInvitation;
  message: string;
}
