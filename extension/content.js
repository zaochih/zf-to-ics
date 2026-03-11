/**
 * content.js — 正方教务课表转 ICS
 *
 * 职责：
 *   1. 检测当前页面是否为正方软件教务系统（检查页脚）
 *   2. 监听来自 popup 的消息，按需请求教务 API
 *   3. 将原始 JSON 数据回传给 popup
 */

"use strict";

// ─── 辅助：检测是否为正方系统 ─────────────────────────────────────────────────

function detectZFSystem() {
  // 优先检查 .footer，兼容多种选择器
  const selectors = [".footer", "footer", "#footer", "#bottom", ".bottom"];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.includes("正方软件股份有限公司")) {
      return true;
    }
  }
  // 兜底：全文搜索（性能稍差，但能应对非标准布局）
  return document.body
    ? document.body.innerText.includes("正方软件股份有限公司")
    : false;
}

// ─── 辅助：从页面提取 gnmkdm（模块码） ────────────────────────────────────────

function detectGnmkdm() {
  // 1. 当前 URL 查询参数
  const urlParam = new URLSearchParams(window.location.search).get("gnmkdm");
  if (urlParam) return urlParam;

  // 2. 页面内的隐藏 input
  const hiddenInput = document.querySelector('input[name="gnmkdm"]');
  if (hiddenInput && hiddenInput.value) return hiddenInput.value;

  // 3. 页面内的任意带 gnmkdm 的链接
  for (const a of document.querySelectorAll('a[href*="gnmkdm="]')) {
    const m = a.href.match(/gnmkdm=([^&]+)/);
    if (m) return m[1];
  }

  // 4. 默认值：正方系统学生课表模块通用码
  return "N253508";
}

// ─── 辅助：根据当前日期猜测学年/学期 ──────────────────────────────────────────

function guessCurrentTerm() {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const year = now.getFullYear();

  let xnm, xqm;

  if (month >= 9 && month <= 12) {
    // 秋季学期（9-12 月）：2025-2026 学年第一学期 xnm=2025
    xnm = year;
    xqm = "3";
  } else if (month === 1) {
    // 1 月仍属上一学年第一学期
    xnm = year - 1;
    xqm = "3";
  } else {
    // 2-8 月：春季学期，xnm 为上一年
    xnm = year - 1;
    xqm = "12";
  }

  return { xnm: String(xnm), xqm };
}

// ─── 核心：向正方 API 发起 POST 请求 ──────────────────────────────────────────

async function postForm(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    credentials: "include", // 携带登录 Cookie
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${url}`);
  }

  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `响应不是合法 JSON（可能需要重新登录）：${text.slice(0, 200)}`,
    );
  }
}

// ─── 辅助：根据学年学期推算节假日切换日期 ─────────────────────────────────────
//   春季(xqm=12) → 五一  2026-05-01
//   秋季(xqm=3)  → 十一  2025-10-01

function defaultSwitchDateStr(xnm, xqm) {
  const y = parseInt(xnm, 10);
  return xqm === "12" ? `${y + 1}-05-01` : `${y}-10-01`;
}

// ─── 辅助：比较两套节次时间是否完全相同 ──────────────────────────────────────

function periodListsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].qssj !== b[i].qssj || a[i].jssj !== b[i].jssj) return false;
  }
  return true;
}

// ─── 核心：拉取全部所需数据 ───────────────────────────────────────────────────
//
// 关键发现（实测）：
//   cxRjc 的节次时间完全由 xqm 决定，rq 参数对结果无影响。
//   同一所学校：
//     xqm=12(春季) → 秋冬作息（如下午 14:35）
//     xqm=3 (秋季) → 春夏作息（如下午 14:55）
//   节假日后的切换：
//     春季(12) 五一后 → 改用 xqm=3 时间
//     秋季(3)  十一后 → 改用 xqm=12 时间
//   因此探测"另一套作息"只需用另一个 xqm 再查一次，不需要 rq。

async function fetchAllData(xnm, xqm, gnmkdm) {
  const base = window.location.origin;
  const qs = `?gnmkdm=${gnmkdm}`;

  // 1. 学生个人课表（含 kbList、xsxx、sjkList 等）
  //    kclbdm= 与页面实际请求保持一致
  const kbData = await postForm(
    `${base}/jwglxt/kbcx/xskbcx_cxXsgrkb.html${qs}`,
    `xnm=${encodeURIComponent(xnm)}&xqm=${encodeURIComponent(xqm)}&kzlx=ck&xsdm=&kclbdm=`,
  );

  // 2. 当前学期作息（节前使用）
  const rjData1 = await postForm(
    `${base}/jwglxt/kbcx/xskbcx_cxRjc.html${qs}`,
    `xnm=${encodeURIComponent(xnm)}&xqm=${encodeURIComponent(xqm)}&xqh_id=1`,
  );

  // 3. 另一套作息（节后使用）
  //    春季(12) 节后 → 用 xqm=3；秋季(3) 节后 → 用 xqm=12
  //    同一学年（xnm 不变），两个学期共用一套作息配置
  const otherXqm = xqm === "12" ? "3" : "12";
  let rjData2 = null;
  let detectedSwitchDate = null;

  try {
    const data = await postForm(
      `${base}/jwglxt/kbcx/xskbcx_cxRjc.html${qs}`,
      `xnm=${encodeURIComponent(xnm)}&xqm=${encodeURIComponent(otherXqm)}&xqh_id=1`,
    );
    if (
      Array.isArray(data) &&
      data.length > 0 &&
      !periodListsEqual(rjData1, data)
    ) {
      rjData2 = data;
      detectedSwitchDate = defaultSwitchDateStr(xnm, xqm);
    }
  } catch {
    // 查询失败则按单套作息处理
  }

  return { kbData, rjData1, rjData2, detectedSwitchDate };
}

// ─── 消息监听 ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ZF_CHECK") {
    // popup 询问：这是正方系统吗？顺带返回基础信息
    const isZF = detectZFSystem();
    const term = guessCurrentTerm();
    sendResponse({
      isZF,
      baseUrl: window.location.origin,
      gnmkdm: isZF ? detectGnmkdm() : null,
      ...term,
    });
    return false; // 同步回复，不需要保持通道
  }

  if (message.type === "ZF_FETCH") {
    // popup 请求抓取数据
    const { xnm, xqm } = message;
    const gnmkdm = detectGnmkdm();

    fetchAllData(xnm, xqm, gnmkdm)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true; // 异步，保持消息通道
  }
});
