// Pure Yjs helpers that read/write the workspace organize data exactly the way
// the AFFiNE frontend stores it. No Nest / storage dependencies so the logic
// can be unit tested in isolation.
//
// Layout references (v0.27.4):
// - root doc (guid = workspaceId)
//   - meta.pages: Y.Array<Y.Map{id,title,createDate,updatedDate?,tags:Y.Array<string>,trash?,trashDate?}>
//   - meta.properties.tags.options: Y.Array<Y.Map{id,value,color,createDate,updateDate,parentId?}>
//     (frontend: modules/tag/stores/tag.ts)
//   - setting.collections: Y.Array<plain {id,name,rules:{filters},allowList}>
//     (frontend: modules/collection/stores/collection.ts)
// - folders doc (guid = db$<workspaceId>$folders), YjsTableAdapter layout:
//   each row is a top-level Y.Map keyed by row id: {id,parentId,type,data,index}
//   deleted rows: non-key fields removed + `$$DELETED: true`
//   (infra: orm/core/adapters/yjs/table.ts, frontend: modules/organize)
import { nanoid } from 'nanoid';
import { Array as YArray, type Doc, Map as YMap } from 'yjs';

import { generateFractionalIndexingKeyBetween } from './fractional-index';

export class OrganizeError extends Error {}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

function plain<T = any>(value: unknown): T {
  if (value instanceof YMap || value instanceof YArray) {
    return value.toJSON() as T;
  }
  return value as T;
}

