import { expect, it } from 'vitest';
import { isFolderShared, moveLeavesSharedFolder } from './folder-sharing';

const folder = (
  id: string,
  name: string,
  parentId: string | null = null,
  extra: { isOwner?: boolean; memberCount?: number } = {}
) => ({ id, name, parentId, createdAt: '2026-01-01T00:00:00Z', ...extra });

const folders = [
  folder('fld_sales', 'Sales', null, { isOwner: true, memberCount: 3 }),
  folder('fld_q3', 'Q3', 'fld_sales', { isOwner: true, memberCount: 0 }),
  folder('fld_private', 'Private', null, { isOwner: true, memberCount: 0 }),
  folder('fld_theirs', 'Theirs', null, { isOwner: false, memberCount: 0 }),
  folder('fld_fresh', 'Fresh'),
];

it('is shared when the folder, or any folder above it, has people or came from someone else', () => {
  expect(isFolderShared(folders, 'fld_sales')).toBe(true);
  expect(isFolderShared(folders, 'fld_q3')).toBe(true);
  expect(isFolderShared(folders, 'fld_theirs')).toBe(true);
  expect(isFolderShared(folders, 'fld_private')).toBe(false);
  // A row the delta has not decorated yet is not claimed as shared.
  expect(isFolderShared(folders, 'fld_fresh')).toBe(false);
});

it('flags a move that leaves a shared folder for one that is not', () => {
  expect(moveLeavesSharedFolder(folders, 'fld_q3', null)).toBe(true);
  expect(moveLeavesSharedFolder(folders, 'fld_q3', 'fld_private')).toBe(true);
  expect(moveLeavesSharedFolder(folders, 'fld_q3', 'fld_sales')).toBe(false);
  expect(moveLeavesSharedFolder(folders, 'fld_private', null)).toBe(false);
  expect(moveLeavesSharedFolder(folders, null, 'fld_private')).toBe(false);
});
