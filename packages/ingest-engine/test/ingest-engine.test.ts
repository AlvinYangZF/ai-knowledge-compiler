import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  convertIngestSource,
  discoverIngestSources,
  rawSourceHash,
  targetMarkdownPath,
  type CommandRunner,
  type IngestSource,
} from "../src/index.js";

describe("ingest-engine", () => {
  it("discovers supported document sources and excludes code by default", () => {
    const root = mkdtempSync(join(tmpdir(), "akb-ingest-engine-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "docs", "a.md"), "# A\n");
    writeFileSync(join(root, "docs", "readme.pdf"), "%PDF fixture");
    writeFileSync(join(root, "notes", "plain.txt"), "plain fixture");
    writeFileSync(join(root, "src", "gc.c"), "int gc_should_trigger(void) { return 1; }\n");

    const result = discoverIngestSources(root, {
      recursive: true,
      includeHidden: false,
      includeDocuments: true,
      includeCode: false,
    });

    expect(result.sources.map((source) => source.relativePath)).toEqual([
      "docs/a.md",
      "docs/readme.pdf",
      "notes/plain.txt",
    ]);
  });

  it("computes stable markdown target paths", () => {
    expect(
      targetMarkdownPath({
        absolutePath: "/tmp/docs/readme.pdf",
        relativePath: "docs/readme.pdf",
        extension: ".pdf",
        kind: "document",
      }),
    ).toBe("docs/readme.pdf.md");
    expect(
      targetMarkdownPath({
        absolutePath: "/tmp/docs/note.markdown",
        relativePath: "docs/note.markdown",
        extension: ".markdown",
        kind: "markdown",
      }),
    ).toBe("docs/note.md");
  });

  it("converts C code into structured markdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "akb-ingest-code-"));
    const file = join(root, "gc.c");
    writeFileSync(
      file,
      [
        "#include <stdio.h>",
        '#include "gc.h"',
        "",
        "int gc_should_trigger(void) {",
        "  return 1;",
        "}",
      ].join("\n"),
    );
    const source: IngestSource = {
      absolutePath: file,
      relativePath: "gc.c",
      extension: ".c",
      kind: "code",
    };

    const result = await convertIngestSource(source, { mode: "auto" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.value.sourceType).toBe("code");
    expect(result.value.sourceSubtype).toBe("c");
    expect(result.value.markdown).toContain("```c");
    expect(result.value.markdown).toContain("gc_should_trigger");
    expect(result.value.metadata.includes).toEqual(["stdio.h", "gc.h"]);
    expect(result.value.metadata.functions).toEqual(["gc_should_trigger"]);
  });

  it("hashes raw source bytes", () => {
    expect(rawSourceHash(Buffer.from("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("reports missing external converters as conversion failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "akb-ingest-doc-"));
    const file = join(root, "legacy.doc");
    writeFileSync(file, "legacy");
    const source: IngestSource = {
      absolutePath: file,
      relativePath: "legacy.doc",
      extension: ".doc",
      kind: "document",
    };
    const failingRunner: CommandRunner = {
      run(command, args) {
        return {
          ok: false,
          error: `missing ${command} ${args.join(" ")}`,
        };
      },
    };

    await expect(
      convertIngestSource(source, {
        mode: "external",
        commandRunner: failingRunner,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("No converter available"),
    });
  });
});
