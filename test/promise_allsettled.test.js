// Test: Promise.allSettled — 1 journalist failure → partial pitches written, pipeline continues
// Verifies that a single failed pitch draft doesn't abort the whole run
import { describe, it, expect, vi } from 'vitest';

// Simulate the pitch drafting phase of processBrief
async function runPitchDrafting(pitchJobs) {
  const results = await Promise.allSettled(pitchJobs);
  const successful = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
  const failed = results
    .filter(r => r.status === 'rejected')
    .map(r => r.reason?.message || 'unknown');
  return { successful, failed };
}

function makePitchJob(id, shouldFail = false) {
  return new Promise((resolve, reject) => {
    if (shouldFail) {
      reject(new Error(`Claude API 529: rate limited for journalist ${id}`));
    } else {
      resolve({ id, subject: `Subject for ${id}`, body: `Body for ${id}` });
    }
  });
}

describe('Promise.allSettled pitch drafting', () => {
  it('returns all successful pitches when all succeed', async () => {
    const jobs = [makePitchJob('j1'), makePitchJob('j2'), makePitchJob('j3')];
    const { successful, failed } = await runPitchDrafting(jobs);

    expect(successful).toHaveLength(3);
    expect(failed).toHaveLength(0);
  });

  it('returns partial results when 1 of 3 fails', async () => {
    const jobs = [
      makePitchJob('j1'),
      makePitchJob('j2', true), // this one fails
      makePitchJob('j3'),
    ];
    const { successful, failed } = await runPitchDrafting(jobs);

    expect(successful).toHaveLength(2);
    expect(failed).toHaveLength(1);
    expect(successful.map(p => p.id)).toContain('j1');
    expect(successful.map(p => p.id)).toContain('j3');
  });

  it('returns empty successful array when all fail (pipeline still completes)', async () => {
    const jobs = [
      makePitchJob('j1', true),
      makePitchJob('j2', true),
    ];
    const { successful, failed } = await runPitchDrafting(jobs);

    expect(successful).toHaveLength(0);
    expect(failed).toHaveLength(2);
    // Pipeline should NOT throw — it handles 0 successful pitches gracefully
  });

  it('handles empty jobs array (no journalists found)', async () => {
    const { successful, failed } = await runPitchDrafting([]);

    expect(successful).toHaveLength(0);
    expect(failed).toHaveLength(0);
  });

  it('preserves error messages for observability', async () => {
    const jobs = [makePitchJob('j1', true)];
    const { failed } = await runPitchDrafting(jobs);

    expect(failed[0]).toContain('Claude API 529');
  });
});
