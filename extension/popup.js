/**
 * popup.js — 正方教务课表转 ICS
 *
 * 职责：
 *   1. popup 打开时向 content script 查询当前页面是否为正方系统
 *   2. 将检测结果及预填参数渲染到表单
 *   3. 用户点击「生成」后，向 content script 请求 API 数据
 *   4. 解析节次时间、周次、星期，生成标准 RFC 5545 .ics 文件并触发下载
 *   5. 可选：通过 GitHub OAuth 将生成的 .ics 发布到 GitHub Gist 供订阅
 */

import {
  fmtDateBasic, fmtDateInput, parseDateInput, defaultStartDate,
  parseWeeks, parseJcs, mergeKbList, buildPeriodMap,
  buildDescription, buildLocation, escapeIcsText, foldLine, generateICS,
} from "./lib.js";

// ─── GitHub Gist 配置 ─────────────────────────────────────────────────────────
// 部署自己的 Cloudflare Worker 后，将此处替换为你的 Worker URL
// 参见 /backend/wrangler.toml
const WORKER_ORIGIN = "https://zics-api.zaochih.com";

// ─── DOM 引用 ────────────────────────────────────────────────────────────────

const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");
const inpXnm = document.getElementById("inp-xnm");
const selXqm = document.getElementById("sel-xqm");
const inpStart = document.getElementById("inp-start");
const inpEnd = document.getElementById("inp-end");
const chkCampus = document.getElementById("chk-campus");
const lblCampus = document.getElementById("lbl-campus");
const chkMerge = document.getElementById("chk-merge");
const inpSwitch = document.getElementById("inp-switch");
const scheduleBadge = document.getElementById("schedule-badge");
const scheduleBadgeTx = document.getElementById("schedule-badge-tx");
const hintBox = document.getElementById("hint-box");
const btnGenerate = document.getElementById("btn-generate");
const resultEl = document.getElementById("result");

// GitHub Gist DOM 引用
const githubDisconnected = document.getElementById("github-disconnected");
const githubConnected = document.getElementById("github-connected");
const githubUserEl = document.getElementById("github-user");
const btnGithubConnect = document.getElementById("btn-github-connect");
const btnGithubDisconnect = document.getElementById("btn-github-disconnect");
const btnGistPublish = document.getElementById("btn-gist-publish");
const gistUrlRow = document.getElementById("gist-url-row");
const gistUrlInput = document.getElementById("gist-url");
const gistResultEl = document.getElementById("gist-result");

// ─── 状态工具 ────────────────────────────────────────────────────────────────

function setStatus(state, text) {
  dot.className = `dot ${state}`;
  statusText.textContent = text;
}

function showResult(type, html) {
  resultEl.className = type;
  resultEl.innerHTML = html;
  resultEl.style.display = "block";
}

function hideResult() {
  resultEl.style.display = "none";
}

function enableForm() {
  inpXnm.disabled = false;
  selXqm.disabled = false;
  inpStart.disabled = false;
  inpEnd.disabled = false;
  inpSwitch.disabled = false;
  chkCampus.disabled = false;
  chkMerge.disabled = false;
  btnGenerate.disabled = false;
  lblCampus.classList.remove("disabled");
  document.getElementById("lbl-merge").classList.remove("disabled");
}

// ─── 下载 ─────────────────────────────────────────────────────────────────────

