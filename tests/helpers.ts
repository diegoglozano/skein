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

// Generate a sample graph of the requested size in the app itself — the path a
// device with no data on it takes.
export async function generateSample(page: Page, nodes: number, edges: number): Promise<void> {
  await page.getByTestId('generate-nodes').fill(String(nodes));
  await page.getByTestId('generate-edges').fill(String(edges));
  await page.getByTestId('generate-run').click();
}

// As `ingestAndLayout`, but the graph is synthesized in the tab instead of
// dropped, so the hash the two return is comparable.
export async function generateAndLayout(
  page: Page,
  nodes: number,
  edges: number,
): Promise<string> {
  await page.goto('/');
  await generateSample(page, nodes, edges);
  await expect(page.getByTestId('ingest-summary')).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'open graph' }).click();
  await expect(page.getByTestId('layout-status')).toContainText(/ready|loaded/, {
    timeout: 120_000,
  });
  const hash = await page.evaluate(() => (window as any).__skeinRender.positionsHash as string);
  expect(hash).toBeTruthy();
  return hash;
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
