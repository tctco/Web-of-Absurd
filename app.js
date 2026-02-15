const elements = {
  searchInput: document.getElementById("searchInput"),
  sectionTabs: document.getElementById("sectionTabs"),
  tierFilter: document.getElementById("tierFilter"),
  reviewFilter: document.getElementById("reviewFilter"),
  holdFilter: document.getElementById("holdFilter"),
  tagTree: document.getElementById("tagTree"),
  tagTreeSelected: document.getElementById("tagTreeSelected"),
  clearTagTree: document.getElementById("clearTagTree"),
  aifSortBtn: document.getElementById("aifSortBtn"),
  aifSortIndicator: document.getElementById("aifSortIndicator"),
  pageSize: document.getElementById("pageSize"),
  prevPage: document.getElementById("prevPage"),
  nextPage: document.getElementById("nextPage"),
  pageInfo: document.getElementById("pageInfo"),
  totalCount: document.getElementById("totalCount"),
  visibleCount: document.getElementById("visibleCount"),
  seedDate: document.getElementById("seedDate"),
  tableBody: document.getElementById("tableBody"),
  mobileList: document.getElementById("mobileList"),
  emptyStateTpl: document.getElementById("emptyStateTpl")
};

const state = {
  query: "",
  section: "SCIE",
  tier: "ALL",
  review: "ALL",
  hold: "ALL",
  tagPath: "ALL",
  sort: "DEFAULT",
  pageSize: 10,
  currentPage: 1
};

let journals = [];
let thresholds = { q25: 0, q50: 0, q75: 0 };
let seedDate = "";
let lastTotalPages = 1;
let subjectTree = [];
const TAB_SECTIONS = ["SCIE", "北小核心", "会议"];

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isJokerJournal(title) {
  return /\b(joker|jokers|joke)\b/i.test(title);
}

function randomAif() {
  return Math.round((Math.random() * 200 - 100) * 10) / 10;
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

function parseSubjectPaths(subjectRaw) {
  if (!subjectRaw) return [];
  return subjectRaw
    .replace(/[，、；;]/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function enrichJournals(rawJournals) {
  seedDate = getUtcSeedDate();
  const holdSet = pickDailyOnHoldIds(
    rawJournals.map((item) => item.id),
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

    return {
      ...item,
      numericAif,
      aifDisplay,
      aifClass,
      subjectPaths,
      onHold: holdSet.has(item.id)
    };
  });

  const numericValues = withAif.map((item) => item.numericAif);
  thresholds = {
    q25: quartile(numericValues, 0.25),
    q50: quartile(numericValues, 0.5),
    q75: quartile(numericValues, 0.75)
  };

  return withAif.map((item) => ({
    ...item,
    tier: computeTier(item.numericAif)
  }));
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
      return `
        <li>
          <button type="button" class="tag-node-btn ${activeClass}" data-tag-path="${escapeHtml(
            node.fullPath
          )}">
            ${escapeHtml(node.name)}
          </button>
          ${renderSubjectTreeNodes(node.children)}
        </li>
      `;
    })
    .join("");

  return `<ul class="${isRoot ? "root" : ""}">${nodeHtml}</ul>`;
}

