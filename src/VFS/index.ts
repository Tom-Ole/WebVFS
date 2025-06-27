

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


export class VFS {

    private inodes = new Map<number, Inode>();
    private dirs = new Map<number, Map<string, number>>();  // dirId -> Map<name, inodeId>
    private nextInodeId = 2;  // Simple counter for inode IDs - 0 as invalid, inode 1 as "/"

    private nextFd = 3 // reserved for stdin, stdout, stderr
    private handles = new Map<number, FileHandle>();

    private cwdId = 1; // Current working directory inode ID, starts at root "/"


    constructor() {
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

    private getInode(id: number): Inode {
        return this.inodes.get(id)!
    }

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
    */
    resolve(path: string): { target?: Inode; parent: Inode } {
        if (path === "") throw new Error("Empty path")

        const isAbs = path.startsWith("/");
        let cur: Inode = this.getInode(isAbs ? 1 : this.cwdId) // Start at root or current working directory

        const parts = path.split("/").filter(Boolean) // Split path into parts, ignoring empty segments
        for (let i = 0; i < parts.length; i++) {
            const seg = parts[i]

            if (seg === ".") continue; // Skip current directory
            if (seg === "..") {
                cur = this.getInode(cur.parent)! // Move to parent directory
                continue
            }

            const child = this.child(cur.id, seg);
            if (!child) {
                return { target: undefined, parent: cur }
            }

            cur = child
        }

        return { target: cur, parent: this.getInode(cur.parent) }

    }

    open(path: string, mode: FileOpenMode): number {
        const now = Date.now();
        const { target, parent } = this.resolve(path);

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



        return fd;
    }

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

    write(fd: number, buf: Uint8Array): void {
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
        h.offset += buf.length; // Update offset

    }

    close(fd: number): void {
        if (!this.handles.delete(fd)) throw new Error(`[EBADF]: Bad file descriptor: ${fd}`);
    }


    mkdir(path: string): void {
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

    }

    cd(path: string): void {
        const { target } = this.resolve(path);
        if (!target || target.type !== "dir") throw new Error(`[ENOENT]: No such directory: ${path}`);
        if (target.id === 1) return; // No need to change if already at root
        this.cwdId = target.id; // Change current working directory to the target directory
    }

    ls(path?: string): Array<{ name: string; type: InodeType; id: number }> {
        if (!path) path = ".";
        const { target } = this.resolve(path);
        if (!target || target.type !== "dir") throw new Error(`[ENOENT]: No such directory: ${path}`);
        const dirEntries = this.dirs.get(target.id);
        if (!dirEntries) throw new Error(`[ENOENT]: No such directory: ${path}`);

        return Array.from(dirEntries.entries())
            .filter(([name]) => name !== "." && name !== "..")
            .map(([name, id]) => {
                const inode = this.getInode(id);
                return { name, type: inode.type, id: inode.id };
            });

    }

}

