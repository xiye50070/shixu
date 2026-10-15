import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

type ModelSettings = {
  provider: "deepseek" | "openai";
  model: string;
  base_url: string;
  max_output_tokens: number;
  api_key_configured: boolean;
  source: "environment" | "saved";
};

const settingsEndpoint = "/api/backend/settings/model";
const fixtureKey = "test-placeholder";
const openAIReply = "这是 OpenAI 兼容模型的测试回复，新的模型配置已经生效。";

async function currentSettings(request: APIRequestContext) {
  const response = await request.get(settingsEndpoint);
  expect(response.ok()).toBe(true);
  const settings = await response.json() as ModelSettings;
  // Fail before any model call if this spec is accidentally aimed at a real
  // Demo or if the isolated launcher has stopped overriding provider settings.
  expect(new URL(settings.base_url).origin).toBe("http://127.0.0.1:18965");
  expect(settings).not.toHaveProperty("api_key");
  expect(JSON.stringify(settings)).not.toContain(fixtureKey);
  return settings;
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型配置", exact: true })).toBeVisible();
  await expect(page.getByLabel("模型名称", { exact: true })).toBeEnabled();
}

async function send(page: Page, message: string) {
  const input = page.getByRole("textbox", { name: "发送给 Agent 的消息" });
  await expect(input).toBeEnabled();
  await input.fill(message);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

test.beforeEach(async ({ baseURL, request }) => {
  expect(new URL(baseURL ?? "").port, "Run through scripts/test-e2e.sh against the disposable services").toBe("3211");
  await currentSettings(request);
});

test("模型配置：密钥隐藏、测试不保存、切换协议后真实流式生效且刷新保留历史", async ({ page, request }, testInfo) => {
  const baseline = await currentSettings(request);
  expect(baseline.provider).toBe("deepseek");
  expect(baseline.api_key_configured).toBe(true);
  const created = await request.post("/api/backend/conversations", { data: { title: `模型配置验收-${Date.now()}` } });
  expect(created.ok()).toBe(true);
  const conversation = await created.json() as { id: string; title: string };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto("/");
    await page.locator(".conversation-select").filter({ hasText: conversation.title }).click();
    await send(page, "记住：蓝色鲸鱼");
    const previousReply = "好的，我记住了：蓝色鲸鱼。你可以在这个任务里继续提问。";
    await expect(page.getByText(previousReply, { exact: true })).toBeVisible();

    await openSettings(page);
    await expect(page.getByRole("button", { name: "模型配置", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "DeepSeek", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue(baseline.model);
    const keyInput = page.getByLabel("API Key", { exact: true });
    await expect(keyInput).toHaveAttribute("type", "password");
    await expect(keyInput).toHaveValue("");
    const metrics = await page.getByTestId("model-settings").evaluate((element) => {
      const numberStyle = (selector: string, property: "height" | "width" | "borderRadius" | "fontSize") => {
        const target = element.querySelector(selector);
        if (!target) throw new Error(`Missing settings metrics target: ${selector}`);
        return Number.parseFloat(getComputedStyle(target)[property]);
      };
      return {
        inputHeight: numberStyle("#model-name", "height"),
        buttonHeight: numberStyle(".model-form-actions .primary-button", "height"),
        sidebarWidth: numberStyle(".settings-sidebar", "width"),
        topbarHeight: numberStyle(".settings-topbar", "height"),
        cardRadius: numberStyle(".model-settings-card", "borderRadius"),
        inputFontSize: numberStyle("#model-name", "fontSize"),
      };
    });
    await testInfo.attach("model-settings-metrics", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
    expect(metrics).toEqual({ inputHeight: 40, buttonHeight: 40, sidebarWidth: 260, topbarHeight: 56, cardRadius: 30, inputFontSize: 14 });

    await page.getByRole("button", { name: "OpenAI 兼容", exact: true }).click();
    await page.getByLabel("模型名称", { exact: true }).fill("fixture-openai");
    await page.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:18965/v1");
    await keyInput.fill(fixtureKey);
    const tested = page.waitForResponse((response) => response.url().endsWith(`${settingsEndpoint}/test`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    const testResponse = await tested;
    expect(testResponse.ok()).toBe(true);
    const testResult = await testResponse.json() as { ok: boolean; message: string };
    expect(testResult.ok).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: testResult.message })).toBeVisible();
    // A successful probe is a draft check; it must not alter the Agent's active model.
    expect(await currentSettings(request)).toEqual(baseline);

    const saved = page.waitForResponse((response) => response.url().endsWith(settingsEndpoint) && response.request().method() === "PUT");
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(keyInput).toHaveValue("");
    const active = await currentSettings(request);
    expect(active).toMatchObject({ provider: "openai", model: "fixture-openai", base_url: "http://127.0.0.1:18965/v1", source: "saved", api_key_configured: true });

    await page.reload();
    await openSettings(page);
    await expect(page.getByRole("button", { name: "OpenAI 兼容", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue("fixture-openai");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
    await page.screenshot({ path: "test-results/model-settings-desktop.png", fullPage: true });
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    await expect(page.getByText(previousReply, { exact: true })).toBeVisible();
    await send(page, "请确认使用新模型回复");
    await expect(page.getByText(openAIReply, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(previousReply, { exact: true })).toBeVisible();
    await expect(page.getByText(openAIReply, { exact: true })).toBeVisible();
    const history = await (await request.get(`/api/backend/conversations/${conversation.id}/messages`)).json() as { role: string; content: string }[];
    expect(history.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual([previousReply, openAIReply]);

    await openSettings(page);
    await page.getByLabel("模型名称", { exact: true }).fill("unsaved-draft-model");
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    const discard = page.getByRole("dialog", { name: "放弃未保存的更改？", exact: true });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue("unsaved-draft-model");
    await page.getByRole("button", { name: "返回工作区", exact: true }).click();
    await discard.getByRole("button", { name: "放弃更改", exact: true }).click();
    expect(await currentSettings(request)).toEqual(active);
    expect(pageErrors).toEqual([]);
  } finally {
    // The suite shares one disposable backend. Always restore the known local
    // DeepSeek fixture so existing conversation/stop/error tests remain valid.
    const restored = await request.put(settingsEndpoint, {
      data: { provider: baseline.provider, model: baseline.model, base_url: baseline.base_url, max_output_tokens: baseline.max_output_tokens, api_key: fixtureKey },
    });
    expect(restored.ok(), "Restore the original local fixture model after this spec").toBe(true);
    await request.delete(`/api/backend/conversations/${conversation.id}`);
  }
});

test("390px 模型配置布局与键盘访问", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await openSettings(page);
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "DeepSeek", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "OpenAI 兼容", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const name of ["测试连接", "保存配置"]) {
    const action = page.getByRole("button", { name, exact: true });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport();
  }
  await page.screenshot({ path: "test-results/model-settings-mobile.png", fullPage: true });
  const helpTrigger = page.getByRole("button", { name: "模型配置帮助", exact: true });
  await helpTrigger.click();
  const helpDialog = page.getByRole("dialog", { name: "配置模型", exact: true });
  await expect(helpDialog).toBeVisible();
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press("Tab");
    expect(await helpDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(helpDialog).not.toBeVisible();
  await expect(helpTrigger).toBeFocused();

  await page.setViewportSize({ width: 720, height: 480 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const name of ["测试连接", "保存配置"]) {
    const action = page.getByRole("button", { name, exact: true });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport();
  }
  await page.screenshot({ path: "test-results/model-settings-short.png", fullPage: true });
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  const opener = page.getByRole("button", { name: "展开侧栏", exact: true });
  await expect(opener).toBeVisible();
  await expect(opener).toBeFocused();
});
