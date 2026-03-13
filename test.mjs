/**
 * test.mjs — 正方教务课表转 ICS 核心逻辑单元测试
 *
 * 运行：node test.mjs
 *
 * 完全独立，不依赖浏览器 API 和 Chrome 扩展 API。
 * 函数定义与 popup.js 保持一致。
 */

import assert from "node:assert/strict";

import {
  fmtDateBasic, fmtDateInput, parseDateInput,
  parseWeeks, parseJcs, buildPeriodMap,
  buildDescription, buildLocation, escapeIcsText,
  foldLine, generateICS, parseApiBase,
} from "./extension/lib.js";

// ─────────────────────────────────────────────────────────────────────────────
// 测试工具
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
/** Promises for async test bodies — awaited before printing summary. */
const _asyncTests = [];

function test(name, fn) {
  let result;
  try {
    result = fn();
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
    return;
  }

  if (result instanceof Promise) {
    _asyncTests.push(
      result.then(
        () => { console.log(`  ✅ ${name}`); passed++; },
        (e) => { console.error(`  ❌ ${name}`); console.error(`     ${e.message}`); failed++; },
      ),
    );
  } else {
    console.log(`  ✅ ${name}`);
    passed++;
  }
}

function suite(name, fn) {
  console.log(`\n▶ ${name}`);
  fn();
}

