import { defineModuleConfig } from '../config';

export type ThrottlerType = 'default' | 'strict' | 'mcp';

declare global {
  interface AppConfigSchema {
    throttle: {
      enabled: boolean;
      throttlers: {
        [key in ThrottlerType]: ConfigItem<{
          ttl: number;
          limit: number;
        }>;
      };
    };
  }
}

defineModuleConfig('throttle', {
  enabled: {
    desc: 'Whether the throttler is enabled.',
    default: true,
  },
  'throttlers.default': {
    desc: 'The config for the default throttler.',
    default: {
      ttl: 60_000,
      limit: 120,
    },
  },
  'throttlers.strict': {
    desc: 'The config for the strict throttler.',
    default: {
      ttl: 60_000,
      limit: 20,
    },
  },
  // fork: AI agents call MCP tools in quick succession, give them their own
  // (per client IP) budget instead of sharing the default 120/min one
  'throttlers.mcp': {
    desc: 'The config for the workspace MCP endpoint throttler.',
    default: {
      ttl: 60_000,
      limit: 1200,
    },
  },
});