function renderSubjectTree() {
  if (!elements.tagTree) return;
  if (subjectTree.length === 0) {
    elements.tagTree.innerHTML = '<div class="empty-state">暂无学科标签</div>';
    elements.tagTreeSelected.textContent = "全部";
    return;
  }

  elements.tagTree.innerHTML = renderSubjectTreeNodes(subjectTree, true);
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

function getFilteredJournals() {
  return journals.filter((item) => {
    if (state.query) {
      const searchable = [
        item.title,
        item.editor,
        item.section,
        item.note,
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

    if (state.tagPath !== "ALL") {
      const matched = (item.subjectPaths || []).some(
        (path) => path === state.tagPath || path.startsWith(`${state.tagPath}/`)
      );
      if (!matched) return false;
    }

    return true;
  });
}

function sortJournals(items) {
  if (state.sort === "DEFAULT") {
    return [...items].sort((a, b) => a.id - b.id);
  }

  const desc = state.sort === "DESC";
  return [...items].sort((a, b) => {
    if (a.numericAif === b.numericAif) {
      return a.title.localeCompare(b.title, "zh-CN");
    }
    return desc ? b.numericAif - a.numericAif : a.numericAif - b.numericAif;
  });
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

function renderTable(items) {
  if (items.length === 0) {
    elements.tableBody.innerHTML = "";
    return;
  }

  elements.tableBody.innerHTML = items
    .map((item) => {
      const reviewHtml = item.isReview ? '<span class="review-flag">Review</span>' : "-";
      const statusHtml = item.onHold
        ? '<span class="status-flag status-hold">ON HOLD</span>'
        : '<span class="status-flag status-normal">Active</span>';

      return `
        <tr>
          <td>${item.cover ? `<img class="cover" src="${escapeHtml(item.cover)}" alt="${escapeHtml(item.title)}" loading="lazy" />` : "-"}</td>
          <td><div class="title">${escapeHtml(item.title)}</div></td>
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
      const statusText = item.onHold ? "ON HOLD" : "Active";

      return `
        <article class="mobile-card">
          <div class="mobile-card-top">
            ${item.cover ? `<img class="mobile-cover" src="${escapeHtml(item.cover)}" alt="${escapeHtml(item.title)}" loading="lazy" />` : ""}
            <div>
              <h3 class="mobile-title">${escapeHtml(item.title)}</h3>
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

function renderEmptyState() {
  const emptyNode = elements.emptyStateTpl.content.firstElementChild.cloneNode(true);
  elements.tableBody.innerHTML = `<tr><td colspan="10"></td></tr>`;
  elements.tableBody.querySelector("td").appendChild(emptyNode);

  elements.mobileList.innerHTML = "";
  elements.mobileList.appendChild(emptyNode.cloneNode(true));
}

function updateSortUi() {
  let text = "↕";
  let title = "默认顺序";
  if (state.sort === "DESC") {
    text = "↓";
    title = "AIF 从高到低";
  } else if (state.sort === "ASC") {
    text = "↑";
    title = "AIF 从低到高";
  }
  elements.aifSortIndicator.textContent = text;
  elements.aifSortBtn.title = title;
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
  renderSubjectTree();

  if (pagination.total === 0) {
    renderEmptyState();
  }
}

function syncState() {
  state.query = elements.searchInput.value.trim().toLowerCase();
  state.tier = elements.tierFilter.value;
  state.review = elements.reviewFilter.value;
  state.hold = elements.holdFilter.value;
  state.pageSize = Number.parseInt(elements.pageSize.value, 10) || 10;
}

function bindEvents() {
  const controls = [
    elements.searchInput,
    elements.tierFilter,
    elements.reviewFilter,
    elements.holdFilter,
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
    if (state.sort === "DEFAULT") {
      state.sort = "DESC";
    } else if (state.sort === "DESC") {
      state.sort = "ASC";
    } else {
      state.sort = "DEFAULT";
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
    if (!target.classList.contains("tag-node-btn")) return;

    const selectedPath = target.dataset.tagPath;
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
}

async function loadData() {
  const response = await fetch("./data/journals.json");
  if (!response.ok) {
    throw new Error(`Failed to load dataset: ${response.status}`);
  }
  const payload = await response.json();
  return payload.journals || [];
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
    const raw = await loadData();
    journals = enrichJournals(raw);
    subjectTree = buildSubjectTree(journals);
    const availableSections = new Set(journals.map((item) => item.section));
    if (!availableSections.has(state.section)) {
      state.section = TAB_SECTIONS.find((section) => availableSections.has(section)) || state.section;
    }
    syncState();
    render();
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
