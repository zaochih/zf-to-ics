/**
 * popup.js — 正方教务课表转 ICS
 *
 * 职责：
 *   1. popup 打开时向 content script 查询当前页面是否为正方系统
 *   2. 将检测结果及预填参数渲染到表单
 *   3. 用户点击「生成」后，向 content script 请求 API 数据
 *   4. 解析节次时间、周次、星期，生成标准 RFC 5545 .ics 文件并触发下载
 */

import {
  fmtDateBasic, fmtDateInput, parseDateInput, defaultStartDate,
  parseWeeks, parseJcs, mergeKbList, buildPeriodMap,
  buildDescription, buildLocation, escapeIcsText, foldLine, generateICS,
} from "./lib.js";

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
