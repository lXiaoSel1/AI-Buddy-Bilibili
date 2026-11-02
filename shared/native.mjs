import {join, isAbsolute} from 'node:path';
import {CONTRACT_HASH, REQUIRED_CAPABILITIES, createHostClient} from './contract.mjs';
import {assert, fail, publicError} from './errors.mjs';
import {VERSION} from './version.mjs';
import {createAccountServices} from './account-services.mjs';

// Only metadata is public. Private reads and all mutations need B's APP principal.
// Source10 does not expose this proposed social facade: installation must remain inert.
export async function registerNativePlugin(ctx, {pluginId, label, createService, unconnected = null, version = VERSION}) {
  let service = null, bridge = null, host = null, closed = false, eventDisposer = null, registration = null, closePromise = null;
  const pendingEvents = new Set();
  const readiness = {pluginId, label, version, mode: 'unavailable', contractHash: CONTRACT_HASH, contractConfirmed: false, blockers: ['B_SOCIAL_BRIDGE_NOT_DELIVERED']};
  try {
    if (typeof ctx.buddySocialServices?.openPlugin === 'function') {
      bridge = await ctx.buddySocialServices.openPlugin({pluginId, contractHash: CONTRACT_HASH});
      host = await createHostClient(bridge, {pluginId});
      const description = await host.describe();
      for (const capability of REQUIRED_CAPABILITIES[pluginId] ?? []) assert(description.capabilities.includes(capability), 'SOCIAL_CAPABILITY_UNAVAILABLE', capability);
      assert(typeof bridge.authorizeRequest === 'function', 'TRUSTED_UI_AUTHORIZER_REQUIRED');
      assert(typeof bridge.subscribeEvents === 'function', 'TRUSTED_BACKGROUND_SUBSCRIPTION_REQUIRED');
      assert(isAbsolute(bridge.dataDirectory ?? ''), 'HOST_PRIVATE_DATA_DIRECTORY_REQUIRED');
      const serviceOptions={platform:bridge.platform,transport:bridge.transport,timeZone:bridge.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone};
      service=description.features?.includes('social-login-v1')?createAccountServices({directory:bridge.dataDirectory,pluginId,host,createService,unconnected,options:serviceOptions}):await createService({databasePath: join(bridge.dataDirectory,'plugin-v1.sqlite'),host,...serviceOptions});
      assert(typeof service.onHostEvent === 'function', 'PLUGIN_BACKGROUND_HANDLER_REQUIRED');
      eventDisposer = await bridge.subscribeEvents({pluginId, contractHash: CONTRACT_HASH}, event => {
        if (closed) return Promise.resolve({status: 'closed'});
        const task = Promise.resolve().then(() => service.onHostEvent(event));
        pendingEvents.add(task); task.finally(() => pendingEvents.delete(task)).catch(() => {});
        return task;
      });
      assert(typeof eventDisposer === 'function', 'BACKGROUND_DISPOSER_REQUIRED');
      Object.assign(readiness, {mode: 'runtime', contractConfirmed: true, blockers: []});
    }
  } catch (error) {
    readiness.blockers = [error.code ?? 'SOCIAL_INITIALIZATION_FAILED'];
    try { await eventDisposer?.(); } catch { readiness.blockers.push('INITIALIZATION_SUBSCRIPTION_CLOSE_PENDING'); }
    try { await service?.close(); } catch { readiness.blockers.push('INITIALIZATION_DRAIN_PENDING'); }
    try { await bridge?.close?.(); } catch { readiness.blockers.push('INITIALIZATION_BRIDGE_CLOSE_PENDING'); }
    service = null; bridge = null;
    eventDisposer = null;
  }
  const route = '/api/' + pluginId.replace('@ai-buddy/', 'ai-buddy/');
  const handler = async request => {
    try {
      assert(!closed, 'PLUGIN_CLOSED');
      const url = new URL(request.url);
      if (request.method === 'GET' && (url.searchParams.get('action') ?? 'readiness') === 'readiness') return Response.json(readiness);
      assert(service && readiness.mode === 'runtime', 'B_SOCIAL_BRIDGE_NOT_DELIVERED');
      assert(request.method === 'POST', 'PLUGIN_POST_REQUIRED');
      const authorizationRequest=request.clone();
      const input = request.method === 'POST' ? await request.json() : {action: url.searchParams.get('action') ?? 'status'};
      assert(input && typeof input.action === 'string' && !['__proto__', 'constructor', 'prototype'].includes(input.action), 'PLUGIN_ACTION_INVALID');
      const principal = await bridge.authorizeRequest(authorizationRequest, {pluginId, action: input.action});
      assert(!closed, 'PLUGIN_CLOSED');
      assert(typeof principal?.contextToken === 'string' && principal.contextToken, 'TRUSTED_UI_PRINCIPAL_REQUIRED');
      // A body-supplied principal, context or filesystem location never replaces this result.
      const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? {...input.payload} : {};
      for (const key of ['principal', 'contextToken', 'databasePath', 'dataDirectory', '__proto__']) delete payload[key];
      if(['onboarding.open','onboarding.contacts'].includes(input.action)){
        const value=await host.invoke('social.context.read',{purpose:'manage-plugin',principal,setupAction:input.action.split('.')[1]});
        assert(value.onboardingAvailable&&value.onboarding,'SOCIAL_ONBOARDING_UNAVAILABLE','请更新 AI 酱后使用扫码连接');return Response.json(value.onboarding);
      }
      const result=await service.dispatch(input.action,payload,principal);
      if(pluginId==='@ai-buddy/bilibili-companion'&&input.action==='settings.update'&&(await host.describe()).features?.includes('social-login-v1'))await host.invoke('social.context.read',{purpose:'manage-plugin',principal,setupAction:'complete'});
      return Response.json(result);
    } catch (error) { return Response.json({error: publicError(error)}, {status: error.code === 'PLUGIN_CLOSED' ? 503 : error.code === 'PLUGIN_POST_REQUIRED' ? 405 : 403}); }
  };
  function close() {
    if(closePromise)return closePromise;
    closed = true;
    // Publish the shared promise before invoking any host disposer: disposal
    // itself may synchronously re-enter close().
    closePromise=Promise.resolve().then(async()=>{
    const errors=[];
    try { if (typeof registration === 'function') {const disposed=registration();if(disposed!==closePromise)await disposed;} } catch(error) { errors.push(error); }
    try { await eventDisposer?.(); } catch(error) { errors.push(error); }
    try { await service?.close(); } catch(error) { errors.push(error); }
    const pending=await Promise.allSettled([...pendingEvents]);
    for(const result of pending)if(result.status==='rejected')errors.push(result.reason);
    try { await bridge?.close?.(); } catch(error) { errors.push(error); }
    if(errors.length)throw fail('PLUGIN_DRAIN_FAILED','插件清理存在待核对项',{codes:errors.map(error=>error?.code??'DRAIN_ERROR')});
    });
    return closePromise;
  }
  try {
    assert(typeof ctx.connection?.fetch?.register==='function','NATIVE_ROUTE_REGISTRY_REQUIRED');
    registration=ctx.connection.fetch.register({path:route,methods:['GET','POST'],requestBody:'buffered',fetch:handler});
    ctx.effect?.(() => close);
  } catch(error) {
    try {await close();} catch(cleanupError) {error.cleanupCode=cleanupError.code??'PLUGIN_DRAIN_FAILED';}
    throw error;
  }
  return {readiness: () => structuredClone(readiness), close, route};
}
