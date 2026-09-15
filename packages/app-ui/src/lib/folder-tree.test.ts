import { describe, expect, it } from 'vitest';
import { buildFolderTree, folderAncestry, folderMoveTargets, levelOf } from './folder-tree';

const folder = (id: string, name: string, parentId: string | null = null) => ({
  id,
  name,
  parentId,
  createdAt: '2026-01-01T00:00:00Z',
});

const work = folder('fld_work', 'Work');
const clients = folder('fld_clients', 'Clients', 'fld_work');
const acme = folder('fld_acme', 'Acme', 'fld_clients');
const personal = folder('fld_personal', 'Personal');

it('builds the tree with subtree note counts, roots and children sorted by name', () => {
  const counts: Record<string, number> = { fld_work: 1, fld_clients: 2, fld_acme: 3 };
  const tree = buildFolderTree([personal, acme, work, clients], id => counts[id] ?? 0);
  expect(tree.map(node => node.folder.name)).toEqual(['Personal', 'Work']);
  const workNode = tree[1]!;
  expect(workNode.noteCount).toBe(6);
  expect(workNode.children[0]!.folder.name).toBe('Clients');
  expect(workNode.children[0]!.children[0]!.noteCount).toBe(3);
});

it('adopts an orphan at the root and still draws a parent cycle', () => {
  const orphan = folder('fld_orphan', 'Shared with me', 'fld_not_mine');
  const a = folder('fld_a', 'A', 'fld_b');
  const b = folder('fld_b', 'B', 'fld_a');
  const tree = buildFolderTree([orphan, a, b], () => 0);
  const names = tree.map(node => node.folder.name);
  expect(names).toContain('Shared with me');
  expect(names.some(name => name === 'A' || name === 'B')).toBe(true);
});

it('walks the ancestry root first', () => {
  expect(folderAncestry([work, clients, acme, personal], 'fld_acme').map(f => f.name)).toEqual([
    'Work',
    'Clients',
    'Acme',
  ]);
  expect(folderAncestry([work], 'fld_work').map(f => f.name)).toEqual(['Work']);
});

it('starts the ancestry at the first folder it can see, and never loops', () => {
  const orphan = folder('fld_orphan', 'Shared with me', 'fld_not_mine');
  expect(folderAncestry([orphan], 'fld_orphan').map(f => f.name)).toEqual(['Shared with me']);
  const a = folder('fld_a', 'A', 'fld_b');
  const b = folder('fld_b', 'B', 'fld_a');
  expect(folderAncestry([a, b], 'fld_a').length).toBe(2);
  expect(folderAncestry([work], 'fld_unknown')).toEqual([]);
});

it('returns one level of the tree', () => {
  const tree = buildFolderTree([work, clients, acme, personal], () => 0);
  expect(levelOf(tree, null).map(node => node.folder.name)).toEqual(['Personal', 'Work']);
  expect(levelOf(tree, 'fld_work').map(node => node.folder.name)).toEqual(['Clients']);
  expect(levelOf(tree, 'fld_clients').map(node => node.folder.name)).toEqual(['Acme']);
  expect(levelOf(tree, 'fld_acme')).toEqual([]);
  expect(levelOf(tree, 'fld_unknown')).toEqual([]);
});

describe('folderMoveTargets', () => {
  const tree = buildFolderTree(
    [
      folder('fld_one', 'One'),
      folder('fld_two', 'Two', 'fld_one'),
      folder('fld_three', 'Three', 'fld_two'),
      folder('fld_flat', 'Flat'),
    ],
    () => 0
  );
  const names = (ids: { node: { folder: { name: string } } }[]) => ids.map(t => t.node.folder.name);

  it('never offers a folder itself or its own subtree, and greys out where it already is', () => {
    const { targets } = folderMoveTargets(tree, 'fld_two');
    expect(names(targets)).toEqual(['Flat', 'One']);
    expect(targets.map(t => t.disabled)).toEqual([false, true]);
  });

  it('refuses a destination that would push the subtree past the depth cap', () => {
    // One is three tiers tall, so nowhere can take it.
    expect(folderMoveTargets(tree, 'fld_one').targets).toEqual([]);
    // A leaf carries nothing, so the same destination is fine for the deepest row.
    expect(names(folderMoveTargets(tree, 'fld_three').targets)).toContain('Flat');
  });

  it('lists the current parent, disabled, and the top level only for a nested folder', () => {
    const forThree = folderMoveTargets(tree, 'fld_three');
    expect(forThree.canMoveToRoot).toBe(true);
    expect(forThree.targets.find(t => t.node.folder.name === 'Two')?.disabled).toBe(true);
    expect(folderMoveTargets(tree, 'fld_flat').canMoveToRoot).toBe(false);
  });

  it('is empty for a folder the tree does not know', () => {
    expect(folderMoveTargets(tree, 'fld_gone')).toEqual({ canMoveToRoot: false, targets: [] });
  });
});
