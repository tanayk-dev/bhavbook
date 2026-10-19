import { defineProject } from 'vitest/config';

// Core tests run in a non-IST timezone so any accidental use of the machine timezone fails (ADR-0005).
export default defineProject({
  test: {
    name: '@bhavbook/core',
    env: { TZ: 'America/New_York' },
  },
});
