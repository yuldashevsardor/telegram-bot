import { expect } from "chai";
import fs from "fs/promises";

// Editing a file that ConfigFileStorage is watching. Every edit is a single step: a poll that lands
// between the truncation and the write of fs.writeFile gives a spurious signal and a rebuild from an
// empty file (docs/architecture/config.md, "Watching the file"). Writes made before watching starts
// need no helpers.

// A write in place. The r+ flag does not truncate, hence the two checks before the write.
// - The contents are not shorter than the previous ones. The write does not remove the rest of the
//   file, and the tail of the previous value would stay in it.
// - The contents are not blank. On an empty file blank contents would pass the size check, while a
//   write of zero length changes neither the size nor the time. The edit would go out without a
//   signal, and the watcher would look guilty.
// The checks stand right here, because a stat itself changes no times of the file and gives no
// signal, unlike a truncation.
export async function change(target: string, contents: string): Promise<void> {
    const length = Buffer.byteLength(contents);

    expect(length).to.be.greaterThan(0);
    expect(length).to.be.at.least((await fs.stat(target)).size);

    await fs.writeFile(target, contents, { flag: "r+" });
}

// Replacing the file as a whole: ready contents are renamed over the path. That is a single step,
// and it gives a new inode, which the spec about replacing the file needs. The file appears the same
// way. fs.writeFile would create it empty and fill it in a second step, and for the watcher that is
// again two changes.
export async function replace(target: string, contents: string): Promise<void> {
    const temporary = `${target}.tmp`;

    await fs.writeFile(temporary, contents);
    await fs.rename(temporary, target);
}
