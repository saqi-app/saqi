/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

export {};
declare global {
  // eslint-disable-next-line no-restricted-syntax -- Astro requires augmenting its global App namespace for trusted middleware locals.
  namespace App {
    interface Locals {
      publicCacheRoute?: { authorSlug: string; poemId?: string };
    }
  }
}
