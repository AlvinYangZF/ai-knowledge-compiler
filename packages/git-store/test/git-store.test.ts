import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitFiles,
  getFileHistory,
  initVault,
  isClean,
} from "../src/index.js";

describe("git-store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "akb-git-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("initializes a repository and creates the initial akb commit", async () => {
    writeFileSync(join(dir, "README.md"), "# Demo\n");

    await initVault(dir);

    const history = await getFileHistory(dir, "README.md");
    expect(history[0].message).toBe("akb: initialize vault");
    expect(await isClean(dir)).toBe(true);
  });

  it("commits selected files with an akb-prefixed message", async () => {
    writeFileSync(join(dir, "README.md"), "# Demo\n");
    await initVault(dir);
    writeFileSync(join(dir, "page.md"), "# Page\n");

    const hash = await commitFiles(dir, ["page.md"], "ingest page.md");

    expect(hash).toMatch(/^[a-f0-9]{40}$/);
    expect((await getFileHistory(dir, "page.md"))[0].message).toBe(
      "akb: ingest page.md",
    );
  });
});
