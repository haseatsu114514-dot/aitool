import { runCommand, parseJsonOutput, truncate, normalizeWhitespace } from "../utils.js";

const BROWSERS = [
  { appName: "Google Chrome", type: "chromium" },
  { appName: "Arc", type: "chromium" },
  { appName: "Safari", type: "safari" },
];

const SITE_RULES = [
  { match: /chatgpt\.com$|chat\.openai\.com$/i, provider: "ChatGPT", siteName: "OpenAI" },
  { match: /claude\.ai$/i, provider: "Claude", siteName: "Anthropic" },
  { match: /gemini\.google\.com$/i, provider: "Gemini", siteName: "Google" },
  { match: /notebooklm\.google\.com$/i, provider: "NotebookLM", siteName: "Google" },
  { match: /genspark\.ai$|genspark\.im$|gemspark\.ai$|gemspark\.im$/i, provider: "Genspark", siteName: "Genspark" },
  { match: /perplexity\.ai$/i, provider: "Perplexity", siteName: "Perplexity" },
  { match: /copilot\.microsoft\.com$/i, provider: "Copilot", siteName: "Microsoft" },
  { match: /grok\.com$/i, provider: "Grok", siteName: "xAI" },
  { match: /deepseek\.com$/i, provider: "DeepSeek", siteName: "DeepSeek" },
];

function buildChromiumScript(appName) {
  return [
    `const app = Application(${JSON.stringify(appName)});`,
    "if (!app.running()) {",
    '  "[]"',
    "} else {",
    "  const tabs = [];",
    "  app.windows().forEach((windowRef, windowIndex) => {",
    "    let activeTabIndex = 0;",
    "    try { activeTabIndex = windowRef.activeTabIndex(); } catch (error) {}",
    "    windowRef.tabs().forEach((tabRef, tabIndex) => {",
    "      tabs.push({",
    "        window: windowIndex + 1,",
    "        index: tabIndex + 1,",
    "        active: activeTabIndex === tabIndex + 1,",
    "        title: tabRef.name(),",
    "        url: tabRef.url()",
    "      });",
    "    });",
    "  });",
    "  JSON.stringify(tabs)",
    "}",
  ].join("\n");
}

function buildSafariScript() {
  return [
    'const app = Application("Safari");',
    "if (!app.running()) {",
    '  "[]"',
    "} else {",
    "  const tabs = [];",
    "  app.windows().forEach((windowRef, windowIndex) => {",
    "    let currentName = '';",
    "    try { currentName = windowRef.currentTab().name(); } catch (error) {}",
    "    windowRef.tabs().forEach((tabRef, tabIndex) => {",
    "      const title = tabRef.name();",
    "      tabs.push({",
    "        window: windowIndex + 1,",
    "        index: tabIndex + 1,",
    "        active: title === currentName,",
    "        title,",
    "        url: tabRef.url()",
    "      });",
    "    });",
    "  });",
    "  JSON.stringify(tabs)",
    "}",
  ].join("\n");
}

function detectSite(url, title) {
  try {
    const hostname = new URL(url).hostname;
    const matched = SITE_RULES.find((rule) => rule.match.test(hostname));
    if (matched) {
      return matched;
    }
  } catch {
    // ignore invalid URLs
  }

  if (/antigravity/i.test(url) || /antigravity/i.test(title)) {
    return {
      provider: "Antigravity Web",
      siteName: "Antigravity",
    };
  }

  if (/genspark|gemspark/i.test(url) || /genspark|gemspark/i.test(title)) {
    return {
      provider: "Genspark",
      siteName: "Genspark",
    };
  }

  return null;
}

function buildBrowserSummary(site, tab) {
  const activeLabel = tab.isDisplayed ? "表示しています" : "開いたままです";

  if (site.provider === "NotebookLM") {
    return `NotebookLM のノートを ${activeLabel}。`;
  }

  if (site.provider === "Gemini") {
    return `Gemini の会話画面を ${activeLabel}。`;
  }

  if (site.provider === "Genspark") {
    return `Genspark の作業ページを ${activeLabel}。`;
  }

  return `${site.siteName} のAIページを ${activeLabel}。`;
}

