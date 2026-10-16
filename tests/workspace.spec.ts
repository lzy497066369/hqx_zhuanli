import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("验收：桌面四大板块同排，白色工作台无错误", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveTitle("知创工坊 · 知识产权创作工作台");
  const cards = page.locator(".category-card");
  await expect(cards).toHaveCount(4);
  const boxes = await cards.evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y };
    }),
  );
  expect(new Set(boxes.map((b) => b.y)).size).toBe(1);
  expect(boxes[3].x).toBeGreaterThan(boxes[0].x);
  await expect(page.getByText("示例项目", { exact: true })).toHaveCount(4);
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("集成：新建、持久化、搜索、编辑、导出、归档及删除项目", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator(".category-card")
    .filter({ hasText: "软件著作权" })
    .getByRole("button", { name: "开始创作" })
    .click();
  await expect(page.getByLabel("知识产权类型")).toHaveValue("software");
  await page.getByLabel("项目名称").fill("测试协同平台 V2.0");
  await page.getByLabel("申请人 / 著作权人").fill("测试团队");
  await page.getByLabel("创意描述").fill("管理任务、共享文档、跟踪进度。");
  await page.getByRole("button", { name: "保存并预览" }).click();
  await expect(page.getByRole("dialog")).toContainText("测试协同平台 V2.0");
  await expect(page.locator(".document-preview")).toContainText(
    "源代码资料清单",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出模板" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("测试协同平台 V2.0-材料模板.txt");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toContain("未经 AI 生成或专业审核");
  await page.getByRole("button", { name: "编辑项目" }).click();
  await page.getByLabel("项目名称").fill("测试协同平台 V3.0");
  await page.getByRole("button", { name: "保存并预览" }).click();
  await page.getByRole("button", { name: "标记已整理" }).click();
  await expect(page.getByRole("button", { name: "移回草稿" })).toBeVisible();
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.reload();
  await page.getByRole("textbox", { name: "搜索项目" }).fill("测试协同平台");
  await expect(page).toHaveURL(/#projects\/all$/);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.locator(".project-name").click();
  await expect(page.getByRole("dialog")).toContainText("测试协同平台 V3.0");
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await page.getByRole("button", { name: "保留项目" }).click();
  await expect(page.getByRole("dialog")).toContainText("测试协同平台 V3.0");
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByText("没有找到相关项目")).toBeVisible();
  await page.reload();
  await expect(page.getByText("测试协同平台 V3.0")).toHaveCount(0);
});

test("集成：四类模板、筛选、搜索空态与文件信息", async ({ page }) => {
  await page.goto("/#templates");
  for (const [index, id] of [
    "invention",
    "utility",
    "design",
    "software",
  ].entries()) {
    await page.getByRole("button", { name: "使用此模板" }).nth(index).click();
    await expect(page.getByLabel("知识产权类型")).toHaveValue(id);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.getByRole("link", { name: /项目管理/ }).click();
  await page.getByRole("button", { name: /^全部专利/ }).click();
  await page.getByRole("button", { name: "草稿", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "全部项目", exact: true }).click();
  await page.getByLabel("按知识产权类型筛选").selectOption("design");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("textbox", { name: "搜索项目" }).fill("不存在的项目");
  await expect(page.getByText("没有找到相关项目")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await page.getByRole("link", { name: "资料库" }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "技术说明.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("本地参考资料"),
  });
  await expect(page.getByText("技术说明.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "移除技术说明.txt" }).click();
  await expect(page.getByText("为你的创意，备好资料")).toBeVisible();
});

test("系统：输入校验、未保存提醒和对话框键盘焦点", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(page.getByLabel("项目名称")).toBeFocused();
  await page.getByLabel("知识产权类型", { exact: true }).selectOption("software");
  await page.getByLabel("项目名称").fill("   ");
  await page.getByRole("button", { name: "保存并预览" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "请输入项目名称，不能只包含空格。",
  );
  page.once("dialog", (d) => d.dismiss());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "新建项目", exact: true }),
  ).toBeFocused();
});

for (const size of [
  { width: 375, height: 812 },
  { width: 812, height: 375 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
]) {
  test(`系统：响应式 ${size.width}×${size.height} 无横向溢出`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator('.category-card')).toHaveCount(4);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (size.width === 375) {
      await page.screenshot({
        path: "test-results/dashboard-mobile.png",
        fullPage: true,
      });
      await page.getByRole("button", { name: "打开导航" }).click();
      await page.getByRole("link", { name: /项目管理/ }).click();
      await expect(
        page.getByRole("heading", { name: "项目管理" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    if (size.width >= 1024) {
      const ys = await page
        .locator(".category-card")
        .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().y));
      expect(new Set(ys).size).toBe(1);
    }
  });
}

test("系统：损坏本地数据安全回退", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("zhichuang-projects-v1", "broken-json"),
  );
  await page.goto("/");
  await expect(page.locator("tbody tr")).toHaveCount(4);
});

test("验收：WCAG 2 AA 可访问性检查", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const dialogResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(dialogResults.violations).toEqual([]);
});

for (const route of ["projects", "templates", "materials"]) {
  test(`验收：${route} 页面可访问性`, async ({ page }) => {
    await page.goto(`/#${route}`);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
  });
}

test("系统：存储不可用时显示恢复提示，长名称不撑破手机布局", async ({
  page,
}) => {
  // 项目落盘走 IndexedDB；仅在 localStorage 上制造失败已打不中真正的写入路径，
  // 必须让 indexedDB.open 失败，才能触发「浏览器存储不可用」提示。
  // indexedDB 是 Window 上的只读访问器，直接赋值会静默失败，须用 defineProperty 覆盖。
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: { open: () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); } },
    });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("浏览器存储不可用");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("知识产权类型", { exact: true }).selectOption("software");
  await page.getByLabel("项目名称").fill("A".repeat(100));
  await page.getByRole("button", { name: "保存并预览" }).click();
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator("tbody tr")).toHaveCount(4);
});
