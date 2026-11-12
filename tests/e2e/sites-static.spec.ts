import { expect, test } from '@playwright/test';
import { trackRequests, watchProblems } from './helpers';

test('Sites: Korean app opens at a deep link without an AI request or demo banner', async ({ page }) => {
  const requests = trackRequests(page);
  const problems = watchProblems(page);
  await page.goto('/settings');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('heading', { name: 'AI 학습 도우미' })).toBeVisible();
  await expect(page.getByText('이 사본에는 AI가 없습니다')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ChatGPT로 계속하기' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '예시 과목 불러오기' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI 학습 도우미' })).toBeVisible();
  expect(requests.filter((url) => new URL(url).pathname.startsWith('/api/'))).toEqual([]);
  expect(problems).toEqual([]);
});