function downloadICS(content, filename) {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Chrome 消息工具 ──────────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

// ─── GitHub OAuth & Gist ──────────────────────────────────────────────────────

/** 最近一次生成的 ICS 内容和文件名（供发布到 Gist 使用） */
let lastIcsContent = null;
let lastIcsFilename = null;

function showGistResult(type, html) {
  gistResultEl.className = type;
  gistResultEl.innerHTML = html;
  gistResultEl.style.display = "block";
}

function hideGistResult() {
  gistResultEl.style.display = "none";
}

/** 根据 chrome.storage.local 里是否存有 token，切换已连接/未连接界面 */
async function refreshGithubUI() {
  const { github_login } = await chrome.storage.local.get("github_login");
  if (github_login) {
    githubUserEl.textContent = github_login;
    githubDisconnected.style.display = "none";
    githubConnected.style.display = "flex";
    btnGistPublish.disabled = !lastIcsContent;
  } else {
    githubDisconnected.style.display = "block";
    githubConnected.style.display = "none";
  }
}

/**
 * 使用 chrome.identity.launchWebAuthFlow 发起 GitHub OAuth 流程。
 * 扩展将 ext_id 和随机 nonce 传给 Cloudflare Worker，Worker 完成
 * client_secret 的保密交换后把 access_token 写回 chromiumapp.org URL，
 * Chrome 拦截该 URL 并将其作为 responseUrl 返回给扩展。
 */
async function connectGitHub() {
  const extId = chrome.runtime.id;

  // 生成 16 字节密码学随机 nonce（用于 CSRF 防护）
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const authUrl =
    `${WORKER_ORIGIN}/oauth/github/authorize?` +
    new URLSearchParams({ ext_id: extId, state: nonce });

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (url) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(url);
        }
      },
    );
  });

  const params = new URLSearchParams(new URL(responseUrl).search);

  // 验证 state（防 CSRF）
  if (params.get("state") !== nonce) {
    throw new Error("State 不匹配，请重试");
  }

  const token = params.get("access_token");
  if (!token) throw new Error("未获得 access_token");

  // 获取 GitHub 用户名
  const userResp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "zf-to-ics",
    },
  });
  if (!userResp.ok) throw new Error("获取 GitHub 用户信息失败");
  const user = await userResp.json();

  await chrome.storage.local.set({
    github_token: token,
    github_login: user.login,
  });
  return user.login;
}

/**
 * 将 ICS 内容发布到 GitHub Gist。
 * - 首次发布：创建新 Gist，将 gist_id 存入 chrome.storage.local
 * - 再次发布同文件名：更新同一 Gist，订阅链接保持不变
 *
 * 返回稳定的 raw 订阅 URL（不含 commit SHA，始终指向最新版本）。
 */
async function publishToGist(icsContent, filename) {
  const { github_token, github_gist_id } = await chrome.storage.local.get([
    "github_token",
    "github_gist_id",
  ]);
  if (!github_token) throw new Error("请先连接 GitHub");

  const gistPayload = {
    description: "正方教务课表 iCal 订阅 · 由 zf-to-ics 生成",
    public: true,
    files: { [filename]: { content: icsContent } },
  };

  let resp;
  if (github_gist_id) {
    resp = await fetch(`https://api.github.com/gists/${github_gist_id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${github_token}`,
        "Content-Type": "application/json",
        "User-Agent": "zf-to-ics",
      },
      body: JSON.stringify(gistPayload),
    });
  } else {
    resp = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${github_token}`,
        "Content-Type": "application/json",
        "User-Agent": "zf-to-ics",
      },
      body: JSON.stringify(gistPayload),
    });
  }

  if (resp.status === 401) {
    // Token 已过期或被撤销，清除本地凭证
    await chrome.storage.local.remove([
      "github_token",
      "github_login",
      "github_gist_id",
    ]);
    await refreshGithubUI();
    throw new Error("GitHub token 已失效，请重新连接");
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`GitHub API 错误：${err.message ?? resp.status}`);
  }

  const gist = await resp.json();
  await chrome.storage.local.set({ github_gist_id: gist.id });

  // 构造不含 commit SHA 的稳定订阅 URL
  const subscriptionUrl =
    `https://gist.githubusercontent.com/${gist.owner.login}/${gist.id}/raw/${filename}`;
  return subscriptionUrl;
}

// ─── GitHub 按钮事件 ──────────────────────────────────────────────────────────

btnGithubConnect.addEventListener("click", async () => {
  btnGithubConnect.disabled = true;
  btnGithubConnect.textContent = "正在授权…";
  hideGistResult();
  try {
    const login = await connectGitHub();
    await refreshGithubUI();
    showGistResult("success", `✅ 已连接 GitHub 账号：${login}`);
  } catch (e) {
    showGistResult("error", "连接 GitHub 失败：" + e.message);
  } finally {
    btnGithubConnect.disabled = false;
    btnGithubConnect.textContent = "连接 GitHub 以发布 iCal 订阅链接";
  }
});