function normalize(name: string) {
  return name.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// docs (root doc meta.pages)
// ---------------------------------------------------------------------------

export interface DocInfo {
  id: string;
  title: string;
  createDate?: number;
  updatedDate?: number;
  tags: string[];
  trash: boolean;
  trashDate?: number;
}

function pagesArray(root: Doc): YArray<YMap<any>> | null {
  const pages = root.getMap('meta').get('pages');
  return pages instanceof YArray ? (pages as YArray<YMap<any>>) : null;
}

function readPageTags(page: YMap<any>): string[] {
  const tags = page.get('tags');
  if (tags instanceof YArray) return tags.toArray().map(String);
  if (Array.isArray(tags)) return tags.map(String);
  return [];
}

export function readDocs(root: Doc): DocInfo[] {
  const pages = pagesArray(root);
  if (!pages) return [];
  const docs: DocInfo[] = [];
  for (const page of pages.toArray()) {
    if (!(page instanceof YMap)) continue;
    const id = page.get('id');
    if (typeof id !== 'string') continue;
    docs.push({
      id,
      title: typeof page.get('title') === 'string' ? page.get('title') : '',
      createDate: page.get('createDate') ?? undefined,
      updatedDate: page.get('updatedDate') ?? undefined,
      tags: readPageTags(page),
      trash: page.get('trash') === true,
      trashDate: page.get('trashDate') ?? undefined,
    });
  }
  return docs;
}

function findPage(root: Doc, docId: string): YMap<any> {
  const pages = pagesArray(root);
  const page = pages
    ?.toArray()
    .find(p => p instanceof YMap && p.get('id') === docId);
  if (!page) throw new OrganizeError(`Doc ${docId} not found.`);
  return page;
}

export function hasDoc(root: Doc, docId: string) {
  return readDocs(root).some(doc => doc.id === docId);
}

export function setDocTrash(root: Doc, docId: string, trash: boolean) {
  const page = findPage(root, docId);
  if (trash) {
    page.set('trash', true);
    page.set('trashDate', Date.now());
  } else {
    page.set('trash', false);
    page.delete('trashDate');
  }
}

// ---------------------------------------------------------------------------
// tags (root doc meta.properties.tags.options)
// ---------------------------------------------------------------------------

export interface TagInfo {
  id: string;
  value: string;
  color: string;
  createDate?: number;
  updateDate?: number;
  parentId?: string;
}

export const TAG_COLORS = [
  'red',
  'teal',
  'blue',
  'yellow',
  'magenta',
  'white',
  'grey',
  'orange',
  'purple',
  'green',
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export function tagColorVar(color: TagColor) {
  return `var(--affine-palette-line-${color})`;
}

function tagOptionsArray(root: Doc, create: boolean): YArray<any> | null {
  const meta = root.getMap('meta');
  let properties = meta.get('properties');
  if (!(properties instanceof YMap)) {
    if (!create) return null;
    properties = new YMap();
    meta.set('properties', properties);
  }
  let tags = (properties as YMap<any>).get('tags');
  if (!(tags instanceof YMap)) {
    if (!create) return null;
    tags = new YMap();
    (properties as YMap<any>).set('tags', tags);
  }
  let options = (tags as YMap<any>).get('options');
  if (!(options instanceof YArray)) {
    if (!create) return null;
    const legacy = Array.isArray(options) ? options : [];
    options = new YArray();
    (tags as YMap<any>).set('options', options);
    if (legacy.length) {
      (options as YArray<any>).push(legacy.map(o => toTagYMap(o)));
    }
  }
  return options as YArray<any>;
}

function toTagYMap(tag: TagInfo) {
  const map = new YMap<any>();
  for (const [key, value] of Object.entries(tag)) {
    if (value !== undefined) map.set(key, value);
  }
  return map;
}

export function readTags(root: Doc): TagInfo[] {
  const options = tagOptionsArray(root, false);
  if (!options) return [];
  return options
    .toArray()
    .map(o => plain<TagInfo>(o))
    .filter(o => o && typeof o.id === 'string');
}

/** Resolve tag references (id or case-insensitive name) to ids. */
export function resolveTags(
  root: Doc,
  refs: string[]
): { ids: string[]; missing: string[] } {
  const tags = readTags(root);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const tag =
      tags.find(t => t.id === ref) ??
      tags.find(t => normalize(t.value) === normalize(ref));
    if (tag) {
      if (!ids.includes(tag.id)) ids.push(tag.id);
    } else {
      missing.push(ref);
    }
  }
  return { ids, missing };
}

export function createTag(
  root: Doc,
  name: string,
  color: TagColor
): { tag: TagInfo; created: boolean } {
  const value = name.trim();
  if (!value) throw new OrganizeError('Tag name cannot be empty.');
  const existing = readTags(root).find(
    t => normalize(t.value) === normalize(value)
  );
  if (existing) return { tag: existing, created: false };

  const now = Date.now();
  const tag: TagInfo = {
    id: nanoid(),
    value,
    color: tagColorVar(color),
    createDate: now,
    updateDate: now,
  };
  tagOptionsArray(root, true)!.push([toTagYMap(tag)]);
  return { tag, created: true };
}

export function updateTag(
  root: Doc,
  tagId: string,
  patch: { name?: string; color?: TagColor }
): TagInfo {
  const options = tagOptionsArray(root, false);
  const option = options?.toArray().find(o => plain<TagInfo>(o)?.id === tagId);
  if (!options || !option) throw new OrganizeError(`Tag ${tagId} not found.`);

  if (patch.name !== undefined) {
    const value = patch.name.trim();
    if (!value) throw new OrganizeError('Tag name cannot be empty.');
    const clash = readTags(root).find(
      t => t.id !== tagId && normalize(t.value) === normalize(value)
    );
    if (clash) {
      throw new OrganizeError(`Another tag is already named "${clash.value}".`);
    }
  }

  if (option instanceof YMap) {
    if (patch.name !== undefined) option.set('value', patch.name.trim());
    if (patch.color !== undefined)
      option.set('color', tagColorVar(patch.color));
    option.set('updateDate', Date.now());
    return plain<TagInfo>(option);
  }

  // legacy plain object entry: replace in place
  const index = options.toArray().indexOf(option);
  const next: TagInfo = {
    ...plain<TagInfo>(option),
    ...(patch.name !== undefined ? { value: patch.name.trim() } : {}),
    ...(patch.color !== undefined ? { color: tagColorVar(patch.color) } : {}),
    updateDate: Date.now(),
  };
  options.delete(index, 1);
  options.insert(index, [toTagYMap(next)]);
  return next;
}

export function deleteTag(root: Doc, tagId: string): { removedFrom: number } {
  const options = tagOptionsArray(root, false);
  const index =
    options?.toArray().findIndex(o => plain<TagInfo>(o)?.id === tagId) ?? -1;
  if (!options || index < 0) throw new OrganizeError(`Tag ${tagId} not found.`);
  options.delete(index, 1);

  let removedFrom = 0;
  for (const page of pagesArray(root)?.toArray() ?? []) {
    if (!(page instanceof YMap)) continue;
    if (removePageTags(page, [tagId])) removedFrom++;
  }
  return { removedFrom };
}

function removePageTags(page: YMap<any>, tagIds: string[]): boolean {
  const tags = page.get('tags');
  if (tags instanceof YArray) {
    let changed = false;
    for (let i = tags.length - 1; i >= 0; i--) {
      if (tagIds.includes(tags.get(i))) {
        tags.delete(i, 1);
        changed = true;
      }
    }
    return changed;
  }
  if (Array.isArray(tags) && tags.some(t => tagIds.includes(t))) {
    page.set('tags', YArray.from(tags.filter(t => !tagIds.includes(t))));
    return true;
  }
  return false;
}

export function updateDocTags(
  root: Doc,
  docId: string,
  change: { add?: string[]; remove?: string[]; set?: string[] }
): string[] {
  const page = findPage(root, docId);
  let tags = page.get('tags');
  if (!(tags instanceof YArray)) {
    const legacy = Array.isArray(tags) ? tags.map(String) : [];
    tags = YArray.from(legacy);
    page.set('tags', tags);
  }
  const arr = tags as YArray<string>;

  if (change.set) {
    const target = [...new Set(change.set)];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!target.includes(arr.get(i))) arr.delete(i, 1);
    }
    const current = arr.toArray();
    const toAdd = target.filter(id => !current.includes(id));
    if (toAdd.length) arr.push(toAdd);
  } else {
    if (change.remove?.length) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (change.remove.includes(arr.get(i))) arr.delete(i, 1);
      }
    }
    if (change.add?.length) {
      const current = arr.toArray();
      const toAdd = [...new Set(change.add)].filter(
        id => !current.includes(id)
      );
      if (toAdd.length) arr.push(toAdd);
    }
  }
  return arr.toArray();
}

