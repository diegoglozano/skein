import type { Page } from '@playwright/test';

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
