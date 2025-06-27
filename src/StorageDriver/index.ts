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
        const inodesReq = this.db.transaction("inodes").objectStore("inodes").getAll();
        const dirsReq = this.db.transaction("dirs").objectStore("dirs").getAll();

        const [inodeArr, dirArr] = await Promise.all([
            new Promise<Inode[]>((res, rej) => {
                inodesReq.onsuccess = () => res(inodesReq.result as Inode[]);
                inodesReq.onerror = () => rej(inodesReq.error);
            }),
            new Promise<Record<string, number>[]>((res, rej) => {
                dirsReq.onsuccess = () => res(dirsReq.result as Record<string, number>[]);
                dirsReq.onerror = () => rej(dirsReq.error);
            })
        ]);

        const inodes: Record<number, Inode> = {};
        inodeArr.forEach(i => (inodes[i.id] = i));

        const dirs: Record<number, Record<string, number>> = {};
        dirArr.forEach((d: any) => (dirs[d.id] = d));

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