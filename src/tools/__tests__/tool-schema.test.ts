import { describe, expect, it } from 'vitest';

import { validateToolDefinition } from '../../lib/tool-validation.ts';
import { buildMemoryFetchCandidatesTool } from '../memory-fetch-candidates.ts';
import { buildMemoryConfirmContextTool } from '../memory-confirm-context.ts';
import { buildUpsertCustomerProfileTool } from '../upsert-customer-profile.ts';
import { buildAddAddressTool } from '../add-address.ts';
import { buildCreateJobTool } from '../create-job.ts';
import { buildAddJobItemTool } from '../add-job-item.ts';
import { buildRecordJobEventTool } from '../record-job-event.ts';

describe('new tool schemas', () => {
  const builders = [
    buildMemoryFetchCandidatesTool,
    buildMemoryConfirmContextTool,
    buildUpsertCustomerProfileTool,
    buildAddAddressTool,
    buildCreateJobTool,
    buildAddJobItemTool,
    buildRecordJobEventTool,
  ];

  it('exposes JSON schemas compatible with tool-validation', () => {
    for (const build of builders) {
      const definition = build();
      expect(() => validateToolDefinition(definition)).not.toThrow();
    }
  });
});
