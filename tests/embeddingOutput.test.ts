import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  embeddingOutputFilePath,
  findReusableEmbeddingOutput,
  writeEmbeddingOutput,
  type EmbeddingOutput,
} from "../src/persistence/embeddingOutput.js";

function makeOutput(overrides: Partial<EmbeddingOutput["metadata"]> = {}): EmbeddingOutput {
  return {
    metadata: {
      inputFile: "data/intelligence/extractions-2026-08-09.json",
      createdAt: "2026-08-09T00:00:00.000Z",
      extractionPromptVersion: "v2",
      embeddingModel: "voyage-4",
      embeddingDimension: 1024,
      technicalEscalations: 18,
      ...overrides,
    },
    embeddings: [
      {
        rootTs: "1",
        normalizedProblemStatement: "Bulk upload times out for large batches",
        classification: "technical_defect",
        permalink: "https://example.slack.com/p1",
        vector: [0.1, 0.2, 0.3],
      },
    ],
  };
}

describe("embeddingOutputFilePath", () => {
  it("names the file with the creation date in YYYY-MM-DD form", () => {
    expect(embeddingOutputFilePath("/tmp/data/intelligence", new Date("2026-08-09T12:00:00.000Z"))).toBe(
      path.join("/tmp/data/intelligence", "embeddings-2026-08-09.json"),
    );
  });

  it("carries the source window tag through", () => {
    expect(embeddingOutputFilePath("/tmp/data/intelligence", new Date("2026-08-09T12:00:00.000Z"), "90d")).toBe(
      path.join("/tmp/data/intelligence", "embeddings-90d-2026-08-09.json"),
    );
  });

  it("does not collide across windows on the same day", () => {
    const day = new Date("2026-08-09T12:00:00.000Z");
    expect(embeddingOutputFilePath("/d", day, "30d")).not.toBe(embeddingOutputFilePath("/d", day, "90d"));
  });
});

describe("writeEmbeddingOutput", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes valid JSON matching the documented output shape", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "escalation-intelligence-embed-test-"));
    const filePath = embeddingOutputFilePath(path.join(dir, "nested"), new Date("2026-08-09T00:00:00.000Z"));
    const output = makeOutput();

    await writeEmbeddingOutput(output, filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as EmbeddingOutput;

    expect(parsed).toEqual(output);
    expect(Object.keys(parsed).sort()).toEqual(["embeddings", "metadata"]);
  });
});

describe("findReusableEmbeddingOutput", () => {
  const criteria = {
    inputFile: "data/intelligence/extractions-2026-08-09.json",
    extractionPromptVersion: "v2",
    embeddingModel: "voyage-4",
  };

  it("reuses an output matching input file, prompt version, and model", () => {
    expect(findReusableEmbeddingOutput([makeOutput()], criteria)).toBeDefined();
  });

  it("does not reuse when the embedding model differs", () => {
    const prior = makeOutput({ embeddingModel: "voyage-4-large" });
    expect(findReusableEmbeddingOutput([prior], criteria)).toBeUndefined();
  });

  it("does not reuse when the extraction prompt version differs", () => {
    const prior = makeOutput({ extractionPromptVersion: "v1" });
    expect(findReusableEmbeddingOutput([prior], criteria)).toBeUndefined();
  });

  it("does not reuse when the source extraction file differs", () => {
    const prior = makeOutput({ inputFile: "data/intelligence/extractions-2026-08-01.json" });
    expect(findReusableEmbeddingOutput([prior], criteria)).toBeUndefined();
  });

  it("returns undefined when there are no prior outputs", () => {
    expect(findReusableEmbeddingOutput([], criteria)).toBeUndefined();
  });
});
