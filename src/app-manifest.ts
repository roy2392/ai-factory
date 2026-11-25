export interface ManifestOptions {
  owner: string;
  port: number;
  name?: string;
}

export function buildManifest({ owner, port, name }: ManifestOptions) {
  return {
    name: name ?? `ai-factory-${owner}`,
    url: `https://github.com/${owner}/ai-factory`,
    hook_attributes: { url: 'https://example.invalid', active: false },
    redirect_url: `http://127.0.0.1:${port}/callback`,
    public: false,
    default_permissions: {
      contents: 'read',
      issues: 'write',
      pull_requests: 'write',
      actions: 'read',
      metadata: 'read',
    },
    default_events: [],
  };
}

export function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]!);
}

export function renderFormPage(
  manifest: ReturnType<typeof buildManifest>,
  state: string,
): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Create GitHub App</title>
<p>Create a private GitHub App for AI Factory. GitHub will ask you to confirm; then return here to save its key and repository secrets.</p>
<form method="post" action="https://github.com/settings/apps/new?state=${escapeHtml(encodeURIComponent(state))}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Create GitHub App on github.com</button></form></html>`;
}

export function validateCallback(
  query: URLSearchParams,
  expectedState: string,
): string | undefined {
  if (
    !expectedState ||
    query.getAll('state').length !== 1 ||
    query.get('state') !== expectedState
  )
    return undefined;
  const code = query.get('code');
  if (query.getAll('code').length !== 1 || !code?.trim()) return undefined;
  return code;
}

export function summarize(conversion: {
  id: number;
  slug: string;
  html_url: string;
}) {
  // Explicit allowlist: never spread the conversion response, which contains credentials.
  return {
    id: conversion.id,
    slug: conversion.slug,
    html_url: conversion.html_url,
    settings_url: `https://github.com/settings/apps/${conversion.slug}`,
    install_url: `https://github.com/apps/${conversion.slug}/installations/new`,
  };
}
