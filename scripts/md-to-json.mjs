#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const INPUT = process.argv[2] || "WOA.md";
const OUTPUT = process.argv[3] || "data/journals.json";

const SECTION_ALIASES = new Map([
  ["SCIE", "SCIE"],
  ["核心期刊", "北小核心"],
  ["北小核心", "北小核心"],
  ["会议", "会议"]
]);

function splitMarkdownRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isAlignmentRow(cells) {
  return (
    cells.length > 0 &&
    cells.every((cell) => cell.length > 0 && /^:?-{2,}:?$/.test(cell))
  );
}

function normalizeRow(cells, expectedLength) {
  if (cells.length === expectedLength) return cells;
  if (cells.length < expectedLength) {
    return [...cells, ...Array(expectedLength - cells.length).fill("")];
  }

  const head = cells.slice(0, expectedLength - 1);
  const tail = cells.slice(expectedLength - 1).join(" | ").trim();
  return [...head, tail];
}

function extractImagePath(raw) {
  if (!raw) return "";
  const markdownMatch = raw.match(/\]\(([^)]+)\)/);
  if (markdownMatch) return normalizeImagePath(markdownMatch[1].trim());

  const htmlMatch = raw.match(/src=["']([^"']+)["']/i);
  if (htmlMatch) return normalizeImagePath(htmlMatch[1].trim());

  return "";
}

function normalizeImagePath(inputPath) {
  if (!inputPath) return "";
  const normalized = inputPath.replace(/\\/g, "/");
  const assetIndex = normalized.indexOf("WOA.assets/");
  if (assetIndex >= 0) {
    return `./${normalized.slice(assetIndex)}`;
  }
  return normalized;
}

function parseTags(raw) {
  if (!raw) return [];
  const normalized = raw.replace(/[，、；;]/g, ",");
  const firstPass = normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const secondPass = firstPass.flatMap((item) =>
    item
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
  );
  return [...new Set(secondPass)];
}

function toBoolReview(raw) {
  if (!raw) return false;
  return /是|yes|review/i.test(raw);
}

function buildJournal(row, section, id) {
  const title = (row["期刊"] || "").trim();
  const subjectRaw = (row["学科"] || row["领域"] || "").trim();
  const notes = (row["注释"] || "").trim();

  return {
    id,
    title,
    section,
    originalQuartile: (row["分区"] || "").trim(),
    originalAif: (row["AIF"] || "").trim(),
    editor: (row["主编"] || row["编辑部"] || "").trim(),
    tags: parseTags(subjectRaw),
    subjectRaw,
    isReview: toBoolReview(row["综述期刊"]),
    note: notes,
    cover: extractImagePath(row["封面"] || "")
  };
}

async function main() {
  const md = await fs.readFile(INPUT, "utf8");
  const lines = md.split(/\r?\n/);

  let section = "";
  let header = null;
  const journals = [];
  let id = 1;

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.+?)\s*$/);
    if (sectionMatch) {
      const maybeSection = sectionMatch[1].trim();
      section = SECTION_ALIASES.get(maybeSection) || section;
      header = null;
      continue;
    }

    if (!line.trim().startsWith("|")) continue;

    const cells = splitMarkdownRow(line);
    if (isAlignmentRow(cells)) continue;
    if (cells.every((cell) => !cell)) continue;

    if (!header) {
      header = cells;
      continue;
    }

    const normalized = normalizeRow(cells, header.length);
    const row = {};
    for (let i = 0; i < header.length; i += 1) {
      row[header[i]] = normalized[i] || "";
    }

    const journal = buildJournal(row, section, id);
    if (!journal.title) continue;

    journals.push(journal);
    id += 1;
  }

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(
    OUTPUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: INPUT,
        count: journals.length,
        journals
      },
      null,
      2
    ) + "\n"
  );

  console.log(`Wrote ${journals.length} journals to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
