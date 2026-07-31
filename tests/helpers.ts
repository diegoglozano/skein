import { expect, type Page } from '@playwright/test';

// Build a File from a same-origin fixture and drop it on the dropzone.
// lastModified is pinned so the OPFS graph id is deterministic across runs.
export async function dropFixture(page: Page, fixture: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(async (name) => {
    const blob = await (await fetch(`/fixtures/${name}`)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type: 'text/csv', lastModified: 42 }));
    return dt;
  }, fixture);
  await page.dispatchEvent('.dropzone', 'drop', { dataTransfer });
}

// Ingest a fixture, open the graph view, wait for the M3 layout to settle
// (computed or loaded from OPFS), and return the deterministic position hash.
export async function ingestAndLayout(page: Page, fixture: string): Promise<string> {
  await page.goto('/');
  await dropFixture(page, fixture);
  await expect(page.getByTestId('ingest-summary')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'open graph' }).click();
  await expect(page.getByTestId('layout-status')).toContainText(/ready|loaded/, {
    timeout: 120_000,
  });
  const hash = await page.evaluate(() => (window as any).__skeinRender.positionsHash as string);
  expect(hash).toBeTruthy();
  return hash;
}