btnGithubDisconnect.addEventListener("click", async () => {
  await chrome.storage.local.remove([
    "github_token",
    "github_login",
    "github_gist_id",
  ]);
  gistUrlRow.style.display = "none";
  hideGistResult();
  await refreshGithubUI();
});

btnGistPublish.addEventListener("click", async () => {
  if (!lastIcsContent || !lastIcsFilename) {
    showGistResult("error", "请先生成 ICS 文件再发布。");
    return;
  }
  hideGistResult();
  btnGistPublish.disabled = true;
  btnGistPublish.textContent = "正在发布…";
  try {
    const subscriptionUrl = await publishToGist(lastIcsContent, lastIcsFilename);
    gistUrlInput.value = subscriptionUrl;
    gistUrlRow.style.display = "flex";
    showGistResult(
      "success",
      `✅ 已发布到 Gist。复制上方链接到日历应用（Apple 日历、Google Calendar 等）即可订阅。`,
    );
  } catch (e) {
    showGistResult("error", "发布失败：" + e.message);
  } finally {
    btnGistPublish.disabled = false;
    btnGistPublish.textContent = "发布 / 更新 Gist 订阅链接";
  }
});

// ─── 表单联动 ─────────────────────────────────────────────────────────────────

function syncDefaults() {
  const xnm = inpXnm.value.trim();
  const xqm = selXqm.value;
  if (!xnm || isNaN(parseInt(xnm, 10))) return;

  // 第 1 周周一（只在未手动填写时预填）
  if (!inpStart.value) {
    inpStart.value = fmtDateInput(defaultStartDate(xnm, xqm));
  }
}

selXqm.addEventListener("change", syncDefaults);
inpXnm.addEventListener("change", syncDefaults);

// ─── 初始化 ───────────────────────────────────────────────────────────────────

(async () => {
  let tab;
  try {
    tab = await getActiveTab();
  } catch (e) {
    setStatus("err", "无法访问当前标签页");
    return;
  }

  let resp;
  try {
    resp = await sendToContent(tab.id, { type: "ZF_CHECK" });
  } catch {
    setStatus("err", "无法连接到页面（请刷新后重试）");
    hintBox.textContent = "请确保在正方教务系统的标签页上打开本扩展。";
    hintBox.classList.add("warn");
    return;
  }

  if (!resp?.isZF) {
    setStatus("warn", "未检测到正方系统");
    hintBox.textContent =
      "当前页面页脚未包含「正方软件股份有限公司」，请切换到正方教务系统后重试。";
    hintBox.classList.add("warn");
    return;
  }

  setStatus("ok", "已检测到正方教务系统");

  inpXnm.value = resp.xnm ?? "";
  selXqm.value = resp.xqm ?? "12";
  syncDefaults();
  enableForm();

  hintBox.textContent =
    "请填写「第 1 周周一日期」（即开学第一天）。留空截止日期则生成整个学期的 ICS。";

  await refreshGithubUI();
})();

// ─── 生成按钮 ─────────────────────────────────────────────────────────────────

