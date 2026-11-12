import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createCourse } from './helpers';

/** The left sidebar: folds away on a desktop and remembers it; on a phone it is a menu drawer that Escape closes. */
async function noHorizontalScroll(page: Page, label: string) {
  const o = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(o.scrollWidth, `${label}: page is wider than the screen`).toBeLessThanOrEqual(o.innerWidth);
}

test('the desktop sidebar folds and unfolds by keyboard, stays folded after a reload, and hides its links while folded', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, '계산 이론', 'CS301');
  const sidebar = page.locator('#app-sidebar');
  const fold = page.getByRole('button', { name: '사이드바 접기' });
  await expect(sidebar).toBeVisible();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(fold).toHaveAttribute('aria-controls', 'app-sidebar');
  await expect(sidebar.getByRole('link', { name: /계산 이론/ })).toBeVisible();

  await fold.focus();
  await page.keyboard.press('Enter');
  await expect(sidebar).toBeHidden();
  const unfold = page.getByRole('button', { name: '사이드바 펼치기' });
  await expect(unfold).toBeFocused(); // the keyboard user stays on the control that replaced the one they pressed
  await expect(unfold).toHaveAttribute('aria-expanded', 'false');
  await expect(unfold).toHaveAttribute('aria-controls', 'app-sidebar');
  await expect(page.locator('#app-sidebar')).toHaveCount(1); // still in the page, so aria-controls points at something
  // nothing inside the folded sidebar can be reached with Tab
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#app-sidebar')), `Tab ${i + 1} reached the folded sidebar`).toBe(false);
  }
  // the page takes the freed width, beside a slim rail that holds the way back
  const main = (await page.locator('#main').boundingBox())!;
  expect(main.x).toBeLessThanOrEqual(48);
  expect(main.width).toBeGreaterThan(1300);
  expect(await page.locator('header').filter({ has: page.getByRole('button', { name: '메뉴 열기' }) }).isVisible()).toBe(false); // no bar over the pages' own sticky headers
  await noHorizontalScroll(page, 'folded');

  await page.reload();
  await expect(page.locator('#app-sidebar')).toBeHidden();
  await expect(page.getByRole('button', { name: '사이드바 펼치기' })).toBeVisible();

  await page.getByRole('button', { name: '사이드바 펼치기' }).click();
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole('button', { name: '사이드바 접기' })).toBeFocused();
  await page.reload();
  await expect(page.locator('#app-sidebar')).toBeVisible();
  await noHorizontalScroll(page, 'unfolded');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('@mobile the phone menu is a drawer: it opens from the menu button, Escape closes it and focus returns', async ({ page }) => {
  // A desktop preference to fold the sidebar must not take the menu away on a phone.
  await page.addInitScript(() => localStorage.setItem('studyai.sidebar', 'collapsed'));
  await page.goto('/');
  await noHorizontalScroll(page, 'phone');
  await expect(page.locator('#app-sidebar')).toBeHidden();
  await expect(page.getByRole('button', { name: '사이드바 펼치기' })).toBeHidden();
  const open = page.getByRole('button', { name: '메뉴 열기' });
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await expect(open).toHaveAttribute('aria-controls', 'app-menu');

  await open.tap();
  const menu = page.getByRole('dialog', { name: '메뉴' });
  await expect(menu).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#app-menu')), 'focus moves into the menu').toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute('aria-expanded', 'false');

  await open.tap();
  await menu.getByRole('button', { name: '메뉴 닫기' }).tap();
  await expect(menu).toBeHidden();
  await open.tap();
  await menu.getByRole('link', { name: '설정과 백업' }).tap();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(menu).toBeHidden(); // navigating closes it
  await noHorizontalScroll(page, 'settings on a phone');
});
