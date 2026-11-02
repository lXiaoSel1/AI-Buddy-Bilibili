import {createHash} from 'node:crypto';
import proposal from '../contracts/proposal.json' with {type: 'json'};
import {assert, fail} from './errors.mjs';
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
export const CONTRACT = freeze(proposal);
export const CONTRACT_HASH = createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
export const REQUIRED_CAPABILITIES = Object.freeze({
  '@ai-buddy/bilibili-companion': Object.freeze(['social.context.read','activity.lease','activity.check','activity.finish','models.request','experience.append','proactive.offer','connections.request','ui.bubble']),
  '@ai-buddy/qq-connect': Object.freeze(['social.context.read','activity.lease','activity.check','activity.finish','models.request','experience.append','connections.open','connections.events','connections.request','connections.close']),
});
export function unavailableHost(reason = 'B_SOCIAL_BRIDGE_NOT_DELIVERED') {
  return {describe: async () => ({mode: 'unavailable', contractHash: CONTRACT_HASH, capabilities: [], blockers: [reason]}), invoke: async () => { throw fail(reason, '公共社交桥接尚未就绪'); }};
}
export async function createHostClient(raw, {pluginId, allowProposalMock = false} = {}) {
  assert(typeof raw?.describe === 'function' && typeof raw?.invoke === 'function', 'B_SOCIAL_BRIDGE_NOT_DELIVERED');
  const description = await raw.describe();
  assert(description.contractHash === CONTRACT_HASH, 'SOCIAL_CONTRACT_MISMATCH');
  assert(description.pluginId === pluginId, 'SOCIAL_PLUGIN_BINDING_MISMATCH');
  assert(allowProposalMock && description.mode === 'proposal-mock' || description.mode === 'runtime' && description.contractAcknowledgement?.owner === 'B' && description.contractAcknowledgement?.hash === CONTRACT_HASH, 'B_CONTRACT_ACK_REQUIRED');
  assert(Array.isArray(description.capabilities), 'CAPABILITIES_REQUIRED');
  return {
    describe: async () => structuredClone(description),
    async invoke(method, payload = {}, options = {}) {
      assert(CONTRACT.methods.includes(method) && description.capabilities.includes(method), 'SOCIAL_CAPABILITY_UNAVAILABLE', method);
      options.signal?.throwIfAborted();
      const result = await raw.invoke(method, payload, options);
      // A late cancellation cannot erase a platform's actual send receipt.
      // Domain code still rechecks leases before new work, while retaining the
      // factual result of already accepted network side effects.
      if (method !== 'connections.request') options.signal?.throwIfAborted();
      if (method === 'social.context.read') {
        assert(typeof result?.contextToken === 'string' && result.contextToken.length > 0, 'TRUSTED_CONTEXT_REQUIRED');
        if (payload.purpose === 'manage-plugin') assert(result.permissions?.includes('plugin.manage'), 'PLUGIN_MANAGE_DENIED');
        else if (payload.purpose === 'plugin-background') assert(result.permissions?.includes('plugin.activity') && typeof result.accountId === 'string', 'PLUGIN_BACKGROUND_DENIED');
        else for (const field of CONTRACT.minimumContextFields) assert(typeof result[field] === 'string' && result[field].length > 0, 'SOCIAL_CONTEXT_INCOMPLETE', field);
      }
      if (method === 'activity.lease') assert(typeof result?.leaseId === 'string' && Number.isSafeInteger(result.generation), 'ACTIVITY_LEASE_REQUIRED');
      if (method === 'models.request') assert(typeof (result?.requestId ?? result?.providerRequestId) === 'string' && result.usageAccounting === 'core-model-router', 'CORE_MODEL_ACCOUNTING_REQUIRED');
      return result;
    },
  };
}
