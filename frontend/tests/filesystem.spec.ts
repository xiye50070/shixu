import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const originalContent = "拾序文件练习\n关键词：蓝色鲸鱼\n状态：初稿\n";
const updatedContent = originalContent.replace("状态：初稿", "状态：已完成");
let filesDirectory: string;

async function sendFilePrompt(page: Page, operation: string, virtualPath: string) {
  const instructions: Record<string, string> = {
    WRITE: "列出工作区，并创建练习文件。",
    READ: "读取练习文件，告诉我完整内容。",
    EDIT: "读取练习文件，把状态从初稿改为已完成。",
    SEARCH: "按文件名查找练习文件，再搜索蓝色鲸鱼。",
    DELETE: "尝试调用未开放的删除工具。",
    EXECUTE: "尝试调用未开放的终端工具删除文件。",
  };
  const input = page.getByRole("textbox", { name: "发送给 Agent 的消息" });
  await expect(input).toBeEnabled();
  await input.fill(`${instructions[operation]}【文件测试:${operation}:${virtualPath}】`);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

async function createConversation(page: Page, request: APIRequestContext, title: string) {
  const response = await request.post("/api/backend/conversations", { data: { title } });
  expect(response.ok()).toBe(true);
  const conversation = await response.json() as { id: string; title: string };
  await page.goto("/");
  await page.locator(".conversation-select").filter({ hasText: title }).click();
  return conversation;
}

test.beforeEach(async ({ baseURL, request }) => {
  // The fixture can make genuine disk writes. Refuse production ports/model
  // endpoints and directories unless the disposable launcher supplied them.
  expect(new URL(baseURL ?? "").port).toBe("3211");
  const settings = await (await request.get("/api/backend/settings/model")).json() as { base_url: string };
  expect(new URL(settings.base_url).origin).toBe("http://127.0.0.1:18965");
  expect(process.env.WORKSPACE_FILES_DIR, "Run through scripts/test-e2e.sh").toBeTruthy();
  filesDirectory = path.resolve(process.env.WORKSPACE_FILES_DIR!);
  expect(path.basename(filesDirectory)).toBe("files");
  expect(path.basename(path.dirname(filesDirectory))).toMatch(/^agent-workspace-e2e\./);
});

test("Deep Agent 真正读写、编辑和搜索本地文件，刷新后保留对话", async ({ page, request }) => {
  const name = `e2e-${Date.now()}-files.txt`;
  const virtualPath = `/workspace/${name}`;
  const physicalPath = path.join(filesDirectory, name);
  const conversation = await createConversation(page, request, `文件能力验收-${Date.now()}`);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await sendFilePrompt(page, "WRITE", virtualPath);
    const writeReply = `已创建文件：${virtualPath}。`;
    await expect(page.getByText(writeReply, { exact: true })).toBeVisible();
    expect(await readFile(physicalPath, "utf8")).toBe(originalContent);

    // Change the disk outside the Agent so read_file must return current disk
    // content, rather than echoing remembered write_file arguments.
    const diskContent = originalContent + "磁盘补充：现场核验\n";
    await writeFile(physicalPath, diskContent, "utf8");
    await sendFilePrompt(page, "READ", virtualPath);
    await expect(page.getByText(/文件读取结果：[\s\S]*磁盘补充：现场核验/)).toBeVisible();

    await sendFilePrompt(page, "EDIT", virtualPath);
    const editReply = `已修改文件：${virtualPath}，状态已完成。`;
    await expect(page.getByText(editReply, { exact: true })).toBeVisible();
    expect(await readFile(physicalPath, "utf8")).toBe(updatedContent + "磁盘补充：现场核验\n");

    await sendFilePrompt(page, "SEARCH", virtualPath);
    await expect(page.getByText(/文件搜索结果：[\s\S]*蓝色鲸鱼/)).toBeVisible();
    const searchReply = page.getByText(/文件搜索结果：[\s\S]*蓝色鲸鱼/);
    await expect(searchReply).toContainText(virtualPath);
    await page.reload();
    await expect(page.getByText(writeReply, { exact: true })).toBeVisible();
    await expect(page.getByText(editReply, { exact: true })).toBeVisible();
    await expect(page.getByText(/文件搜索结果：[\s\S]*蓝色鲸鱼/)).toBeVisible();
    const history = await (await request.get(`/api/backend/conversations/${conversation.id}/messages`)).json() as { role: string; content: string }[];
    expect(history.filter((item) => item.role === "user")).toHaveLength(4);
    // Assistant tool-call messages are saved too; count the four final replies.
    expect(history.filter((item) => item.role === "assistant" && item.content.trim())).toHaveLength(4);
    expect(pageErrors).toEqual([]);
    await page.screenshot({ path: "test-results/filesystem-chat.png", fullPage: true });
  } finally {
    await request.delete(`/api/backend/conversations/${conversation.id}`);
    await rm(physicalPath, { force: true });
  }
});

test("模型强行调用 delete 或 execute 时不能删除本地文件", async ({ page, request }) => {
  const name = `e2e-${Date.now()}-protected.txt`;
  const virtualPath = `/workspace/${name}`;
  const physicalPath = path.join(filesDirectory, name);
  await writeFile(physicalPath, originalContent, "utf8");
  const conversation = await createConversation(page, request, `删除边界验收-${Date.now()}`);
  try {
    await sendFilePrompt(page, "DELETE", virtualPath);
    await expect(page.getByText("已拒绝 delete：该工具未开放，文件保留。", { exact: true })).toBeVisible();
    expect(await readFile(physicalPath, "utf8")).toBe(originalContent);
    await sendFilePrompt(page, "EXECUTE", virtualPath);
    await expect(page.getByText("已拒绝 execute：该工具未开放，文件保留。", { exact: true })).toBeVisible();
    expect(await readFile(physicalPath, "utf8")).toBe(originalContent);
  } finally {
    await request.delete(`/api/backend/conversations/${conversation.id}`);
    await rm(physicalPath, { force: true });
  }
});