// ---------------------------------------------------------------------------
// collections (root doc setting.collections)
// ---------------------------------------------------------------------------

export interface CollectionFilter {
  type: string;
  key: string;
  method: string;
  value?: string;
}

export interface CollectionInfo {
  id: string;
  name: string;
  rules: { filters: CollectionFilter[] };
  allowList: string[];
}

function collectionsArray(root: Doc, create: boolean): YArray<any> | null {
  const setting = root.getMap('setting');
  let collections = setting.get('collections');
  if (!(collections instanceof YArray)) {
    if (!create) return null;
    collections = new YArray();
    setting.set('collections', collections);
  }
  return collections as YArray<any>;
}

function normalizeCollection(raw: any): CollectionInfo | null {
  const value = plain<any>(raw);
  if (!value || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '',
    // legacy `filterList` collections are surfaced without rules; their
    // filters are preserved untouched unless the collection is rewritten
    rules:
      value.rules && Array.isArray(value.rules.filters)
        ? { filters: value.rules.filters }
        : { filters: [] },
    allowList: Array.isArray(value.allowList) ? value.allowList : [],
  };
}

export function readCollections(root: Doc): CollectionInfo[] {
  const collections = collectionsArray(root, false);
  if (!collections) return [];
  return collections
    .toArray()
    .map(normalizeCollection)
    .filter((c): c is CollectionInfo => c !== null);
}

export function createCollection(
  root: Doc,
  info: { name: string; allowList?: string[]; tagIds?: string[] }
): CollectionInfo {
  const name = info.name.trim();
  if (!name) throw new OrganizeError('Collection name cannot be empty.');
  const collection: CollectionInfo = {
    id: nanoid(),
    name,
    rules: {
      filters: (info.tagIds ?? []).map(tagId => ({
        type: 'system',
        key: 'tags',
        method: 'include-all',
        value: tagId,
      })),
    },
    allowList: [...new Set(info.allowList ?? [])],
  };
  collectionsArray(root, true)!.push([collection]);
  return collection;
}