/** RFC 5545 展开折行：去掉 CRLF + 续行首空格，还原为逻辑行 */
function unfoldIcs(ics) {
  return ics.replace(/\r\n[ \t]/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// 样本数据（基于 ref/ 真实返回值）
// ─────────────────────────────────────────────────────────────────────────────

// 春季作息（xqm=12，探测 2026-04-25 返回）
const RJ_SPRING = [
  { jcmc: "1", qssj: "08:10", jssj: "08:55" },
  { jcmc: "2", qssj: "09:00", jssj: "09:45" },
  { jcmc: "3", qssj: "10:05", jssj: "10:50" },
  { jcmc: "4", qssj: "10:55", jssj: "11:40" },
  { jcmc: "5", qssj: "12:10", jssj: "12:55" },
  { jcmc: "6", qssj: "13:00", jssj: "13:45" },
  { jcmc: "7", qssj: "14:35", jssj: "15:20" },
  { jcmc: "8", qssj: "15:25", jssj: "16:10" },
  { jcmc: "9", qssj: "16:20", jssj: "17:05" },
  { jcmc: "10", qssj: "17:10", jssj: "17:55" },
  { jcmc: "11", qssj: "18:15", jssj: "19:00" },
  { jcmc: "12", qssj: "19:00", jssj: "19:45" },
  { jcmc: "13", qssj: "19:50", jssj: "20:35" },
  { jcmc: "14", qssj: "20:40", jssj: "21:25" },
];

// 秋季作息（xqm=3，探测 2025-10-08 返回，7-10节时间不同）
const RJ_FALL = [
  { jcmc: "1", qssj: "08:10", jssj: "08:55" },
  { jcmc: "2", qssj: "09:00", jssj: "09:45" },
  { jcmc: "3", qssj: "10:05", jssj: "10:50" },
  { jcmc: "4", qssj: "10:55", jssj: "11:40" },
  { jcmc: "5", qssj: "12:10", jssj: "12:55" },
  { jcmc: "6", qssj: "13:00", jssj: "13:45" },
  { jcmc: "7", qssj: "14:55", jssj: "15:40" },
  { jcmc: "8", qssj: "15:45", jssj: "16:30" },
  { jcmc: "9", qssj: "16:40", jssj: "17:25" },
  { jcmc: "10", qssj: "17:30", jssj: "18:15" },
  { jcmc: "11", qssj: "18:15", jssj: "19:00" },
  { jcmc: "12", qssj: "19:00", jssj: "19:45" },
  { jcmc: "13", qssj: "19:50", jssj: "20:35" },
  { jcmc: "14", qssj: "20:40", jssj: "21:25" },
];

// 模拟一门课（基于 ref/ kbList[0]）
const COURSE = {
  kcmc: "大学生心理健康教育",
  xm: "梁海巍",
  cdmc: "厚德楼-104",
  xqmc: "荆东校区",
  xqj: "1", // 周一
  jcs: "1-2",
  zcd: "1-16周",
  xf: "2.0",
  kclb: "公共必修课",
  jxbmc: "(2025-2026-2)-1211102001-20210134-2",
  jxbzc: "25计算机科学与技术1班;25计算机科学与技术2班",
  khfsmc: "未安排",
  xkbz: "",
  kcxszc: "理论:32",
  zhxs: "2",
  zxs: "32",
};

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: parseWeeks
// ─────────────────────────────────────────────────────────────────────────────

suite("parseWeeks — 周次字符串解析", () => {
  test("标准范围 '1-16周'", () => {
    const w = parseWeeks("1-16周");
    assert.equal(w.length, 16);
    assert.equal(w[0], 1);
    assert.equal(w[15], 16);
  });

  test("单一周 '3周'", () => {
    assert.deepEqual(parseWeeks("3周"), [3]);
  });

  test("逗号分隔范围 '1-8,10-16周'", () => {
    const w = parseWeeks("1-8,10-16周");
    assert.equal(w.length, 15);
    assert.ok(!w.includes(9), "不应包含第 9 周");
    assert.ok(
      w.includes(1) && w.includes(8) && w.includes(10) && w.includes(16),
    );
  });

  test("全角逗号 '1-8，10-16周'", () => {
    const w = parseWeeks("1-8，10-16周");
    assert.equal(w.length, 15);
    assert.ok(!w.includes(9));
  });

  test("奇数周 '1-16(单)周'", () => {
    const w = parseWeeks("1-16(单)周");
    assert.equal(w.length, 8);
    assert.ok(
      w.every((x) => x % 2 === 1),
      "应全为奇数",
    );
    assert.deepEqual(w, [1, 3, 5, 7, 9, 11, 13, 15]);
  });

  test("偶数周 '1-16(双)周'", () => {
    const w = parseWeeks("1-16(双)周");
    assert.equal(w.length, 8);
    assert.ok(
      w.every((x) => x % 2 === 0),
      "应全为偶数",
    );
  });

  test("前缀单周 '单1-10周'", () => {
    const w = parseWeeks("单1-10周");
    assert.ok(w.every((x) => x % 2 === 1));
    assert.equal(w.length, 5);
  });

  test("前缀双周 '双2-12周'", () => {
    const w = parseWeeks("双2-12周");
    assert.ok(w.every((x) => x % 2 === 0));
  });

  test("枚举列表 '2,4,6,8周'", () => {
    assert.deepEqual(parseWeeks("2,4,6,8周"), [2, 4, 6, 8]);
  });

  test("空/null/undefined 返回 []", () => {
    assert.deepEqual(parseWeeks(""), []);
    assert.deepEqual(parseWeeks(null), []);
    assert.deepEqual(parseWeeks(undefined), []);
  });

  test("去重", () => {
    const w = parseWeeks("1-4,3-6周");
    assert.equal(w.length, [...new Set(w)].length);
  });

  test("结果始终升序", () => {
    const w = parseWeeks("10-12,1-3周");
    for (let i = 1; i < w.length; i++) assert.ok(w[i] > w[i - 1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: parseJcs
// ─────────────────────────────────────────────────────────────────────────────

suite("parseJcs — 节次字符串解析", () => {
  test("'1-2' → {first:1, last:2}", () =>
    assert.deepEqual(parseJcs("1-2"), { first: 1, last: 2 }));
  test("'3-5' → {first:3, last:5}", () =>
    assert.deepEqual(parseJcs("3-5"), { first: 3, last: 5 }));
  test("'7'   → {first:7, last:7}", () =>
    assert.deepEqual(parseJcs("7"), { first: 7, last: 7 }));
  test("'11-12' → {first:11, last:12}", () =>
    assert.deepEqual(parseJcs("11-12"), { first: 11, last: 12 }));
  test("null/undefined/'' → null", () => {
    assert.equal(parseJcs(null), null);
    assert.equal(parseJcs(undefined), null);
    assert.equal(parseJcs(""), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: buildPeriodMap
// ─────────────────────────────────────────────────────────────────────────────

suite("buildPeriodMap — 节次时间查找表", () => {
  const map = buildPeriodMap(RJ_SPRING);

  test("包含全部 14 节", () => assert.equal(Object.keys(map).length, 14));
  test("第 1 节开始 08:10", () => assert.equal(map["1"].qssj, "08:10"));
  test("第 1 节结束 08:55", () => assert.equal(map["1"].jssj, "08:55"));
  test("第 14 节结束 21:25", () => assert.equal(map["14"].jssj, "21:25"));
  test("空数组 → 空对象", () => assert.deepEqual(buildPeriodMap([]), {}));
  test("缺 qssj/jssj 的条目跳过", () => {
    const m = buildPeriodMap([
      { jcmc: "1", qssj: "08:00" },
      { jcmc: "2", jssj: "09:00" },
      { jcmc: "3", qssj: "10:00", jssj: "10:45" },
    ]);
    assert.ok(!m["1"]);
    assert.ok(!m["2"]);
    assert.ok(m["3"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: buildDescription
// ─────────────────────────────────────────────────────────────────────────────

suite("buildDescription — 事件描述格式", () => {
  const desc = buildDescription(COURSE);

  test("以 '(节次)周次' 开头", () => {
    assert.ok(
      desc.startsWith("(1-2节)1-16周"),
      `实际开头: ${desc.slice(0, 20)}`,
    );
  });

  test("包含校区字段", () => assert.ok(desc.includes("校区:荆东校区")));
  test("包含场地字段", () => assert.ok(desc.includes("场地:厚德楼-104")));
  test("包含教师字段", () => assert.ok(desc.includes("教师:梁海巍")));
  test("包含教学班", () => assert.ok(desc.includes("教学班:(2025-2026-2)")));
  test("包含教学班组成", () =>
    assert.ok(desc.includes("教学班组成:25计算机科学与技术1班")));
  test("包含考核方式", () => assert.ok(desc.includes("考核方式:未安排")));
  test("包含学分", () => assert.ok(desc.includes("学分:2.0")));
  test("用 / 分隔各字段", () => {
    const fields = desc.split("/");
    assert.ok(fields.length >= 10, `字段数应 ≥ 10，实际 ${fields.length}`);
  });

  test("缺失字段显示为空值（不崩溃）", () => {
    const minimal = { jcs: "1-2", zcd: "1-8周" };
    assert.doesNotThrow(() => buildDescription(minimal));
    const d = buildDescription(minimal);
    assert.ok(d.startsWith("(1-2节)1-8周"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5: buildLocation
// ─────────────────────────────────────────────────────────────────────────────

suite("buildLocation — 地点字段", () => {
  test("showCampus=true → 校区·教室", () => {
    assert.equal(buildLocation(COURSE, true), "荆东校区·厚德楼-104");
  });

  test("showCampus=false → 仅教室", () => {
    assert.equal(buildLocation(COURSE, false), "厚德楼-104");
  });

  test("无校区时 showCampus=true 也只显示教室", () => {
    const c = { cdmc: "博学楼-202", xqmc: "" };
    assert.equal(buildLocation(c, true), "博学楼-202");
  });

  test("无教室时返回空字符串", () => {
    assert.equal(buildLocation({}, false), "");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 6: escapeIcsText
// ─────────────────────────────────────────────────────────────────────────────

suite("escapeIcsText — ICS 文本转义", () => {
  test("转义反斜杠", () => assert.equal(escapeIcsText("a\\b"), "a\\\\b"));
  test("转义分号", () => assert.equal(escapeIcsText("a;b"), "a\\;b"));
  test("转义逗号", () => assert.equal(escapeIcsText("a,b"), "a\\,b"));
  test("换行 → \\n", () => assert.equal(escapeIcsText("a\nb"), "a\\nb"));
  test("CRLF → \\n", () => assert.equal(escapeIcsText("a\r\nb"), "a\\nb"));
  test("null/undefined → ''", () => {
    assert.equal(escapeIcsText(null), "");
    assert.equal(escapeIcsText(undefined), "");
  });
  test("中文不被转义", () => {
    const s = "大学生心理健康教育";
    assert.equal(escapeIcsText(s), s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 7: foldLine
// ─────────────────────────────────────────────────────────────────────────────

suite("foldLine — RFC 5545 长行折叠", () => {
  test("短行 ≤75 字节不折叠", () => {
    const l = "SUMMARY:Hello";
    assert.equal(foldLine(l), l);
  });

  test("恰好 75 字节不折叠", () => {
    const l = "A".repeat(75);
    assert.equal(foldLine(l), l);
  });

  test("76 字节触发折叠，续行以空格开头", () => {
    const parts = foldLine("B".repeat(76)).split("\r\n");
    assert.equal(parts.length, 2);
    assert.ok(parts[1].startsWith(" "));
  });

  test("折叠后内容重组等于原始字符串", () => {
    const orig = "SUMMARY:" + "课".repeat(30);
    const recon = foldLine(orig)
      .split("\r\n")
      .map((s, i) => (i === 0 ? s : s.slice(1)))
      .join("");
    assert.equal(recon, orig);
  });

  test("不切断 UTF-8 多字节字符", () => {
    const line = "DESCRIPTION:" + "学".repeat(25);
    const dec = new TextDecoder("utf-8", { fatal: true });
    const enc = new TextEncoder();
    for (const seg of foldLine(line).split("\r\n")) {
      assert.doesNotThrow(() =>
        dec.decode(enc.encode(seg.startsWith(" ") ? seg.slice(1) : seg)),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 8: 日期工具
// ─────────────────────────────────────────────────────────────────────────────

suite("日期格式化工具", () => {
  const d = new Date(2026, 2, 2); // 2026-03-02

  test("fmtDateBasic → 'YYYYMMDD'", () =>
    assert.equal(fmtDateBasic(d), "20260302"));
  test("fmtDateInput → 'YYYY-MM-DD'", () =>
    assert.equal(fmtDateInput(d), "2026-03-02"));
  test("单位数月日补零", () => {
    assert.equal(fmtDateBasic(new Date(2025, 0, 5)), "20250105");
  });

  test("parseDateInput 往返", () => {
    const s = "2026-03-02";
    assert.equal(fmtDateInput(parseDateInput(s)), s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 9: generateICS — 基础（单套作息）
// ─────────────────────────────────────────────────────────────────────────────

suite("generateICS — 基础（单套作息）", () => {
  const pm = buildPeriodMap(RJ_SPRING);
  const termStart = new Date(2026, 2, 2); // 2026-03-02 周一
  const endDate = new Date(2026, 3, 30); // 2026-04-30

  const ics = generateICS([COURSE], pm, null, null, termStart, endDate, false);

  test("以 BEGIN:VCALENDAR 开始", () =>
    assert.ok(ics.startsWith("BEGIN:VCALENDAR")));
  test("以 END:VCALENDAR 结尾", () =>
    assert.ok(ics.trimEnd().endsWith("END:VCALENDAR")));
  test("含时区定义", () => assert.ok(ics.includes("TZID:Asia/Shanghai")));
  test("含 VEVENT", () => assert.ok(ics.includes("BEGIN:VEVENT")));
  test("SUMMARY 含课程名", () =>
    assert.ok(ics.includes("SUMMARY:大学生心理健康教育")));
  test("LOCATION 仅含教室（无校区）", () => {
    assert.ok(ics.includes("LOCATION:厚德楼-104"));
    assert.ok(!ics.includes("荆东校区·厚德楼"));
  });
  test("DESCRIPTION 含新格式", () => assert.ok(ics.includes("(1-2节)1-16周")));
  test("DESCRIPTION 含 / 分隔符", () =>
    assert.ok(ics.includes("场地:厚德楼-104")));
  test("DTSTART 时间正确（第1节 08:10）", () =>
    assert.ok(ics.includes("DTSTART;TZID=Asia/Shanghai:20260302T081000")));
  test("DTEND 时间正确（第2节 09:45）", () =>
    assert.ok(ics.includes("DTEND;TZID=Asia/Shanghai:20260302T094500")));
  test("截至 4/30 生成 9 个事件", () => {
    const count = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
    assert.equal(count, 9, `应为 9，实际 ${count}`);
  });
  test("第 10 周（05/04）不生成", () => assert.ok(!ics.includes("20260504")));
  test("CRLF 行结尾，无裸 LF", () => {
    assert.ok(ics.includes("\r\n"));
    assert.ok(!ics.replace(/\r\n/g, "").includes("\n"));
  });
  test("空 kbList 只有骨架无 VEVENT", () => {
    const e = generateICS([], pm, null, null, termStart, endDate, false);
    assert.ok(!e.includes("BEGIN:VEVENT"));
    assert.ok(e.includes("BEGIN:VCALENDAR"));
  });
  test("节次不存在时跳过不崩溃", () => {
    const bad = { ...COURSE, jcs: "99-100" };
    assert.doesNotThrow(() => {
      const r = generateICS([bad], pm, null, null, termStart, endDate, false);
      assert.ok(!r.includes("BEGIN:VEVENT"));
    });
  });
  test("endDate=null 生成全部 16 周", () => {
    const full = generateICS([COURSE], pm, null, null, termStart, null, false);
    assert.equal((full.match(/BEGIN:VEVENT/g) ?? []).length, 16);
  });
  test("相同课程+日期去重", () => {
    const ics2 = generateICS(
      [COURSE, COURSE],
      pm,
      null,
      null,
      termStart,
      endDate,
      false,
    );
    assert.equal((ics2.match(/BEGIN:VEVENT/g) ?? []).length, 9);
  });
  test("showCampus=true 时 LOCATION 含校区", () => {
    const ics3 = generateICS(
      [COURSE],
      pm,
      null,
      null,
      termStart,
      endDate,
      true,
    );
    assert.ok(ics3.includes("LOCATION:荆东校区·厚德楼-104"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 10: generateICS — 双套作息切换
// ─────────────────────────────────────────────────────────────────────────────
//
// 根源：cxRjc 的节次时间完全由 xqm 决定，rq 参数无效。
//   春季(xqm=12) 全程返回秋冬作息（如下午 14:35）
//   秋季(xqm=3)  全程返回春夏作息（如下午 14:55）
// 正确做法：节前用当前 xqm，节后用另一个 xqm 查到的作息。

suite("generateICS — 双套作息切换", () => {
  // 下午课（第 7-8 节），春秋作息在该节次时间不同
  const PM_COURSE = {
    kcmc: "操作系统",
    xm: "陈老师",
    cdmc: "博学楼-301",
    xqmc: "荆东校区",
    xqj: "3", // 周三
    jcs: "7-8",
    zcd: "1-20周",
    xf: "3.0",
    jxbmc: "(2025-2026-1)-xxx",
    jxbzc: "25计科1班",
    khfsmc: "考试",
    xkbz: "",
    kcxszc: "理论:48",
    zhxs: "3",
    zxs: "48",
  };

  // pm1 = 当前学期作息（秋季查到的 xqm=3  → 14:55，对应 0501-0930 区间）
  // pm2 = 另一学期作息（冬季查到的 xqm=12 → 14:35，对应 1001-0430 区间）
  const pm1 = buildPeriodMap(RJ_FALL);    // 14:55 for period 7（0501-0930）
  const pm2 = buildPeriodMap(RJ_SPRING);  // 14:35 for period 7（1001-0430）

  // 秋冬学期：2025-09-01 起，切换日 2025-10-01（第 5 周周三）
  const termStart = new Date(2025, 8, 1); // 2025-09-01 周一
  const switchDate = new Date(2025, 9, 1); // 2025-10-01
  const endDate30 = new Date(2025, 9, 30); // 2025-10-30

  const ics = generateICS(
    [PM_COURSE],
    pm1,
    pm2,
    switchDate,
    termStart,
    null,
    false,
  );

  test("切换前第 4 周 09/24（周三）使用 pm1 → 14:55", () => {
    // 第4周周三 = 09/01 + 3×7 + 2 = 09/24
    assert.ok(
      ics.includes("20250924T145500"),
      "切换前第7节应为 14:55（0501-0930 作息）",
    );
  });

  test("切换日 10/01（第 5 周周三）起用 pm2 → 14:35", () => {
    // 第5周周三 = 09/01 + 4×7 + 2 = 10/01，switchDate 当天已属 pm2
    assert.ok(
      ics.includes("20251001T143500"),
      "切换日（含）第7节应为 14:35（1001-0430 作息）",
    );
  });

  test("切换后第 6 周 10/08 仍用 pm2 → 14:35", () => {
    assert.ok(ics.includes("20251008T143500"), "切换后第7节应继续用 14:35");
  });

  test("switchDate=null 时全程用 pm1 → 14:55", () => {
    const noSwitch = generateICS(
      [PM_COURSE],
      pm1,
      pm2,
      null,
      termStart,
      endDate30,
      false,
    );
    // 10/01 周三不切换，应仍为 14:55
    assert.ok(
      noSwitch.includes("20251001T145500"),
      "不切换时 10/01 应用 pm1（14:55）",
    );
    assert.ok(!noSwitch.includes("20251001T143500"));
  });

  test("periodMap2=null 时全程用 pm1，不崩溃", () => {
    const noPm2 = generateICS(
      [PM_COURSE],
      pm1,
      null,
      switchDate,
      termStart,
      endDate30,
      false,
    );
    assert.ok(noPm2.includes("20251001T145500"), "无 pm2 时全程应用 pm1");
  });

  test("验证春季场景：xqm=12 节前 14:35，节后改用 xqm=3 的 14:55", () => {
    // 模拟春季学期：2026-03-02 起，五一切换
    const springStart = new Date(2026, 2, 2); // 2026-03-02 周一
    const maySwitchDate = new Date(2026, 4, 1); // 2026-05-01
    // pm1 = xqm=12 → RJ_SPRING (14:35)
    // pm2 = xqm=3  → RJ_FALL   (14:55)
    const springIcs = generateICS(
      [PM_COURSE],
      RJ_SPRING,
      RJ_FALL,
      maySwitchDate,
      springStart,
      null,
      false,
    );
    // wait, buildPeriodMap 接受 rjData 数组，不是直接 pm
    // 重新正确调用
    const spm1 = buildPeriodMap(RJ_SPRING);
    const spm2 = buildPeriodMap(RJ_FALL);
    const ics2 = generateICS(
      [PM_COURSE],
      spm1,
      spm2,
      maySwitchDate,
      springStart,
      null,
      false,
    );
    // 第 8 周周三 = 03/02 + 7×7 + 2 = 04/22（五一前），应为 14:35
    assert.ok(ics2.includes("20260422T143500"), "五一前第7节应为 14:35");
    // 第 9 周周三 = 03/02 + 8×7 + 2 = 04/29（五一前），应为 14:35
    assert.ok(ics2.includes("20260429T143500"), "4/29 仍为 14:35");
    // 第 10 周周三 = 03/02 + 9×7 + 2 = 05/06（五一后），应为 14:55
    assert.ok(ics2.includes("20260506T145500"), "五一后第7节应为 14:55");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 11: 综合冒烟 — 多门课 + 复杂周次
// ─────────────────────────────────────────────────────────────────────────────

suite("综合冒烟 — 多门课 + 复杂周次", () => {
  const courses = [
    { ...COURSE },
    {
      kcmc: "高等数学",
      xm: "王老师",
      cdmc: "博学楼-301",
      xqmc: "荆东校区",
      xqj: "3",
      jcs: "3-4",
      zcd: "1-8,10-16周",
      xf: "4.0",
      jxbmc: "xxx",
      jxbzc: "班级",
      khfsmc: "考试",
      xkbz: "",
      kcxszc: "理论:64",
      zhxs: "4",
      zxs: "64",
    },
    {
      kcmc: "英语听说",
      xm: "李老师",
      cdmc: "外语楼-201",
      xqmc: "荆东校区",
      xqj: "5",
      jcs: "7-8",
      zcd: "1-16(双)周",
      xf: "2.0",
      jxbmc: "yyy",
      jxbzc: "班级",
      khfsmc: "考查",
      xkbz: "",
      kcxszc: "理论:32",
      zhxs: "2",
      zxs: "32",
    },
  ];

  const pm = buildPeriodMap(RJ_SPRING);
  const termStart = new Date(2026, 2, 2); // 2026-03-02
  const endDate = new Date(2026, 3, 30); // 2026-04-30

  const ics = generateICS(courses, pm, null, null, termStart, endDate, true);

  test("三门课都出现在 ICS 中", () => {
    assert.ok(ics.includes("SUMMARY:大学生心理健康教育"));
    assert.ok(ics.includes("SUMMARY:高等数学"));
    assert.ok(ics.includes("SUMMARY:英语听说"));
  });

  test("高等数学第 9 周（04/29 周三）无课", () => {
    // 第9周周三 = 03/02 + 8*7 + 2 = 04/29
    assert.ok(!ics.includes("20260429T100500"), "第9周应无高等数学");
  });

  test("英语听说奇数周（第1周 03/06 周五）不出现", () => {
    assert.ok(!ics.includes("20260306T143500"), "第1周（奇数）不应有英语听说");
  });

  test("英语听说偶数周（第2周 03/13 周五）出现", () => {
    assert.ok(ics.includes("20260313T143500"), "第2周（偶数）应有英语听说");
  });

  test("showCampus=true 时 LOCATION 含校区前缀", () => {
    assert.ok(ics.includes("LOCATION:荆东校区·厚德楼-104"));
  });

  test("DESCRIPTION 包含教学班组成（含分号，被转义）", () => {
    // 分号在 ICS 中应被转义为 \;；先展开折行再搜索
    const unfolded = unfoldIcs(ics);
    assert.ok(
      unfolded.includes("25计算机科学与技术1班\\;25计算机科学与技术2班"),
      "教学班组成中的分号应被转义为 \\;",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseApiBase — API 根路径提取
// ─────────────────────────────────────────────────────────────────────────────

suite("parseApiBase", () => {
  test("fjsmu 带 /jwglxt 前缀", () => {
    assert.equal(
      parseApiBase("https://jwxxt.fjsmu.edu.cn/jwglxt/xtgl/login_slogin.html"),
      "https://jwxxt.fjsmu.edu.cn/jwglxt",
    );
  });

  test("hbfs 无路径前缀", () => {
    assert.equal(
      parseApiBase("http://jwxt1.hbfs.edu.cn/xtgl/login_slogin.html"),
      "http://jwxt1.hbfs.edu.cn",
    );
  });

  test("带查询参数时仍正确提取", () => {
    assert.equal(
      parseApiBase("https://jwxxt.fjsmu.edu.cn/jwglxt/xtgl/login_slogin.html?url=/jwglxt/"),
      "https://jwxxt.fjsmu.edu.cn/jwglxt",
    );
  });

  test("不含登录页后缀时返回 null", () => {
    assert.equal(parseApiBase("https://jwxxt.fjsmu.edu.cn/jwglxt/"), null);
  });

  test("空字符串返回 null", () => {
    assert.equal(parseApiBase(""), null);
  });

  test("null/undefined 返回 null", () => {
    assert.equal(parseApiBase(null), null);
    assert.equal(parseApiBase(undefined), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Worker — OAuth 路由单元测试
// ─────────────────────────────────────────────────────────────────────────────

import worker from "./backend/worker.js";

const MOCK_ENV = {
  GITHUB_CLIENT_ID: "test_client_id",
  GITHUB_CLIENT_SECRET: "test_client_secret",
};

function makeRequest(path) {
  return new Request(`https://worker.example.com${path}`);
}

suite("Worker — GET /oauth/github/authorize", () => {
  test("缺少 ext_id 时返回 400", async () => {
    const resp = await worker.fetch(
      makeRequest("/oauth/github/authorize?state=nonce123"),
      MOCK_ENV,
    );
    assert.equal(resp.status, 400);
  });

  test("缺少 state 时返回 400", async () => {
    const resp = await worker.fetch(
      makeRequest("/oauth/github/authorize?ext_id=abc"),
      MOCK_ENV,
    );
    assert.equal(resp.status, 400);
  });

  test("参数齐全时重定向到 GitHub（302）", async () => {
    const resp = await worker.fetch(
      makeRequest("/oauth/github/authorize?ext_id=myextid&state=randomnonce"),
      MOCK_ENV,
    );
    assert.equal(resp.status, 302);
    const location = resp.headers.get("Location");
    assert.ok(location.startsWith("https://github.com/login/oauth/authorize?"), "应跳转到 GitHub");
    assert.ok(location.includes("client_id=test_client_id"), "应包含 client_id");
    assert.ok(location.includes("scope=gist"), "scope 应为 gist");
  });

  test("state 中编码了 ext_id 和 nonce", async () => {
    const resp = await worker.fetch(
      makeRequest("/oauth/github/authorize?ext_id=myextid&state=randomnonce"),
      MOCK_ENV,
    );
    const location = resp.headers.get("Location");
    const params = new URLSearchParams(new URL(location).search);
    const payload = JSON.parse(atob(params.get("state")));
    assert.equal(payload.ext_id, "myextid");
    assert.equal(payload.nonce, "randomnonce");
  });

  test("redirect_uri 指向 /oauth/github/callback", async () => {
    const resp = await worker.fetch(
      makeRequest("/oauth/github/authorize?ext_id=e&state=s"),
      MOCK_ENV,
    );
    const location = resp.headers.get("Location");
    const params = new URLSearchParams(new URL(location).search);
    assert.ok(
      params.get("redirect_uri").endsWith("/oauth/github/callback"),
      "redirect_uri 应指向 callback 路由",
    );
  });
});

suite("Worker — GET /oauth/github/callback", () => {
  test("缺少 code 时返回 400", async () => {
    const state = btoa(JSON.stringify({ ext_id: "e", nonce: "n" }));
    const resp = await worker.fetch(
      makeRequest(`/oauth/github/callback?state=${encodeURIComponent(state)}`),
      MOCK_ENV,
    );
    assert.equal(resp.status, 400);
  });

  test("缺少 state 时返回 400", async () => {
    const resp = await worker.fetch(
      makeRequest("/oauth/github/callback?code=abc"),
      MOCK_ENV,
    );
    assert.equal(resp.status, 400);
  });

  test("state 格式非法时返回 400", async () => {
    const resp = await worker.fetch(
      makeRequest("/oauth/github/callback?code=abc&state=notvalidbase64!!!"),
      MOCK_ENV,
    );
    assert.equal(resp.status, 400);
  });

  test("GitHub token 交换成功后重定向到 chromiumapp.org", async () => {
    // 用 globalThis.fetch 的临时 mock 模拟 GitHub token 端点
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, _opts) => {
        if (String(url).includes("access_token")) {
          return new Response(
            JSON.stringify({ access_token: "ghp_test_token", token_type: "bearer" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(url, _opts);
      };

      const state = btoa(JSON.stringify({ ext_id: "myextid", nonce: "mynonce" }));
      const resp = await worker.fetch(
        makeRequest(`/oauth/github/callback?code=authcode&state=${encodeURIComponent(state)}`),
        MOCK_ENV,
      );

      assert.equal(resp.status, 302);
      const location = resp.headers.get("Location");
      assert.ok(
        location.startsWith("https://myextid.chromiumapp.org/"),
        "应重定向到 chromiumapp.org",
      );
      const params = new URLSearchParams(new URL(location).search);
      assert.equal(params.get("access_token"), "ghp_test_token", "应携带 access_token");
      assert.equal(params.get("state"), "mynonce", "应携带原始 nonce");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GitHub 返回 error 时回复 400", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, _opts) => {
        if (String(url).includes("access_token")) {
          return new Response(
            JSON.stringify({ error: "bad_verification_code", error_description: "The code passed is incorrect" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(url, _opts);
      };

      const state = btoa(JSON.stringify({ ext_id: "e", nonce: "n" }));
      const resp = await worker.fetch(
        makeRequest(`/oauth/github/callback?code=badcode&state=${encodeURIComponent(state)}`),
        MOCK_ENV,
      );

      assert.equal(resp.status, 400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

suite("Worker — 未知路由", () => {
  test("GET / 返回 404", async () => {
    const resp = await worker.fetch(makeRequest("/"), MOCK_ENV);
    assert.equal(resp.status, 404);
  });

  test("POST /oauth/github/authorize 返回 404", async () => {
    const resp = await worker.fetch(
      new Request("https://worker.example.com/oauth/github/authorize", { method: "POST" }),
      MOCK_ENV,
    );
    assert.equal(resp.status, 404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────────────────────

// Wait for all async test bodies to complete before reporting results.
await Promise.allSettled(_asyncTests);

console.log(`\n${"─".repeat(50)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项测试通过`);
} else {
  console.log(`结果：${passed} 通过，${failed} 失败`);
  process.exit(1);
}
