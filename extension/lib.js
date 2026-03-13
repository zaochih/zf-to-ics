/**
 * lib.js — 纯函数模块，无 DOM / Chrome 依赖
 *
 * 供 popup.js（浏览器环境）和单元测试（Node.js）共用。
 */

// ─── 日期工具 ────────────────────────────────────────────────────────────────

/** Date → "YYYYMMDD" */
export function fmtDateBasic(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

/** Date → "YYYY-MM-DD"（用于 <input type="date">） */
export function fmtDateInput(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** "YYYY-MM-DD" → Date（本地时区，不偏移） */
export function parseDateInput(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 根据学期返回「第 1 周周一」的合理默认猜测 */
export function defaultStartDate(xnm, xqm) {
  const y = parseInt(xnm, 10);
  if (xqm === "12") {
    return new Date(y + 1, 1, 24); // Feb 24 of xnm+1
  } else {
    return new Date(y, 8, 1); // Sep 1 of xnm
  }
}

// ─── 周次解析 ─────────────────────────────────────────────────────────────────
//
// 支持格式：
//   "1-16周"  "1-8,10-16周"  "1-16(单)周"  "1-16(双)周"
//   "单1-10周"  "双2-12周"   "2,4,6,8周"

export function parseWeeks(zcd) {
  if (!zcd || !zcd.trim()) return [];

  let str = zcd.trim();

  const oddOnly = /单/.test(str);
  const evenOnly = /双/.test(str);

  str = str
    .replace(/[（(][^）)]*[）)]/g, "") // 去括号内容
    .replace(/[^0-9,，\-]/g, " ") // 非数字分隔符变空格
    .replace(/，/g, ",")
    .trim();

  const weeks = [];
  for (const part of str.split(/[\s,]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = parseInt(range[1], 10);
      const hi = parseInt(range[2], 10);
      for (let w = lo; w <= hi; w++) {
        if (oddOnly && w % 2 === 0) continue;
        if (evenOnly && w % 2 === 1) continue;
        weeks.push(w);
      }
    } else if (/^\d+$/.test(part)) {
      const w = parseInt(part, 10);
      if (oddOnly && w % 2 === 0) continue;
      if (evenOnly && w % 2 === 1) continue;
      weeks.push(w);
    }
  }

  return [...new Set(weeks)].sort((a, b) => a - b);
}

// ─── 节次解析 ─────────────────────────────────────────────────────────────────
// "1-2" → {first:1, last:2}   "7" → {first:7, last:7}

export function parseJcs(jcs) {
  if (!jcs) return null;
  const parts = String(jcs)
    .split("-")
    .map(Number)
    .filter((n) => !isNaN(n));
  if (parts.length === 0) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

// ─── 课程合并（理论 + 实验 / 实践）────────────────────────────────────────────
//
// 同一课程（同 kch）在同一天（xqj）、同一周次（zcd）若出现多条记录，
// 且各条的节次相邻或紧连（无空隙），则合并为一条，节次取整体跨度。
// 非相邻节次（中间有课间以上的间隔）视为独立排课，不合并。

export function mergeKbList(kbList) {
  // 按 (kch, xqj, zcd) 分组；kch 为空时用 kcmc 代替
  const groups = new Map();
  for (const course of kbList) {
    const key = `${course.kch || course.kcmc}|${course.xqj}|${course.zcd}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(course);
  }

  const result = [];

  for (const items of groups.values()) {
    if (items.length === 1) {
      result.push(items[0]);
      continue;
    }

    // 解析节次并按起始节排序
    const parsed = items.map((item) => ({ item, p: parseJcs(item.jcs) }));
    parsed.sort((a, b) => (a.p?.first ?? 0) - (b.p?.first ?? 0));

    // 将排序后的条目拆分成若干连续子组（相邻定义：前一组末节 + 1 >= 当前组首节）
    const subGroups = [[parsed[0]]];
    for (let i = 1; i < parsed.length; i++) {
      const prev = subGroups[subGroups.length - 1];
      const prevLast = prev[prev.length - 1].p?.last ?? -Infinity;
      const currFirst = parsed[i].p?.first ?? Infinity;
      if (currFirst <= prevLast + 1) {
        prev.push(parsed[i]); // 相邻或重叠：加入同一子组
      } else {
        subGroups.push([parsed[i]]); // 有间隔：新子组
      }
    }

    for (const sg of subGroups) {
      if (sg.length === 1) {
        result.push(sg[0].item);
        continue;
      }

      const minFirst = sg[0].p.first;
      const maxLast = Math.max(...sg.map((x) => x.p?.last ?? x.p?.first ?? minFirst));

      const locations = [
        ...new Set(sg.map((x) => String(x.item.cdmc ?? "").trim()).filter(Boolean)),
      ];
      const teachers = [
        ...new Set(sg.map((x) => String(x.item.xm ?? "").trim()).filter(Boolean)),
      ];
      const types = sg
        .map((x) => String(x.item.xslxbj ?? "").trim())
        .filter(Boolean);
      const kcxszcParts = [
        ...new Set(
          sg.map((x) => String(x.item.kcxszc ?? "").trim()).filter(Boolean),
        ),
      ];

      const base = { ...sg[0].item };
      base.jcs = `${minFirst}-${maxLast}`;
      base.jc = `${base.jcs}节`;
      base.jcor = base.jcs;
      base.cdmc = locations.join(" / ");
      base.xm = teachers.join(" / ");
      base.xslxbj = types.join("");
      base.kcxszc = kcxszcParts.join(",");

      result.push(base);
    }
  }

  return result;
}

// ─── 构建节次查找表 ───────────────────────────────────────────────────────────
// { "1": {qssj:"08:10", jssj:"08:55"}, ... }

export function buildPeriodMap(rjData) {
  const map = {};
  for (const item of Array.isArray(rjData) ? rjData : []) {
    const jcmc = String(item.jcmc ?? "").trim();
    if (jcmc && item.qssj && item.jssj) {
      map[jcmc] = { qssj: item.qssj.trim(), jssj: item.jssj.trim() };
    }
  }
  return map;
}

// ─── 事件描述构建 ─────────────────────────────────────────────────────────────
//
// 格式：(1-2节)1-16周/校区:荆东校区/场地:博学楼-202/教师:张三/
//       教学班:(...)/教学班组成:.../考核方式:未安排/
//       课程学时组成:理论:48/周学时:3/总学时:48/学分:3.0

export function buildDescription(course) {
  const jcs = String(course.jcs ?? "").trim();
  const zcd = String(course.zcd ?? "").trim();

  const parts = [`(${jcs}节)${zcd}`];

  const push = (label, key) => {
    const v = String(course[key] ?? "").trim();
    if (v) parts.push(`${label}:${v}`);
  };

  push("校区", "xqmc");
  push("场地", "cdmc");
  push("教师", "xm");
  push("教学班", "jxbmc");
  push("教学班组成", "jxbzc");
  push("考核方式", "khfsmc");
  push("选课备注", "xkbz");
  push("课程学时组成", "kcxszc");
  push("周学时", "zhxs");
  push("总学时", "zxs");
  push("学分", "xf");

  return parts.join("/");
}

// ─── Location 构建 ────────────────────────────────────────────────────────────

export function buildLocation(course, showCampus) {
  const cdmc = String(course.cdmc ?? "").trim();
  const xqmc = String(course.xqmc ?? "").trim();
  if (showCampus && xqmc) {
    return `${xqmc}·${cdmc}`;
  }
  return cdmc;
}

// ─── API 根路径提取 ───────────────────────────────────────────────────────────

/**
 * 从登录页面 URL 中提取 API 根路径。
 *
 * 正方系统各校登录页路径格式均为 <rootPath>/xtgl/login_slogin.html，
 * 切掉该后缀即可得到 rootPath（含协议和域名）。
 *
 * 示例：
 *   "https://jwxxt.fjsmu.edu.cn/jwglxt/xtgl/login_slogin.html"
 *   → "https://jwxxt.fjsmu.edu.cn/jwglxt"
 *
 *   "http://jwxt1.hbfs.edu.cn/xtgl/login_slogin.html"
 *   → "http://jwxt1.hbfs.edu.cn"
 *
 * 未匹配则返回 null。
 */
export function parseApiBase(loginUrl) {
  const suffix = "/xtgl/login_slogin.html";
  const idx = String(loginUrl ?? "").indexOf(suffix);
  return idx !== -1 ? loginUrl.slice(0, idx) : null;
}

// ─── ICS 字符串工具 ───────────────────────────────────────────────────────────

export function escapeIcsText(str) {
  return String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** RFC 5545 §3.1 行折叠（75 字节上限，续行以空格开头，不切断 UTF-8 字符） */
export function foldLine(line) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const bytes = enc.encode(line);
  if (bytes.length <= 75) return line;

  const chunks = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const max = first ? 75 : 74;
    let end = start + max;
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push((first ? "" : " ") + dec.decode(bytes.slice(start, end)));
    start = end;
    first = false;
  }
  return chunks.join("\r\n");
}

let _uidSeq = 0;
export function makeUID(kcmc, xqj, week, jcs) {
  _uidSeq++;
  const slug = `${kcmc}-${xqj}-${week}-${jcs}-${_uidSeq}`.replace(
    /[^a-zA-Z0-9\-]/g,
    "_",
  );
  return `${slug}@zf-to-ics`;
}

// ─── ICS 生成主函数 ───────────────────────────────────────────────────────────

/**
 * @param {Array}       kbList      kbList 数组
 * @param {Object}      periodMap1  节次时间查找表（切换日期前，= 当前学期 xqm 查到的作息）
 * @param {Object|null} periodMap2  切换日期后使用的节次表（另一个 xqm 查到的作息）
 * @param {Date|null}   switchDate  作息切换日期（当天起改用 periodMap2）
 *                                  春季(xqm=12): 2025-05-01 前用 periodMap1，之后用 periodMap2
 *                                  秋季(xqm=3) : 2025-10-01 前用 periodMap1，之后用 periodMap2
 * @param {Date}        termStart   第 1 周周一
 * @param {Date|null}   endDate     截止日期（null = 全学期）
 * @param {boolean}     showCampus  是否在 LOCATION 中前置校区
 * @returns {string}
 */
export function generateICS(kbList, periodMap1, periodMap2, switchDate, termStart, endDate, showCampus) {
  _uidSeq = 0;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ZF-to-ICS//ZF Course Schedule//ZH",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:课表",
    "X-WR-TIMEZONE:Asia/Shanghai",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZNAME:CST",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  const seen = new Set();

  for (const course of kbList) {
    const kcmc = String(course.kcmc ?? "").trim();
    const xqj = parseInt(course.xqj, 10); // 1=周一 … 7=周日
    const jcs = String(course.jcs ?? "").trim();
    const zcd = String(course.zcd ?? "").trim();

    if (!kcmc || !xqj || !jcs || !zcd) continue;

    const periods = parseJcs(jcs);
    if (!periods) continue;

    const weeks = parseWeeks(zcd);
    if (weeks.length === 0) continue;

    const dayOffset = xqj - 1; // 周一=0 … 周日=6

    for (const week of weeks) {
      const courseDate = new Date(termStart);
      courseDate.setDate(termStart.getDate() + (week - 1) * 7 + dayOffset);

      if (endDate && courseDate > endDate) continue;

      const useMap = (periodMap2 && switchDate && courseDate >= switchDate)
        ? periodMap2
        : periodMap1;
      const startPeriod = useMap[String(periods.first)];
      const endPeriod = useMap[String(periods.last)];
      if (!startPeriod || !endPeriod) continue;

      const dateStr = fmtDateBasic(courseDate);
      const dedupeKey = `${kcmc}|${dateStr}|${jcs}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const dtStart = `${dateStr}T${startPeriod.qssj.replace(":", "")}00`;
      const dtEnd = `${dateStr}T${endPeriod.jssj.replace(":", "")}00`;

      const eventLines = [
        "BEGIN:VEVENT",
        `DTSTART;TZID=Asia/Shanghai:${dtStart}`,
        `DTEND;TZID=Asia/Shanghai:${dtEnd}`,
        `SUMMARY:${escapeIcsText(kcmc)}`,
        `LOCATION:${escapeIcsText(buildLocation(course, showCampus))}`,
        `DESCRIPTION:${escapeIcsText(buildDescription(course))}`,
        `UID:${makeUID(kcmc, xqj, week, jcs)}`,
        "END:VEVENT",
      ];

      for (const l of eventLines) lines.push(foldLine(l));
    }
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
