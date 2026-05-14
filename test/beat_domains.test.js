// Test: BEAT_DOMAINS — beat not in table returns empty array, pipeline continues
import { describe, it, expect } from 'vitest';
import { BEAT_DOMAINS, getDomainsForBeat } from '../src/worker.js';

describe('BEAT_DOMAINS constant', () => {
  it('returns domains for a known beat', () => {
    const domains = getDomainsForBeat('marketing-tech');
    expect(Array.isArray(domains)).toBe(true);
    expect(domains.length).toBeGreaterThan(0);
    expect(domains).toContain('techcrunch.com');
  });

  it('returns empty array for unknown beat (pipeline must continue)', () => {
    const domains = getDomainsForBeat('underwater-basket-weaving');
    expect(Array.isArray(domains)).toBe(true);
    expect(domains.length).toBe(0);
  });

  it('returns empty array for undefined beat', () => {
    const domains = getDomainsForBeat(undefined);
    expect(domains.length).toBe(0);
  });

  it('returns empty array for null beat', () => {
    const domains = getDomainsForBeat(null);
    expect(domains.length).toBe(0);
  });

  it('all known beats have at least one domain', () => {
    for (const [beat, domains] of Object.entries(BEAT_DOMAINS)) {
      expect(domains.length, `Beat "${beat}" has no domains`).toBeGreaterThan(0);
    }
  });

  it('all domains are valid hostnames (no http:// prefix)', () => {
    for (const domains of Object.values(BEAT_DOMAINS)) {
      for (const domain of domains) {
        expect(domain).not.toMatch(/^https?:\/\//);
        expect(domain).toMatch(/\./); // has at least one dot
      }
    }
  });
});
