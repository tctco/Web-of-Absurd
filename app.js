const elements = {
  viewTabs: document.getElementById("viewTabs"),
  catalogView: document.getElementById("catalogView"),
  metricsView: document.getElementById("metricsView"),
  searchInput: document.getElementById("searchInput"),
  sectionTabs: document.getElementById("sectionTabs"),
  tierFilter: document.getElementById("tierFilter"),
  reviewFilter: document.getElementById("reviewFilter"),
  holdFilter: document.getElementById("holdFilter"),
  sourceFilter: document.getElementById("sourceFilter"),
  tagTree: document.getElementById("tagTree"),
  tagTreeSelected: document.getElementById("tagTreeSelected"),
  clearTagTree: document.getElementById("clearTagTree"),
  titleSortBtn: document.getElementById("titleSortBtn"),
  titleSortIndicator: document.getElementById("titleSortIndicator"),
  aifSortBtn: document.getElementById("aifSortBtn"),
  aifSortIndicator: document.getElementById("aifSortIndicator"),
  pageSize: document.getElementById("pageSize"),
  prevPage: document.getElementById("prevPage"),
  nextPage: document.getElementById("nextPage"),
  pageInfo: document.getElementById("pageInfo"),
  totalCount: document.getElementById("totalCount"),
  visibleCount: document.getElementById("visibleCount"),
  seedBox: document.querySelector(".seed-box"),
  seedDate: document.getElementById("seedDate"),
  metricLineChart: document.getElementById("metricLineChart"),
  metricWordCloud: document.getElementById("metricWordCloud"),
  metricTypePie: document.getElementById("metricTypePie"),
  metricTagPie: document.getElementById("metricTagPie"),
  metricTagScopeTabs: document.getElementById("metricTagScopeTabs"),
  tableBody: document.getElementById("tableBody"),
  mobileList: document.getElementById("mobileList"),
  emptyStateTpl: document.getElementById("emptyStateTpl")
};

const state = {
  view: "catalog",
  query: "",
  section: "SCIE",
  tier: "ALL",
  review: "ALL",
  hold: "ALL",
  source: "ALL",
  tagPath: "ALL",
  metricTagScope: "ALL",
  sort: "TITLE_ASC",
  pageSize: 10,
  currentPage: 1
};

let journals = [];
let sourceJournals = [];
let thresholds = { q25: 0, q50: 0, q75: 0 };
let seedDate = "";
let lastTotalPages = 1;
let subjectTree = [];
let historyEntries = [];
const metricCharts = {
  line: null,
  word: null,
  pie: null,
  tagPie: null
};
const TAB_SECTIONS = ["SCIE", "北小核心", "会议"];
const METRIC_TAG_SCOPES = ["ALL", ...TAB_SECTIONS];
const RUNTIME_SNAPSHOT_KEY = "woa-runtime-snapshot-v2";
const TITLE_STOPWORDS = new Set([
  "journal",
  "journals",
  "the",
  "of",
  "and",
  "in",
  "for",
  "on",
  "to",
  "with",
  "a",
  "an",
  "international",
  "advanced",
  "communications",
  "review",
  "science",
  "scientific",
  "applied",
  "new",
  "期刊",
  "杂志",
  "研究",
  "中国"
]);

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildDetailHref(issn) {
  return `./journal.html?issn=${encodeURIComponent(String(issn))}`;
}

function isJokerJournal(title) {
  return /\b(joker|jokers|joke)\b/i.test(title);
}

function randomAif() {
  return Math.round((Math.random() * 200 - 100) * 10) / 10;
}

function randomExtremeAif() {
  const sign = Math.random() < 0.5 ? -1 : 1;
  const magnitude = 50 + Math.random() * 50;
  return Math.round(sign * magnitude * 10) / 10;
}

