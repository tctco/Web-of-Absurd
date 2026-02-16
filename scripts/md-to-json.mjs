#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const INPUT = process.argv[2] || "WOA.md";
const OUTPUT = process.argv[3] || "data/journals.json";
const HISTORY = process.argv[4] || "data/journal-count-history.json";

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

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toIssnFromSeed(seedNumber) {
  const body = String(seedNumber % 10000000).padStart(7, "0");
  const digits = body.split("").map((char) => Number.parseInt(char, 10));
  let sum = 0;
  for (let i = 0; i < 7; i += 1) {
    sum += digits[i] * (8 - i);
  }
  const mod = sum % 11;
  const check = (11 - mod) % 11;
  const checkChar = check === 10 ? "X" : String(check);
  return `${body.slice(0, 4)}-${body.slice(4)}${checkChar}`;
}

function assignIssn(journals) {
  const used = new Set();
  for (const journal of journals) {
    let salt = 0;
    let candidate = "";
    do {
      const hash = fnv1a32(`${journal.title}|${journal.section}|${salt}`);
      candidate = toIssnFromSeed(hash);
      salt += 1;
    } while (used.has(candidate));

    used.add(candidate);
    journal.issn = candidate;
  }
}

function countBySection(journals) {
  const result = {};
  for (const journal of journals) {
    const key = journal.section || "未分区";
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

async function readJsonArrayIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
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

  assignIssn(journals);

  const generatedAt = new Date().toISOString();
  const sectionCounts = countBySection(journals);

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(
    OUTPUT,
    JSON.stringify(
      {
        generatedAt,
        source: INPUT,
        count: journals.length,
        sectionCounts,
        journals
      },
      null,
      2
    ) + "\n"
  );

  await fs.mkdir(path.dirname(HISTORY), { recursive: true });
  const history = await readJsonArrayIfExists(HISTORY);
  history.push({
    generatedAt,
    count: journals.length,
    sectionCounts,
    source: INPUT,
    output: OUTPUT
  });
  await fs.writeFile(HISTORY, JSON.stringify(history, null, 2) + "\n");

  console.log(`Wrote ${journals.length} journals to ${OUTPUT}`);
  console.log(`Appended history entry to ${HISTORY}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
