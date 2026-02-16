const detailPanel = document.getElementById("detailPanel");
const detailSeedDate = document.getElementById("detailSeedDate");
const RUNTIME_SNAPSHOT_KEY = "woa-runtime-snapshot-v2";

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

function tierClass(tier) {
  return `tier-${String(tier || "T4").toLowerCase()}`;
}

function getAifClass(aifDisplay, numericAif) {
  if (aifDisplay === "🤡") return "aif-joker";
  return numericAif >= 0 ? "aif-pos" : "aif-neg";
}

function buildFallbackRuntime(journals) {
  const seedDate = getUtcSeedDate();
  const holdSet = pickDailyOnHoldIds(
    journals.map((item) => item.id),
    seedDate,
    0.05
  );

  const temp = journals.map((item) => {
    const title = item.title.trim();
    let numericAif = 0;
    let aifDisplay = "";

    if (title === "Rubbish") {
      numericAif = 100;
      aifDisplay = "100.0";
    } else if (isJokerJournal(title)) {
      numericAif = 0;
      aifDisplay = "🤡";
    } else {
      numericAif = randomAif();
      aifDisplay = numericAif.toFixed(1);
    }

    return {
      id: item.id,
      issn: item.issn || "",
      numericAif,
      aifDisplay,
      onHold: holdSet.has(item.id)
    };
  });

  const values = temp.map((item) => item.numericAif);
  const q25 = quartile(values, 0.25);
  const q50 = quartile(values, 0.5);
  const q75 = quartile(values, 0.75);

  const runtimeItems = {};
  for (const item of temp) {
    let tier = "T4";
    if (item.numericAif >= q75) tier = "T1";
    else if (item.numericAif >= q50) tier = "T2";
    else if (item.numericAif >= q25) tier = "T3";

    const key = String(item.issn || item.id);
    runtimeItems[key] = {
      ...item,
      tier,
      aifClass: getAifClass(item.aifDisplay, item.numericAif)
    };
  }

  return {
    seedDate,
    items: runtimeItems
  };
}

function loadRuntime(journals) {
  try {
    const raw = sessionStorage.getItem(RUNTIME_SNAPSHOT_KEY);
    if (!raw) return buildFallbackRuntime(journals);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.items) {
      return buildFallbackRuntime(journals);
    }
    return {
      seedDate: parsed.seedDate || getUtcSeedDate(),
      items: parsed.items
    };
  } catch {
    return buildFallbackRuntime(journals);
  }
}

function renderDetail(journal, runtime) {
  const runtimeKey = String(journal.issn || journal.id);
  const runtimeItem = runtime.items[runtimeKey] || runtime.items[String(journal.id)] || {};
  const tier = runtimeItem.tier || journal.originalQuartile || "T4";
  const aifDisplay = runtimeItem.aifDisplay || journal.originalAif || "-";
  const numericAif = Number(runtimeItem.numericAif ?? 0);
  const aifClass = runtimeItem.aifClass || getAifClass(aifDisplay, numericAif);
  const statusHtml = runtimeItem.onHold
    ? '<span class="status-flag status-hold">ON HOLD</span>'
    : '<span class="status-flag status-normal">Active</span>';
  const reviewHtml = journal.isReview ? '<span class="review-flag">Review</span>' : "否";
  const tagsHtml =
    journal.tags && journal.tags.length
      ? journal.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")
      : "<span>-</span>";

  detailSeedDate.textContent = runtime.seedDate || "-";
  document.title = `${journal.title} | Web of Absurd`;

  detailPanel.innerHTML = `
    <div class="detail-head">
      <h2>${escapeHtml(journal.title)}</h2>
      <p>${escapeHtml(journal.section)} · ISSN ${escapeHtml(journal.issn || "-")}</p>
    </div>
    <div class="detail-card">
      <div class="detail-cover-wrap">
        ${journal.cover ? `<img class="detail-cover" src="${escapeHtml(journal.cover)}" alt="${escapeHtml(journal.title)}" />` : '<div class="detail-cover-placeholder">No Cover</div>'}
      </div>
      <div class="detail-grid">
        <div><strong>当前分区</strong><span class="tier ${tierClass(tier)}">${escapeHtml(tier)}</span></div>
        <div><strong>当前 AIF</strong><span class="aif ${aifClass}">${escapeHtml(aifDisplay)}</span></div>
        <div><strong>状态</strong>${statusHtml}</div>
        <div><strong>综述期刊</strong>${reviewHtml}</div>
        <div><strong>收录</strong>${escapeHtml(journal.section || "-")}</div>
        <div><strong>主编/编辑部</strong>${escapeHtml(journal.editor || "-")}</div>
        <div><strong>学科标签</strong><div class="tags">${tagsHtml}</div></div>
        <div><strong>学科原文</strong>${escapeHtml(journal.subjectRaw || "-")}</div>
      </div>
    </div>
    <div class="detail-note panel">
      <h3>期刊注释</h3>
      <p>${escapeHtml(journal.note || "暂无注释")}</p>
    </div>
  `;
}

function renderError(message) {
  detailPanel.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
  detailSeedDate.textContent = "-";
}

async function loadData() {
  const response = await fetch("./data/journals.json");
  if (!response.ok) throw new Error(`Failed to load dataset: ${response.status}`);
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
  registerServiceWorker();
  const params = new URLSearchParams(window.location.search);
  const issnParam = params.get("issn");
  const idParam = params.get("id");
  if (!issnParam && !idParam) {
    renderError("缺少期刊 ISSN 参数");
    return;
  }

  try {
    const journals = await loadData();
    const journal = issnParam
      ? journals.find((item) => String(item.issn || "") === String(issnParam))
      : journals.find((item) => String(item.id) === String(idParam));
    if (!journal) {
      renderError("未找到该期刊");
      return;
    }

    const runtime = loadRuntime(journals);
    renderDetail(journal, runtime);
  } catch (error) {
    console.error(error);
    renderError("详情加载失败，请稍后重试");
  }
}

bootstrap();
