import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

type Workspace = {
  available: boolean;
  root_dir: string;
  kind: "default" | "project";
  grants: { id: string; path: string; access: "read" | "read_write"; mount_path: string }[];
};
type Conversation = { id: string; title: string };
type PathCommand = {
  op: "WRITE" | "READ" | "DELETE" | "EXECUTE";
  path: string;
  root: string;
  project?: string;
  token: string;
  expected?: "allowed" | "blocked";
  contains?: string;
  delegate?: boolean;
  grants?: { path: string; label: string }[];
  revoked?: string[];
};

let fixtureRoot: string;
type NativePickRequest = { title: string; initial_path: string | null; include_files: boolean };
type NativePickPlan = { status?: number; body: Record<string, unknown>; gate?: Promise<void> };
let nativeRequests: NativePickRequest[];
let nativePlans: NativePickPlan[];

async function workspace(request: APIRequestContext, conversation: Conversation): Promise<Workspace> {
  const response = await request.get(`/api/backend/conversations/${conversation.id}/workspace`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function selectNativePath(page: Page, trigger: Locator, title: string, selectedPath: string, includeFiles = false) {
  const before = nativeRequests.length;
  nativePlans.push({ body: { path: selectedPath, cancelled: false } });
  await trigger.click();
  await expect.poll(() => nativeRequests.length).toBe(before + 1);
  expect(nativeRequests[before]).toMatchObject({ title, include_files: includeFiles });
  await expect(trigger).toBeEnabled();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("dialog", { name: title, exact: true })).toHaveCount(0);
  // The real macOS window is verified separately. Browser automation mocks its
  // response while keeping actual backend persistence and file tools intact.
  expect(nativeRequests).toHaveLength(before + 1);
}

async function openConversation(page: Page, request: APIRequestContext, title: string, projectId?: string) {
  const response = await request.post("/api/backend/conversations", { data: { title, ...(projectId ? { project_id: projectId } : {}) } });
  expect(response.ok()).toBe(true);
  const conversation = await response.json() as Conversation;
  await page.goto("/");
  await page.locator(".conversation-select").filter({ hasText: title }).click();
  await expect(page.getByRole("button", { name: "目录与授权", exact: true })).toBeVisible();
  return conversation;
}

async function sendPathCommand(page: Page, command: PathCommand) {
  const input = page.getByRole("textbox", { name: "发送给 Agent 的消息" });
  await expect(input).toBeEnabled();
  await input.fill(`请按当前工作区和权限执行文件操作。【路径测试:${JSON.stringify(command)}】`);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const reply = `${command.delegate ? "子 Agent " : ""}路径验证 ${command.token} ${command.expected ?? "allowed"}`;
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  return reply;
}

async function createProjectWithPicker(page: Page, request: APIRequestContext, name: string, directory: string) {
  await page.goto("/");
  await page.locator(".projects-heading").getByRole("button", { name: "创建项目", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "创建项目", exact: true });
  await dialog.getByLabel("项目名称", { exact: true }).fill(name);
  await selectNativePath(page, dialog.getByRole("button", { name: "浏览项目工作目录", exact: true }), "选择项目工作目录", path.join(fixtureRoot, directory));
  await expect(dialog.getByLabel("项目工作目录", { exact: true })).toHaveValue(path.join(fixtureRoot, directory));
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const projects = await (await request.get("/api/backend/projects")).json() as { id: string; name: string; workspace_path: string }[];
  const project = projects.find((item) => item.name === name);
  expect(project).toBeDefined();
  expect(project!.workspace_path).toBe(path.join(fixtureRoot, directory));
  return project!;
}

async function openGrants(page: Page) {
  await page.getByRole("button", { name: /^目录与授权/ }).click();
  const dialog = page.getByRole("dialog", { name: "工作目录与授权", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function addExternalGrant(page: Page, dialog: Locator, access: "read" | "read_write") {
  await selectNativePath(page, dialog.getByRole("button", { name: "浏览外部路径", exact: true }), "选择授权路径", path.join(fixtureRoot, "external"), true);
  await dialog.getByLabel("访问权限", { exact: true }).selectOption(access);
  await dialog.getByRole("button", { name: "添加授权", exact: true }).click();
  await expect(dialog.getByRole("button", { name: `撤销对 ${path.join(fixtureRoot, "external")} 的授权`, exact: true })).toBeVisible();
}

test.beforeEach(async ({ baseURL, request, page }) => {
  // Disk assertions are permitted only against the launcher's disposable tree.
  expect(new URL(baseURL ?? "").port).toBe("3211");
  const model = await (await request.get("/api/backend/settings/model")).json() as { base_url: string };
  expect(new URL(model.base_url).origin).toBe("http://127.0.0.1:18965");
  expect(process.env.WORKSPACE_E2E_ROOT, "Run through scripts/test-e2e.sh").toBeTruthy();
  fixtureRoot = await realpath(process.env.WORKSPACE_E2E_ROOT!);
  expect(path.basename(fixtureRoot)).toMatch(/^agent-workspace-e2e\./);
  expect(await realpath(process.env.WORKSPACE_FILES_DIR!)).toBe(path.join(fixtureRoot, "files"));
  nativeRequests = [];
  nativePlans = [];
  // Never let a Playwright test unexpectedly open a real OS modal. Each test
  // explicitly supplies the native panel result; the backend validates/saves it.
  await page.route("**/api/backend/filesystem/pick", async (route) => {
    nativeRequests.push(route.request().postDataJSON() as NativePickRequest);
    const plan = nativePlans.shift() ?? { status: 500, body: { detail: "E2E 未安排系统选择结果" } };
    if (plan.gate) await plan.gate;
    await route.fulfill({ status: plan.status ?? 200, contentType: "application/json", body: JSON.stringify(plan.body) });
  });
});

test("外部网页伪造的工作目录修改被拒绝，原配置保持不变", async ({ request }) => {
  const endpoint = "/api/backend/settings/workspace";
  const baseline = await (await request.get(endpoint)).json() as { default_workspace_path: string };
  const response = await request.put(endpoint, {
    headers: { Origin: "http://evil.example", "Content-Type": "text/plain" },
    data: JSON.stringify({ default_workspace_path: path.join(fixtureRoot, "default-alt") }),
  });
  expect(response.status()).toBe(403);
  expect(await (await request.get(endpoint)).json()).toEqual(baseline);
});

test("系统选择取消保持原表单，失败可重试，每次点击只请求一次（系统窗口模拟）", async ({ page, request }) => {
  const baseline = await (await request.get("/api/backend/settings/workspace")).json() as { default_workspace_path: string };
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "工作目录", exact: true }).click();
  const input = page.getByLabel("默认工作目录", { exact: true });
  await expect(input).toHaveValue(baseline.default_workspace_path);
  const browse = page.getByRole("button", { name: "浏览默认工作目录", exact: true });
  let finishPick = () => {};
  const gate = new Promise<void>((resolve) => { finishPick = resolve; });
  try {
    nativePlans.push({ body: { path: null, cancelled: true }, gate });
    await browse.click();
    await expect.poll(() => nativeRequests.length).toBe(1);
    await expect(browse).toBeDisabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await browse.evaluate((element) => (element as HTMLButtonElement).click());
    expect(nativeRequests).toHaveLength(1);
    await expect(input).toHaveValue(baseline.default_workspace_path);
    finishPick();
    await expect(browse).toBeEnabled();
    await expect(browse).toBeFocused();
    await expect(input).toHaveValue(baseline.default_workspace_path);
    expect(nativeRequests[0]).toEqual({ title: "选择默认工作目录", initial_path: baseline.default_workspace_path, include_files: false });

    nativePlans.push({ status: 503, body: { detail: "测试系统窗口失败，可重试" } });
    await browse.click();
    await expect(page.getByRole("alert").filter({ hasText: "测试系统窗口失败，可重试" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(nativeRequests).toHaveLength(2);
    await expect(input).toHaveValue(baseline.default_workspace_path);
    await expect(browse).toBeEnabled();
    await expect(browse).toBeFocused();
    const selected = path.join(fixtureRoot, "default-alt");
    await selectNativePath(page, browse, "选择默认工作目录", selected);
    await expect(input).toHaveValue(selected);
    expect(nativeRequests).toHaveLength(3);
    expect(await (await request.get("/api/backend/settings/workspace")).json()).toEqual(baseline);
  } finally {
    finishPick();
  }
});

test("系统选择项目目录期间只保留创建项目表单，浏览禁用且取消保留草稿（系统窗口模拟）", async ({ page }) => {
  await page.goto("/");
  const create = page.locator(".projects-heading").getByRole("button", { name: "创建项目", exact: true });
  await create.click();
  const dialog = page.getByRole("dialog", { name: "创建项目", exact: true });
  await dialog.getByLabel("项目名称", { exact: true }).fill("系统选择取消后保留的项目草稿");
  const originalPath = path.join(fixtureRoot, "project-a");
  await dialog.getByLabel("项目工作目录", { exact: true }).fill(originalPath);
  const browse = dialog.getByRole("button", { name: "浏览项目工作目录", exact: true });
  let finishPick = () => {};
  const gate = new Promise<void>((resolve) => { finishPick = resolve; });
  try {
    nativePlans.push({ body: { path: null, cancelled: true }, gate });
    await browse.click();
    await expect.poll(() => nativeRequests.length).toBe(1);
    await expect(browse).toBeDisabled();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog", { name: "选择项目工作目录", exact: true })).toHaveCount(0);
    await browse.evaluate((element) => (element as HTMLButtonElement).click());
    expect(nativeRequests).toHaveLength(1);
    finishPick();
    await expect(browse).toBeEnabled();
    await expect(browse).toBeFocused();
    await expect(dialog.getByLabel("项目名称", { exact: true })).toHaveValue("系统选择取消后保留的项目草稿");
    await expect(dialog.getByLabel("项目工作目录", { exact: true })).toHaveValue(originalPath);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(create).toBeFocused();
  } finally {
    finishPick();
  }
});

test("外部授权的系统选择允许文件，所选文件经过真实后端校验授权（系统窗口模拟）", async ({ page, request }) => {
  const conversation = await openConversation(page, request, `系统选择文件验收-${Date.now()}`);
  const selected = path.join(fixtureRoot, "external", "source.txt");
  try {
    const dialog = await openGrants(page);
    await selectNativePath(page, dialog.getByRole("button", { name: "浏览外部路径", exact: true }), "选择授权路径", selected, true);
    await expect(dialog.getByLabel("外部路径", { exact: true })).toHaveValue(selected);
    await dialog.getByLabel("访问权限", { exact: true }).selectOption("read");
    await dialog.getByRole("button", { name: "添加授权", exact: true }).click();
    await expect(dialog.getByRole("button", { name: `撤销对 ${selected} 的授权`, exact: true })).toBeVisible();
    expect((await workspace(request, conversation)).grants).toEqual(expect.arrayContaining([expect.objectContaining({ path: selected, access: "read", kind: "file" })]));
    expect(nativeRequests).toHaveLength(1);
  } finally {
    await request.delete(`/api/backend/conversations/${conversation.id}`);
  }
});

test("390px 系统选择期间仅保留授权表单，错误就近显示且焦点返回（系统窗口模拟）", async ({ page, request }) => {
  const conversation = await openConversation(page, request, `目录手机验收-${Date.now()}`);
  let finishPick = () => {};
  const responseGate = new Promise<void>((resolve) => { finishPick = resolve; });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const trigger = page.getByRole("button", { name: /^目录与授权/ });
    const dialog = await openGrants(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: "test-results/workspace-grants-mobile.png", fullPage: true });
    const browse = dialog.getByRole("button", { name: "浏览外部路径", exact: true });
    nativePlans.push({ status: 503, body: { detail: "系统窗口暂时不可用，请重试选择" }, gate: responseGate });
    await browse.click();
    await expect.poll(() => nativeRequests.length).toBe(1);
    await expect(browse).toBeDisabled();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog", { name: "选择授权路径", exact: true })).toHaveCount(0);
    await expect(page.getByText("请在系统窗口中选择文件或目录。", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await browse.evaluate((element) => (element as HTMLButtonElement).click());
    expect(nativeRequests).toHaveLength(1);
    await page.screenshot({ path: "test-results/workspace-native-pending-mobile.png", fullPage: true });
    finishPick();
    await expect(dialog.getByRole("alert")).toContainText("系统窗口暂时不可用");
    await expect(browse).toBeEnabled();
    await expect(browse).toBeFocused();
    expect(nativeRequests).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await page.screenshot({ path: "test-results/workspace-native-error-mobile.png", fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  } finally {
    finishPick();
    await request.delete(`/api/backend/conversations/${conversation.id}`);
  }
});

test("系统选目录结果经真实后端保存，普通会话相对路径落盘（系统窗口模拟）", async ({ page, request }) => {
  const baseline = await (await request.get("/api/backend/settings/workspace")).json() as { default_workspace_path: string };
  const filename = `default-${Date.now()}.txt`;
  const targetRoot = path.join(fixtureRoot, "default-alt");
  let conversation: Conversation | undefined;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "工作目录", exact: true }).click();
    await selectNativePath(page, page.getByRole("button", { name: "浏览默认工作目录", exact: true }), "选择默认工作目录", targetRoot);
    await expect(page.getByLabel("默认工作目录", { exact: true })).toHaveValue(targetRoot);
    await page.getByRole("button", { name: "保存工作目录", exact: true }).click();
    await expect.poll(async () => (await (await request.get("/api/backend/settings/workspace")).json()).default_workspace_path).toBe(targetRoot);
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "工作目录", exact: true }).click();
    await expect(page.getByLabel("默认工作目录", { exact: true })).toHaveValue(targetRoot);
    await page.screenshot({ path: "test-results/workspace-directory-settings.png", fullPage: true });
    conversation = await openConversation(page, request, `默认目录验收-${Date.now()}`);
    expect(await workspace(request, conversation)).toMatchObject({ available: true, kind: "default", root_dir: targetRoot });
    await sendPathCommand(page, { op: "WRITE", path: filename, root: targetRoot, token: "default-write" });
    expect(await readFile(path.join(targetRoot, filename), "utf8")).toBe("路径隔离验证：default-write\n");
    await expect(readFile(path.join(fixtureRoot, "files", filename), "utf8")).rejects.toThrow();
    await page.screenshot({ path: "test-results/workspace-default-path.png", fullPage: true });
  } finally {
    const restored = await request.put("/api/backend/settings/workspace", { data: baseline });
    expect(restored.ok()).toBe(true);
    if (conversation) await request.delete(`/api/backend/conversations/${conversation.id}`);
    await rm(path.join(targetRoot, filename), { force: true });
  }
});

test("两个项目绑定系统返回的目录，同名相对文件隔离且子 Agent 继承上下文（系统窗口模拟）", async ({ page, request }) => {
  test.setTimeout(90000);
  const run = Date.now();
  const filename = `same-${run}.txt`;
  const childName = `child-${run}.txt`;
  const projectA = await createProjectWithPicker(page, request, `目录项目A-${run}`, "project-a");
  const projectB = await createProjectWithPicker(page, request, `目录项目B-${run}`, "project-b");
  const conversations: Conversation[] = [];
  try {
    for (const [project, directory, token] of [[projectA, "project-a", "project-a-write"], [projectB, "project-b", "project-b-write"]] as const) {
      const root = path.join(fixtureRoot, directory);
      const conversation = await openConversation(page, request, `${project.name}任务`, project.id);
      conversations.push(conversation);
      expect(await workspace(request, conversation)).toMatchObject({ available: true, kind: "project", root_dir: root });
      await sendPathCommand(page, { op: "WRITE", path: filename, root, project: project.name, token });
      expect(await readFile(path.join(root, filename), "utf8")).toBe(`路径隔离验证：${token}\n`);
    }
    await sendPathCommand(page, { op: "WRITE", path: childName, root: path.join(fixtureRoot, "project-b"), project: projectB.name, token: "child-project-b", delegate: true });
    expect(await readFile(path.join(fixtureRoot, "project-b", childName), "utf8")).toBe("路径隔离验证：child-project-b\n");
    await expect(readFile(path.join(fixtureRoot, "project-a", childName), "utf8")).rejects.toThrow();
    await sendPathCommand(page, { op: "DELETE", path: filename, root: path.join(fixtureRoot, "project-b"), project: projectB.name, token: "child-no-delete", delegate: true, expected: "blocked" });
    await sendPathCommand(page, { op: "EXECUTE", path: filename, root: path.join(fixtureRoot, "project-b"), project: projectB.name, token: "child-no-execute", delegate: true, expected: "blocked" });
    expect(await readFile(path.join(fixtureRoot, "project-a", filename), "utf8")).toBe("路径隔离验证：project-a-write\n");
    expect(await readFile(path.join(fixtureRoot, "project-b", filename), "utf8")).toBe("路径隔离验证：project-b-write\n");
    await page.screenshot({ path: "test-results/workspace-project-paths.png", fullPage: true });
  } finally {
    for (const conversation of conversations) await request.delete(`/api/backend/conversations/${conversation.id}`);
    for (const directory of ["project-a", "project-b"]) {
      for (const name of [filename, childName]) await rm(path.join(fixtureRoot, directory, name), { force: true });
    }
  }
});

test("外部目录未授权拒绝，只读授权不能写，撤销立即生效，读写授权由子 Agent 继承", async ({ page, request }) => {
  test.setTimeout(90000);
  const conversation = await openConversation(page, request, `外部授权验收-${Date.now()}`);
  const current = await workspace(request, conversation);
  const externalRoot = path.join(fixtureRoot, "external");
  const source = path.join(externalRoot, "source.txt");
  const output = path.join(externalRoot, `authorized-${Date.now()}.txt`);
  try {
    await sendPathCommand(page, { op: "READ", path: source, root: current.root_dir, token: "outside-denied", expected: "blocked" });
    let dialog = await openGrants(page);
    await addExternalGrant(page, dialog, "read");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    expect((await workspace(request, conversation)).grants).toEqual(expect.arrayContaining([expect.objectContaining({ path: externalRoot, access: "read" })]));
    const readGrant = [{ path: externalRoot, label: "只读" }];
    await sendPathCommand(page, { op: "READ", path: source, root: current.root_dir, token: "outside-read", contains: "外部路径测试：只读资料", grants: readGrant, delegate: true });
    await sendPathCommand(page, { op: "WRITE", path: output, root: current.root_dir, token: "readonly-no-write", expected: "blocked", grants: readGrant });
    await expect(readFile(output, "utf8")).rejects.toThrow();
    dialog = await openGrants(page);
    await dialog.getByRole("button", { name: `撤销对 ${externalRoot} 的授权`, exact: true }).click();
    await expect(dialog.getByRole("button", { name: `撤销对 ${externalRoot} 的授权`, exact: true })).not.toBeVisible();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    expect((await workspace(request, conversation)).grants).toHaveLength(0);
    await sendPathCommand(page, { op: "READ", path: source, root: current.root_dir, token: "revoked-no-read", expected: "blocked", revoked: [externalRoot] });
    dialog = await openGrants(page);
    await addExternalGrant(page, dialog, "read_write");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await sendPathCommand(page, { op: "WRITE", path: output, root: current.root_dir, token: "external-child-write", grants: [{ path: externalRoot, label: "可读写" }], delegate: true });
    expect(await readFile(output, "utf8")).toBe("路径隔离验证：external-child-write\n");
    await sendPathCommand(page, { op: "READ", path: output, root: current.root_dir, token: "external-main-read", grants: [{ path: externalRoot, label: "可读写" }], contains: "external-child-write" });
    expect(await readFile(source, "utf8")).toBe("外部路径测试：只读资料\n");
    await openGrants(page);
    await page.screenshot({ path: "test-results/workspace-external-grants.png", fullPage: true });
  } finally {
    await request.delete(`/api/backend/conversations/${conversation.id}`);
    await rm(output, { force: true });
  }
});
