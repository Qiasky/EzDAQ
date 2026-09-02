// EzDAQ EPS standalone demo — UI regression selftest.
// Loads demo/index.html (file://) and exercises the data-source
// configuration flows plus baseline pages of the prototype.
const { test, expect } = require('@playwright/test');

const DEMO_URL = 'file://' + require('path').join(__dirname, '..', '..', 'demo', 'index.html').replace(/\\/g, '/');

test.beforeEach(async ({ page }) => {
  await page.goto(DEMO_URL);
  // the web admin shell must be the visible view after load
  await expect(page.locator('#web')).toBeVisible();
});

test('demo renders four device views and baseline pages', async ({ page }) => {
  for (const view of ['web', 'mobile', 'mini', 'windows']) {
    await expect(page.locator(`main#${view}.view`)).toHaveCount(1);
  }
  // switch through every shell view
  for (const label of ['手机 APP', '微信小程序', 'Windows 上位机', 'Web 管理端']) {
    await page.getByRole('button', { name: label }).click();
    await expect(page.locator('.demo-switcher button.active')).toContainText(label);
  }
});

test('sidebar navigates to data source page with seeded channels', async ({ page }) => {
  await page.getByRole('button', { name: /数据源/ }).click();
  await expect(page.locator('#webContent h1')).toHaveText('数据源与接入');
  const table = page.locator('#webContent .device-table tbody');
  await expect(table.locator('tr')).toHaveCount(4);
  await expect(table).toContainText('浦东机房 Modbus 网关');
  await expect(table).toContainText('Modbus TCP');
  await expect(table).toContainText('VISA');
  await expect(table).toContainText('第三方驱动 DLL');
  await expect(table).toContainText('精密空调厂商驱动');
});

test('device page lists data source column for each device', async ({ page }) => {
  await page.getByRole('button', { name: /设备与机房/ }).click();
  const rows = page.locator('#webContent .device-table tbody tr');
  await expect(rows).toHaveCount(4);
  // row order: 温湿度/新风机(Modbus 网关), UPS(监控服务器), 门禁(VISA)
  const expected = ['浦东机房 Modbus 网关', '市电/配电监控服务器', '门禁控制器 VISA', '浦东机房 Modbus 网关'];
  for (let i = 0; i < expected.length; i++) {
    await expect(rows.nth(i).locator('td').nth(3)).toHaveText(expected[i]);
  }
});

test('add data source: type-driven form, save, then connection test', async ({ page }) => {
  await page.getByRole('button', { name: /数据源/ }).click();
  const table = page.locator('#webContent .device-table tbody');

  await page.getByRole('button', { name: '+ 新增数据源' }).click();
  // pick VISA -> visa-specific field appears
  await page.locator('#dsTypeSel').selectOption('visa');
  await expect(page.locator('#dsf_resource')).toBeVisible();
  await page.fill('#dsName', 'AI 自测 VISA 仪表');
  await page.fill('#dsf_resource', 'GPIB0::12::INSTR');
  await page.getByRole('button', { name: '保存', exact: true }).click();

  await expect(table.locator('tr')).toHaveCount(5);
  await expect(table).toContainText('AI 自测 VISA 仪表');
  await expect(table).toContainText('已配置');

  // run the connection test on the last row (simulated in the prototype)
  const lastRow = table.locator('tr').last();
  await lastRow.getByRole('button', { name: '测试连接' }).click();
  await expect(page.locator('#toast')).toContainText('正在测试', { timeout: 5000 });
  await expect(lastRow).toContainText('在线', { timeout: 5000 });
});

test('cannot delete a data source that still has devices mounted', async ({ page }) => {
  await page.getByRole('button', { name: /数据源/ }).click();
  const row = page.locator('#webContent .device-table tbody tr', { hasText: '浦东机房 Modbus 网关' });
  await row.getByRole('button', { name: '删除' }).click();
  await expect(page.locator('#toast')).toContainText('无法删除');
  // modal never opens and row remains
  await expect(page.locator('.modal-shade')).toHaveCount(0);
  await expect(page.locator('#webContent .device-table tbody tr')).toHaveCount(4);
});

test('add and delete an un-mounted data source (full lifecycle)', async ({ page }) => {
  await page.getByRole('button', { name: /数据源/ }).click();
  const table = page.locator('#webContent .device-table tbody');

  await page.getByRole('button', { name: '+ 新增数据源' }).click();
  await page.locator('#dsTypeSel').selectOption('dll');
  await expect(page.locator('#dsf_path')).toBeVisible();
  await page.fill('#dsName', '临时 DLL 通道');
  await page.fill('#dsf_path', 'C:\\drivers\\temp.dll');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(table.locator('tr')).toHaveCount(5);

  const row = table.locator('tr', { hasText: '临时 DLL 通道' });
  await row.getByRole('button', { name: '删除' }).click();
  await expect(page.locator('.modal-shade')).toBeVisible();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(table.locator('tr')).toHaveCount(4);
});
