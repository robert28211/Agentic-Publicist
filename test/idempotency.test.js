// Test: Queue Consumer idempotency (brief.status field pattern)
// Eng review D2 decision: complete=ack+skip, error=clean+retry
import { describe, it, expect, vi } from 'vitest';

// Isolated test — does not need the Workers runtime
// Tests the idempotency LOGIC extracted from processBrief

function makeDb(briefStatus, pitchCount = 0) {
  const pitches = [];
  return {
    _pitches: pitches,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT status FROM briefs')) return { status: briefStatus };
              if (sql.includes('SELECT id FROM entities')) return { id: args[0] };
              return null;
            },
            async all() { return { results: [] }; },
            async run() {
              if (sql.includes('DELETE FROM pitches')) pitches.push('deleted');
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function makeMessage(briefId, acked = { value: false }) {
  return {
    body: { briefId },
    async ack() { acked.value = true; },
  };
}

// Simulate the idempotency check at the top of processBrief
async function idempotencyCheck(briefStatus, db, message) {
  const brief = await db.prepare('SELECT status FROM briefs WHERE id=?').bind(message.body.briefId).first();
  if (!brief) { await message.ack(); return 'not_found'; }
  if (brief.status === 'complete') { await message.ack(); return 'complete_ack'; }
  if (brief.status === 'error') {
    await db.prepare('DELETE FROM pitches WHERE brief_id=?').bind(message.body.briefId).run();
    return 'error_clean_retry';
  }
  return 'continue';
}

describe('Queue Consumer idempotency', () => {
  it('acks and returns early when brief status is complete (duplicate delivery)', async () => {
    const acked = { value: false };
    const db = makeDb('complete');
    const msg = makeMessage('brief-1', acked);

    const result = await idempotencyCheck('complete', db, msg);

    expect(result).toBe('complete_ack');
    expect(acked.value).toBe(true);
  });

  it('deletes partial pitches and continues when brief status is error', async () => {
    const acked = { value: false };
    const db = makeDb('error');
    const msg = makeMessage('brief-2', acked);

    const result = await idempotencyCheck('error', db, msg);

    expect(result).toBe('error_clean_retry');
    expect(db._pitches).toContain('deleted'); // DELETE FROM pitches ran
    expect(acked.value).toBe(false); // NOT acked — retries allowed
  });

  it('continues pipeline for pending status', async () => {
    const acked = { value: false };
    const db = makeDb('pending');
    const msg = makeMessage('brief-3', acked);

    const result = await idempotencyCheck('pending', db, msg);

    expect(result).toBe('continue');
    expect(acked.value).toBe(false);
  });

  it('continues pipeline for processing status', async () => {
    const db = makeDb('processing');
    const msg = makeMessage('brief-4');

    const result = await idempotencyCheck('processing', db, msg);

    expect(result).toBe('continue');
  });
});
