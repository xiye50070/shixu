import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// Run through scripts/test-e2e.sh so all traffic stays inside the disposable
// backend/database and local model fixture. These checks never send a chat message.
test.beforeEach(async ({ baseURL }) => {
  expect(new URL(baseURL ?? "").port, "Use the isolated test service, not the user's 3210 Demo").toBe("3211");
});

async function conversationFixture(request: APIRequestContext, title: string) {
  const response = await request.post("/api/backend/conversations", { data: { title } });
  expect(response.ok()).toBe(true);
  return await response.json() as { id: string; title: string };
}

async function expectFocusInside(container: Locator) {
  await expect.poll(() => container.evaluate((element) => element.contains(document.activeElement))).toBe(true);
}

async function openSearch(page: Page) {
  await page.getByRole("button", { name: "搜索会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "搜索会话", exact: true });
  await expect(dialog).toBeVisible();
  return { dialog, input: dialog.getByRole("textbox", { name: "搜索会话标题或消息内容" }) };
}

test("会话菜单支持方向键、首尾键及 Escape 还焦", async ({ page, request }) => {
  const conversation = await conversationFixture(request, `菜单键盘验收-${Date.now()}`);
  try {
    await page.goto("/");
    const trigger = page.getByRole("button", { name: `${conversation.title}的更多操作`, exact: true });
    await trigger.click();
    const menu = page.getByRole("menu", { name: `${conversation.title}的更多操作`, exact: true });
    const rename = menu.getByRole("menuitem", { name: "重命名", exact: true });
    const pin = menu.getByRole("menuitem", { name: "置顶会话", exact: true });
    const remove = menu.getByRole("menuitem", { name: "删除会话", exact: true });
    await expect(rename).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(pin).toBeFocused();
    await page.keyboard.press("End");
    await expect(remove).toBeFocused();
    await page.keyboard.press("Home");
    await expect(rename).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(remove).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(rename).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(trigger).toBeFocused();
  } finally {
    await request.delete(`/api/backend/conversations/${conversation.id}`);
  }
});

test("原生项目弹窗限制 Tab 焦点并在关闭后还焦", async ({ page }) => {
  await page.goto("/");
  const trigger = page.locator(".projects-heading").getByRole("button", { name: "创建项目", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "创建项目", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("项目名称")).toBeFocused();
  await dialog.getByLabel("项目名称").fill("键盘验收草稿，不提交");
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    await expectFocusInside(dialog);
  }
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Shift+Tab");
    await expectFocusInside(dialog);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("搜索在输入法组合期间不请求，提交组合后才查询", async ({ page }) => {
  const queries: string[] = [];
  await page.route("**/api/backend/search?*", async (route) => {
    queries.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto("/");
  const { dialog, input } = await openSearch(page);
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.fill("拾序组合输入");
  // Observe beyond the search debounce window; no real model traffic is involved.
  await page.waitForTimeout(600);
  expect(queries).toEqual([]);
  await input.dispatchEvent("compositionend", { data: "拾序组合输入" });
  await expect.poll(() => queries).toEqual(["拾序组合输入"]);
  await expect(dialog.getByText("没有找到匹配的会话", { exact: true })).toBeVisible();
  const reopenedQuery = `组合中快捷键重开-${Date.now()}`;
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.fill(reopenedQuery);
  await page.waitForTimeout(600);
  expect(queries).toEqual(["拾序组合输入"]);
  await page.keyboard.press("Control+k");
  await expect(dialog).not.toBeVisible();
  // Closing cancels composition: no compositionend event arrives from the
  // removed input, so reopening must clear the old IME guard itself.
  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue(reopenedQuery);
  await expect.poll(() => queries).toEqual(["拾序组合输入", reopenedQuery]);
  await expect(dialog.getByText("没有找到匹配的会话", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("新搜索等待响应时不呈现上一个查询的结果", async ({ page, request }) => {
  const token = Date.now();
  const firstQuery = `旧结果验收-${token}`;
  const nextQuery = `新结果验收-${token}`;
  const first = await conversationFixture(request, firstQuery);
  const next = await conversationFixture(request, nextQuery);
  let delayedRequestReceived = false;
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/backend/search?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === nextQuery) {
      delayedRequestReceived = true;
      await responseGate;
    }
    await route.continue();
  });
  try {
    await page.goto("/");
    const { dialog, input } = await openSearch(page);
    await input.fill(firstQuery);
    await expect(dialog.locator(".search-result").filter({ hasText: first.title })).toHaveCount(1);
    await input.fill(nextQuery);
    await expect.poll(() => delayedRequestReceived).toBe(true);
    await expect(dialog.getByText("正在搜索…", { exact: true })).toBeVisible();
    await expect(dialog.locator(".search-result")).toHaveCount(0);
    releaseResponse();
    await expect(dialog.locator(".search-result").filter({ hasText: next.title })).toHaveCount(1);
    await expect(dialog.locator(".search-result").filter({ hasText: first.title })).toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    releaseResponse();
    await request.delete(`/api/backend/conversations/${first.id}`);
    await request.delete(`/api/backend/conversations/${next.id}`);
  }
});

test("390px 导航抽屉聚焦、隔离背景、限制 Tab 并在 Escape 后还焦", async ({ page, request }) => {
  const conversation = await conversationFixture(request, `抽屉菜单验收-${Date.now()}`);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const opener = page.getByRole("button", { name: "展开侧栏", exact: true });
    await opener.click();
    const drawer = page.getByRole("dialog", { name: "工作空间导航", exact: true });
    const close = drawer.getByRole("button", { name: "收起侧栏", exact: true });
    const main = page.locator(".main-panel");
    await expect(drawer).toBeVisible();
    await expect(close).toBeFocused();
    await expect(main).toHaveJSProperty("inert", true);
    // Programmatic focus also cannot escape into the inert chat/background area.
    await opener.evaluate((element) => element.focus());
    await expect(close).toBeFocused();
    const menuTrigger = drawer.getByRole("button", { name: `${conversation.title}的更多操作`, exact: true });
    await menuTrigger.click();
    // The menu's portal stays under the modal drawer, preserving its accessible
    // keyboard scope while the rest of the workspace is inert.
    const menu = drawer.getByRole("menu", { name: `${conversation.title}的更多操作`, exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "重命名", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(drawer).toBeVisible();
    await expect(menuTrigger).toBeFocused();
    await expect(main).toHaveJSProperty("inert", true);
    const first = drawer.locator("button:not([disabled])").first();
    const last = drawer.locator("button:not([disabled])").last();
    await last.focus();
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Tab");
      await expectFocusInside(drawer);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "工作空间导航", exact: true })).toHaveCount(0);
    await expect(main).toHaveJSProperty("inert", false);
    await expect(page.locator(".sidebar")).toHaveJSProperty("inert", true);
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAttribute("aria-expanded", "false");
  } finally {
    await request.delete(`/api/backend/conversations/${conversation.id}`);
  }
});
