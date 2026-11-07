import z from 'zod/v3';

import type { PermissionAccess } from '../../../core/permission';
import {
  addLink,
  buildFolderTree,
  createCollection,
  createFolder,
  createTag,
  deleteCollection,
  deleteFolder,
  deleteTag,
  type FolderLinkType,
  hasDoc,
  moveNode,
  OrganizeError,
  readCollections,
  readDocs,
  readFolderRows,
  readTags,
  removeLink,
  renameFolder,
  resolveTags,
  setDocTrash,
  TAG_COLORS,
  type TagColor,
  updateCollection,
  updateDocTags,
  updateTag,
} from './organize-model';
import { WorkspaceOrganizer } from './organizer';
import {
  defineTool,
  toolError,
  toolJson,
  type WorkspaceMcpToolDefinition,
  type WorkspaceMcpToolResult,
} from './tool-kit';

type Context = {
  ac: PermissionAccess;
  organizer: WorkspaceOrganizer;
  userId: string;
  workspaceId: string;
};

const docIdsSchema = z.array(z.string().min(1).max(128)).min(1).max(200);
const docIdsJson = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  maxItems: 200,
};
const tagRefsJson = {
  type: 'array',
  items: { type: 'string' },
  description: 'Tag ids or tag names (case-insensitive)',
};
const colorSchema = z.enum(TAG_COLORS);
const colorJson = { type: 'string', enum: [...TAG_COLORS] };
const linkTypeSchema = z.enum(['doc', 'tag', 'collection']);
const linkTypeJson = {
  type: 'string',
  enum: ['doc', 'tag', 'collection'],
  description: 'What the folder entry points to (default: doc)',
};

async function run(
  fn: () => Promise<unknown>
): Promise<WorkspaceMcpToolResult> {
  try {
    return toolJson(await fn());
  } catch (error) {
    if (error instanceof OrganizeError) return toolError(error.message);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return toolError(`Operation failed: ${message}`);
  }
}

