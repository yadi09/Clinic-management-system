import { expect, test } from "@playwright/test";

import { login } from "./stack";

test("REG-E2E-004 appointments: the Follow-ups view shows its row of tabs", async ({ page }) => {
  await login(page, "owner");
  await page.goto("/appointments");
  await page.getByRole("tablist", { name: "Calendar view" }).getByRole("tab", { name: "Follow-ups" }).click();
  const tabs = page.getByRole("tablist", { name: "Follow-ups" });
  await expect(tabs).toBeVisible();
  for (const name of [/Missed/, /Today/, /Coming up/]) {
    await expect(tabs.getByRole("tab", { name })).toBeVisible();
  }
  await expect(tabs.getByRole("tab", { selected: true })).toHaveCount(1);
});
