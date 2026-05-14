// Test: Journalist cooldown — cross-brief 30-day rate limiting
// Journalist last_contacted 15 days ago → excluded
// Journalist last_contacted 45 days ago → included
// Journalist never contacted → included
import { describe, it, expect } from 'vitest';
import { filterEligibleJournalists } from '../src/worker.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function daysAgo(n) {
  return Date.now() - n * 24 * 60 * 60 * 1000;
}

describe('filterEligibleJournalists (30-day cooldown)', () => {
  it('excludes journalist contacted 15 days ago', () => {
    const journalists = [{ id: '1', name: 'Jane Doe', email: 'jane@techcrunch.com', last_contacted_at: daysAgo(15) }];
    const eligible = filterEligibleJournalists(journalists);
    expect(eligible).toHaveLength(0);
  });

  it('includes journalist contacted 45 days ago', () => {
    const journalists = [{ id: '2', name: 'John Smith', email: 'john@venturebeat.com', last_contacted_at: daysAgo(45) }];
    const eligible = filterEligibleJournalists(journalists);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe('2');
  });

  it('includes journalist who has never been contacted (null)', () => {
    const journalists = [{ id: '3', name: 'Alice Lee', email: 'alice@inc.com', last_contacted_at: null }];
    const eligible = filterEligibleJournalists(journalists);
    expect(eligible).toHaveLength(1);
  });

  it('includes journalist who has never been contacted (undefined)', () => {
    const journalists = [{ id: '4', name: 'Bob Chen', email: 'bob@entrepreneur.com' }]; // no last_contacted_at
    const eligible = filterEligibleJournalists(journalists);
    expect(eligible).toHaveLength(1);
  });

  it('correctly mixes eligible and ineligible in same batch', () => {
    const journalists = [
      { id: '1', last_contacted_at: daysAgo(5) },   // 5 days → excluded
      { id: '2', last_contacted_at: daysAgo(31) },  // 31 days → included
      { id: '3', last_contacted_at: null },           // never → included
      { id: '4', last_contacted_at: daysAgo(29) },  // 29 days → excluded (just under 30)
      { id: '5', last_contacted_at: daysAgo(90) },  // 90 days → included
    ];

    const eligible = filterEligibleJournalists(journalists);

    const ids = eligible.map(j => j.id);
    expect(ids).toContain('2');
    expect(ids).toContain('3');
    expect(ids).toContain('5');
    expect(ids).not.toContain('1');
    expect(ids).not.toContain('4');
    expect(eligible).toHaveLength(3);
  });

  it('returns empty array for empty input', () => {
    expect(filterEligibleJournalists([])).toHaveLength(0);
  });

  it('handles exactly 30 days as ineligible (boundary)', () => {
    const exactly30 = [{ id: '1', last_contacted_at: Date.now() - THIRTY_DAYS_MS }];
    // Exactly 30 days is NOT > THIRTY_DAYS_MS, so should be excluded
    const eligible = filterEligibleJournalists(exactly30);
    expect(eligible).toHaveLength(0);
  });
});
