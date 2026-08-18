import { test, expect } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

type CapturedPostHogRequest = {
  url: string;
  body: string;
};

type CapturedPostHogEvent = {
  event?: string;
  properties?: JsonObject;
};

function parseCapturedEvents(requests: CapturedPostHogRequest[]): CapturedPostHogEvent[] {
  return requests.flatMap((request) => {
    try {
      const body = parsePostHogBody(request.body);
      if (Array.isArray(body.batch)) {
        return body.batch;
      }
      return [body];
    } catch {
      return [];
    }
  });
}

function parsePostHogBody(bodyText: string): CapturedPostHogEvent & { batch?: CapturedPostHogEvent[] } {
  try {
    // SAFETY: captured PostHog requests are decoded into the fixture's constrained event shape.
    return JSON.parse(bodyText) as CapturedPostHogEvent & { batch?: CapturedPostHogEvent[] };
  } catch {
    const data = new URLSearchParams(bodyText).get('data');
    // SAFETY: captured PostHog requests are decoded into the fixture's constrained event shape.
    return data
      ? JSON.parse(data) as CapturedPostHogEvent & { batch?: CapturedPostHogEvent[] }
      : {};
  }
}

test('declining analytics sends identified consent events and discards queued usage', async ({ page }) => {
  const identity = {
    distinctId: 'install:install_decline_e2e',
    installId: 'install_decline_e2e',
    identitySource: 'anonymous',
    appVersion: '2.1.2-test',
    platform: 'linux',
    electronVersion: 'test-electron',
    webDistinctId: 'web_decline_e2e',
    webAttributionPresent: true,
    isFirstLaunch: true,
    previousVersion: null,
  };
  const requests: CapturedPostHogRequest[] = [];

  await page.route('http://posthog.test/**', async (route) => {
    requests.push({
      url: route.request().url(),
      body: route.request().postData() ?? '',
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });

  await installElectronApiMock(page, {
    analyticsConsentShown: false,
    analyticsIdentity: identity,
    initialConfig: {
      analytics: {
        enabled: false,
        posthogApiKey: 'phc_test',
        posthogHost: 'http://posthog.test',
        installId: identity.installId,
        distinctId: identity.distinctId,
        identitySource: identity.identitySource,
      },
    },
    mainAnalyticsEvents: [
      {
        eventName: 'app_opened',
        properties: { is_first_launch: true },
      },
    ],
  });

  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  await expect(page.getByRole('dialog', { name: 'Help Improve Pane' })).toBeVisible({ timeout: 10000 });
  await expect.poll(() => parseCapturedEvents(requests).map((event) => event.event)).toEqual(
    expect.arrayContaining(['consent_dialog_shown', 'app_first_opened'])
  );

  await page.getByRole('button', { name: 'No thanks' }).click();

  await expect.poll(() => parseCapturedEvents(requests).map((event) => event.event)).toEqual(
    expect.arrayContaining(['consent_dialog_shown', 'app_first_opened', '$create_alias', 'analytics_opted_out'])
  );

  const events = parseCapturedEvents(requests);
  const consentShown = events.find((event) => event.event === 'consent_dialog_shown');
  const firstOpened = events.find((event) => event.event === 'app_first_opened');
  const optedOut = events.find((event) => event.event === 'analytics_opted_out');
  const alias = events.find((event) => event.event === '$create_alias');

  for (const event of [consentShown, firstOpened, optedOut]) {
    expect(event?.properties).toMatchObject({
      distinct_id: identity.distinctId,
      install_id: identity.installId,
      identity_source: identity.identitySource,
      app_version: identity.appVersion,
      platform: identity.platform,
    });
    expect(event?.properties?.$set).toMatchObject({
      install_id: identity.installId,
      app_version: identity.appVersion,
      platform: identity.platform,
    });
  }

  expect(firstOpened?.properties).toMatchObject({
    source: 'web_attribution',
    web_attributed: true,
    web_attribution_present: true,
    is_first_launch: true,
  });
  expect(alias?.properties).toMatchObject({
    distinct_id: identity.webDistinctId,
    alias: identity.distinctId,
    install_id: identity.installId,
  });
  expect(events.some((event) => event.event === 'app_opened')).toBe(false);
});

test('accepting analytics captures opt-in before any queued usage event can flush', async ({ page }) => {
  const identity = {
    distinctId: 'install:install_accept_e2e',
    installId: 'install_accept_e2e',
    identitySource: 'anonymous',
    appVersion: '2.1.2-test',
    platform: 'linux',
    electronVersion: 'test-electron',
    webAttributionPresent: false,
    isFirstLaunch: false,
    previousVersion: '2.1.1-test',
  };
  const requests: CapturedPostHogRequest[] = [];

  await page.route('http://posthog.test/**', async (route) => {
    requests.push({
      url: route.request().url(),
      body: route.request().postData() ?? '',
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });

  await installElectronApiMock(page, {
    analyticsConsentShown: false,
    analyticsIdentity: identity,
    initialConfig: {
      analytics: {
        enabled: false,
        posthogApiKey: 'phc_test',
        posthogHost: 'http://posthog.test',
        installId: identity.installId,
        distinctId: identity.distinctId,
        identitySource: identity.identitySource,
      },
    },
    mainAnalyticsEvents: [
      {
        eventName: 'app_opened',
        properties: { is_first_launch: false },
      },
    ],
  });

  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  await expect(page.getByRole('dialog', { name: 'Help Improve Pane' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Enable analytics' }).click();

  await expect.poll(() => parseCapturedEvents(requests).map((event) => event.event)).toContain('analytics_opted_in');

  const events = parseCapturedEvents(requests);
  const optInIndex = events.findIndex((event) => event.event === 'analytics_opted_in');
  const appOpenedIndex = events.findIndex((event) => event.event === 'app_opened');
  const optedIn = events[optInIndex];

  expect(optInIndex).toBeGreaterThanOrEqual(0);
  if (appOpenedIndex >= 0) {
    expect(appOpenedIndex).toBeGreaterThan(optInIndex);
  }
  expect(optedIn.properties).toMatchObject({
    distinct_id: identity.distinctId,
    install_id: identity.installId,
    identity_source: identity.identitySource,
    app_version: identity.appVersion,
    platform: identity.platform,
  });
});
