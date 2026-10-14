import { test, expect, type Page } from "@playwright/test";

async function send(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "发送给 Agent 的消息" });
  await expect(input).toBeEnabled();
  await input.fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

async function projectTask(page: Page, name: string) {
  await page.locator(".project-row").filter({ hasText: name }).hover();
  await page.getByRole("button", { name: `在${name}中新建任务`, exact: true }).click();
}

async function menu(page: Page, title: string) {
  await page.locator(".conversation-row").filter({ hasText: title }).first().hover();
  await page.getByRole("button", { name: `${title}的更多操作`, exact: true }).click();
}

test("项目、新建会话、流式响应、多轮、刷新、正文搜索和会话隔离", async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const projectName = `验收项目-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "创建项目", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "创建项目" });
  await dialog.getByLabel("项目名称").fill(projectName);
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await projectTask(page, projectName);
  await send(page, "记住：蓝色鲸鱼");
  const firstReply = "好的，我记住了：蓝色鲸鱼。你可以在这个任务里继续提问。";
  await expect(page.getByText(firstReply, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(firstReply, { exact: true })).toBeVisible();
  await expect(page.getByText(firstReply, { exact: true })).toHaveCount(1);
  await send(page, "之前的关键词是什么？");
  await expect(page.getByText("你之前提到的关键词是蓝色鲸鱼。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "搜索会话", exact: false }).first().click();
  const searchDialog = page.getByRole("dialog", { name: "搜索会话" });
  await searchDialog.getByRole("textbox", { name: "搜索会话标题或消息内容" }).fill("继续提问");
  const result = searchDialog.locator(".search-result").filter({ hasText: projectName });
  await expect(result).toHaveCount(1);
  await result.click();
  await expect(searchDialog).not.toBeVisible();
  await projectTask(page, projectName);
  await send(page, "之前的关键词是什么？");
  await expect(page.getByText("这个会话中没有这个关键词。", { exact: true })).toBeVisible();
  const list = await (await request.get("/api/backend/conversations")).json();
  const projects = await (await request.get("/api/backend/projects")).json();
  const project = projects.find((item: { name: string }) => item.name === projectName);
  const conversations = list.filter((item: { project_id: string }) => item.project_id === project.id);
  expect(conversations).toHaveLength(2);
  const first = conversations.find((item: { title: string }) => item.title.includes("记住"));
  const history = await (await request.get(`/api/backend/conversations/${first.id}/messages`)).json();
  expect(history.filter((item: { role: string }) => item.role === "user")).toHaveLength(2);
  expect(history.filter((item: { role: string }) => item.role === "assistant")).toHaveLength(2);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: "test-results/workspace-chat.png", fullPage: true });
});

test("重命名、置顶、移动及删除清理", async ({ page, request }) => {
  const response = await request.post("/api/backend/conversations", { data: { title: `整理测试-${Date.now()}` } });
  const conversation = await response.json();
  const project = await (await request.post("/api/backend/projects", { data: { name: `整理项目-${Date.now()}` } })).json();
  await page.goto("/");
  await menu(page, conversation.title);
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByRole("dialog", { name: "重命名会话" }).getByLabel("会话名称").fill("已重命名的任务");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await menu(page, "已重命名的任务");
  await page.getByRole("menuitem", { name: "置顶会话", exact: true }).click();
  const pinned = await (await request.get(`/api/backend/conversations/${conversation.id}`)).json();
  expect(pinned.pinned).toBe(true);
  await menu(page, "已重命名的任务");
  await page.getByRole("menuitem", { name: "移动到项目", exact: true }).click();
  await page.getByLabel("目标项目").selectOption(project.id);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const moved = await (await request.get(`/api/backend/conversations/${conversation.id}`)).json();
  expect(moved.project_id).toBe(project.id);
  await menu(page, "已重命名的任务");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
  await expect(page.getByRole("button", { name: "已重命名的任务的更多操作", exact: true })).not.toBeVisible();
  expect((await request.get(`/api/backend/conversations/${conversation.id}`)).status()).toBe(404);
  expect((await request.delete(`/api/backend/conversations/${conversation.id}`)).status()).toBe(204);
});

test("手机布局与搜索快捷键", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "展开侧栏", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await expect(page.getByRole("button", { name: "搜索会话", exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "搜索会话" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "搜索会话" })).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/workspace-mobile.png", fullPage: true });
});

test("停止生成、运行中删除保护与模型错误提示", async ({ page, request }) => {
  const conversation = await (await request.post("/api/backend/conversations", { data: { title: `停止测试-${Date.now()}` } })).json();
  await page.goto("/");
  await page.locator(".conversation-select").filter({ hasText: conversation.title }).click();
  await send(page, "请慢速回复，用于测试停止");
  const stop = page.getByRole("button", { name: "停止生成", exact: true });
  await expect(stop).toBeVisible();
  // isRunning is optimistic while the HTTP request is being scheduled.
  // A received delta proves the backend run has actually acquired its lock.
  await expect(page.getByText(/这是用于验证停止按钮/).first()).toBeVisible();
  const busyDelete = await request.delete(`/api/backend/conversations/${conversation.id}`);
  expect(busyDelete.status()).toBe(409);
  await stop.click();
  await expect(stop).not.toBeVisible();
  await send(page, "继续正常回复");
  await expect(page.getByText("我已收到你的任务。我们可以先整理目标，再拆分步骤，逐项完成。", { exact: true })).toBeVisible();
  await send(page, "触发错误");
  await expect(page.getByRole("status")).toContainText(/DeepSeek|Agent/);
  await expect(stop).not.toBeVisible();
  await send(page, "再次正常回复");
  await expect(page.getByText("我已收到你的任务。我们可以先整理目标，再拆分步骤，逐项完成。", { exact: true })).toHaveCount(2);
});
