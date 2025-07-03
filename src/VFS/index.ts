import { IndexedDbDriver, MemoryDriver, type StorageDriver } from "../StorageDriver";


export type InodeType = "file" | "dir" | "symlink";

export interface InodePayload {
    file?: Uint8Array;
    symlink?: string;
    // dir has not payload - children live in DirEntry map
}

export interface Inode {
    id: number;             // Unique identifier for the inode
    type: InodeType;        // Type of inode: file, directory, or symlink
    mode: number;           // Unix file mode
    uid: number;            // User ID
    gid: number;            // Group ID
    ctime: number;          // Creation time in milliseconds since epoch
    mtime: number;          // Modification time in milliseconds since epoch
    atime: number;          // Access time in milliseconds since epoch
    size: number;           // Size in bytes
    links: number;          // Number of hard links to this inode
    payload?: InodePayload; // Optional payload for file or symlink
    parent: number;         // Parent inode ID for directories, undefined for root
    name?: string;          // Name of the file or directory, undefined for non-directory inodes
}


export type FileOpenMode = "r" | "w" | "rw"


export interface FileHandle {
    fd: number;              // File descriptor
    inodeId: number;         // Inode ID of the file
    offset: number;          // Current offset in the file
    mode: FileOpenMode;      // Open mode: read, write, or read/write
}

export type TDriver = MemoryDriver | IndexedDbDriver;

export class VFS {

    private inodes = new Map<number, Inode>(); // inodeId -> Inode
    private dirs = new Map<number, Map<string, number>>();  // dirId -> Map<name, inodeId>
    private nextInodeId = 2;  // Simple counter for inode IDs - 0 as invalid, inode 1 as "/"

    private nextFd = 3 // reserved for stdin, stdout, stderr
    private handles = new Map<number, FileHandle>(); // fd -> FileHandle

    private cwdId = 1; // Current working directory inode ID, starts at root "/"

    private driver: StorageDriver; // Storage driver for loading and saving the filesystem snapshot

    private dirtyInodes: Set<number> = new Set(); // Set of dirty inode IDs that need to be flushed
    private dirtyDirs: Set<number> = new Set(); // Set of dirty directory IDs that need to be flushed