export function updateCollection(
  root: Doc,
  collectionId: string,
  patch: { name?: string; addDocs?: string[]; removeDocs?: string[] }
): CollectionInfo {
  const collections = collectionsArray(root, false);
  const raw = collections?.toArray() ?? [];
  const index = raw.findIndex(c => plain<any>(c)?.id === collectionId);
  if (!collections || index < 0) {
    throw new OrganizeError(`Collection ${collectionId} not found.`);
  }
  const original = plain<any>(raw[index]);
  const current = normalizeCollection(original)!;

  let allowList = current.allowList;
  if (patch.removeDocs?.length) {
    allowList = allowList.filter(id => !patch.removeDocs!.includes(id));
  }
  if (patch.addDocs?.length) {
    allowList = [...new Set([...allowList, ...patch.addDocs])];
  }
  let name = current.name;
  if (patch.name !== undefined) {
    name = patch.name.trim();
    if (!name) throw new OrganizeError('Collection name cannot be empty.');
  }

  // keep legacy fields (e.g. filterList) when the entry has no `rules`, the
  // frontend migrates them on read
  const next = { ...original, id: current.id, name, allowList };
  collections.delete(index, 1);
  collections.insert(index, [next]);
  return normalizeCollection(next)!;
}

export function deleteCollection(root: Doc, collectionId: string) {
  const collections = collectionsArray(root, false);
  const index =
    collections?.toArray().findIndex(c => plain<any>(c)?.id === collectionId) ??
    -1;
  if (!collections || index < 0) {
    throw new OrganizeError(`Collection ${collectionId} not found.`);
  }
  collections.delete(index, 1);
}

// ---------------------------------------------------------------------------
// folders (db$<workspaceId>$folders)
// ---------------------------------------------------------------------------

export type FolderLinkType = 'doc' | 'tag' | 'collection';

export interface FolderRow {
  id: string;
  parentId: string | null;
  type: 'folder' | FolderLinkType;
  data: string;
  index: string;
}

const DELETED_FLAG = '$$DELETED';
const FOLDER_FIELDS = ['parentId', 'data', 'type', 'index'] as const;

function isLiveRow(map: YMap<any>) {
  return map.size > 0 && map.get(DELETED_FLAG) !== true;
}

export function readFolderRows(folders: Doc): FolderRow[] {
  const rows: FolderRow[] = [];
  for (const key of folders.share.keys()) {
    const map = folders.getMap<any>(key);
    if (!isLiveRow(map)) continue;
    const type = map.get('type');
    if (typeof type !== 'string') continue;
    rows.push({
      id: typeof map.get('id') === 'string' ? map.get('id') : key,
      parentId: map.get('parentId') ?? null,
      type,
      data: map.get('data') ?? '',
      index: map.get('index') ?? '',
    } as FolderRow);
  }
  return rows;
}

function getRow(folders: Doc, id: string): FolderRow | null {
  if (!folders.share.has(id)) return null;
  return readFolderRows(folders).find(row => row.id === id) ?? null;
}

function sortedChildren(rows: FolderRow[], parentId: string | null) {
  return rows
    .filter(row => (row.parentId ?? null) === parentId)
    .sort((a, b) => (a.index > b.index ? 1 : -1));
}

function nextIndex(rows: FolderRow[], parentId: string | null) {
  const last = sortedChildren(rows, parentId).at(-1);
  return generateFractionalIndexingKeyBetween(last?.index || null, null);
}

function insertRow(folders: Doc, row: Omit<FolderRow, 'id'>): FolderRow {
  const id = nanoid();
  const map = folders.getMap<any>(id);
  map.set('id', id);
  map.set('parentId', row.parentId);
  map.set('type', row.type);
  map.set('data', row.data);
  map.set('index', row.index);
  map.delete(DELETED_FLAG);
  return { id, ...row };
}

function deleteRow(folders: Doc, id: string) {
  const map = folders.getMap<any>(id);
  for (const field of FOLDER_FIELDS) map.delete(field);
  map.set(DELETED_FLAG, true);
}

function assertFolder(folders: Doc, id: string): FolderRow {
  const row = getRow(folders, id);
  if (!row || row.type !== 'folder') {
    throw new OrganizeError(`Folder ${id} not found.`);
  }
  return row;
}