function pickColor(seed: string): TagColor {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export function buildOrganizeTools(ctx: Context): {
  read: WorkspaceMcpToolDefinition[];
  write: WorkspaceMcpToolDefinition[];
} {
  const { ac, organizer, userId, workspaceId } = ctx;
  const foldersDocId = WorkspaceOrganizer.foldersDocId(workspaceId);

  const workspace = () => ac.user(userId).workspace(workspaceId);

  const readableDocIds = async (ids: string[]) =>
    new Set(
      (
        await workspace().docs(
          ids.map(docId => ({ docId })),
          'Doc.Read'
        )
      ).map(item => item.docId)
    );

  const assertDocs = async (
    ids: string[],
    action: 'Doc.Update' | 'Doc.Trash' | 'Doc.Restore'
  ) => {
    const allowed = new Set(
      (
        await workspace().docs(
          ids.map(docId => ({ docId })),
          action
        )
      ).map(item => item.docId)
    );
    const denied = ids.filter(id => !allowed.has(id));
    if (denied.length) {
      throw new OrganizeError(
        `No permission (${action}) or not found: ${denied.join(', ')}`
      );
    }
  };

  const assertRootWrite = () =>
    ac.user(userId).doc(workspaceId, workspaceId).assert('Doc.Update');
  const assertFoldersWrite = () =>
    ac.user(userId).doc(workspaceId, foldersDocId).assert('Doc.Update');

  // ------------------------------------------------------------------ read

  const listDocuments = defineTool({
    name: 'list_documents',
    title: 'List Documents',
    description:
      'List documents in the workspace with id, title, tags and timestamps. Use this to discover doc ids before organizing. Supports simple filters and paging.',
    parser: z.object({
      include_trash: z.boolean().optional(),
      only_trash: z.boolean().optional(),
      title_contains: z.string().optional(),
      tag: z.string().optional(),
      untagged: z.boolean().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        include_trash: {
          type: 'boolean',
          description: 'Include trashed docs (default false)',
        },
        only_trash: { type: 'boolean', description: 'Only trashed docs' },
        title_contains: {
          type: 'string',
          description: 'Case-insensitive title substring filter',
        },
        tag: { type: 'string', description: 'Only docs with this tag id/name' },
        untagged: { type: 'boolean', description: 'Only docs without tags' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    execute: async args =>
      run(async () => {
        const root = await organizer.loadRoot(workspaceId);
        const tags = readTags(root);
        const tagNames = new Map(tags.map(t => [t.id, t.value]));
        let docs = readDocs(root);

        if (args.only_trash) docs = docs.filter(d => d.trash);
        else if (!args.include_trash) docs = docs.filter(d => !d.trash);
        if (args.title_contains) {
          const needle = args.title_contains.toLowerCase();
          docs = docs.filter(d => d.title.toLowerCase().includes(needle));
        }
        if (args.tag) {
          const { ids, missing } = resolveTags(root, [args.tag]);
          if (missing.length)
            throw new OrganizeError(`Tag not found: ${args.tag}`);
          docs = docs.filter(d => d.tags.includes(ids[0]));
        }
        if (args.untagged) docs = docs.filter(d => d.tags.length === 0);

        const readable = await readableDocIds(docs.map(d => d.id));
        docs = docs.filter(d => readable.has(d.id));

        const offset = args.offset ?? 0;
        const limit = args.limit ?? 200;
        return {
          total: docs.length,
          offset,
          documents: docs.slice(offset, offset + limit).map(d => ({
            id: d.id,
            title: d.title || 'Untitled',
            tags: d.tags.map(id => tagNames.get(id) ?? id),
            trash: d.trash || undefined,
            created_at: d.createDate
              ? new Date(d.createDate).toISOString()
              : undefined,
            updated_at: d.updatedDate
              ? new Date(d.updatedDate).toISOString()
              : undefined,
          })),
        };
      }),
  });

  const listTags = defineTool({
    name: 'list_tags',
    title: 'List Tags',
    description: 'List all workspace tags with id, name, color and doc count.',
    parser: z.object({}),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () =>
      run(async () => {
        const root = await organizer.loadRoot(workspaceId);
        const docs = readDocs(root).filter(d => !d.trash);
        return {
          colors: TAG_COLORS,
          tags: readTags(root).map(tag => ({
            id: tag.id,
            name: tag.value,
            color: tag.color,
            doc_count: docs.filter(d => d.tags.includes(tag.id)).length,
          })),
        };
      }),
  });

  const listFolders = defineTool({
    name: 'list_folders',
    title: 'List Folders',
    description:
      'Return the sidebar "Organize" folder tree. Folder entries have type "folder" and children; leaf entries link a doc, tag or collection (target_id).',
    parser: z.object({}),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () =>
      run(async () => {
        await workspace().assert('Workspace.Organize.Read');
        const [root, folders] = await Promise.all([
          organizer.loadRoot(workspaceId),
          organizer.loadFolders(workspaceId),
        ]);
        const tree = buildFolderTree(readFolderRows(folders), {
          doc: new Map(
            readDocs(root).map(d => [
              d.id,
              (d.title || 'Untitled') + (d.trash ? ' (trash)' : ''),
            ])
          ),
          tag: new Map(readTags(root).map(t => [t.id, t.value])),
          collection: new Map(readCollections(root).map(c => [c.id, c.name])),
        });
        return { folders: tree };
      }),
  });

  const listCollections = defineTool({
    name: 'list_collections',
    title: 'List Collections',
    description:
      'List collections with their manually included doc ids and rule filters.',
    parser: z.object({}),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () =>
      run(async () => {
        const root = await organizer.loadRoot(workspaceId);
        const tagNames = new Map(readTags(root).map(t => [t.id, t.value]));
        return {
          collections: readCollections(root).map(c => ({
            id: c.id,
            name: c.name,
            doc_ids: c.allowList,
            filters: c.rules.filters.map(f =>
              f.key === 'tags' && f.value
                ? { ...f, tag_name: tagNames.get(f.value) }
                : f
            ),
          })),
        };
      }),
  });

  // ----------------------------------------------------------------- write

  const createTagTool = defineTool({
    name: 'create_tag',
    title: 'Create Tag',
    description:
      'Create a workspace tag. Returns the existing tag if one with the same name (case-insensitive) exists.',
    parser: z.object({
      name: z.string().min(1),
      color: colorSchema.optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, color: colorJson },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async ({ name, color }) =>
      run(async () => {
        await assertRootWrite();
        return organizer.mutateRoot(workspaceId, userId, root =>
          createTag(root, name, color ?? pickColor(name))
        );
      }),
  });

  const updateTagTool = defineTool({
    name: 'update_tag',
    title: 'Update Tag',
    description: 'Rename a tag and/or change its color.',
    parser: z.object({
      tag: z.string().min(1),
      name: z.string().min(1).optional(),
      color: colorSchema.optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Tag id or name' },
        name: { type: 'string' },
        color: colorJson,
      },
      required: ['tag'],
      additionalProperties: false,
    },
    execute: async ({ tag, name, color }) =>
      run(async () => {
        await assertRootWrite();
        return organizer.mutateRoot(workspaceId, userId, root => {
          const { ids, missing } = resolveTags(root, [tag]);
          if (missing.length) throw new OrganizeError(`Tag not found: ${tag}`);
          return updateTag(root, ids[0], { name, color });
        });
      }),
  });

  const deleteTagTool = defineTool({
    name: 'delete_tag',
    title: 'Delete Tag',
    description: 'Delete a tag and remove it from every document.',
    parser: z.object({ tag: z.string().min(1) }),
    inputSchema: {
      type: 'object',
      properties: { tag: { type: 'string', description: 'Tag id or name' } },
      required: ['tag'],
      additionalProperties: false,
    },
    execute: async ({ tag }) =>
      run(async () => {
        await assertRootWrite();
        return organizer.mutateRoot(workspaceId, userId, root => {
          const { ids, missing } = resolveTags(root, [tag]);
          if (missing.length) throw new OrganizeError(`Tag not found: ${tag}`);
          return { deleted: ids[0], ...deleteTag(root, ids[0]) };
        });
      }),
  });

  const setDocumentTags = defineTool({
    name: 'set_document_tags',
    title: 'Set Document Tags',
    description:
      'Add, remove or replace tags on one or more documents. Tags can be referenced by id or name; set create_missing to create unknown tag names on the fly.',
    parser: z
      .object({
        doc_ids: docIdsSchema,
        add: z.array(z.string().min(1)).optional(),
        remove: z.array(z.string().min(1)).optional(),
        set: z.array(z.string().min(1)).optional(),
        create_missing: z.boolean().optional(),
      })
      .refine(v => v.add || v.remove || v.set, {
        message: 'one of add, remove or set is required',
      }),
    inputSchema: {
      type: 'object',
      properties: {
        doc_ids: docIdsJson,
        add: tagRefsJson,
        remove: tagRefsJson,
        set: { ...tagRefsJson, description: 'Replace all tags with these' },
        create_missing: { type: 'boolean' },
      },
      required: ['doc_ids'],
      additionalProperties: false,
    },
    execute: async args =>
      run(async () => {
        await assertRootWrite();
        const docIds = [...new Set(args.doc_ids)];
        await assertDocs(docIds, 'Doc.Update');
        return organizer.mutateRoot(workspaceId, userId, root => {
          const created: string[] = [];
          const resolve = (refs?: string[], allowCreate = false) => {
            if (!refs) return undefined;
            const { ids, missing } = resolveTags(root, refs);
            if (missing.length) {
              if (!allowCreate || !args.create_missing) {
                throw new OrganizeError(
                  `Unknown tags: ${missing.join(', ')} (pass create_missing: true to create them)`
                );
              }
              for (const name of missing) {
                const { tag } = createTag(root, name, pickColor(name));
                ids.push(tag.id);
                created.push(tag.value);
              }
            }
            return ids;
          };
          const change = {
            add: resolve(args.add, true),
            remove: resolve(args.remove),
            set: resolve(args.set, true),
          };
          const names = new Map(readTags(root).map(t => [t.id, t.value]));
          const results = docIds.map(docId => ({
            doc_id: docId,
            tags: updateDocTags(root, docId, change).map(
              id => names.get(id) ?? id
            ),
          }));
          return { created_tags: created, documents: results };
        });
      }),
  });

  const createFolderTool = defineTool({
    name: 'create_folder',
    title: 'Create Folder',
    description:
      'Create a folder in the sidebar Organize tree, at the root or inside parent_id.',
    parser: z.object({
      name: z.string().min(1),
      parent_id: z.string().min(1).nullable().optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        parent_id: {
          type: ['string', 'null'],
          description: 'Parent folder id; omit for root level',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async ({ name, parent_id }) =>
      run(async () => {
        await assertFoldersWrite();
        const folder = await organizer.mutateFolders(
          workspaceId,
          userId,
          folders => createFolder(folders, name, parent_id ?? null)
        );
        return { id: folder.id, name: folder.data, parent_id: folder.parentId };
      }),
  });

  const renameFolderTool = defineTool({
    name: 'rename_folder',
    title: 'Rename Folder',
    description: 'Rename a folder.',
    parser: z.object({ folder_id: z.string().min(1), name: z.string().min(1) }),
    inputSchema: {
      type: 'object',
      properties: { folder_id: { type: 'string' }, name: { type: 'string' } },
      required: ['folder_id', 'name'],
      additionalProperties: false,
    },
    execute: async ({ folder_id, name }) =>
      run(async () => {
        await assertFoldersWrite();
        await organizer.mutateFolders(workspaceId, userId, folders =>
          renameFolder(folders, folder_id, name)
        );
        return { id: folder_id, name: name.trim() };
      }),
  });

  const moveFolderNode = defineTool({
    name: 'move_folder_node',
    title: 'Move Folder Node',
    description:
      'Move a folder (or a folder entry) into another folder, appended at the end. Use parent_id null to move a folder to the root level.',
    parser: z.object({
      node_id: z.string().min(1),
      parent_id: z.string().min(1).nullable(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        parent_id: { type: ['string', 'null'] },
      },
      required: ['node_id', 'parent_id'],
      additionalProperties: false,
    },
    execute: async ({ node_id, parent_id }) =>
      run(async () => {
        await assertFoldersWrite();
        const node = await organizer.mutateFolders(
          workspaceId,
          userId,
          folders => moveNode(folders, node_id, parent_id)
        );
        return { id: node.id, parent_id: node.parentId };
      }),
  });

  const deleteFolderTool = defineTool({
    name: 'delete_folder',
    title: 'Delete Folder',
    description:
      'Delete a folder and everything inside it from the Organize tree. Linked documents themselves are NOT deleted.',
    parser: z.object({ folder_id: z.string().min(1) }),
    inputSchema: {
      type: 'object',
      properties: { folder_id: { type: 'string' } },
      required: ['folder_id'],
      additionalProperties: false,
    },
    execute: async ({ folder_id }) =>
      run(async () => {
        await assertFoldersWrite();
        const removed = await organizer.mutateFolders(
          workspaceId,
          userId,
          folders => deleteFolder(folders, folder_id)
        );
        return { deleted: folder_id, removed_entries: removed };
      }),
  });

  const addToFolder = defineTool({
    name: 'add_to_folder',
    title: 'Add To Folder',
    description:
      'Link documents (or tags/collections) into a folder. A document can live in several folders; existing links are skipped.',
    parser: z.object({
      folder_id: z.string().min(1),
      target_ids: docIdsSchema,
      type: linkTypeSchema.optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string' },
        target_ids: { ...docIdsJson, description: 'Doc/tag/collection ids' },
        type: linkTypeJson,
      },
      required: ['folder_id', 'target_ids'],
      additionalProperties: false,
    },
    execute: async ({ folder_id, target_ids, type }) =>
      run(async () => {
        await assertFoldersWrite();
        const linkType: FolderLinkType = type ?? 'doc';
        const ids = [...new Set(target_ids)];
        const root = await organizer.loadRoot(workspaceId);
        const unknown = ids.filter(id =>
          linkType === 'doc'
            ? !hasDoc(root, id)
            : linkType === 'tag'
              ? !readTags(root).some(t => t.id === id)
              : !readCollections(root).some(c => c.id === id)
        );
        if (unknown.length) {
          throw new OrganizeError(
            `Unknown ${linkType} ids: ${unknown.join(', ')}`
          );
        }
        if (linkType === 'doc') {
          const readable = await readableDocIds(ids);
          const denied = ids.filter(id => !readable.has(id));
          if (denied.length) {
            throw new OrganizeError(`No access to docs: ${denied.join(', ')}`);
          }
        }
        return organizer.mutateFolders(workspaceId, userId, folders => {
          let added = 0;
          for (const id of ids) {
            if (addLink(folders, folder_id, linkType, id).created) added++;
          }
          return { folder_id, added, skipped: ids.length - added };
        });
      }),
  });

  const removeFromFolder = defineTool({
    name: 'remove_from_folder',
    title: 'Remove From Folder',
    description:
      'Unlink documents (or tags/collections) from a folder. The documents themselves are not deleted.',
    parser: z.object({
      folder_id: z.string().min(1),
      target_ids: docIdsSchema,
      type: linkTypeSchema.optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string' },
        target_ids: docIdsJson,
        type: linkTypeJson,
      },
      required: ['folder_id', 'target_ids'],
      additionalProperties: false,
    },
    execute: async ({ folder_id, target_ids, type }) =>
      run(async () => {
        await assertFoldersWrite();
        return organizer.mutateFolders(workspaceId, userId, folders => {
          let removed = 0;
          for (const id of new Set(target_ids)) {
            removed += removeLink(folders, folder_id, type ?? 'doc', id);
          }
          return { folder_id, removed };
        });
      }),
  });

  const createCollectionTool = defineTool({
    name: 'create_collection',
    title: 'Create Collection',
    description:
      'Create a collection. doc_ids are included manually; tags adds rule filters so every doc having ALL of those tags is included automatically.',
    parser: z.object({
      name: z.string().min(1),
      doc_ids: z.array(z.string().min(1)).max(500).optional(),
      tags: z.array(z.string().min(1)).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        doc_ids: { type: 'array', items: { type: 'string' } },
        tags: tagRefsJson,
      },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async ({ name, doc_ids, tags }) =>
      run(async () => {
        await assertRootWrite();
        return organizer.mutateRoot(workspaceId, userId, root => {
          const unknownDocs = (doc_ids ?? []).filter(id => !hasDoc(root, id));
          if (unknownDocs.length) {
            throw new OrganizeError(
              `Unknown doc ids: ${unknownDocs.join(', ')}`
            );
          }
          const resolved = resolveTags(root, tags ?? []);
          if (resolved.missing.length) {
            throw new OrganizeError(
              `Unknown tags: ${resolved.missing.join(', ')}`
            );
          }
          return createCollection(root, {
            name,
            allowList: doc_ids,
            tagIds: resolved.ids,
          });
        });
      }),
  });

  const updateCollectionTool = defineTool({
    name: 'update_collection',
    title: 'Update Collection',
    description:
      'Rename a collection and/or add/remove manually included documents.',
    parser: z.object({
      collection_id: z.string().min(1),
      name: z.string().min(1).optional(),
      add_doc_ids: z.array(z.string().min(1)).optional(),
      remove_doc_ids: z.array(z.string().min(1)).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        collection_id: { type: 'string' },
        name: { type: 'string' },
        add_doc_ids: { type: 'array', items: { type: 'string' } },
        remove_doc_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['collection_id'],
      additionalProperties: false,
    },
    execute: async args =>
      run(async () => {
        await assertRootWrite();
        return organizer.mutateRoot(workspaceId, userId, root => {
          const unknownDocs = (args.add_doc_ids ?? []).filter(
            id => !hasDoc(root, id)
          );
          if (unknownDocs.length) {
            throw new OrganizeError(
              `Unknown doc ids: ${unknownDocs.join(', ')}`
            );
          }
          return updateCollection(root, args.collection_id, {
            name: args.name,
            addDocs: args.add_doc_ids,
            removeDocs: args.remove_doc_ids,
          });
        });
      }),
  });

  const deleteCollectionTool = defineTool({
    name: 'delete_collection',
    title: 'Delete Collection',
    description: 'Delete a collection. Documents in it are not affected.',
    parser: z.object({ collection_id: z.string().min(1) }),
    inputSchema: {
      type: 'object',
      properties: { collection_id: { type: 'string' } },
      required: ['collection_id'],
      additionalProperties: false,
    },
    execute: async ({ collection_id }) =>
      run(async () => {
        await assertRootWrite();
        await organizer.mutateRoot(workspaceId, userId, root =>
          deleteCollection(root, collection_id)
        );
        return { deleted: collection_id };
      }),
  });

  const trashDocuments = defineTool({
    name: 'trash_documents',
    title: 'Move Documents To Trash',
    description:
      'Move documents to the trash (recoverable with restore_documents). Does not permanently delete.',
    parser: z.object({ doc_ids: docIdsSchema }),
    inputSchema: {
      type: 'object',
      properties: { doc_ids: docIdsJson },
      required: ['doc_ids'],
      additionalProperties: false,
    },
    execute: async ({ doc_ids }) =>
      run(async () => {
        await assertRootWrite();
        const ids = [...new Set(doc_ids)];
        await assertDocs(ids, 'Doc.Trash');
        await organizer.mutateRoot(workspaceId, userId, root => {
          for (const id of ids) setDocTrash(root, id, true);
        });
        return { trashed: ids };
      }),
  });

  const restoreDocuments = defineTool({
    name: 'restore_documents',
    title: 'Restore Documents',
    description: 'Restore documents from the trash.',
    parser: z.object({ doc_ids: docIdsSchema }),
    inputSchema: {
      type: 'object',
      properties: { doc_ids: docIdsJson },
      required: ['doc_ids'],
      additionalProperties: false,
    },
    execute: async ({ doc_ids }) =>
      run(async () => {
        await assertRootWrite();
        const ids = [...new Set(doc_ids)];
        await assertDocs(ids, 'Doc.Restore');
        await organizer.mutateRoot(workspaceId, userId, root => {
          for (const id of ids) setDocTrash(root, id, false);
        });
        return { restored: ids };
      }),
  });

  return {
    read: [listDocuments, listTags, listFolders, listCollections],
    write: [
      createTagTool,
      updateTagTool,
      deleteTagTool,
      setDocumentTags,
      createFolderTool,
      renameFolderTool,
      moveFolderNode,
      deleteFolderTool,
      addToFolder,
      removeFromFolder,
      createCollectionTool,
      updateCollectionTool,
      deleteCollectionTool,
      trashDocuments,
      restoreDocuments,
    ],
  };
}
