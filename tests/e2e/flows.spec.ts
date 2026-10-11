import { expect, Page, test } from '@playwright/test';

const DEMO = 'E2e-Demo-Pass-1';
const stamp = Date.now();

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('customer: register, browse, select show, hold seat, mock pay, ticket survives refresh', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/register');
  await page.getByLabel('Full name').fill('Eve Customer');
  await page.getByLabel('Email').fill(`eve+${stamp}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('Passw0rd1');
  await page.getByLabel('Confirm password').fill('Passw0rd1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: /now showing/i }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Movies' }).first().click();
  await page.getByRole('link', { name: /Midnight Orbit/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Showtimes' })).toBeVisible();
  await page.locator('a[href^="/shows/"]').first().click();

  await page.getByRole('button', { name: /available/i }).first().click();
  await expect(page.getByTestId('seat-total')).not.toHaveText('₹0');
  await page.getByRole('button', { name: /Hold seats/ }).click();

  await expect(page.getByRole('timer')).toBeVisible();
  await page.getByLabel('Name on card').fill('Eve Customer');
  await page.getByRole('button', { name: /^Pay/ }).click();

  await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toBeVisible();
  const ticket = await page.getByTestId('ticket-number').textContent();
  expect(ticket).toMatch(/^TKT-/);

  await page.reload();
  await expect(page.getByTestId('ticket-number')).toHaveText(ticket!);
  await page.goto('/bookings');
  await expect(page.getByText('Midnight Orbit').first()).toBeVisible();
  expect(errors.filter((e) => !/favicon|fonts|picsum|Failed to load resource/i.test(e))).toEqual([]);
});

test('manager: register, await approval, admin approves, add theatre, admin approves, configure', async ({ page, browser }) => {
  const email = `mgr+${stamp}@example.com`;
  await page.goto('/register?as=manager');
  await page.getByLabel('Full name').fill('Mia Manager');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Passw0rd1');
  await page.getByLabel('Confirm password').fill('Passw0rd1');
  await page.getByRole('button', { name: 'Request manager access' }).click();
  await expect(page.getByRole('heading', { name: 'Awaiting approval' })).toBeVisible();
  await page.goto('/manager/theatres');
  await expect(page).toHaveURL(/\/manager\/pending/);

  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto('http://localhost:5174/login');
  await admin.getByLabel('Email').fill('admin@demo.local');
  await admin.getByLabel('Password').fill(DEMO);
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await expect(admin).toHaveURL(/\/admin$/);
  await admin.goto('http://localhost:5174/admin/managers');
  const row = admin.getByRole('row', { name: new RegExp(email.replace('+', '\\+')) });
  await row.getByRole('button', { name: 'Approve' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(row.getByText('Active')).toBeVisible();

  await page.getByRole('button', { name: 'Check status' }).click();
  await page.goto('/manager/theatres/new');
  await page.getByLabel('Theatre name').fill(`E2E Palace ${stamp}`);
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('Contact number').fill('+91 20 5555 0000');
  await page.getByLabel('Address').fill('7 Test Lane, Pune 411001');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Awaiting admin review')).toBeVisible();

  await admin.goto('http://localhost:5174/admin/theatres');
  await admin.getByRole('combobox', { name: 'Status filter' }).selectOption('PENDING_APPROVAL');
  const trow = admin.getByRole('row', { name: new RegExp(`E2E Palace ${stamp}`) });
  await trow.getByRole('button', { name: 'Approve' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByRole('row', { name: new RegExp(`E2E Palace ${stamp}`) })).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: 'Add screen' }).click();
  await page.getByLabel('Screen name').fill('Screen 1');
  await page.getByRole('button', { name: 'Create layout' }).click();
  await expect(page.getByRole('cell', { name: 'Screen 1' })).toBeVisible();

  const res = await page.request.get('/api/theatres');
  expect(JSON.stringify(await res.json())).toContain(`E2E Palace ${stamp}`);
  await adminCtx.close();
});

test('admin: login, reports with live data, approval queue and audit log', async ({ page }) => {
  await signIn(page, 'admin@demo.local', DEMO);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByText('Gross ticket revenue')).toBeVisible();
  await expect(page.getByText('Top-performing theatres')).toBeVisible();
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await page.getByRole('link', { name: 'Manager approvals' }).click();
  await expect(page.getByRole('heading', { name: 'Manager approvals' })).toBeVisible();
});
