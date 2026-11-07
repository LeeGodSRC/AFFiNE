import { Injectable, Logger } from '@nestjs/common';
import { applyUpdate, Doc, mergeUpdates } from 'yjs';

import { EventBus } from '../../../base';
import { PgWorkspaceDocStorageAdapter } from '../../../core/doc';

/**
 * Loads workspace Yjs docs (root doc, folders db doc), applies a mutation and
 * persists only the resulting delta, then broadcasts it to connected clients
 * the same way {@link DocWriter} does.
 */
@Injectable()
export class WorkspaceOrganizer {
  private readonly logger = new Logger(WorkspaceOrganizer.name);

  constructor(
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly event: EventBus
  ) {}

  static foldersDocId(workspaceId: string) {
    return `db$${workspaceId}$folders`;
  }

  async load(workspaceId: string, docId: string): Promise<Doc> {
    const record = await this.storage.getDoc(workspaceId, docId);
    const doc = new Doc({ guid: docId });
    if (record?.bin && !this.storage.isEmptyBin(record.bin)) {
      applyUpdate(doc, record.bin);
    }
    return doc;
  }

  async loadRoot(workspaceId: string) {
    return this.load(workspaceId, workspaceId);
  }

  async loadFolders(workspaceId: string) {
    return this.load(workspaceId, WorkspaceOrganizer.foldersDocId(workspaceId));
  }

  /**
   * Run `mutate` inside a single Yjs transaction on a freshly loaded doc and
   * push the produced delta. Nothing is persisted if `mutate` throws.
   */
  async mutate<T>(
    workspaceId: string,
    docId: string,
    editorId: string,
    mutate: (doc: Doc) => T
  ): Promise<T> {
    const doc = await this.load(workspaceId, docId);

    // Capture exactly the update produced by this transaction. (Diffing with
    // encodeStateAsUpdate(doc, stateVector) would always re-send the doc's
    // whole delete set.)
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));

    let result!: T;
    let error: unknown;
    doc.transact(() => {
      try {
        result = mutate(doc);
      } catch (e) {
        error = e;
      }
    });
    if (error) throw error;

    const update = updates.length === 1 ? updates[0] : mergeUpdates(updates);
    if (!updates.length || this.storage.isEmptyBin(update)) {
      return result;
    }

    const timestamp = await this.storage.pushDocUpdates(
      workspaceId,
      docId,
      [update],
      editorId
    );
    this.event.emit('doc.updates.pushed', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId,
      updates: [update],
      timestamp,
      editor: editorId,
    });
    this.logger.debug(
      `pushed organize update to ${workspaceId}/${docId} (${update.byteLength} bytes)`
    );
    return result;
  }

  mutateRoot<T>(workspaceId: string, editorId: string, fn: (doc: Doc) => T) {
    return this.mutate(workspaceId, workspaceId, editorId, fn);
  }

  mutateFolders<T>(workspaceId: string, editorId: string, fn: (doc: Doc) => T) {
    return this.mutate(
      workspaceId,
      WorkspaceOrganizer.foldersDocId(workspaceId),
      editorId,
      fn
    );
  }
}