    getCurrentPath(): string {
        let inode = this.getInode(this.cwdId);
        let path = inode.name || "/";
        while (inode.parent !== 0) { // Traverse up to root
            inode = this.getInode(inode.parent);
            path = `${inode.name}/${path}`;
        }
        return path.replace(/\/\//g, "/"); // Normalize double slashes
    }

    constructor(driver: StorageDriver = new MemoryDriver()) {
        this.driver = driver;
    }

    

    /**
     * Create a new VFS instance with an optional storage driver.
     * 
     * @param driver Storage driver to use for loading and saving the filesystem snapshot.
     * If not provided, defaults to an in-memory driver.
     * @returns 
     */
    static async create(driver: TDriver = new MemoryDriver()) {
        const vfs = new VFS(driver);
        await vfs.bootstrap();
        if (!vfs.inodes.has(1)) vfs.initRoot();     // only if snapshot empty
        return vfs;
    }

    /**
     * Initialize the root directory inode and its entry in the directory map.
     * This is called only if the filesystem snapshot is empty.
     */
    private initRoot() {
        const root: Inode = {
            id: 1,
            type: "dir",
            mode: 0o755,        // rwxr-xr-x
            uid: 0,
            gid: 0,
            ctime: Date.now(),
            mtime: Date.now(),
            atime: Date.now(),
            size: 0,
            links: 2,           // root has two links: itself and its parent (which is also root)
            name: "/",
            parent: 0,          // Root has no parent, can be set to 0 or undefined
        }
        this.inodes.set(root.id, root);
        this.dirs.set(root.id, new Map<string, number>()); // Initialize root directory with an empty map
    }

    /**
    * Bootstrap the VFS by loading the filesystem snapshot from the driver.
    * If the snapshot is empty, it initializes the root directory.
    *
    */
    private async bootstrap(): Promise<void> {
        const snap = await this.driver.loadFS();

        if (Object.keys(snap.inodes).length) {
            // restore
            this.inodes = new Map(Object.entries(snap.inodes).map(([inodeId, inode]) => [Number(inodeId), inode]));
            this.dirs = new Map(
                Object.entries(snap.dirs).map(([dirId, entires]) => [Number(dirId), new Map(Object.entries(entires))])
            );

            this.nextInodeId = Math.max(...this.inodes.keys()) + 1;
        } else {
            // first boot: create /
            const now = Date.now();
            const root: Inode = {
                id: 1, type: "dir", name: "/", parent: 0,
                mode: 0o755, uid: 0, gid: 0,
                ctime: now, mtime: now, atime: now,
                size: 0, links: 2
            };
            this.inodes.set(1, root);
            this.dirs.set(1, new Map());
            this.nextInodeId = 2;

            this.markDirtyInode(1);
            this.markDirtyDir(1);
            await this.flush();                      // persist clean snapshot
        }
    }


    /**
     * Mark an inode as dirty.
     * * This method adds the inode ID to the dirty set, which will be flushed later.
     * * This is used to track changes to inodes that need to be persisted.
     * 
     * @param id - The inode ID to mark as dirty
     */
    private markDirtyInode(id: number) { this.dirtyInodes.add(id); }

    /**
     * Mark a directory as dirty.
     * * This method adds the directory ID to the dirty set, which will be flushed later.
     * * This is used to track changes to directories that need to be persisted.
     * 
     * @param id - The directory ID to mark as dirty
     */
    private markDirtyDir(id: number) { this.dirtyDirs.add(id); }


    /**
     * Flush all dirty inodes and directories to the storage driver.
     * * This method collects all dirty inodes and directories,
     * * serializes them into a snapshot, and sends it to the driver.
     * * It clears the dirty sets after flushing.
     * 
     * @returns {Promise<void>} - A promise that resolves when the flush is complete
     */
    private async flush() {
        if (!this.dirtyInodes.size && !this.dirtyDirs.size) return;

        const inodesObj: Record<number, Inode> = {};
        this.dirtyInodes.forEach(id => (inodesObj[id] = this.inodes.get(id)!));

        const dirsObj: Record<number, Record<string, number>> = {};
        this.dirtyDirs.forEach(id => (dirsObj[id] = Object.fromEntries(this.dirs.get(id)!)));

        await this.driver.flushDelta({
            fullSnapshot: {           // could skip if driver only needs delta
                inodes: Object.fromEntries(this.inodes),
                dirs: Object.fromEntries([...this.dirs].map(([k, v]) => [k, Object.fromEntries(v)]))
            },
            changes: { inodes: inodesObj, dirs: dirsObj }
        });
        this.dirtyInodes.clear();
        this.dirtyDirs.clear();
    }

    /**
     * Synchronizes the filesystem state with the storage driver.
     */
    async sync() {
        await this.flush(); // Ensure all changes are flushed to the storage driver
    }

    /**
     * Gets an inode by its ID.
     * 
     * @param {number} id - The inode ID to retrieve
     */
    private getInode(id: number): Inode {
        return this.inodes.get(id)!
    }

    /**
     * Finds a child inode by name in a given directory.
     * 
     * @param {number} dirId - The ID of the directory to search in
     * @param {string} name - The name of the child to find
     */
    private child(dirId: number, name: string): Inode | undefined {
        const dir = this.dirs.get(dirId);
        if (!dir) return undefined; // No such directory

        const childId = dir.get(name);
        if (childId === undefined) return undefined; // No such child

        return this.getInode(childId); // Return the child inode
    }



    /** 
    * Resolve a path to an inode ID 
    * 
    * @param {string} path - The path to resolve
    * @returns {{ target?: Inode; parent: Inode }} An object containing the target inode and its parent
    */
    resolve(path: string): { target?: Inode; parent: Inode } {
        if (path === "") throw new Error("Empty path")
        

        // Normalize the path by removing trailing slashes
        const normalizePath = path === "/" ? "/" : path.replace(/\/+$/, "")

        const isAbs = normalizePath.startsWith("/"); // Check if the path is absolute
        let cur: Inode = this.getInode(isAbs ? 1 : this.cwdId) // If absolute, start from root; otherwise, start from current working directory
        let parent: Inode = cur;

        const parts = normalizePath.split("/").filter(Boolean) // Split path into parts, ignoring empty segments

        if (parts.length === 0 && isAbs) {
            const root = this.getInode(1); // If path is absolute and empty, return root inode
            return { target: root, parent: root } // If path is empty, return current directory
        }

        for (let i = 0; i < parts.length; i++) {
            const seg = parts[i]

            if (seg === ".") continue; // Skip current directory
            if (seg === "..") {
                if (cur.parent === 0) continue; // If at root, stay there
                
                parent = cur.parent !== 0 ? this.getInode(cur.parent) : this.getInode(1); // Move to parent directory
                cur = parent

                if (cur.id !== 1) {
                    parent = cur.parent !== 0 ? this.getInode(cur.parent) : this.getInode(1); // Update parent to the parent of current directory
                }
                continue
            }

            if (cur.type !== "dir") throw new Error(`[ENOTDIR]: Not a directory: ${cur.name || "/"}`); // If current inode is not a directory, throw error

            const child = this.child(cur.id, seg); // Find child inode by name in the current directory
            if (!child) {
                return { target: undefined, parent: cur } // If child not found, return undefined target and current directory as parent
            }

            parent = cur;
            cur = child
        }


        return { target: cur, parent: parent }
    }

    /**
     *  Open a file at the specified path with the given mode.
     * 
     * @param {string} path - The path to the file to open
     * @param {FileOpenMode} mode - The mode to open the file in (read, write, or read/write)
     */
    open(path: string, mode: FileOpenMode): number {
        const now = Date.now();
        const { target, parent } = this.resolve(path);
        
        if (!parent || parent.type !== "dir") throw new Error(`[ENOTDIR]: Not a directory: ${path}`);

        let fileNode: Inode;
        if (!target) {
            if (!mode.includes("w")) throw new Error(`[ENOENT]: File does not exists in path: ${path}`);
            const name = path.split("/").filter(Boolean).pop()!;
            fileNode = {
                id: this.nextInodeId++,
                type: "file",
                name,
                parent: parent.id,
                mode: 0o644,
                uid: 0,
                gid: 0,
                ctime: now,
                mtime: now,
                atime: now,
                size: 0,
                links: 1,
                payload: { file: new Uint8Array() }
            }
            this.inodes.set(fileNode.id, fileNode);
            this.dirs.get(parent.id)!.set(name, fileNode.id); // Add to parent directory


        } else {
            if (target.type !== "file") throw new Error(`[EISDIR]`)
            fileNode = target;
        }

        const fd = this.nextFd++;
        this.handles.set(fd, { fd, inodeId: fileNode.id, offset: 0, mode }); // Create a new file handle
        fileNode.atime = now; // Update access time

        this.markDirtyInode(fileNode.id); // Mark inode as dirty for flushing later
        this.markDirtyDir(parent.id); // Mark parent directory as dirty for flushing later
        this.flush(); // Flush changes to the storage driver

        return fd;
    }

    /**
     * Read data from a file at the specified file descriptor.
     * 
     * @param {number} fd - The file descriptor of the file to read from
     * @param {number} size - The number of bytes to read from the file
     */
    read(fd: number, size: number): Uint8Array {
        const h = this.handles.get(fd);
        if (!h || !h.mode.includes("r")) throw new Error(`[EBADF]: Bad file descriptor: ${fd}`);

        const node = this.getInode(h.inodeId);
        const data = node.payload?.file ?? new Uint8Array();
        const slice = data.slice(h.offset, h.offset + size);
        h.offset += slice.length; // Update offset
        node.atime = Date.now(); // Update access time
        return slice;

    }

    /**
     * Write data to a file at the specified file descriptor.
     * 
     * @param fd - The file descriptor of the file to write to
     * @param buf - The data to write to the file as a Uint8Array
     */
    async write(fd: number, buf: Uint8Array): Promise<void> {
        const h = this.handles.get(fd)
        if (!h || !h.mode.includes("w")) throw new Error(`[EBADF]: Bad file descriptor: ${fd}`);

        const node = this.getInode(h.inodeId);
        const oldData = node.payload?.file ?? new Uint8Array();
        const newLen = Math.max(oldData.length, h.offset + buf.length);
        const newData = new Uint8Array(newLen);

        newData.set(oldData, 0); // Copy old data
        newData.set(buf, h.offset); // Write new data at current offset

        node.payload = { file: newData }
        node.size = newLen
        node.mtime = node.atime = Date.now(); // Update modification time
        this.markDirtyInode(node.id); // Mark inode as dirty for flushing later
        this.markDirtyDir(node.parent); // Mark parent directory as dirty for flushing later
        await this.flush();
        h.offset += buf.length; // Update offset
    }

    /**
     * Clear the buffer of the file payload
     * 
     * @param fd - The file descriptor of the file to clean
     */
    async cleanPayload(fd: number): Promise<void> {
        const h = this.handles.get(fd);
        if (!h || !h.mode.includes("w")) throw new Error(`[EBADF]: Bad file descriptor: ${fd}`);

        const node = this.getInode(h.inodeId);
        if (node.type !== "file") throw new Error(`[EISDIR]: Cannot clean payload of a directory`);

        node.payload = { file: new Uint8Array() }; // Clear the file payload
        node.size = 0; // Reset size
        node.mtime = node.atime = Date.now(); // Update modification time
        this.markDirtyInode(node.id); // Mark inode as dirty for flushing later
        this.markDirtyDir(node.parent); // Mark parent directory as dirty for flushing later
        await this.flush();
    }

    /**
     * Closes the given file descriptor.
     * 
     * @param fd - The file descriptor of the file to close
     */
    close(fd: number): void {
        if (!this.handles.delete(fd)) throw new Error(`[EBADF]: Bad file descriptor: ${fd}`);
    }

    /**
     * Create a new directory at the specified path.
     * 
     * @param path - The path of the directory to create
     */
    async mkdir(path: string): Promise<void> {
        const { target, parent } = this.resolve(path);
        if (target) throw new Error(`[EEXIST]: Directory already exists at path: ${path}`);

        const name = path.split("/").filter(Boolean).pop()!;
        const now = Date.now();
        const dir: Inode = {
            id: this.nextInodeId++,
            type: "dir",
            name,
            parent: parent.id,
            mode: 0o755,
            uid: 0,
            gid: 0,
            ctime: now,
            mtime: now,
            atime: now,
            size: 0,
            links: 2                // '.' and '..'
        };

        this.inodes.set(dir.id, dir);
        this.dirs.set(dir.id, new Map<string, number>()); // Initialize directory entry map
        this.dirs.get(parent.id)!.set(name, dir.id); // Add to parent directory

        this.markDirtyInode(dir.id); // Mark inode as dirty for flushing later
        this.markDirtyDir(parent.id); // Mark parent directory as dirty for flushing later
        await this.flush();

    }

    /**
     * Change directectory to the specified path.
     * 
     * @param path - The path of the directory to change to
     */
    cd(path: string): void {
        const { target } = this.resolve(path) // .. resolve into {target: parent, parent: parent of parent}

        if (!target || target.type !== "dir") throw new Error(`[ENOENT]: No such directory: ${path}`);


        this.cwdId = target.id; // Change current working directory to the target directory
        target.atime = Date.now(); // Update access time of the target directory
        this.markDirtyInode(target.id); // Mark inode as dirty for flushing later
        this.flush(); // Flush changes to the storage driver
    }


    /**
     * List the contents of a directory at the specified path. 
     * If not path is provided, lists the contents of the current working directory.
     * 
     * @param path - [optional] The path of the directory to list 
     */
    ls(path?: string): Array<{ name: string; type: InodeType; id: number }> {
        if (!path) path = this.getCurrentPath(); // Default to current working directory if no path is provided

        const { target } = this.resolve(path);


        if (!target || target.type !== "dir") throw new Error(`[ENOENT]: No such directory: ${path}`);

        const dirEntries = this.dirs.get(target.id); // Get the directory entries for the target directory

        if (!dirEntries) return []; // If no entries, return empty array

        return Array.from(dirEntries.entries())
            .filter(([name]) => name !== "." && name !== "..")
            .map(([name, id]) => {
                const inode = this.getInode(id);
                return { name, type: inode.type, id: inode.id };
            });
    }


    /**
     * Create a new file at the specified path.
     * 
     * @param path - The path of the file to create
     */
    async touch(path: string) {
        const { target, parent } = this.resolve(path);
        if (target) throw new Error(`[EEXIST]: File already exists at path: ${path}`);

        const name = path.split("/").filter(Boolean).pop()!;
        
        const now = Date.now();
        const fileNode: Inode = {
            id: this.nextInodeId++,
            type: "file",
            name,
            parent: parent.id,
            mode: 0o644,
            uid: 0,
            gid: 0,
            ctime: now,
            mtime: now,
            atime: now,
            size: 0,
            links: 1,
            payload: { file: new Uint8Array() }
        };

        this.inodes.set(fileNode.id, fileNode);
        this.dirs.get(parent.id)!.set(name, fileNode.id); // Add to parent directory

        this.markDirtyInode(fileNode.id); // Mark inode as dirty for flushing later
        this.markDirtyDir(parent.id); // Mark parent directory as dirty for flushing later
        await this.flush();
    }

    async cat(path: string): Promise<Uint8Array> {
        const { target } = this.resolve(path);
        if (!target || target.type !== "file") throw new Error(`[ENOENT]: No such file: ${path}`);
        console.log("cat", path, target);
        
        const inode = this.getInode(target.id);
        if (!inode.payload?.file) throw new Error(`[ENOENT]: File is empty: ${path}`);

        inode.atime = Date.now(); // Update access time
        this.markDirtyInode(inode.id); // Mark inode as dirty for flushing later
        await this.flush();

        return inode.payload.file; // Return the file content
    }

}

