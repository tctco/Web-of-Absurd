#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const INPUT = process.argv[2] || "WOA.md";
const OUTPUT = process.argv[3] || "data/journals.json";
const HISTORY = process.argv[4] || "data/journal-count-history.json";
const CHN_INPUT = process.argv[5] || "CHN.md";
const DELISTED_INPUT = process.argv[6] || "delisted.json";

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

function pickRowValue(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function normalizeIssn(raw) {
  if (!raw) return "";
  const compact = String(raw).toUpperCase().replace(/[^0-9X]/g, "");
  if (compact.length !== 8) return "";
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function extractIssns(raw) {
  if (!raw) return [];
  const matches = String(raw)
    .toUpperCase()
    .match(/\b\d{4}-?\d{3}[\dX]\b/g);
  if (!matches) return [];
  const normalized = matches.map((token) => normalizeIssn(token)).filter(Boolean);
  return [...new Set(normalized)];
}

function normalizeTitleForLookup(raw) {
  if (!raw) return "";
  return String(raw)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildJournal(row, section, id) {
  const title = (row["期刊"] || "").trim();
  const subjectRaw = (row["学科"] || row["领域"] || "").trim();
  const notes = (row["注释"] || "").trim();
  const sourceIssnRaw = pickRowValue(row, ["ISSN/EISSN", "ISSN", "EISSN"]);

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
    cover: extractImagePath(row["封面"] || ""),
    sourceIssnRaw,
    sourceIssns: extractIssns(sourceIssnRaw),
    statusTags: [],
    statusMeta: {
      casWarning: false,
      casWarningReasons: [],
      wosDelisted: false,
      wosStatuses: []
    },
    sourceType: "XHS",
    onHoldEligible: true
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
    const existingCandidates = [
      normalizeIssn(journal.issn || ""),
      ...(journal.sourceIssns || []).map((item) => normalizeIssn(item))
    ].filter(Boolean);
    const existing = existingCandidates.find((item) => !used.has(item));
    if (existing) {
      journal.issn = existing;
      used.add(existing);
      continue;
    }

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

function countByStatus(journals) {
  const result = {
    中科院预警: 0,
    WOS除名: 0
  };
  for (const journal of journals) {
    for (const tag of journal.statusTags || []) {
      result[tag] = (result[tag] || 0) + 1;
    }
  }
  return result;
}

function countBySourceType(journals) {
  const result = {};
  for (const journal of journals) {
    const key = journal.sourceType || "UNKNOWN";
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function parseMarkdownTableRows(raw) {
  const lines = raw.split(/\r?\n/);
  const rows = [];
  let header = null;

  for (const line of lines) {
    if (!line.trim().startsWith("|")) {
      header = null;
      continue;
    }

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
    rows.push(row);
  }

  return rows;
}

function mergeIssns(existingIssns, newIssns) {
  return [...new Set([...(existingIssns || []), ...(newIssns || [])].map((item) => normalizeIssn(item)).filter(Boolean))];
}

function ensureStatusShape(journal) {
  if (!Array.isArray(journal.statusTags)) {
    journal.statusTags = [];
  }
  if (!journal.statusMeta || typeof journal.statusMeta !== "object") {
    journal.statusMeta = {};
  }
  if (!Array.isArray(journal.statusMeta.casWarningReasons)) {
    journal.statusMeta.casWarningReasons = [];
  }
  if (!Array.isArray(journal.statusMeta.wosStatuses)) {
    journal.statusMeta.wosStatuses = [];
  }
  if (!Array.isArray(journal.sourceIssns)) {
    journal.sourceIssns = [];
  }
  if (typeof journal.onHoldEligible !== "boolean") {
    journal.onHoldEligible = true;
  }
  if (!journal.sourceType) {
    journal.sourceType = "XHS";
  }
}

function addStatusTag(journal, tag) {
  if (!journal.statusTags.includes(tag)) {
    journal.statusTags.push(tag);
  }
}

function addStatusFromExternalEntry(journal, entry) {
  ensureStatusShape(journal);
  journal.sourceIssns = mergeIssns(journal.sourceIssns, entry.issns || []);
  journal.sourceIssnRaw = journal.sourceIssns.join(" / ");

  if (entry.kind === "CAS_WARNING") {
    addStatusTag(journal, "中科院预警");
    journal.statusMeta.casWarning = true;
    if (entry.reason && !journal.statusMeta.casWarningReasons.includes(entry.reason)) {
      journal.statusMeta.casWarningReasons.push(entry.reason);
    }
    if (!journal.note && entry.reason) {
      journal.note = `中科院预警：${entry.reason}`;
    }
    return;
  }

  if (entry.kind === "WOS_DELISTED") {
    addStatusTag(journal, "WOS除名");
    journal.statusMeta.wosDelisted = true;
    if (entry.status && !journal.statusMeta.wosStatuses.includes(entry.status)) {
      journal.statusMeta.wosStatuses.push(entry.status);
    }
    if (!journal.note && entry.status) {
      journal.note = `WoS状态：${entry.status}`;
    }
  }
}

function findJournalForExternalEntry(journals, entry) {
  const entryIssns = mergeIssns([], entry.issns || []);
  if (entryIssns.length > 0) {
    for (const journal of journals) {
      const journalIssns = mergeIssns(journal.sourceIssns || [], [journal.issn]);
      if (entryIssns.some((issn) => journalIssns.includes(issn))) {
        return journal;
      }
    }
  }

  const entryTitleKey = normalizeTitleForLookup(entry.title);
  if (!entryTitleKey) return null;
  for (const journal of journals) {
    if (normalizeTitleForLookup(journal.title) === entryTitleKey) {
      return journal;
    }
  }
  return null;
}

function createJournalFromExternalEntry(entry, id) {
  const journal = {
    id,
    title: entry.title,
    section: "SCIE",
    originalQuartile: "",
    originalAif: "",
    editor: "",
    tags: [],
    subjectRaw: "",
    isReview: false,
    note: "",
    cover: "",
    sourceIssnRaw: mergeIssns([], entry.issns || []).join(" / "),
    sourceIssns: mergeIssns([], entry.issns || []),
    statusTags: [],
    statusMeta: {
      casWarning: false,
      casWarningReasons: [],
      wosDelisted: false,
      wosStatuses: []
    },
    sourceType: "EXTERNAL_INDEX",
    onHoldEligible: false
  };
  addStatusFromExternalEntry(journal, entry);
  return journal;
}

function mergeExternalEntriesIntoJournals(journals, entries, nextId) {
  let idCursor = nextId;
  for (const entry of entries) {
    const title = String(entry.title || "").trim();
    if (!title) continue;
    const normalizedEntry = {
      ...entry,
      title,
      issns: mergeIssns([], entry.issns || [])
    };

    const matchedJournal = findJournalForExternalEntry(journals, normalizedEntry);
    if (matchedJournal) {
      addStatusFromExternalEntry(matchedJournal, normalizedEntry);
      continue;
    }

    journals.push(createJournalFromExternalEntry(normalizedEntry, idCursor));
    idCursor += 1;
  }
  return idCursor;
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
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

async function loadCasWarnings(filePath) {
  const raw = await readTextIfExists(filePath);
  if (!raw) return [];
  const rows = parseMarkdownTableRows(raw);

  return rows
    .map((row) => {
      const title = pickRowValue(row, ["期刊", "刊名", "Title", "Journal"]);
      const issnRaw = pickRowValue(row, ["ISSN/EISSN", "ISSN", "EISSN"]);
      return {
        title,
        issns: extractIssns(issnRaw),
        reason: pickRowValue(row, ["预警原因", "原因", "Reason"]),
        kind: "CAS_WARNING"
      };
    })
    .filter((item) => item.title);
}

async function loadWosDelisted(filePath) {
  const raw = await readTextIfExists(filePath);
  if (!raw) return [];

  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.d?.results)
      ? parsed.d.results
      : Array.isArray(parsed?.results)
        ? parsed.results
        : [];

  return list
    .filter((item) => String(item?.WoS_x0020_Status || "").trim() === "Delisted 2025")
    .map((item) => {
      const issn = normalizeIssn(item?.ISSN);
      const eissn = normalizeIssn(item?.EISSN);
      return {
        title: String(item?.Title || "").trim(),
        issns: [...new Set([issn, eissn].filter(Boolean))],
        status: String(item?.WoS_x0020_Status || "").trim(),
        kind: "WOS_DELISTED"
      };
    })
    .filter((item) => item.title);
}

async function main() {
  const md = await fs.readFile(INPUT, "utf8");
  const lines = md.split(/\r?\n/);
  const [casWarnings, wosDelisted] = await Promise.all([
    loadCasWarnings(CHN_INPUT),
    loadWosDelisted(DELISTED_INPUT)
  ]);
  const externalEntries = [...casWarnings, ...wosDelisted];

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

  mergeExternalEntriesIntoJournals(journals, externalEntries, id);
  assignIssn(journals);

  const generatedAt = new Date().toISOString();
  const sectionCounts = countBySection(journals);
  const statusCounts = countByStatus(journals);
  const sourceCounts = countBySourceType(journals);

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(
    OUTPUT,
    JSON.stringify(
      {
        generatedAt,
        source: INPUT,
        count: journals.length,
        sectionCounts,
        statusCounts,
        sourceCounts,
        sourceStatuses: {
          casWarningSource: CHN_INPUT,
          casWarningPool: casWarnings.length,
          wosDelistedSource: DELISTED_INPUT,
          wosDelistedPool: wosDelisted.length,
          externalMergedPool: externalEntries.length
        },
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
    statusCounts,
    sourceCounts,
    source: INPUT,
    output: OUTPUT
  });
  await fs.writeFile(HISTORY, JSON.stringify(history, null, 2) + "\n");

  console.log(`Wrote ${journals.length} journals to ${OUTPUT}`);
  console.log(
    `Applied status tags: 中科院预警=${statusCounts["中科院预警"] || 0}, WOS除名=${statusCounts["WOS除名"] || 0}`
  );
  console.log(
    `Source counts: XHS=${sourceCounts.XHS || 0}, EXTERNAL_INDEX=${sourceCounts.EXTERNAL_INDEX || 0}`
  );
  console.log(`Appended history entry to ${HISTORY}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
