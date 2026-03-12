/**
 * background.js — 正方教务课表转 ICS 背景服务工作者
 *
 * 职责：
 *   在后台处理 GitHub OAuth 流程，避免 popup 在授权窗口打开时因失去焦点
 *   而被 Chrome 关闭，导致 launchWebAuthFlow 的回调永远无法执行。
 */

"use strict";

const WORKER_ORIGIN = "https://zics-api.zaochih.com";

/**
 * 在背景服务工作者中执行 GitHub OAuth 流程。
 * @param {string} extId  扩展 ID
 * @param {string} nonce  CSRF 防护用随机值
 * @returns {Promise<string>} GitHub 用户名
 */
async function connectGitHub(extId, nonce) {
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GITHUB_AUTH_START") {
    const { extId, nonce } = message;
    connectGitHub(extId, nonce)
      .then((login) => sendResponse({ ok: true, login }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // 保持消息通道以便异步回复
  }
});
