import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type Project = { id: string; name: string; workspace_path: string };
type Conversation = { id: string; title: string; project_id: string | null; pinned: boolean };
let fixtureRoot: string;

async function createProject(request: APIRequestContext, name: string, workspacePath: string) {
  const response = await request.post("/api/backend/projects", { data: { name, workspace_path: workspacePath } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Project>;
}

async function createConversation(request: APIRequestContext, project: Project, title: string) {
  const response = await request.post("/api/backend/conversations", { data: { title, project_id: project.id } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Conversation>;
}

async function openConversation(page: Page, conversation: Conversation) {
  await page.goto("/");
  await page.locator(".conversation-select").filter({ hasText: conversation.title }).click();
  await expect(page.getByRole("textbox", { name: "发送给 Agent 的消息" })).toBeEnabled();
}

async function send(page: Page, message: string, reply: string) {
  await page.getByRole("textbox", { name: "发送给 Agent 的消息" }).fill(message);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止生成", exact: true })).not.toBeVisible();
}

async function openProjectMenu(page: Page, project: Project) {
  const trigger = page.getByRole("button", { name: `${project.name}的项目操作`, exact: true });
  await page.locator(".project-row").filter({ hasText: project.name }).hover();
  await trigger.click();
  const menu = page.getByRole("menu", { name: `${project.name}的项目操作`, exact: true });
  await expect(menu).toBeVisible();
  return { trigger, menu };
}

async function requestDeletion(page: Page, project: Project) {
  const { menu } = await openProjectMenu(page, project);
  await menu.getByRole("menuitem", { name: "删除项目", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "删除项目", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function projectList(request: APIRequestContext) {
  return (await request.get("/api/backend/projects")).json() as Promise<Project[]>;
}

test.beforeEach(async ({ baseURL, request }) => {
  expect(new URL(baseURL ?? "").port, "Only run against the isolated launcher").toBe("3211");
  const model = await (await request.get("/api/backend/settings/model")).json() as { base_url: string };
  expect(new URL(model.base_url).origin).toBe("http://127.0.0.1:18965");
  expect(process.env.WORKSPACE_E2E_ROOT).toBeTruthy();
  fixtureRoot = await realpath(process.env.WORKSPACE_E2E_ROOT!);
  expect(path.basename(fixtureRoot)).toMatch(/^agent-workspace-e2e\./);
  expect(await realpath(process.env.WORKSPACE_DATA_DIR!)).toBe(path.join(fixtureRoot, "data"));
});

test("取消不删除；确认只移除项目，多会话历史、置顶、授权和磁盘文件保留，当前会话转用默认目录", async ({ page, request }) => {
  test.setTimeout(90000);
  const token = Date.now();
  const projectRoot = path.join(fixtureRoot, `delete-project-${token}`);
  await mkdir(projectRoot);
  const physicalFile = path.join(projectRoot, "项目删除后保留.txt");
  const fileContent = "这是项目目录里的独立磁盘文件，删除项目不能删除它。\n";
  await writeFile(physicalFile, fileContent, "utf8");
  const project = await createProject(request, `项目删除保留验收-${token}`, projectRoot);
  const first = await createConversation(request, project, `保留历史A-${token}`);
  const second = await createConversation(request, project, `保留历史B-${token}`);
  const firstReply = "好的，我记住了：蓝色鲸鱼。你可以在这个任务里继续提问。";
  const secondReply = "我已收到你的任务。我们可以先整理目标，再拆分步骤，逐项完成。";
  let deleteRequests = 0;
  page.on("request", (item) => { if (item.method() === "DELETE" && item.url().endsWith(`/api/backend/projects/${project.id}`)) deleteRequests += 1; });
  try {
    await openConversation(page, first);
    await send(page, "记住：蓝色鲸鱼", firstReply);
    await openConversation(page, second);
    await send(page, "用于验证第二条会话历史保留", secondReply);
    expect((await request.patch(`/api/backend/conversations/${first.id}`, { data: { pinned: true } })).ok()).toBe(true);
    const grant = await request.post(`/api/backend/conversations/${first.id}/grants`, { data: { path: path.join(fixtureRoot, "external", "source.txt"), access: "read" } });
    expect(grant.ok()).toBe(true);
    const firstHistory = await (await request.get(`/api/backend/conversations/${first.id}/messages`)).json();
    const secondHistory = await (await request.get(`/api/backend/conversations/${second.id}/messages`)).json();
    const originalWorkspace = await (await request.get(`/api/backend/conversations/${first.id}/workspace`)).json();
    const defaultSettings = await (await request.get("/api/backend/settings/workspace")).json() as { default_workspace_path: string };
    await openConversation(page, first);
    await expect(page.getByText(firstReply, { exact: true })).toBeVisible();

    let dialog = await requestDeletion(page, project);
    expect(deleteRequests).toBe(0);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(deleteRequests).toBe(0);
    expect((await projectList(request)).some((item) => item.id === project.id)).toBe(true);
    expect(await readFile(physicalFile, "utf8")).toBe(fileContent);

    dialog = await requestDeletion(page, project);
    await page.screenshot({ path: "test-results/project-delete-confirm.png", fullPage: true });
    const deleted = page.waitForResponse((item) => item.request().method() === "DELETE" && item.url().endsWith(`/api/backend/projects/${project.id}`));
    await dialog.getByRole("button", { name: "删除项目", exact: true }).click();
    expect((await deleted).status()).toBe(204);
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".project-row").filter({ hasText: project.name })).toHaveCount(0);
    expect(deleteRequests).toBe(1);
    expect((await projectList(request)).some((item) => item.id === project.id)).toBe(false);
    for (const conversation of [first, second]) {
      const saved = await (await request.get(`/api/backend/conversations/${conversation.id}`)).json() as Conversation;
      expect(saved.project_id).toBeNull();
      expect(saved.pinned).toBe(conversation.id === first.id);
    }
    expect(await (await request.get(`/api/backend/conversations/${first.id}/messages`)).json()).toEqual(firstHistory);
    expect(await (await request.get(`/api/backend/conversations/${second.id}/messages`)).json()).toEqual(secondHistory);
    const changedWorkspace = await (await request.get(`/api/backend/conversations/${first.id}/workspace`)).json();
    expect(changedWorkspace).toMatchObject({ available: true, kind: "default", project_id: null, root_dir: defaultSettings.default_workspace_path, grants: originalWorkspace.grants });
    await expect(page.locator('.conversation-select[aria-current="page"]')).toHaveAttribute("title", first.title);
    await expect(page.getByText(firstReply, { exact: true })).toBeVisible();
    await expect(page.locator(".conversation-cwd")).toContainText(defaultSettings.default_workspace_path);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("agent-workspace-active-thread"))).toBe(first.id);
    expect(await readFile(physicalFile, "utf8")).toBe(fileContent);
    await page.screenshot({ path: "test-results/project-deleted.png", fullPage: true });
    await page.reload();
    await expect(page.getByText(firstReply, { exact: true })).toBeVisible();
    await expect(page.locator(".conversation-cwd")).toContainText(defaultSettings.default_workspace_path);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("agent-workspace-active-thread"))).toBe(first.id);
    await page.locator(".conversation-select").filter({ hasText: second.title }).click();
    await expect(page.getByText(secondReply, { exact: true })).toBeVisible();
    expect(await readFile(physicalFile, "utf8")).toBe(fileContent);
  } finally {
    for (const conversation of [first, second]) await request.delete(`/api/backend/conversations/${conversation.id}`);
    await request.delete(`/api/backend/projects/${project.id}`);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("390px 项目菜单支持键盘和44px触控，删除错误留在确认表单并可重试", async ({ page, request }) => {
  const token = Date.now();
  const project = await createProject(request, `手机项目删除-${token}`, path.join(fixtureRoot, "project-a"));
  const conversation = await createConversation(request, project, `手机项目会话-${token}`);
  const deleteEndpoint = `**/api/backend/projects/${project.id}`;
  try {
    await openConversation(page, conversation);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    const { trigger, menu } = await openProjectMenu(page, project);
    const remove = menu.getByRole("menuitem", { name: "删除项目", exact: true });
    await expect(remove).toBeFocused();
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      await page.keyboard.press(key);
      await expect(remove).toBeFocused();
    }
    const triggerSize = await trigger.boundingBox();
    const itemSize = await remove.boundingBox();
    expect(triggerSize!.width).toBeGreaterThanOrEqual(44);
    expect(triggerSize!.height).toBeGreaterThanOrEqual(44);
    expect(itemSize!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(trigger).toBeFocused();
    let failedDeletes = 0;
    await page.route(deleteEndpoint, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      failedDeletes += 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "测试：项目暂时无法删除，请重试" }) });
    });
    await trigger.click();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "删除项目", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "删除项目", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("项目暂时无法删除");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    expect(failedDeletes).toBe(1);
    expect((await projectList(request)).some((item) => item.id === project.id)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await page.unroute(deleteEndpoint);
    const deleted = page.waitForResponse((item) => item.request().method() === "DELETE" && item.url().endsWith(`/api/backend/projects/${project.id}`));
    await dialog.getByRole("button", { name: "删除项目", exact: true }).click();
    expect((await deleted).status()).toBe(204);
    await expect(dialog).not.toBeVisible();
    expect((await projectList(request)).some((item) => item.id === project.id)).toBe(false);
    expect((await (await request.get(`/api/backend/conversations/${conversation.id}`)).json()).project_id).toBeNull();
  } finally {
    await page.unroute(deleteEndpoint);
    await request.delete(`/api/backend/conversations/${conversation.id}`);
    await request.delete(`/api/backend/projects/${project.id}`);
  }
});

