// Test: KNOWN_BEATS + getJournalistsForBeat
// Verifies that an unknown beat returns [], a known beat filters correctly,
// and that the beat matching logic handles malformed beat_keywords gracefully.
import { describe, it, expect } from 'vitest';
import { KNOWN_BEATS, getJournalistsForBeat } from '../src/worker.js';

function makeDb(rows) {
  return {
    prepare() {
      return {
        bind() { return this; },
        async all() { return { results: rows }; },
      };
    },
  };
}

describe('KNOWN_BEATS', () => {
  it('contains at least the core beats', () => {
    expect(KNOWN_BEATS).toContain('marketing-tech');
    expect(KNOWN_BEATS).toContain('home-services');
    expect(KNOWN_BEATS).toContain('ai-automation');
  });

  it('has no duplicates', () => {
    expect(new Set(KNOWN_BEATS).size).toBe(KNOWN_BEATS.length);
  });

  it('all beats are lowercase hyphen-only strings', () => {
    for (const beat of KNOWN_BEATS) {
      expect(beat).toMatch(/^[a-z-]+$/);
    }
  });
});

describe('getJournalistsForBeat', () => {
  it('returns journalists whose beat_keywords include the target beat', async () => {
    const db = makeDb([
      { id: '1', name: 'Jane', beat_keywords: '["marketing-tech","ai-automation"]' },
      { id: '2', name: 'Bob', beat_keywords: '["home-services"]' },
      { id: '3', name: 'Alice', beat_keywords: '["marketing-tech"]' },
    ]);

    const results = await getJournalistsForBeat('marketing-tech', db);
    const ids = results.map(j => j.id);

    expect(ids).toContain('1');
    expect(ids).toContain('3');
    expect(ids).not.toContain('2');
  });

  it('returns empty array for a beat with no matching journalists (pipeline continues)', async () => {
    const db = makeDb([
      { id: '1', beat_keywords: '["home-services"]' },
    ]);

    const results = await getJournalistsForBeat('flooring-industry', db);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when journalist DB is empty', async () => {
    const db = makeDb([]);
    const results = await getJournalistsForBeat('marketing-tech', db);
    expect(results).toHaveLength(0);
  });

  it('handles malformed beat_keywords JSON gracefully (does not throw)', async () => {
    const db = makeDb([
      { id: '1', beat_keywords: 'not-valid-json' },
      { id: '2', beat_keywords: '["marketing-tech"]' },
    ]);

    const results = await getJournalistsForBeat('marketing-tech', db);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('2');
  });

  it('handles null beat_keywords gracefully', async () => {
    const db = makeDb([
      { id: '1', beat_keywords: null },
      { id: '2', beat_keywords: '["marketing-tech"]' },
    ]);

    const results = await getJournalistsForBeat('marketing-tech', db);
    expect(results).toHaveLength(1);
  });
});