function isAncestor(rows: FolderRow[], childId: string, ancestorId: string) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const seen = new Set<string>([childId]);
  let current = byId.get(childId)?.parentId ?? null;
  while (current) {
    if (current === ancestorId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

export function createFolder(
  folders: Doc,
  name: string,
  parentId: string | null
): FolderRow {
  const data = name.trim();
  if (!data) throw new OrganizeError('Folder name cannot be empty.');
  if (parentId) assertFolder(folders, parentId);
  const rows = readFolderRows(folders);
  return insertRow(folders, {
    parentId,
    type: 'folder',
    data,
    index: nextIndex(rows, parentId),
  });
}

export function renameFolder(folders: Doc, folderId: string, name: string) {
  assertFolder(folders, folderId);
  const data = name.trim();
  if (!data) throw new OrganizeError('Folder name cannot be empty.');
  folders.getMap<any>(folderId).set('data', data);
}

export function moveNode(
  folders: Doc,
  nodeId: string,
  parentId: string | null
): FolderRow {
  const node = getRow(folders, nodeId);
  if (!node) throw new OrganizeError(`Folder node ${nodeId} not found.`);
  const rows = readFolderRows(folders);
  if (parentId) {
    if (parentId === nodeId) {
      throw new OrganizeError('Cannot move a folder into itself.');
    }
    assertFolder(folders, parentId);
    if (isAncestor(rows, parentId, nodeId)) {
      throw new OrganizeError('Cannot move a folder into its own descendant.');
    }
  } else if (node.type !== 'folder') {
    throw new OrganizeError('Only folders can be placed at the root level.');
  }
  const index = nextIndex(
    rows.filter(row => row.id !== nodeId),
    parentId
  );
  const map = folders.getMap<any>(nodeId);
  map.set('parentId', parentId);
  map.set('index', index);
  return { ...node, parentId, index };
}

export function deleteFolder(folders: Doc, folderId: string): number {
  assertFolder(folders, folderId);
  const rows = readFolderRows(folders);
  const stack = [folderId];
  let removed = 0;
  while (stack.length) {
    const id = stack.pop()!;
    for (const child of rows.filter(row => row.parentId === id)) {
      stack.push(child.id);
    }
    deleteRow(folders, id);
    removed++;
  }
  return removed;
}

export function addLink(
  folders: Doc,
  folderId: string,
  type: FolderLinkType,
  targetId: string
): { link: FolderRow; created: boolean } {
  assertFolder(folders, folderId);
  const rows = readFolderRows(folders);
  const existing = rows.find(
    row =>
      row.parentId === folderId && row.type === type && row.data === targetId
  );
  if (existing) return { link: existing, created: false };
  const link = insertRow(folders, {
    parentId: folderId,
    type,
    data: targetId,
    index: nextIndex(rows, folderId),
  });
  return { link, created: true };
}

export function removeLink(
  folders: Doc,
  folderId: string,
  type: FolderLinkType,
  targetId: string
): number {
  assertFolder(folders, folderId);
  const links = readFolderRows(folders).filter(
    row =>
      row.parentId === folderId && row.type === type && row.data === targetId
  );
  for (const link of links) deleteRow(folders, link.id);
  return links.length;
}

export interface FolderTreeNode {
  id: string;
  type: FolderRow['type'];
  name: string;
  target_id?: string;
  missing?: boolean;
  children?: FolderTreeNode[];
}

export function buildFolderTree(
  rows: FolderRow[],
  names: {
    doc: Map<string, string>;
    tag: Map<string, string>;
    collection: Map<string, string>;
  }
): FolderTreeNode[] {
  const build = (parentId: string | null): FolderTreeNode[] =>
    sortedChildren(rows, parentId)
      .filter(row => parentId !== null || row.type === 'folder')
      .map(row => {
        if (row.type === 'folder') {
          return {
            id: row.id,
            type: row.type,
            name: row.data,
            children: build(row.id),
          };
        }
        const name = names[row.type]?.get(row.data);
        return {
          id: row.id,
          type: row.type,
          name: name ?? '',
          target_id: row.data,
          ...(name === undefined ? { missing: true } : {}),
        };
      });
  return build(null);
}