btnGenerate.addEventListener("click", async () => {
  hideResult();

  const xnm = inpXnm.value.trim();
  const xqm = selXqm.value;
  const startVal = inpStart.value;
  const endVal = inpEnd.value;
  const showCampus = chkCampus.checked;

  // ── 基本校验 ──────────────────────────────────────────────────────────
  if (!xnm || isNaN(parseInt(xnm, 10))) {
    showResult("error", "请填写正确的学年（起始年份）。");
    return;
  }
  if (!startVal) {
    showResult("error", "请填写「第 1 周周一日期」。");
    return;
  }

  const termStart = parseDateInput(startVal);
  if (termStart.getDay() !== 1) {
    const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
    showResult(
      "error",
      `所填日期（${startVal}）不是周一` +
        `（当天是周${dayNames[termStart.getDay()]}），请重新确认。`,
    );
    return;
  }

  const endDate = endVal ? parseDateInput(endVal) : null;

  // ── 抓取数据 ──────────────────────────────────────────────────────────
  btnGenerate.disabled = true;
  btnGenerate.textContent = "正在获取数据…";

  let tab;
  try {
    tab = await getActiveTab();
  } catch (e) {
    showResult("error", "无法访问当前标签页：" + e.message);
    btnGenerate.disabled = false;
    btnGenerate.textContent = "获取课表并生成 .ics";
    return;
  }

  let data;
  try {
    const resp = await sendToContent(tab.id, { type: "ZF_FETCH", xnm, xqm });
    if (!resp?.ok) throw new Error(resp?.error ?? "未知错误");
    data = resp;
  } catch (e) {
    showResult("error", "获取课表数据失败：" + e.message);
    btnGenerate.disabled = false;
    btnGenerate.textContent = "获取课表并生成 .ics";
    return;
  }

  // ── 构建节次查找表 ────────────────────────────────────────────────────
  const periodMap1 = buildPeriodMap(data.rjData1);
  const periodMap2 = data.rjData2 ? buildPeriodMap(data.rjData2) : null;

  if (Object.keys(periodMap1).length === 0) {
    showResult("error", "节次时间数据为空，请检查学年/学期是否正确。");
    btnGenerate.disabled = false;
    btnGenerate.textContent = "获取课表并生成 .ics";
    return;
  }

  // 若 content.js 探测到双套作息且表单里切换日期为空，自动预填
  if (periodMap2 && data.detectedSwitchDate && !inpSwitch.value) {
    inpSwitch.value = data.detectedSwitchDate;
  }

  // 更新双作息提示 badge
  if (periodMap2) {
    scheduleBadge.classList.add("visible");
    scheduleBadgeTx.textContent = `已检测到两套作息，将在 ${inpSwitch.value || data.detectedSwitchDate || "切换日期"} 前后自动切换`;
  } else {
    scheduleBadge.classList.remove("visible");
  }

  // ── 课表列表 ──────────────────────────────────────────────────────────
  const rawKbList = data.kbData?.kbList ?? [];
  const kbList = chkMerge.checked ? mergeKbList(rawKbList) : rawKbList;
  const xsxx = data.kbData?.xsxx ?? {};

  if (kbList.length === 0) {
    showResult("error", "该学期课表为空，请确认学年/学期参数是否正确。");
    btnGenerate.disabled = false;
    btnGenerate.textContent = "获取课表并生成 .ics";
    return;
  }

  // ── 生成 ICS ──────────────────────────────────────────────────────────
  // 以表单当前值为准（可能已被自动预填）
  const finalSwitchDate = inpSwitch.value
    ? parseDateInput(inpSwitch.value)
    : null;

  const icsContent = generateICS(
    kbList,
    periodMap1,
    periodMap2,
    finalSwitchDate,
    termStart,
    endDate,
    showCampus,
  );

  const studentName = (xsxx.XM ?? "").trim() || "student";
  const semLabel = xqm === "3" ? "秋冬" : "春夏";
  const endLabel = endDate ? `_截至${fmtDateBasic(endDate)}` : "";
  const filename = `${studentName}_${xnm}-${parseInt(xnm) + 1}_${semLabel}${endLabel}.ics`;

  downloadICS(icsContent, filename);

  // 保存 ICS 内容供「发布到 Gist」使用
  lastIcsContent = icsContent;
  lastIcsFilename = filename;
  btnGistPublish.disabled = false;

  const totalEvents = (icsContent.match(/BEGIN:VEVENT/g) ?? []).length;
  const scheduleNote = periodMap2
    ? `（双套作息，${inpSwitch.value} 前后自动切换）`
    : "（单套作息）";

  showResult(
    "success",
    `✅ 已生成 <strong>${totalEvents}</strong> 个课程事件${scheduleNote}，` +
      `文件「${filename}」已下载。` +
      (endDate
        ? ``
        : `<br/><small style="opacity:.7">未设截止日期，已生成整个学期。</small>`),
  );

  btnGenerate.disabled = false;
  btnGenerate.textContent = "获取课表并生成 .ics";
});
