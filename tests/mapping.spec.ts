// §10's column mapping dialog: format sniffing plus source/target/weight and
// delimiter, over a preview of the file.
//
// The interesting cases are files the app could not open at all before this
// existed — semicolon-separated, edge columns that are not the first two,
// no header row — so the fixtures here are written in the test rather than
// generated: each one is a shape, not a size, and three rows say it.

import { test, expect, type Page } from '@playwright/test';

/** Drop an in-memory CSV on the drop zone, as a real file picker would. */
async function drop(page: Page, name: string, content: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ name, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: 'text/csv', lastModified: 42 }));
      return dt;
    },
    { name, content },
  );
  await page.dispatchEvent('.dropzone', 'drop', { dataTransfer });
}

test('sniffs the delimiter and guesses the columns by name', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  // Semicolons, and the edge in columns 2 and 3 — unopenable before the
  // dialog, because ingest hard-coded comma and columns 0 and 1.
  await drop(
    page,
    'meetings.csv',
    'when;source;target;weight\n2024-01-01;ana;bo;3\n2024-01-02;bo;cy;1\n',
  );

  await expect(page.getByTestId('column-mapping')).toBeVisible();
  await expect(page.getByTestId('mapping-delimiter')).toHaveValue(';');
  await expect(page.getByTestId('mapping-header')).toBeChecked();
  await expect(page.getByTestId('mapping-source')).toHaveValue('1');
  await expect(page.getByTestId('mapping-target')).toHaveValue('2');
  // Weight is guessed by name too, but stays the caller's to change.
  await expect(page.getByTestId('mapping-weight')).toHaveValue('3');

  // The preview shows the file as the chosen delimiter splits it, so a wrong
  // guess is visible rather than something to discover after a 60 s ingest.
  const preview = page.getByTestId('mapping-preview');
  await expect(preview).toContainText('ana');
  await expect(preview).toContainText('2024-01-01');

  await page.getByTestId('mapping-import').click();
  const summary = page.getByTestId('ingest-summary');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  // ana, bo, cy — three nodes from the columns we named, not from the dates
  // in column 0.
  await expect(summary).toContainText('3 nodes');
  await expect(summary).toContainText('2 edges');
});

test('a headerless file can be imported by saying so', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  // Every row is data. The guess gets this wrong — string ids look like
  // labels — which is the reason the checkbox is next to the preview.
  await drop(page, 'pairs.csv', 'a,b\nb,c\nc,d\n');

  await expect(page.getByTestId('mapping-header')).toBeChecked();
  await page.getByTestId('mapping-header').uncheck();
  // With no header the columns are numbered, and the first row joins the data.
  await expect(page.getByTestId('mapping-preview')).toContainText('column 1');

  await page.getByTestId('mapping-import').click();
  const summary = page.getByTestId('ingest-summary');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  // a, b, c, d — the first row counted. Read as a header it would be 3 nodes.
  await expect(summary).toContainText('4 nodes');
  await expect(summary).toContainText('3 edges');
});

test('refuses a mapping that cannot describe an edge, and can be cancelled', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await drop(page, 'tiny-ish.csv', 'source,target\nn0,n1\nn1,n2\n');

  await page.getByTestId('mapping-target').selectOption('0');
  await expect(page.getByTestId('mapping-error')).toContainText('must be different');
  await expect(page.getByTestId('mapping-import')).toBeDisabled();

  // Picking a delimiter the file does not use leaves one column, which cannot
  // be an edge either — and says so rather than importing a graph of nothing.
  await page.getByTestId('mapping-target').selectOption('1');
  await page.getByTestId('mapping-delimiter').selectOption('|');
  await expect(page.getByTestId('mapping-error')).toContainText('try another delimiter');
  await expect(page.getByTestId('mapping-import')).toBeDisabled();

  await page.getByTestId('mapping-cancel').click();
  await expect(page.getByTestId('column-mapping')).toHaveCount(0);
  await expect(page.getByLabel('file drop zone')).toBeVisible();
});
