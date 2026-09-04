/** Wire-level DTO types shared by web, api and mcp. Populated per phase. */
export type BrandedId<T extends string> = string & { readonly __brand: T };

export type OrgId = BrandedId<'OrgId'>;
export type UserId = BrandedId<'UserId'>;
export type DocumentId = BrandedId<'DocumentId'>;
export type VersionId = BrandedId<'VersionId'>;
export type ProjectId = BrandedId<'ProjectId'>;
export type CommentId = BrandedId<'CommentId'>;
export type ReplyId = BrandedId<'ReplyId'>;
export type GrantId = BrandedId<'GrantId'>;
export type InviteId = BrandedId<'InviteId'>;
export type AllowlistEntryId = BrandedId<'AllowlistEntryId'>;
export type ReviewRequestId = BrandedId<'ReviewRequestId'>;
export type ApprovalId = BrandedId<'ApprovalId'>;
export type PublicDocId = BrandedId<'PublicDocId'>;

export * from './result.js';
export * from './resolve-relative-asset.js';