function quartile(values, percentile) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * percentile;
  const base = Math.floor(position);
  const rest = position - base;
  if (sorted[base + 1] === undefined) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function xmur3(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function hash() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a) {
  return function rng() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getUtcSeedDate() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function pickDailyOnHoldIds(ids, dailySeed, ratio = 0.05) {
  if (!ids || ids.length === 0) return new Set();
  const count = Math.max(1, Math.round(ids.length * ratio));
  const pool = [...ids];
  const seedHash = xmur3(dailySeed)();
  const rng = mulberry32(seedHash);

  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return new Set(pool.slice(0, count));
}

function computeTier(value) {
  if (value >= thresholds.q75) return "T1";
  if (value >= thresholds.q50) return "T2";
  if (value >= thresholds.q25) return "T3";
  return "T4";
}

function computeExtremeTier(value) {
  return value >= 0 ? "T1" : "T4";
}

function parseSubjectPaths(subjectRaw) {
  if (!subjectRaw) return [];
  return subjectRaw
    .replace(/[，、；;]/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function enrichJournals(rawJournals, options = {}) {
  const extremeMode = options.extremeMode === true;
  seedDate = getUtcSeedDate();
  const holdEligibleIds = rawJournals
    .filter((item) => item.onHoldEligible !== false)
    .map((item) => item.id);
  const holdSet = pickDailyOnHoldIds(
    holdEligibleIds,
    seedDate,
    0.05
  );

  const withAif = rawJournals.map((item) => {
    const title = item.title.trim();
    const isRubbish = title === "Rubbish";
    const isJoker = isJokerJournal(title);
    const subjectPaths = parseSubjectPaths(item.subjectRaw || "");

    let numericAif = 0;
    let aifDisplay = "";
    let aifClass = "aif-pos";

    if (extremeMode) {
      numericAif = randomExtremeAif();
      aifDisplay = numericAif.toFixed(1);
      aifClass = numericAif >= 0 ? "aif-pos" : "aif-neg";
    } else {
      if (isRubbish) {
        numericAif = 100;
        aifDisplay = "100.0";
        aifClass = "aif-pos";
      } else if (isJoker) {
        numericAif = 0;
        aifDisplay = "🤡";
        aifClass = "aif-joker";
      } else {
        numericAif = randomAif();
        aifDisplay = numericAif.toFixed(1);
        aifClass = numericAif >= 0 ? "aif-pos" : "aif-neg";
      }
    }

    return {
      ...item,
      numericAif,
      aifDisplay,
      aifClass,
      subjectPaths,
      statusTags: Array.isArray(item.statusTags) ? item.statusTags : [],
      onHold: holdSet.has(item.id)
    };
  });

  if (!extremeMode) {
    const numericValues = withAif.map((item) => item.numericAif);
    thresholds = {
      q25: quartile(numericValues, 0.25),
      q50: quartile(numericValues, 0.5),
      q75: quartile(numericValues, 0.75)
    };
  }

  return withAif.map((item) => ({
    ...item,
    tier: extremeMode ? computeExtremeTier(item.numericAif) : computeTier(item.numericAif)
  }));
}

function rerollExtremeAif() {
  if (!sourceJournals.length) return;
  journals = enrichJournals(sourceJournals, { extremeMode: true });
  storeRuntimeSnapshot(journals);
  render();
}

function buildSubjectTree(items) {
  const root = new Map();

  for (const item of items) {
    for (const path of item.subjectPaths || []) {
      const parts = path
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);

      let currentMap = root;
      const pathParts = [];

      for (const part of parts) {
        pathParts.push(part);
        if (!currentMap.has(part)) {
          currentMap.set(part, {
            name: part,
            fullPath: pathParts.join("/"),
            children: new Map()
          });
        }
        currentMap = currentMap.get(part).children;
      }
    }
  }

  function toArray(treeMap) {
    return [...treeMap.values()]
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .map((node) => ({
        name: node.name,
        fullPath: node.fullPath,
        children: toArray(node.children)
      }));
  }

  return toArray(root);
}

function renderSubjectTreeNodes(nodes, isRoot = false) {
  if (!nodes || nodes.length === 0) return "";

  const nodeHtml = nodes
    .map((node) => {
      const activeClass = state.tagPath === node.fullPath ? "active" : "";
      const count = node.count || 0;
      return `
        <li>
          <button type="button" class="tag-node-btn ${activeClass}" data-tag-path="${escapeHtml(
            node.fullPath
          )}">
            <span>${escapeHtml(node.name)}</span>
            <span class="tag-node-count">${count}</span>
          </button>
          ${renderSubjectTreeNodes(node.children)}
        </li>
      `;
    })
    .join("");

  return `<ul class="${isRoot ? "root" : ""}">${nodeHtml}</ul>`;
}

function applyTreeCounts(nodes, countMap) {
  return nodes.map((node) => ({
    ...node,
    count: countMap.get(node.fullPath) || 0,
    children: applyTreeCounts(node.children, countMap)
  }));
}

function buildTreeCountMap(items) {
  const countMap = new Map();
  for (const item of items) {
    const prefixes = new Set();
    for (const path of item.subjectPaths || []) {
      const parts = path
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
      for (let i = 1; i <= parts.length; i += 1) {
        prefixes.add(parts.slice(0, i).join("/"));
      }
    }

    for (const prefix of prefixes) {
      countMap.set(prefix, (countMap.get(prefix) || 0) + 1);
    }
  }
  return countMap;
}

function renderSubjectTree(countMap) {
  if (!elements.tagTree) return;
  if (subjectTree.length === 0) {
    elements.tagTree.innerHTML = '<div class="empty-state">暂无学科标签</div>';
    elements.tagTreeSelected.textContent = "全部";
    return;
  }

  const treeWithCounts = applyTreeCounts(subjectTree, countMap);
  elements.tagTree.innerHTML = renderSubjectTreeNodes(treeWithCounts, true);
  elements.tagTreeSelected.textContent = state.tagPath === "ALL" ? "全部" : state.tagPath;
}

function updateSectionTabsUi() {
  if (!elements.sectionTabs) return;
  const buttons = elements.sectionTabs.querySelectorAll(".section-tab");
  for (const button of buttons) {
    const isActive = button.dataset.section === state.section;
    button.classList.toggle("active", isActive);
  }
}

function updateViewTabsUi() {
  if (!elements.viewTabs) return;
  const buttons = elements.viewTabs.querySelectorAll(".view-tab");
  for (const button of buttons) {
    const isActive = button.dataset.view === state.view;
    button.classList.toggle("active", isActive);
  }
}

function updateMetricTagScopeUi() {
  if (!elements.metricTagScopeTabs) return;
  const buttons = elements.metricTagScopeTabs.querySelectorAll(".metric-scope-tab");
  for (const button of buttons) {
    const isActive = button.dataset.metricScope === state.metricTagScope;
    button.classList.toggle("active", isActive);
  }
}

function setView(view) {
  state.view = view === "metrics" ? "metrics" : "catalog";
  elements.catalogView.classList.toggle("hidden", state.view !== "catalog");
  elements.metricsView.classList.toggle("hidden", state.view !== "metrics");
  updateViewTabsUi();

  if (state.view === "metrics") {
    renderMetrics();
    requestAnimationFrame(() => {
      metricCharts.line?.resize();
      metricCharts.word?.resize();
      metricCharts.pie?.resize();
      metricCharts.tagPie?.resize();
    });
  }
}

function isXhsSource(item) {
  return item.sourceType === "XHS" || item.sourceType === "WOA_MD";
}

function getSourceMarkers(item) {
  const markers = [];
  if (isXhsSource(item)) markers.push("XHS");
  if ((item.statusTags || []).includes("中科院预警")) markers.push("中科院预警");
  if ((item.statusTags || []).includes("WOS除名")) markers.push("WOS除名");
  return markers;
}

function matchesPrimaryFilters(item) {
  if (state.query) {
    const searchable = [
      item.title,
      item.editor,
      item.section,
      item.note,
      ...(getSourceMarkers(item) || []),
      ...(item.statusTags || []),
      ...(item.tags || []),
      ...(item.subjectPaths || [])
    ]
      .join(" ")
      .toLowerCase();
    if (!searchable.includes(state.query)) return false;
  }

  if (item.section !== state.section) return false;
  if (state.tier !== "ALL" && item.tier !== state.tier) return false;
  if (state.review === "ONLY" && !item.isReview) return false;
  if (state.hold === "ONLY" && !item.onHold) return false;
  if (state.hold === "EXCLUDE" && item.onHold) return false;
  if (state.source === "XHS" && !isXhsSource(item)) return false;
  if (state.source === "CAS_WARNING" && !(item.statusTags || []).includes("中科院预警")) {
    return false;
  }
  if (state.source === "WOS_DELISTED" && !(item.statusTags || []).includes("WOS除名")) {
    return false;
  }
  return true;
}

function getTreeCountBaseJournals() {
  return journals.filter((item) => matchesPrimaryFilters(item));
}

function getFilteredJournals() {
  return journals.filter((item) => {
    if (!matchesPrimaryFilters(item)) return false;
    if (state.tagPath === "ALL") return true;
    return (item.subjectPaths || []).some(
      (path) => path === state.tagPath || path.startsWith(`${state.tagPath}/`)
    );
  });
}

function sortJournals(items) {
  if (state.sort === "DEFAULT") {
    return [...items].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  }

  if (state.sort === "AIF_DESC" || state.sort === "AIF_ASC") {
    const desc = state.sort === "AIF_DESC";
    return [...items].sort((a, b) => {
      if (a.numericAif === b.numericAif) {
        return a.title.localeCompare(b.title, "zh-CN");
      }
      return desc ? b.numericAif - a.numericAif : a.numericAif - b.numericAif;
    });
  }

  if (state.sort === "TITLE_ASC" || state.sort === "TITLE_DESC") {
    const desc = state.sort === "TITLE_DESC";
    return [...items].sort((a, b) => {
      const byTitle = a.title.localeCompare(b.title, "zh-CN");
      if (byTitle === 0) return a.id - b.id;
      return desc ? -byTitle : byTitle;
    });
  }

  return [...items].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}

function paginateItems(items) {
  const total = items.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / state.pageSize);

  if (totalPages > 0 && state.currentPage > totalPages) {
    state.currentPage = totalPages;
  }
  if (totalPages === 0) {
    state.currentPage = 1;
  }

  const startIndex = total === 0 ? 0 : (state.currentPage - 1) * state.pageSize;
  const pagedItems = items.slice(startIndex, startIndex + state.pageSize);
  const endIndex = total === 0 ? 0 : startIndex + pagedItems.length;

  return {
    pagedItems,
    total,
    totalPages,
    startIndex,
    endIndex
  };
}

function tierClass(tier) {
  return `tier-${tier.toLowerCase()}`;
}

function renderTags(tags) {
  if (!tags || tags.length === 0) return "-";
  return `<div class="tags">${tags
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("")}</div>`;
}

function getStatusLabels(item) {
  const labels = [];
  if (item.onHold) labels.push("ON HOLD");
  for (const tag of item.statusTags || []) {
    labels.push(tag);
  }
  if (labels.length === 0) labels.push("Active");
  return [...new Set(labels)];
}

function getStatusClass(label) {
  if (label === "ON HOLD") return "status-hold";
  if (label === "Active") return "status-normal";
  return "status-alert";
}

function renderStatusBadges(item) {
  return getStatusLabels(item)
    .map((label) => `<span class="status-flag ${getStatusClass(label)}">${escapeHtml(label)}</span>`)
    .join("");
}

function renderTable(items) {
  if (items.length === 0) {
    elements.tableBody.innerHTML = "";
    return;
  }

  elements.tableBody.innerHTML = items
    .map((item) => {
      const reviewHtml = item.isReview ? '<span class="review-flag">Review</span>' : "-";
      const statusHtml = renderStatusBadges(item);

      return `
        <tr>
          <td>${item.cover ? `<img class="cover" src="${escapeHtml(item.cover)}" alt="${escapeHtml(item.title)}" loading="lazy" />` : "-"}</td>
          <td>
            <a class="title-link" href="${buildDetailHref(item.issn || item.id)}">${escapeHtml(item.title)}</a>
          </td>
          <td><span class="tier ${tierClass(item.tier)}">${item.tier}</span></td>
          <td><span class="aif ${item.aifClass}">${escapeHtml(item.aifDisplay)}</span></td>
          <td>${escapeHtml(item.section || "-")}</td>
          <td><span class="editor">${escapeHtml(item.editor || "-")}</span></td>
          <td>${renderTags(item.tags)}</td>
          <td>${reviewHtml}</td>
          <td>${statusHtml}</td>
          <td>${escapeHtml(item.note || "-")}</td>
        </tr>
      `;
    })
    .join("");
}

function renderMobile(items) {
  if (items.length === 0) {
    elements.mobileList.innerHTML = "";
    return;
  }

  elements.mobileList.innerHTML = items
    .map((item) => {
      const reviewText = item.isReview ? "是" : "否";
      const statusText = getStatusLabels(item).join(" / ");

      return `
        <article class="mobile-card">
          <div class="mobile-card-top">
            ${item.cover ? `<img class="mobile-cover" src="${escapeHtml(item.cover)}" alt="${escapeHtml(item.title)}" loading="lazy" />` : ""}
            <div>
              <h3 class="mobile-title">
                <a class="title-link" href="${buildDetailHref(item.issn || item.id)}">${escapeHtml(item.title)}</a>
              </h3>
              <div><span class="tier ${tierClass(item.tier)}">${item.tier}</span></div>
            </div>
          </div>
          <div class="mobile-meta">
            <div><strong>AIF</strong> <span class="aif ${item.aifClass}">${escapeHtml(item.aifDisplay)}</span></div>
            <div><strong>收录</strong> ${escapeHtml(item.section)}</div>
            <div><strong>主编</strong> ${escapeHtml(item.editor || "-")}</div>
            <div><strong>综述</strong> ${reviewText}</div>
            <div><strong>状态</strong> ${statusText}</div>
            <div><strong>标签</strong> ${(item.tags || []).join(" / ") || "-"}</div>
          </div>
          ${item.note ? `<p class="mobile-note">${escapeHtml(item.note)}</p>` : ""}
        </article>
      `;
    })
    .join("");
}

function storeRuntimeSnapshot(items) {
  try {
    const runtimeItems = {};
    for (const item of items) {
      const key = String(item.issn || item.id);
      runtimeItems[key] = {
        id: item.id,
        issn: item.issn || "",
        numericAif: item.numericAif,
        aifDisplay: item.aifDisplay,
        aifClass: item.aifClass,
        onHold: item.onHold,
        tier: item.tier
      };
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      seedDate,
      items: runtimeItems
    };
    sessionStorage.setItem(RUNTIME_SNAPSHOT_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("failed to persist runtime snapshot", error);
  }
}

function renderEmptyState() {
  const emptyNode = elements.emptyStateTpl.content.firstElementChild.cloneNode(true);
  elements.tableBody.innerHTML = `<tr><td colspan="10"></td></tr>`;
  elements.tableBody.querySelector("td").appendChild(emptyNode);

  elements.mobileList.innerHTML = "";
  elements.mobileList.appendChild(emptyNode.cloneNode(true));
}

function updateSortUi() {
  let aifText = "↕";
  let aifTitle = "AIF 默认顺序";
  if (state.sort === "AIF_DESC") {
    aifText = "↓";
    aifTitle = "AIF 从高到低";
  } else if (state.sort === "AIF_ASC") {
    aifText = "↑";
    aifTitle = "AIF 从低到高";
  }
  elements.aifSortIndicator.textContent = aifText;
  elements.aifSortBtn.title = aifTitle;

  let titleText = "↕";
  let titleHint = "期刊名默认顺序";
  if (state.sort === "TITLE_ASC" || state.sort === "DEFAULT") {
    titleText = "↑";
    titleHint = "期刊名字典序升序";
  } else if (state.sort === "TITLE_DESC") {
    titleText = "↓";
    titleHint = "期刊名字典序降序";
  }
  elements.titleSortIndicator.textContent = titleText;
  elements.titleSortBtn.title = titleHint;
}

function tokenizeTitle(title) {
  const normalized = title
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const englishTokens = normalized.match(/[a-z][a-z0-9]{1,}/g) || [];
  const chineseTokens = normalized.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  return [...englishTokens, ...chineseTokens].filter((token) => !TITLE_STOPWORDS.has(token));
}

function getWordCloudData(items) {
  const freq = new Map();
  for (const item of items) {
    const tokens = tokenizeTitle(item.title || "");
    for (const token of tokens) {
      freq.set(token, (freq.get(token) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 120);
}

function formatHistoryLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}Z`;
}

function getLineData() {
  const points = [...historyEntries]
    .filter((entry) => typeof entry.count === "number" && entry.generatedAt)
    .map((entry) => {
      const time = new Date(entry.generatedAt).getTime();
      return Number.isNaN(time) ? null : [time, entry.count];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);

  if (points.length === 0) {
    return [[Date.now(), journals.length]];
  }

  return points;
}

function getSectionPieData(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.section || "未分类";
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([name, value]) => ({ name, value }));
}

function getTagPieData(items, limit = 10) {
  const map = new Map();
  for (const item of items) {
    const seen = new Set(item.tags || []);
    for (const tag of seen) {
      map.set(tag, (map.get(tag) || 0) + 1);
    }
  }

  const sorted = [...map.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  if (sorted.length <= limit) return sorted;
  const head = sorted.slice(0, limit);
  const tailSum = sorted.slice(limit).reduce((sum, item) => sum + item.value, 0);
  return [...head, { name: "其他", value: tailSum }];
}

function getTagPieSourceItems() {
  if (state.metricTagScope === "ALL") return journals;
  return journals.filter((item) => item.section === state.metricTagScope);
}

function renderMetrics() {
  const echarts = window.echarts;
  if (!echarts) {
    elements.metricLineChart.innerHTML = '<div class="empty-state">ECharts 未加载</div>';
    elements.metricWordCloud.innerHTML = '<div class="empty-state">ECharts 未加载</div>';
    elements.metricTypePie.innerHTML = '<div class="empty-state">ECharts 未加载</div>';
    elements.metricTagPie.innerHTML = '<div class="empty-state">ECharts 未加载</div>';
    return;
  }

  if (!metricCharts.line) metricCharts.line = echarts.init(elements.metricLineChart);
  if (!metricCharts.word) metricCharts.word = echarts.init(elements.metricWordCloud);
  if (!metricCharts.pie) metricCharts.pie = echarts.init(elements.metricTypePie);
  if (!metricCharts.tagPie) metricCharts.tagPie = echarts.init(elements.metricTagPie);

  const lineData = getLineData();
  const wordData = getWordCloudData(journals);
  const pieData = getSectionPieData(journals);
  const tagPieData = getTagPieData(getTagPieSourceItems(), 10);

  metricCharts.line.setOption({
    tooltip: {
      trigger: "axis",
      formatter(params) {
        const first = Array.isArray(params) ? params[0] : null;
        if (!first || !Array.isArray(first.data)) return "";
        return `${formatHistoryLabel(new Date(first.data[0]).toISOString())}<br/>Count: ${first.data[1]}`;
      }
    },
    grid: { left: 40, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: "time",
      axisLabel: {
        formatter(value) {
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return "";
          const m = String(date.getUTCMonth() + 1).padStart(2, "0");
          const d = String(date.getUTCDate()).padStart(2, "0");
          const hh = String(date.getUTCHours()).padStart(2, "0");
          const mm = String(date.getUTCMinutes()).padStart(2, "0");
          return `${m}-${d}\n${hh}:${mm}`;
        }
      }
    },
    yAxis: { type: "value", name: "Count" },
    series: [
      {
        type: "line",
        data: lineData,
        smooth: true,
        areaStyle: { opacity: 0.14 },
        lineStyle: { width: 2 },
        symbolSize: 7
      }
    ]
  });

  try {
    metricCharts.word.setOption({
      tooltip: {},
      series: [
        {
          type: "wordCloud",
          shape: "circle",
          left: "center",
          top: "center",
          width: "100%",
          height: "100%",
          sizeRange: [12, 58],
          rotationRange: [-45, 45],
          gridSize: 8,
          textStyle: {
            color() {
              const palette = ["#0f5fb4", "#1d63b1", "#1d8a52", "#b76815", "#5f6d7d"];
              return palette[Math.floor(Math.random() * palette.length)];
            }
          },
          emphasis: { focus: "self", textStyle: { shadowBlur: 8, shadowColor: "#8eb4e3" } },
          data: wordData
        }
      ]
    });
  } catch {
    metricCharts.word.setOption({
      tooltip: { trigger: "axis" },
      grid: { left: 60, right: 20, top: 20, bottom: 40 },
      xAxis: { type: "value" },
      yAxis: {
        type: "category",
        data: wordData.slice(0, 20).map((item) => item.name),
        axisLabel: { fontSize: 11 }
      },
      series: [{ type: "bar", data: wordData.slice(0, 20).map((item) => item.value) }]
    });
  }

  metricCharts.pie.setOption({
    tooltip: { trigger: "item" },
    legend: { bottom: 0 },
    series: [
      {
        type: "pie",
        radius: ["32%", "68%"],
        center: ["50%", "45%"],
        data: pieData,
        label: { formatter: "{b}: {d}%" }
      }
    ]
  });

  metricCharts.tagPie.setOption({
    tooltip: { trigger: "item" },
    legend: {
      type: "scroll",
      left: "center",
      bottom: 4
    },
    series: [
      {
        type: "pie",
        radius: ["30%", "58%"],
        center: ["50%", "40%"],
        avoidLabelOverlap: true,
        minShowLabelAngle: 3,
        data: tagPieData,
        label: { formatter: "{b}: {d}%" },
        labelLayout: { moveOverlap: "shiftY" }
      }
    ]
  });
}

function updatePaginationUi(total, totalPages, startIndex, endIndex) {
  lastTotalPages = totalPages;

  if (total === 0) {
    elements.pageInfo.textContent = "第 0 / 0 页";
    elements.prevPage.disabled = true;
    elements.nextPage.disabled = true;
    return;
  }

  elements.pageInfo.textContent = `第 ${state.currentPage} / ${totalPages} 页 · 显示 ${
    startIndex + 1
  }-${endIndex} / ${total}`;
  elements.prevPage.disabled = state.currentPage <= 1;
  elements.nextPage.disabled = state.currentPage >= totalPages;
}

function render() {
  const treeCountBase = getTreeCountBaseJournals();
  const treeCountMap = buildTreeCountMap(treeCountBase);
  const filtered = getFilteredJournals();
  const sorted = sortJournals(filtered);
  const pagination = paginateItems(sorted);

  elements.totalCount.textContent = journals.length;
  elements.visibleCount.textContent = filtered.length;
  elements.seedDate.textContent = seedDate;

  renderTable(pagination.pagedItems);
  renderMobile(pagination.pagedItems);
  updatePaginationUi(
    pagination.total,
    pagination.totalPages,
    pagination.startIndex,
    pagination.endIndex
  );
  updateSortUi();
  updateSectionTabsUi();
  renderSubjectTree(treeCountMap);

  if (pagination.total === 0) {
    renderEmptyState();
  }
}

function syncState() {
  state.query = elements.searchInput.value.trim().toLowerCase();
  state.tier = elements.tierFilter.value;
  state.review = elements.reviewFilter.value;
  state.hold = elements.holdFilter.value;
  state.source = elements.sourceFilter.value;
  state.pageSize = Number.parseInt(elements.pageSize.value, 10) || 10;
}

function bindEvents() {
  const controls = [
    elements.searchInput,
    elements.tierFilter,
    elements.reviewFilter,
    elements.holdFilter,
    elements.sourceFilter,
    elements.pageSize
  ];

  for (const control of controls) {
    const eventName = control.tagName.toLowerCase() === "input" ? "input" : "change";
    control.addEventListener(eventName, () => {
      syncState();
      state.currentPage = 1;
      render();
    });
  }

  elements.viewTabs.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.classList.contains("view-tab")) return;
    const nextView = target.dataset.view;
    setView(nextView);
  });

  elements.sectionTabs.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.classList.contains("section-tab")) return;

    const selectedSection = target.dataset.section;
    if (!selectedSection || !TAB_SECTIONS.includes(selectedSection)) return;
    state.section = selectedSection;
    state.currentPage = 1;
    render();
  });

  elements.aifSortBtn.addEventListener("click", () => {
    if (state.sort === "AIF_DESC") {
      state.sort = "AIF_ASC";
    } else if (state.sort === "AIF_ASC") {
      state.sort = "TITLE_ASC";
    } else {
      state.sort = "AIF_DESC";
    }
    state.currentPage = 1;
    render();
  });

  elements.titleSortBtn.addEventListener("click", () => {
    if (state.sort === "TITLE_ASC") {
      state.sort = "TITLE_DESC";
    } else {
      state.sort = "TITLE_ASC";
    }
    state.currentPage = 1;
    render();
  });

  elements.clearTagTree.addEventListener("click", () => {
    state.tagPath = "ALL";
    state.currentPage = 1;
    render();
  });

  elements.tagTree.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest(".tag-node-btn");
    if (!(button instanceof HTMLElement)) return;

    const selectedPath = button.dataset.tagPath;
    if (!selectedPath) return;
    state.tagPath = selectedPath;
    state.currentPage = 1;
    render();
  });

  elements.prevPage.addEventListener("click", () => {
    if (state.currentPage <= 1) return;
    state.currentPage -= 1;
    render();
  });

  elements.nextPage.addEventListener("click", () => {
    if (state.currentPage >= lastTotalPages) return;
    state.currentPage += 1;
    render();
  });

  elements.seedBox?.addEventListener("click", () => {
    rerollExtremeAif();
  });

  elements.metricTagScopeTabs?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest(".metric-scope-tab");
    if (!(button instanceof HTMLElement)) return;

    const nextScope = button.dataset.metricScope;
    if (!nextScope || !METRIC_TAG_SCOPES.includes(nextScope)) return;
    if (state.metricTagScope === nextScope) return;

    state.metricTagScope = nextScope;
    updateMetricTagScopeUi();
    if (state.view === "metrics") {
      renderMetrics();
    }
  });
}

async function loadData() {
  const response = await fetch("./data/journals.json");
  if (!response.ok) {
    throw new Error(`Failed to load dataset: ${response.status}`);
  }
  const payload = await response.json();
  return payload.journals || [];
}

async function loadHistory() {
  try {
    const response = await fetch("./data/journal-count-history.json");
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.warn("service worker registration failed", error);
    });
  });
}

async function bootstrap() {
  bindEvents();
  registerServiceWorker();

  try {
    const [raw, history] = await Promise.all([loadData(), loadHistory()]);
    historyEntries = history;
    sourceJournals = raw;
    journals = enrichJournals(sourceJournals);
    storeRuntimeSnapshot(journals);
    subjectTree = buildSubjectTree(journals);
    updateMetricTagScopeUi();
    const availableSections = new Set(journals.map((item) => item.section));
    if (!availableSections.has(state.section)) {
      state.section = TAB_SECTIONS.find((section) => availableSections.has(section)) || state.section;
    }
    syncState();
    render();
    setView("catalog");
    window.addEventListener("resize", () => {
      metricCharts.line?.resize();
      metricCharts.word?.resize();
      metricCharts.pie?.resize();
      metricCharts.tagPie?.resize();
    });
  } catch (error) {
    console.error(error);
    elements.tableBody.innerHTML = `<tr><td colspan="10" class="empty-state">数据加载失败，请稍后重试。</td></tr>`;
    elements.mobileList.innerHTML = `<div class="empty-state">数据加载失败，请稍后重试。</div>`;
    elements.pageInfo.textContent = "加载失败";
    elements.prevPage.disabled = true;
    elements.nextPage.disabled = true;
  }
}

bootstrap();
