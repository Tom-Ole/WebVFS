import { describe, it, expect, beforeEach } from "vitest";
import { VFS } from "../VFS";       // adjust relative path to where your class lives

describe("VFS", () => {
    let vfs: VFS;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    beforeEach(() => {
        vfs = new VFS();               // fresh FS for every test
    });

    /* ------------------------------------------------------------------ *
     * Path resolution & cwd
     * ------------------------------------------------------------------ */
    it("resolves '/' to the root inode", () => {
        const { target } = vfs.resolve("/");
        expect(target?.id).toBe(1);
        expect(target?.type).toBe("dir");
    });

    it("changes cwd with chdir semantic by modifying vfs.cwdId", () => {
        // mkdir equivalent: open for write to create file, then check parent dir
        vfs.open("/workfile", "w");
        vfs.resolve("/workfile");  // should not throw
        // Mimic a minimal chdir by directly tweaking cwd (since chdir isn't implemented)
        (vfs as any).cwdId = 1;    // still root; just sanity
    });

    /* ------------------------------------------------------------------ *
     * Open, write, read, close
     * ------------------------------------------------------------------ */
    it("creates, writes, reads and closes a file correctly", () => {
        const fd = vfs.open("/hello.txt", "rw");
        vfs.write(fd, enc.encode("Hello VFS"));
        vfs.close(fd);

        const fd2 = vfs.open("/hello.txt", "r");
        const data = vfs.read(fd2, 1024);
        vfs.close(fd2);

        expect(dec.decode(data)).toBe("Hello VFS");
    });

    /* ------------------------------------------------------------------ *
     * Relative paths & cwd tracking
     * ------------------------------------------------------------------ */
    it("handles relative paths from the stored cwd", () => {
        vfs.mkdir("/docs");
        vfs.open("/docs/readme.md", "w");

        (vfs as any).cwdId = vfs.resolve("/docs").target!.id;

        const fd = vfs.open("readme.md", "r");
        const bytes = vfs.read(fd, 5);
        vfs.close(fd);

        expect(bytes.length).toBe(0);
    });


    /* ------------------------------------------------------------------ *
     * ls
     * ------------------------------------------------------------------ */
    it("lists files in a directory", () => {
        vfs.mkdir("/testdir");
        vfs.mkdir("/testdir/testdir2");
        vfs.open("/testdir/file1.txt", "w");
        vfs.open("/testdir/file2.txt", "w");

        const files = vfs.ls("/testdir");

        expect(files.length).toBe(3);
        expect(files[0].name).toBe("testdir2")
        expect(files[0].type).toBe("dir")
        expect(files[1].name).toBe("file1.txt");
        expect(files[1].type).toBe("file");
        expect(files[2].name).toBe("file2.txt");
        expect(files[2].type).toBe("file");
    });

    /* ------------------------------------------------------------------ *
     * Error cases
     * ------------------------------------------------------------------ */
    it("throws ENOENT if file missing and opened readonly", () => {
        expect(() => vfs.open("/nope.txt", "r")).toThrowError(/ENOENT/);
    });

    it("throws EISDIR when trying to open a directory as a file", () => {
        expect(() => vfs.open("/", "r")).toThrowError(/EISDIR/);
    });

    it("throws EBADF when using an unknown fd", () => {
        expect(() => vfs.read(999, 10)).toThrowError(/EBADF/);
    });
});