function cleanTitle(title, provider) {
  return normalizeWhitespace(
    String(title || "")
      .replace(/\s*[-|]\s*(ChatGPT|Claude|Gemini|NotebookLM|Genspark|Perplexity|Copilot|Grok|DeepSeek)\s*$/i, "")
      .replace(/^NotebookLM$/i, "NotebookLM のノート")
      .replace(/^Google Gemini$/i, "Gemini の会話")
      .replace(/^ChatGPT$/i, "会話を開いています"),
  ) || `${provider} を開いています`;
}

function normalizeBrowserUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    const search = parsed.search || "";
    return `${parsed.hostname}${pathname}${search}`;
  } catch {
    return normalizeWhitespace(String(rawUrl || ""));
  }
}

function stableTabKey(browserAppName, siteProvider, tab) {
  const normalizedUrl = normalizeBrowserUrl(tab.url);
  if (normalizedUrl) {
    return `${browserAppName}:${siteProvider}:${normalizedUrl}`;
  }

  const windowIndex = Number(tab.window) || 0;
  const tabIndex = Number(tab.index) || 0;
  return `${browserAppName}:${siteProvider}:${windowIndex}:${tabIndex}`;
}

function shouldReplaceBrowserSession(current, next) {
  if (!current) {
    return true;
  }

  if (Boolean(next.frontmost) !== Boolean(current.frontmost)) {
    return Boolean(next.frontmost);
  }

  if ((next.statusKey === "viewing") !== (current.statusKey === "viewing")) {
    return next.statusKey === "viewing";
  }

  if ((next.browserWindow || 999) !== (current.browserWindow || 999)) {
    return (next.browserWindow || 999) < (current.browserWindow || 999);
  }

  if ((next.browserTab || 999) !== (current.browserTab || 999)) {
    return (next.browserTab || 999) < (current.browserTab || 999);
  }

  return String(next.taskTitle || "").length > String(current.taskTitle || "").length;
}

export async function collectBrowserSessions(systemState = null) {
  const dedupedSessions = new Map();
  const warnings = [];

  await Promise.all(
    BROWSERS.map(async (browser) => {
      try {
        const script =
          browser.type === "safari" ? buildSafariScript() : buildChromiumScript(browser.appName);
        const { stdout } = await runCommand("osascript", ["-l", "JavaScript", "-e", script], {
          timeout: 4000,
        });
        const tabs = parseJsonOutput(stdout, []);

        for (const tab of tabs) {
          const site = detectSite(tab.url, tab.title);
          if (!site) {
            continue;
          }

          const isDisplayed = Boolean(systemState?.appStates?.[browser.appName]?.frontmost) && tab.active && tab.window === 1;

          const session = {
            id: `browser:${stableTabKey(browser.appName, site.provider, tab)}`,
            provider: site.provider,
            source: `${browser.appName} タブ`,
            sourceType: "browser",
            appName: browser.appName,
            browserWindow: Number(tab.window) || null,
            browserTab: Number(tab.index) || null,
            taskTitle: cleanTitle(tab.title, site.provider),
            summary: truncate(buildBrowserSummary(site, { ...tab, isDisplayed }), 80),
            workspace: null,
            url: tab.url || null,
            statusKey: isDisplayed ? "viewing" : "idle",
            statusLabel: isDisplayed ? "表示中" : "開いたまま",
            startedAt: null,
            lastActiveAt: isDisplayed ? Date.now() : null,
            cpu: null,
            frontmost: Boolean(isDisplayed),
          };

          const existing = dedupedSessions.get(session.id);
          if (shouldReplaceBrowserSession(existing, session)) {
            dedupedSessions.set(session.id, session);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("Application can't be found")) {
          return;
        }
        warnings.push(`${browser.appName} のタブ情報を取れませんでした。`);
      }
    }),
  );

  return { sessions: [...dedupedSessions.values()], warnings };
}