test("排队阶段的项目会话阻止删除，其他项目排队不阻止删除当前项目", async ({ request }) => {
  const token = Date.now();
  const first = await createProject(request, `排队项目A-${token}`, path.join(fixtureRoot, "project-a"));
  const second = await createProject(request, `排队项目B-${token}`, path.join(fixtureRoot, "project-b"));
  const queued = await createConversation(request, first, `排队会话-${token}`);
  const independent = await createConversation(request, second, `无排队会话-${token}`);
  // This normal idempotent API call initializes the runtime schema. No Agent is
  // invoked: only a queue flag is simulated in the launcher's disposable DB.
  expect((await request.delete(`/api/backend/conversations/e2e-runtime-init-${token}`)).status()).toBe(204);
  expect(process.env.RUNTIME_DB_PATH).toBeTruthy();
  expect(path.resolve(process.env.RUNTIME_DB_PATH!)).toBe(path.resolve(process.env.WORKSPACE_E2E_ROOT!, "data", "runtime.db"));
  const runtimePath = await realpath(process.env.RUNTIME_DB_PATH!);
  expect(runtimePath).toBe(path.join(fixtureRoot, "data", "runtime.db"));
  const db = new Database(runtimePath, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  const previous = db.prepare("SELECT * FROM run_state WHERE thread_id = ?").get(queued.id) as { thread_id: string; is_running: number; current_run_id: string | null; updated_at: number } | undefined;
  try {
    db.prepare("INSERT OR REPLACE INTO run_state (thread_id, is_running, current_run_id, updated_at) VALUES (?, 1, ?, ?)").run(queued.id, `e2e-queued-${token}`, Date.now());
    const busy = await request.delete(`/api/backend/projects/${first.id}`);
    expect(busy.status()).toBe(409);
    expect((await projectList(request)).some((item) => item.id === first.id)).toBe(true);
    expect((await (await request.get(`/api/backend/conversations/${queued.id}`)).json()).project_id).toBe(first.id);
    // Queue membership is scoped to the project rather than a global busy flag.
    expect((await request.delete(`/api/backend/projects/${second.id}`)).status()).toBe(204);
    expect((await (await request.get(`/api/backend/conversations/${independent.id}`)).json()).project_id).toBeNull();
    db.prepare("UPDATE run_state SET is_running = 0, current_run_id = NULL WHERE thread_id = ?").run(queued.id);
    expect((await request.delete(`/api/backend/projects/${first.id}`)).status()).toBe(204);
    expect((await (await request.get(`/api/backend/conversations/${queued.id}`)).json()).project_id).toBeNull();
  } finally {
    if (previous) {
      db.prepare("INSERT OR REPLACE INTO run_state (thread_id, is_running, current_run_id, updated_at) VALUES (?, ?, ?, ?)").run(previous.thread_id, previous.is_running, previous.current_run_id, previous.updated_at);
    } else db.prepare("DELETE FROM run_state WHERE thread_id = ?").run(queued.id);
    db.close();
    for (const conversation of [queued, independent]) await request.delete(`/api/backend/conversations/${conversation.id}`);
    for (const project of [first, second]) await request.delete(`/api/backend/projects/${project.id}`);
  }
});
