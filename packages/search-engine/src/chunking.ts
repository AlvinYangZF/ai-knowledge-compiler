import type { PageId } from "@akb/core";
import type { Chunk } from "./types.js";

export interface ChunkingOptions {
  maxTokens?: number;
  charsPerToken?: number;
  bodyStartLine?: number;
}

export function chunkByHeaders(
  pageId: PageId,
  body: string,
  opts: ChunkingOptions = {},
): Chunk[] {
  const maxTokens = opts.maxTokens ?? 800;
  const charsPerToken = opts.charsPerToken ?? 4;
  const bodyStartLine = opts.bodyStartLine ?? 1;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return [];
  }

  const starts = findSectionStarts(lines);
  const ranges =
    starts.length === 0
      ? [{ start: 0, end: lines.length - 1 }]
      : buildHeaderRanges(starts, lines.length);

  const chunks: Chunk[] = [];
  for (const range of ranges) {
    const trimmed = trimTrailingBlank(lines, range.start, range.end);
    if (trimmed.end < trimmed.start) {
      continue;
    }
    const text = lines.slice(trimmed.start, trimmed.end + 1).join("\n");
    for (const piece of splitOversizedText(text, maxTokens, charsPerToken)) {
      chunks.push({
        id: `${pageId}:c${chunks.length}`,
        pageId,
        index: chunks.length,
        lineStart: bodyStartLine + trimmed.start,
        lineEnd: bodyStartLine + trimmed.end,
        text: piece,
        tokenCount: estimateTokens(piece, charsPerToken),
      });
    }
  }

  return chunks;
}

export function estimateTokens(text: string, charsPerToken = 4): number {
  return Math.ceil(text.length / charsPerToken);
}

function findSectionStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let inFence = false;
  let fenceMarker: "`" | "~" | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marker = fence[1][0] as "`" | "~";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = undefined;
      }
      continue;
    }

    if (!inFence && /^#{1,3}\s+/.test(line)) {
      starts.push(index);
    }
  }
  return starts;
}

function buildHeaderRanges(
  starts: number[],
  lineCount: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  if (starts[0] > 0) {
    ranges.push({ start: 0, end: starts[0] - 1 });
  }
  for (let index = 0; index < starts.length; index += 1) {
    ranges.push({
      start: starts[index],
      end: index + 1 < starts.length ? starts[index + 1] - 1 : lineCount - 1,
    });
  }
  return ranges;
}

function trimTrailingBlank(
  lines: string[],
  start: number,
  end: number,
): { start: number; end: number } {
  let trimmedEnd = end;
  while (trimmedEnd >= start && lines[trimmedEnd].trim() === "") {
    trimmedEnd -= 1;
  }
  return { start, end: trimmedEnd };
}

function splitOversizedText(
  text: string,
  maxTokens: number,
  charsPerToken: number,
): string[] {
  if (estimateTokens(text, charsPerToken) <= maxTokens) {
    return [text];
  }

  const maxChars = maxTokens * charsPerToken;
  const units = text.includes("\n\n")
    ? text.split(/(\n{2,})/)
    : text.split(/(?<=[.!?。！？])\s+/u);
  const normalizedUnits = units.filter((unit) => unit.length > 0);
  if (normalizedUnits.length <= 1) {
    return splitByWords(text, maxChars);
  }

  const pieces: string[] = [];
  let current = "";
  for (const unit of normalizedUnits) {
    if (unit.length > maxChars) {
      if (current.trim()) {
        pieces.push(current.trim());
        current = "";
      }
      pieces.push(...splitByWords(unit, maxChars));
      continue;
    }
    const next = current ? `${current}${unit}` : unit;
    if (next.length > maxChars && current.trim()) {
      pieces.push(current.trim());
      current = unit;
    } else {
      current = next;
    }
  }
  if (current.trim()) {
    pieces.push(current.trim());
  }
  return pieces;
}

function splitByWords(text: string, maxChars: number): string[] {
  const words = text.split(/(\s+)/);
  const pieces: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxChars) {
      if (current.trim()) {
        pieces.push(current.trim());
        current = "";
      }
      for (let index = 0; index < word.length; index += maxChars) {
        pieces.push(word.slice(index, index + maxChars));
      }
      continue;
    }
    if (current.length + word.length > maxChars && current.trim()) {
      pieces.push(current.trim());
      current = word;
    } else {
      current += word;
    }
  }
  if (current.trim()) {
    pieces.push(current.trim());
  }
  return pieces;
}
