import type { Inode } from "../VFS";

export interface StorageDriver {
    loadFS(): Promise<SerializedFS>;
    flushDelta(delta: FSDelta): Promise<void>;
}

export interface SerializedFS {
    inodes: Record<number, Inode>;
    dirs: Record<number, Record<string, number>>;
}

export interface FSDelta {
    fullSnapshot: SerializedFS;
    changes: {
        inodes: Record<number, Inode>;
        dirs: Record<number, Record<string, number>>;
    };
}

// 2. default in-memory no-op driver
export class MemoryDriver implements StorageDriver {
    private snapshot: SerializedFS | null = null;

    async loadFS(): Promise<SerializedFS> {
        if (this.snapshot) {
            return this.snapshot;
        }
        // Return an empty snapshot if nothing has been set yet
        return { inodes: {}, dirs: {} };
    }

    async flushDelta(delta: FSDelta): Promise<void> {
        // Store the full snapshot in memory
        this.snapshot = delta.fullSnapshot;
    }
}

export class IndexedDbDriver implements StorageDriver {
    private db!: IDBDatabase;

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