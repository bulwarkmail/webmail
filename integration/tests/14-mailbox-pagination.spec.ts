import { expect, test } from "@playwright/test";
import { ACCOUNTS } from "./helpers/config";
import { folderRow, login } from "./helpers/app";
import { JmapClient } from "./helpers/jmap";

const PREFIX = "IT-Pagination-";
const CHILD_COUNT = 520;
const BATCH_SIZE = 400;

async function setMailboxes(
  client: JmapClient,
  property: "create" | "update",
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.request([
    ["Mailbox/set", { accountId: client.accountId, [property]: values }, "set"],
  ]);
  const result = response.methodResponses[0][1];
  expect(result[property === "create" ? "notCreated" : "notUpdated"] ?? {}).toEqual({});
  return result;
}

test.describe("Mailbox pagination with real Stalwart data", () => {
  test.setTimeout(180_000);
  let client: JmapClient;

  test.beforeAll(async () => {
    client = await JmapClient.connect(ACCOUNTS.alice.email, ACCOUNTS.alice.password);
    await client.reset();
  });
  test.afterAll(async () => client.reset());

  test("loads and nests all 520 children beneath their parent", async ({ page }) => {
    const childIds: string[] = [];
    for (let offset = 0; offset < CHILD_COUNT; offset += BATCH_SIZE) {
      const names = Array.from(
        { length: Math.min(BATCH_SIZE, CHILD_COUNT - offset) },
        (_, index) => `${PREFIX}Child-${(offset + index).toString().padStart(3, "0")}`,
      );
      const create = Object.fromEntries(names.map((name, index) => [`item-${index}`, { name }]));
      const created = (await setMailboxes(client, "create", create)).created as Record<string, { id: string }>;
      childIds.push(...Object.keys(create).map((key) => created[key].id));
    }

    // Creating the parent last puts it beyond a legacy capped Mailbox/get.
    const parentId = await client.createMailbox(`${PREFIX}Parent`);
    for (let offset = 0; offset < CHILD_COUNT; offset += BATCH_SIZE) {
      await setMailboxes(client, "update", Object.fromEntries(
        childIds.slice(offset, offset + BATCH_SIZE).map((id) => [id, { parentId }]),
      ));
    }

    const fixture = (await client.mailboxes()).filter(({ name }) => name.startsWith(PREFIX));
    expect(fixture).toHaveLength(CHILD_COUNT + 1);
    expect(fixture.filter((mailbox) => mailbox.parentId === parentId)).toHaveLength(CHILD_COUNT);

    await page.addInitScript(() => localStorage.setItem("expandedMailboxes", "[]"));
    await login(page, ACCOUNTS.alice);
    const fixtureRows = page.locator(`[data-testid="folder-row"][data-folder-name^="${PREFIX}"]`);
    await expect(fixtureRows).toHaveCount(1, { timeout: 60_000 });

    const parentRow = folderRow(page, { mailboxId: parentId }).first();
    await parentRow.locator('[data-testid="folder-expand-toggle"]').click();
    const tree = page.getByTestId("mailbox-tree-rows").first();
    await expect(tree).toHaveAttribute("data-total-rows", /\d+/, { timeout: 60_000 });
    expect(Number(await tree.getAttribute("data-total-rows"))).toBeGreaterThanOrEqual(CHILD_COUNT + 1);
    expect(await fixtureRows.count()).toBeLessThanOrEqual(250);
    expect(await fixtureRows.evaluateAll((rows) => {
      const ids = new Set(rows.map((row) => row.getAttribute("data-mailbox-id")));
      return rows.every((row) => !row.dataset.parentId || ids.has(row.dataset.parentId));
    })).toBe(true);

    const childRow = folderRow(page, { mailboxId: childIds[0] }).first();
    await expect(childRow).toHaveAttribute("data-parent-id", parentId);
    const indent = (row: typeof childRow) => row.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element.firstElementChild!).paddingLeft));
    expect(await indent(childRow)).toBeGreaterThan(await indent(parentRow));
  });
});
