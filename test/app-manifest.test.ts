import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  renderFormPage,
  summarize,
  validateCallback,
} from '../src/app-manifest.js';

describe('App manifest helpers', () => {
  it('uses the exact private App fields, disabled webhook, and least permissions', () => {
    expect(buildManifest({ owner: 'roy2392', port: 12345 })).toEqual({
      name: 'ai-factory-roy2392',
      url: 'https://github.com/roy2392/ai-factory',
      hook_attributes: { url: 'https://example.invalid', active: false },
      redirect_url: 'http://127.0.0.1:12345/callback',
      public: false,
      default_permissions: {
        contents: 'read',
        issues: 'write',
        pull_requests: 'write',
        actions: 'read',
        metadata: 'read',
      },
      default_events: [],
    });
    expect(
      buildManifest({ owner: 'owner', port: 12345, name: 'custom-name' }).name,
    ).toBe('custom-name');
  });
  it('HTML-escapes every attribute delimiter in manifest JSON and renders one POST button', () => {
    const manifest = buildManifest({
      owner: 'owner',
      port: 12345,
      name: `"'><script>&`,
    });
    const page = renderFormPage(manifest, 'state&"');
    expect(page).toContain('method="post"');
    expect(page).toContain(
      'action="https://github.com/settings/apps/new?state=state%26%22"',
    );
    expect(page).toContain('type="hidden" name="manifest"');
    expect(page).toContain('&quot;');
    expect(page).toContain('&#39;&gt;&lt;script&gt;&amp;');
    expect(page).not.toContain('<script>');
    expect(page.match(/<button/g)).toHaveLength(1);
    expect(page).toContain('Create GitHub App on github.com');
    const attribute = page.match(/name="manifest" value="([^"]*)"/)![1]!;
    const decoded = attribute
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(JSON.parse(decoded)).toEqual(manifest);
  });
  it('accepts only one nonempty code and one matching state', () => {
    expect(
      validateCallback(
        new URLSearchParams('code=one-use-code&state=expected'),
        'expected',
      ),
    ).toBe('one-use-code');
    for (const query of [
      'code=code&state=wrong',
      'code=code',
      'state=expected',
      'code=&state=expected',
      'code=code&state=expected&state=wrong',
      'code=code&code=other&state=expected',
    ]) {
      expect(
        validateCallback(new URLSearchParams(query), 'expected'),
      ).toBeUndefined();
    }
    expect(
      validateCallback(new URLSearchParams('code=code&state='), ''),
    ).toBeUndefined();
  });
  it('summarizes only public metadata and never includes pem, client secret, or webhook secret', () => {
    const conversion = {
      id: 123,
      slug: 'test-app',
      html_url: 'https://github.com/apps/test-app',
      pem: 'PRIVATE-KEY',
      client_secret: 'CLIENT-SECRET',
      webhook_secret: 'WEBHOOK-SECRET',
    };
    const summary = summarize(conversion);
    expect(summary).toEqual({
      id: 123,
      slug: 'test-app',
      html_url: conversion.html_url,
      settings_url: 'https://github.com/settings/apps/test-app',
      install_url: 'https://github.com/apps/test-app/installations/new',
    });
    for (const secret of [
      conversion.pem,
      conversion.client_secret,
      conversion.webhook_secret,
      'pem',
      'client_secret',
      'webhook_secret',
    ])
      expect(JSON.stringify(summary)).not.toContain(secret);
  });
});
