import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          d1Databases: ['DB'],
          queues: {
            producers: [{ bindingName: 'PIPELINE_QUEUE', queueName: 'publicist-pipeline' }],
          },
        },
      },
    },
  },
});
