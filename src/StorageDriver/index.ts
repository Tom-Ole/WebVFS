import type { Inode } from "../VFS";

/**
 * Interface for storage drivers used by the virtual filesystem.
 */
export interface StorageDriver {
    loadFS(): Promise<SerializedFS>;
    flushDelta(delta: FSDelta): Promise<void>;
}

/**
 * Serialized representation of the filesystem.
 */
export interface SerializedFS {
    inodes: Record<number, Inode>;
    dirs: Record<number, Record<string, number>>;
}

/**
 * Represents a delta of changes made to the filesystem.
 */
export interface FSDelta {
    fullSnapshot: SerializedFS;
    changes: {
        inodes: Record<number, Inode>;
        dirs: Record<number, Record<string, number>>;
    };
}

/**
 * Memory-based storage driver for the virtual filesystem.
 * This driver stores the filesystem state in memory, allowing for fast access
 * and manipulation of the filesystem. It implements the StorageDriver interface,
 * providing methods to load the filesystem state and flush changes to memory.
 * Note that this driver does not persist data across sessions, so it is suitable
 * for testing or temporary storage needs.
 */
export class MemoryDriver implements StorageDriver {
    private snapshot: SerializedFS | null = null;

    /**
     * Loads the current filesystem snapshot from memory.
     * 
     * @returns A promise that resolves to the current filesystem snapshot.
     */
    async loadFS(): Promise<SerializedFS> {
        if (this.snapshot) {
            return this.snapshot;
        }
        // Return an empty snapshot if nothing has been set yet
        return { inodes: {}, dirs: {} };
    }

    /**
     * Flushes the provided delta to memory.
     * 
     * @param delta The delta containing the full snapshot and changes to be flushed.
     * @returns A promise that resolves when the delta has been flushed.
     */
    async flushDelta(delta: FSDelta): Promise<void> {
        // Store the full snapshot in memory
        this.snapshot = delta.fullSnapshot;
    }
}


/**
 * IndexedDB-based storage driver for the virtual filesystem.
 * This driver uses IndexedDB to persist the filesystem state, allowing for
 * persistent storage across browser sessions.
 * It implements the StorageDriver interface, providing methods to load the
 * filesystem state and flush changes to the database.
 */
export class IndexedDbDriver implements StorageDriver {
    private db!: IDBDatabase;

    /**
     * Loads the current filesystem snapshot from IndexedDB.
     * 
     * @returns A promise that resolves to the current filesystem snapshot.
     */
    async loadFS(): Promise<SerializedFS> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("vfs", 1);
            request.onupgradeneeded = (event) => {
                this.db = (event.target as IDBOpenDBRequest).result;
                this.db.createObjectStore("inodes");
                this.db.createObjectStore("dirs");
            };
            request.onsuccess = async (event) => {
                this.db = (event.target as IDBOpenDBRequest).result;
                resolve(await this.getSnapshot());
            };
            request.onerror = (event) => {
                reject((event.target as IDBOpenDBRequest).error);
            };
        });
    }

    /**
     * Gets the current filesystem snapshot from IndexedDB.
     * 
     * @returns A promise that resolves to the current filesystem snapshot from IndexedDB.
     */
    private async getSnapshot(): Promise<SerializedFS> {
        const inodes: Record<number, Inode> = {};
        const dirs: Record<number, Record<string, number>> = {};

        // Helper to walk one store with a cursor
        const walkStore = <T>(
            storeName: "inodes" | "dirs",
            target: Record<number, T>
        ) =>
            new Promise<void>((resolve, reject) => {
                const cursorReq = this.db
                    .transaction(storeName)
                    .objectStore(storeName)
                    .openCursor();

                cursorReq.onsuccess = () => {
                    const cur = cursorReq.result;
                    if (cur) {
                        target[cur.key as number] = cur.value as T;
                        cur.continue();          // keep walking
                    } else {
                        resolve();               // done
                    }
                };

                cursorReq.onerror = () => reject(cursorReq.error);
            });

        // Run both walks in parallel
        await Promise.all([
            walkStore<Inode>("inodes", inodes),
            walkStore<Record<string, number>>("dirs", dirs),
        ]);

        return { inodes, dirs };
    }


    /**
     * Flushes the provided delta to IndexedDB.
     * 
     * @param delta The delta containing the full snapshot and changes to be flushed.
     * @returns A promise that resolves when the delta has been flushed to IndexedDB.
     */
    async flushDelta(delta: FSDelta): Promise<void> {
        const transaction = this.db.transaction(["inodes", "dirs"], "readwrite");
        const inodesStore = transaction.objectStore("inodes");
        const dirsStore = transaction.objectStore("dirs");

        for (const [id, inode] of Object.entries(delta.changes.inodes)) {
            inodesStore.put(inode, Number(id));
        }

        for (const [id, dir] of Object.entries(delta.changes.dirs)) {
            dirsStore.put(dir, Number(id));
        }

        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = (event) => reject((event.target as IDBTransaction).error);
        });
    }
}